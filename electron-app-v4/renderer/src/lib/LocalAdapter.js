/**
 * LocalAdapter.js — implements the same interface as api.js remote calls
 * but reads/writes directly from @capacitor-community/sqlite on-device.
 *
 * Used when db_mode='local' (standalone Capacitor, no server required).
 * All three paths — local, v4 server, v2 FastAPI — share the same Svelte UI;
 * only api.js routes differently based on db_mode.
 */

import { Capacitor } from '@capacitor/core';
import { query, run } from './LocalDB.js';
import { VLM_PROVIDERS, VLM_MODELS } from './VlmData.js';

// ── Voy-search helper (WASM HNSW) ─────────────────────────────────────────────

let _voyIndex = null;

async function _getVoyIndex(forceRebuild = false) {
  if (_voyIndex && !forceRebuild) return _voyIndex;
  
  const { Voy } = await import('voy-search');
  const items = await _loadAllEmbeddings();
  
  const embeddings = items.map(p => ({
    id:         String(p.face_id),
    title:      p.person_name,
    url:        JSON.stringify({ image_id: p.image_id, filename: p.filename }),
    embeddings: Array.from(p.vec),
  }));
  
  _voyIndex = new Voy({ embeddings });
  return _voyIndex;
}

/** Return the best-matching person above threshold using Voy (HNSW). */
async function _voyBestMatch(embedding, threshold = 0.4) {
  try {
    const index = await _getVoyIndex();
    const results = index.search(Array.from(embedding), 1);
    if (results.length > 0) {
      const best = results[0];
      // Voy score is similarity (higher is better for IP index)
      if (best.score >= threshold) {
        return { person_id: parseInt(best.id), name: best.title };
      }
    }
  } catch (err) {
    console.error('[LocalAdapter] Voy search error:', err);
  }
  return null;
}

// ── Filepath cache — lets thumbnailUrl() stay synchronous ─────────────────────
// Populated whenever getImages / getImage / getPerson returns records.
export const fileCache = new Map(); // image_id → filepath

function _cache(images) {
  for (const img of images)
    if (img?.id && img?.filepath) fileCache.set(img.id, img.filepath);
  return images;
}

/** Convert a native filesystem path to a URL WKWebView can load. */
export function toWebUrl(filepath) {
  if (!filepath) return '';
  return Capacitor.convertFileSrc(filepath);
}

/** Load all face embeddings from SQLite for the search index. */
async function _loadAllEmbeddings() {
  const rows = await query(`
    SELECT fe.id, fe.person_id, p.name, fe.embedding_vector, f.image_id, i.filename
    FROM face_embeddings fe
    JOIN faces f ON f.id = fe.face_id
    JOIN images i ON i.id = f.image_id
    LEFT JOIN people p ON p.id = fe.person_id
    WHERE fe.embedding_vector IS NOT NULL
  `);
  return rows.map(r => ({
    face_id: r.id,
    person_id: r.person_id,
    person_name: r.name || 'Unknown',
    image_id: r.image_id,
    filename: r.filename,
    vec: _csvToFloat32(r.embedding_vector),
  }));
}

function _csvToFloat32(str) {
  if (!str) return new Float32Array(0);
  const parts = str.split(',');
  const arr = new Float32Array(parts.length);
  for (let i = 0; i < parts.length; i++) arr[i] = +parts[i];
  return arr;
}

// ── Health / Auth (mocked — local mode has no server session) ─────────────────

export const localAdapter = {

  health() {
    return { ok: true, version: 'local', backend: 'capacitor-sqlite', model_ready: true };
  },

  me() {
    return { username: 'local', role: 'admin' };
  },

  async searchImages(q, limit = 50) {
    console.log('[LocalAdapter] searchImages', { q, limit });
    // Standalone mode semantic search using Voy
    try {
      const index = await _getVoyIndex();
      // If q is an embedding (array of numbers), search directly.
      // If q is a string, we currently don't have a local text-to-vector model (CLIP),
      // so we fall back to a simple SQL LIKE search on filename/description.
      if (Array.isArray(q)) {
        const results = index.search(q, limit);
        const imageIds = [...new Set(results.map(r => JSON.parse(r.url).image_id))];
        if (imageIds.length === 0) return [];
        const sql = `SELECT * FROM images WHERE id IN (${imageIds.join(',')})`;
        return _cache(await query(sql));
      } else {
        const sql = `SELECT * FROM images WHERE filename LIKE ? OR description LIKE ? LIMIT ?`;
        const pattern = `%${q}%`;
        return _cache(await query(sql, [pattern, pattern, limit]));
      }
    } catch (err) {
      console.error('[LocalAdapter] Search error:', err);
      return [];
    }
  },

  async settings() {
    const rows = await query('SELECT key, value FROM settings WHERE key LIKE "pref_%"');
    const prefs = {};
    for (const row of rows) {
      prefs[row.key.replace('pref_', '')] = row.value;
    }
    
    return {
      ui: { 
        language: prefs.language || localStorage.getItem('pwa_language') || 'en' 
      },
      face_recognition: { 
        insightface: { 
          det_model: prefs.det_model || 'auto',
          recognition_threshold: parseFloat(prefs.rec_threshold || '0.4'),
          detection_threshold: parseFloat(prefs.det_threshold || '0.5'),
          det_size: parseInt(prefs.det_size || '640')
        } 
      },
      processing: { backend: 'local' },
      vlm: { 
        enabled: prefs.vlm_enabled === 'true',
        provider: prefs.vlm_provider || 'anthropic',
        model: prefs.vlm_model || ''
      },
    };
  },

  async saveSettings(body) {
    const mapping = {
      'language': body.language,
      'det_model': body.det_model,
      'rec_threshold': body.rec_threshold,
      'det_threshold': body.det_threshold,
      'det_size': body.det_size,
      'vlm_enabled': body.vlm_enabled ? 'true' : 'false',
      'vlm_provider': body.vlm_provider,
      'vlm_model': body.vlm_model
    };
    
    for (const [key, value] of Object.entries(mapping)) {
      if (value !== undefined) {
        await run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [`pref_${key}`, String(value)]);
      }
    }
    return { ok: true };
  },

  getProviders() {
    return VLM_PROVIDERS;
  },

  async getVlmModels(provider) {
    console.log(`[LocalAdapter] getVlmModels for ${provider}`);
    const { vlmClientWeb } = await import('./VlmWeb.js');
    const keys = await this.getVlmKeys();
    vlmClientWeb.setKeys(keys);
    
    let models = [];
    try {
      const liveModels = await vlmClientWeb.fetchModels(provider);
      if (liveModels && liveModels.length > 0) {
        console.log(`[LocalAdapter] Live models found: ${liveModels.length}`);
        models = liveModels;
      }
    } catch (err) {
      console.warn(`[LocalAdapter] Live fetch failed for ${provider}:`, err);
    }

    // Merge with hardcoded defaults if empty or to ensure variety
    const defaults = VLM_MODELS[provider] || [];
    if (models.length === 0) {
      models = defaults;
    } else {
      // Add defaults that aren't in the live list
      for (const d of defaults) {
        if (!models.includes(d)) models.push(d);
      }
    }
    
    console.log(`[LocalAdapter] Returning ${models.length} models`);
    return models;
  },

  async getKeyStatus() {
    const rows = await query('SELECT key FROM settings WHERE key LIKE "vlm_key_%"');
    const status = {};
    for (const row of rows) {
      const provider = row.key.replace('vlm_key_', '');
      status[provider] = { has_user_key: true, has_system_key: false };
    }
    return status;
  },

  async saveApiKey(provider, value) {
    await run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [`vlm_key_${provider}`, value]);
    return { ok: true };
  },

  async deleteApiKey(provider) {
    await run('DELETE FROM settings WHERE key = ?', [`vlm_key_${provider}`]);
    return { ok: true };
  },

  async testApiKey(provider) {
    const { vlmClientWeb } = await import('./VlmWeb.js');
    const keys = await this.getVlmKeys();
    const key = keys[provider];
    if (!key) throw new Error(`No key found for ${provider}`);
    
    return vlmClientWeb.testKey(provider, key);
  },

  async getVlmKeys() {
    const rows = await query('SELECT key, value FROM settings WHERE key LIKE "vlm_key_%"');
    const keys = {};
    for (const row of rows) {
      keys[row.key.replace('vlm_key_', '')] = row.value;
    }
    return keys;
  },

  async listUsers() {
    return query('SELECT * FROM users ORDER BY username');
  },

  async createUser(username, password, role) {
    // Note: standalone mode doesn't implement secure password hashing yet,
    // it just stores the data so the UI functions.
    await run('INSERT INTO users (username, role) VALUES (?, ?)', [username, role]);
    return { ok: true };
  },

  async updateUser(userId, changes) {
    const fields = [];
    const params = [];
    for (const [k, v] of Object.entries(changes)) {
      fields.push(`${k} = ?`);
      params.push(v);
    }
    if (fields.length === 0) return { ok: true };
    params.push(userId);
    await run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, params);
    return { ok: true };
  },

  async deleteUser(userId) {
    await run('DELETE FROM users WHERE id = ?', [userId]);
    return { ok: true };
  },

  async dbStatus() {
    const [img] = await query('SELECT COUNT(*) AS n FROM images');
    const [ppl] = await query('SELECT COUNT(*) AS n FROM people');
    const [usr] = await query('SELECT COUNT(*) AS n FROM users');
    return {
      db_path: 'Browser IndexedDB (WASM SQLite)',
      file_size_mb: 'N/A',
      permissions_ok: true,
      image_count: img?.n ?? 0,
      user_count: usr?.n ?? 0
    };
  },

  i18n() {
    return { language: localStorage.getItem('pwa_language') || 'en', translations: {} };
  },

  // ── Images ─────────────────────────────────────────────────────────────────

  async getImages({ person='', tag='', scene='', folder='', path='',
                    dateFrom='', dateTo='', sort='newest',
                    limit=200, offset=0, unidentified=false, album=0 } = {}) {
    console.log('[LocalAdapter] getImages', { person, tag, scene, folder, path, dateFrom, dateTo, sort, limit, offset, unidentified, album });
    let sql    = 'SELECT * FROM images WHERE 1=1';
    const params = [];

    if (person) {
      sql += ` AND id IN (
        SELECT DISTINCT f.image_id FROM faces f
        JOIN face_embeddings fe ON fe.face_id=f.id
        JOIN people p           ON fe.person_id=p.id
        WHERE p.name LIKE ?)`;
      params.push(`%${person}%`);
    }
    if (tag) {
      sql += ` AND id IN (SELECT image_id FROM image_tags WHERE tag LIKE ?)`;
      params.push(`%${tag}%`);
    }
    if (scene) {
      sql += ` AND scene_type LIKE ?`;
      params.push(`%${scene}%`);
    }
    if (folder || path) {
      sql += ` AND filepath LIKE ?`;
      params.push(`%${folder || path}%`);
    }
    if (dateFrom) {
      sql += ` AND date_taken >= ?`;
      params.push(dateFrom);
    }
    if (dateTo) {
      sql += ` AND date_taken <= ?`;
      params.push(dateTo);
    }
    if (unidentified) {
      sql += ` AND id IN (
        SELECT DISTINCT f.image_id FROM faces f
        LEFT JOIN face_embeddings fe ON fe.face_id=f.id
        WHERE fe.person_id IS NULL)`;
    }
    if (album) {
      sql += ` AND id IN (SELECT image_id FROM image_albums WHERE album_id=?)`;
      params.push(album);
    }

    const orderMap = {
      newest:          'id DESC',
      oldest:          'id ASC',
      date_taken_desc: 'date_taken DESC, id DESC',
      date_taken_asc:  'date_taken ASC,  id ASC',
      filename_az:     'filename ASC',
      most_faces:      'id DESC',    // approximate — no face count per image in this query
    };
    sql += ` ORDER BY ${orderMap[sort] ?? 'id DESC'} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    try {
      const results = await query(sql, params);
      console.log(`[LocalAdapter] SQL: ${sql} | Params: ${JSON.stringify(params)} | Results: ${results.length}`);
      return _cache(results);
    } catch (err) {
      console.error('[LocalAdapter] getImages error:', err);
      throw err;
    }
  },

  async getImage(id) {
    const rows = await query('SELECT * FROM images WHERE id=?', [id]);
    if (rows[0]) _cache([rows[0]]);
    return rows[0] ?? null;
  },

  async deleteImage(id) {
    await run('DELETE FROM images WHERE id=?', [id]);
    fileCache.delete(id);
    return { ok: true };
  },

  async getImageFaces(id) {
    return query(`
      SELECT f.id, f.image_id,
             f.bbox_x1, f.bbox_y1, f.bbox_x2, f.bbox_y2,
             f.detection_confidence,
             fe.person_id, fe.embedding_dimension,
             p.name AS person_name
      FROM faces f
      LEFT JOIN face_embeddings fe ON fe.face_id=f.id
      LEFT JOIN people p           ON fe.person_id=p.id
      WHERE f.image_id=?
    `, [id]);
  },

  async patchMetadata(id, { description='', scene_type='', tags_csv='' }) {
    await run(`UPDATE images SET description=?, scene_type=? WHERE id=?`,
              [description || null, scene_type || null, id]);
    // Replace tags
    await run('DELETE FROM image_tags WHERE image_id=?', [id]);
    for (const tag of (tags_csv || '').split(',').map(t => t.trim()).filter(Boolean))
      await run('INSERT OR IGNORE INTO image_tags(image_id, tag) VALUES(?,?)', [id, tag]);
    return { ok: true };
  },

  // ── People ─────────────────────────────────────────────────────────────────

  async getPeople() {
    return query(`
      SELECT p.*,
             COUNT(DISTINCT fe.face_id) AS face_count
      FROM people p
      LEFT JOIN face_embeddings fe ON fe.person_id=p.id
      GROUP BY p.id
      ORDER BY p.total_appearances DESC, p.name ASC
    `);
  },

  async getPerson(id) {
    const rows = await query('SELECT * FROM people WHERE id=?', [id]);
    if (!rows[0]) return null;
    const images = await query(`
      SELECT DISTINCT i.id, i.filename, i.filepath
      FROM images i
      JOIN faces f            ON f.image_id=i.id
      JOIN face_embeddings fe ON fe.face_id=f.id
      WHERE fe.person_id=? LIMIT 50
    `, [id]);
    _cache(images);
    return { ...rows[0], images };
  },

  async renamePerson(id, name) {
    await run('UPDATE people SET name=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
              [name.trim(), id]);
    _voyIndex = null; // Invalidate index
    return { ok: true };
  },

  async deletePerson(id) {
    await run('UPDATE face_embeddings SET person_id=NULL WHERE person_id=?', [id]);
    await run('DELETE FROM people WHERE id=?', [id]);
    _voyIndex = null; // Invalidate index
    return { ok: true };
  },

  async mergePeople(source_id, target_id) {
    await run('UPDATE face_embeddings SET person_id=? WHERE person_id=?', [target_id, source_id]);
    await run('DELETE FROM people WHERE id=?', [source_id]);
    const cnt = (await query('SELECT COUNT(*) AS n FROM face_embeddings WHERE person_id=?',
                             [target_id]))[0]?.n ?? 0;
    await run('UPDATE people SET total_appearances=? WHERE id=?', [cnt, target_id]);
    _voyIndex = null; // Invalidate index
    return { ok: true };
  },

  async reassignFace(face_id, new_name) {
    const name = new_name.trim();
    await run('INSERT OR IGNORE INTO people(name) VALUES(?)', [name]);
    const person = (await query('SELECT id FROM people WHERE name=?', [name]))[0];
    await run('UPDATE face_embeddings SET person_id=? WHERE face_id=?', [person.id, face_id]);
    const cnt = (await query('SELECT COUNT(*) AS n FROM face_embeddings WHERE person_id=?',
                             [person.id]))[0]?.n ?? 0;
    await run('UPDATE people SET total_appearances=? WHERE id=?', [cnt, person.id]);
    _voyIndex = null; // Invalidate index
    return { ok: true, person_id: person.id };
  },

  // ── Tags / stats ────────────────────────────────────────────────────────────

  async getTags() {
    return query(`
      SELECT tag AS name, COUNT(*) AS count
      FROM image_tags
      GROUP BY tag
      ORDER BY count DESC
    `);
  },

  async getStats() {
    const [img]  = await query('SELECT COUNT(*) AS n FROM images');
    const [ppl]  = await query('SELECT COUNT(*) AS n FROM people');
    const [face] = await query('SELECT COUNT(*) AS n FROM faces');
    return {
      total_images: img?.n  ?? 0,
      total_people: ppl?.n  ?? 0,
      total_faces:  face?.n ?? 0,
    };
  },

  // ── Import processed (output of FaceEngineWeb) ──────────────────────────────
  // Called by ProcessView after local ONNX inference completes.
  // In local mode this writes directly to SQLite instead of POSTing to server.

  async importProcessed({ filepath, filename, width, height, date_taken,
                          faces = [], description, scene_type, tags = [],
                          embedding_dim = 512 }) {
    const fname = filename || filepath.split('/').pop();

    // Upsert image record
    await run(`INSERT OR IGNORE INTO images
               (filename, filepath, width, height, date_taken, description, scene_type)
               VALUES(?,?,?,?,?,?,?)`,
              [fname, filepath, width ?? null, height ?? null,
               date_taken ?? null, description ?? null, scene_type ?? null]);
    const imgRows = await query('SELECT id FROM images WHERE filepath=?', [filepath]);
    const imageId = imgRows[0]?.id;
    if (!imageId) throw new Error('Failed to insert image record');
    fileCache.set(imageId, filepath);

    // Tags
    for (const tag of tags)
      await run('INSERT OR IGNORE INTO image_tags(image_id, tag) VALUES(?,?)', [imageId, tag]);

    // Faces + embeddings
    let faceCount = 0;
    for (const face of faces) {
      const bbox = face.bbox ?? [0, 0, 1, 1];
      const faceRes = await run(
        `INSERT INTO faces(image_id, bbox_x1, bbox_y1, bbox_x2, bbox_y2, detection_confidence)
         VALUES(?,?,?,?,?,?)`,
        [imageId, bbox[0], bbox[1], bbox[2], bbox[3], face.score ?? null],
      );
      const faceId = faceRes.changes?.lastId;
      if (faceId && face.embedding) {
        const f32 = face.embedding instanceof Float32Array
          ? face.embedding
          : new Float32Array(face.embedding);
        
        // Match against known people using Voy (WASM HNSW)
        const match = await _voyBestMatch(f32, 0.4);
        
        // Store as comma-separated string (SQLite BLOB via @capacitor-community/sqlite)
        const embStr = Array.from(f32).join(',');
        await run(
          `INSERT OR REPLACE INTO face_embeddings
           (face_id, person_id, embedding_vector, embedding_dimension) VALUES(?,?,?,?)`,
          [faceId, match?.person_id ?? null, embStr, f32.length],
        );
        if (match) {
          // Increment total_appearances for matched person
          await run('UPDATE people SET total_appearances=total_appearances+1 WHERE id=?',
                    [match.person_id]);
        }
        faceCount++;
      }
    }

    _voyIndex = null; // Invalidate index after adding new embeddings
    return { ok: true, image_id: imageId, face_count: faceCount };
  },
};
