/**
 * LocalAdapter.js — implements the same interface as api.js remote calls
 * but reads/writes directly from @capacitor-community/sqlite on-device.
 *
 * Used when db_mode='local' (standalone Capacitor, no server required).
 * All three paths — local, v4 server, v2 FastAPI — share the same Svelte UI;
 * only api.js routes differently based on db_mode.
 */

import { Capacitor } from '@capacitor/core';
import { query, run, exportDatabase, importDatabase, getDatabaseSize, clearDatabase, hardResetApp } from './LocalDB.js';
import { VLM_PROVIDERS, VLM_MODELS } from './VlmData.js';

// ── Voy-search helper (WASM HNSW) ─────────────────────────────────────────────

let _voyIndex = null;

async function _getVoyIndex(forceRebuild = false) {
  if (_voyIndex && !forceRebuild) return _voyIndex;

  const mod = await import('voy-search');
  console.log('[LocalAdapter] Voy module loaded:', Object.keys(mod));

  // wasm-pack packages require explicit WASM initialization before any class can be used.
  // The default export is the async init() function; it must be awaited before new Voy().
  // Always attempt WASM init — safe to call multiple times (idempotent after first call).
  // Do NOT guard with `initFn !== mod.Voy`: in some bundler configs the guard fires
  // incorrectly and skips init, leaving voy_new undefined → "t.voy_new is not a function".
  const initFn = mod.default;
  if (typeof initFn === 'function') {
    try {
      await initFn();
      console.log('[LocalAdapter] Voy WASM initialized');
    } catch (e) {
      // Ignore "already initialized" errors on subsequent calls
      if (!String(e).includes('already')) console.warn('[LocalAdapter] Voy WASM init warning:', e);
    }
  }

  // In minified/Vercel build, the export might be directly on the module or under 'default'
  let Voy = mod.Voy || mod.default?.Voy || mod.default;

  // Some versions/bundlers wrap it another level
  if (typeof Voy !== 'function' && Voy?.Voy) Voy = Voy.Voy;

  if (typeof Voy !== 'function') {
    console.error('[LocalAdapter] Voy is not a constructor:', Voy);
    throw new Error('Voy search engine failed to load (module resolution error)');
  }

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

/** Brute-force cosine fallback — works in all browsers, no WASM required. */
async function _bruteForceMatch(embedding, threshold = 0.4) {
  const items = await _loadAllEmbeddings();
  if (items.length === 0) return null;
  let best = null, bestSim = -1;
  for (const item of items) {
    const sim = _cosine(embedding, item.vec);
    if (sim > bestSim) { bestSim = sim; best = item; }
  }
  return (best && bestSim >= threshold)
    ? { person_id: best.person_id, name: best.person_name }
    : null;
}

function _cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}

/** Return the best-matching person above threshold using Voy (HNSW), with brute-force fallback. */
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
    return null;
  } catch (err) {
    console.warn('[LocalAdapter] Voy search unavailable, using brute-force:', err.message);
    return _bruteForceMatch(embedding, threshold);
  }
}

// ── Filepath cache — lets thumbnailUrl() stay synchronous ─────────────────────
// Populated whenever getImages / getImage / getPerson returns records.
export const fileCache = new Map(); // image_id → filepath
export const thumbCache = new Map(); // image_id → base64 jpeg string

function uint8ToBase64(u8) {
  let b = '';
  for (let i = 0; i < u8.length; i++) b += String.fromCharCode(u8[i]);
  return btoa(b);
}

function _cache(images) {
  for (const img of images) {
    if (img?.id && img?.filepath) fileCache.set(String(img.id), img.filepath);
    if (img?.id && img?.thumbnail_blob) {
      let b64 = img.thumbnail_blob;
      if (b64 instanceof Uint8Array) {
        console.log(`[LocalAdapter] Converting binary thumb for image ${img.id}`);
        b64 = uint8ToBase64(b64);
      }
      thumbCache.set(String(img.id), b64);
    }
  }
  return images;
}

/** Convert a native filesystem path to a URL WKWebView can load. */
export function toWebUrl(filepath) {
  if (!filepath) return '';
  // In pure standalone web mode, native file paths cannot be loaded directly.
  // We rely on the thumbnail_blob data URL fallback in api.js.
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

  async getFaceCrop(imageId, faceId, size = 128) {
    console.log(`[LocalAdapter] getFaceCrop imageId=${imageId} faceId=${faceId} size=${size}`);
    try {
      // 1. Get face coordinates
      const rows = await query('SELECT bbox_x1, bbox_y1, bbox_x2, bbox_y2 FROM faces WHERE id = ?', [faceId]);
      if (rows.length === 0) throw new Error('Face not found');
      const { bbox_x1, bbox_y1, bbox_x2, bbox_y2 } = rows[0];

      // 2. Get image source
      const imgRows = await query('SELECT filepath, thumbnail_blob FROM images WHERE id = ?', [imageId]);
      if (imgRows.length === 0) throw new Error('Image not found');
      const { filepath, thumbnail_blob } = imgRows[0];

      // 3. Load image into memory
      let imgSource = '';
      if (thumbnail_blob) {
        imgSource = thumbnail_blob.startsWith('data:') ? thumbnail_blob : `data:image/jpeg;base64,${thumbnail_blob}`;
      } else {
        imgSource = toWebUrl(filepath);
      }

      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = imgSource;
      });

      // 4. Crop using Canvas
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext('2d');
      
      const x = bbox_x1 * img.width;
      const y = bbox_y1 * img.height;
      const w = (bbox_x2 - bbox_x1) * img.width;
      const h = (bbox_y2 - bbox_y1) * img.height;

      ctx.drawImage(img, x, y, w, h, 0, 0, size, size);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
      return URL.createObjectURL(blob);
    } catch (err) {
      console.error('[LocalAdapter] getFaceCrop failed:', err);
      return '';
    }
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
    console.log('[LocalAdapter] settings() triggered — loading preferences from SQLite...');
    try {
      const rows = await query('SELECT key, value FROM settings WHERE key LIKE "pref_%"');
      console.log(`[LocalAdapter] Found ${rows.length} preference rows in SQLite:`, rows.map(r => r.key));
      
      const prefs = {};
      for (const row of rows) {
        prefs[row.key.replace('pref_', '')] = row.value;
      }
      
      const result = {
        ui: { 
          language: prefs.language || localStorage.getItem('pwa_language') || 'en' 
        },
        face_recognition: { 
          insightface: { 
            det_model: prefs.det_model || 'auto',
            recognition_threshold: parseFloat(prefs.rec_threshold || '0.4'),
            detection_threshold: parseFloat(prefs.det_threshold || '0.5'),
            det_retries: parseInt(prefs.det_retries || '1'),
            det_size: parseInt(prefs.det_size || '640')
          } 
        },
        processing: { backend: 'local' },
        vlm: { 
          enabled: prefs.vlm_enabled === 'true' || prefs.vlm_enabled === true,
          provider: prefs.vlm_provider || 'anthropic',
          model: prefs.vlm_model || ''
        },
      };
      console.log('[LocalAdapter] settings() success — Returning object:', JSON.stringify(result));
      return result;
    } catch (err) {
      console.error('[LocalAdapter] settings() FAILED:', err);
      throw err;
    }
  },

  async saveSettings(body) {
    console.log('[LocalAdapter] saveSettings() start — Body:', JSON.stringify(body));
    const mapping = {
      'language': body.language,
      'det_model': body.det_model,
      'rec_threshold': body.rec_threshold,
      'det_threshold': body.det_threshold,
      'det_size': body.det_size,
      'vlm_enabled': body.vlm_enabled !== undefined ? (body.vlm_enabled ? 'true' : 'false') : undefined,
      'vlm_provider': body.vlm_provider,
      'vlm_model': body.vlm_model
    };
    
    console.log('[LocalAdapter] Mapped preferences for SQLite:', mapping);
    for (const [key, value] of Object.entries(mapping)) {
      if (value !== undefined) {
        console.log(`[LocalAdapter] Writing setting: pref_${key} = ${value}`);
        await run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [`pref_${key}`, String(value)]);
      }
    }
    console.log('[LocalAdapter] saveSettings() successfully finished');
    return { ok: true };
  },

  getProviders() {
    return VLM_PROVIDERS;
  },

  async getVlmModels(provider) {
    console.log(`[LocalAdapter] getVlmModels for ${provider}`);
    const vlmMod = await import('./VlmWeb.js');
    const vlmClientWeb = vlmMod.vlmClientWeb ?? vlmMod.default;
    if (!vlmClientWeb || typeof vlmClientWeb.setKeys !== 'function') throw new Error('VlmWeb module failed to provide vlmClientWeb');
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
    const vlmMod = await import('./VlmWeb.js');
    const vlmClientWeb = vlmMod.vlmClientWeb ?? vlmMod.default;
    if (!vlmClientWeb || typeof vlmClientWeb.testKey !== 'function') throw new Error('VlmWeb module failed to provide vlmClientWeb');
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

  async fetchUserVlmPrefs() {
    const s = await this.settings();
    return { 
      effective: { 
        vlm_enabled: s.vlm.enabled, 
        vlm_provider: s.vlm.provider, 
        vlm_model: s.vlm.model 
      }, 
      global: { 
        vlm_enabled: s.vlm.enabled, 
        vlm_provider: s.vlm.provider, 
        vlm_model: s.vlm.model 
      } 
    };
  },

  async fetchUserDetPrefs() {
    const s = await this.settings();
    return { 
      effective: { det_model: s.face_recognition.insightface.det_model }, 
      global: { det_model: s.face_recognition.insightface.det_model } 
    };
  },

  async saveUserVlmPrefs(prefs) {
    return this.saveSettings({
      vlm_enabled: prefs.vlm_enabled,
      vlm_provider: prefs.vlm_provider,
      vlm_model: prefs.vlm_model
    });
  },

  async saveUserDetPrefs(prefs) {
    return this.saveSettings({
      det_model: prefs.det_model
    });
  },

  async getAlbums() {
    return query('SELECT * FROM albums ORDER BY name');
  },

  async dbStatus() {
    const [img] = await query('SELECT COUNT(*) AS n FROM images');
    const [ppl] = await query('SELECT COUNT(*) AS n FROM people');
    const [usr] = await query('SELECT COUNT(*) AS n FROM users');
    const sizeMb = await getDatabaseSize();
    return {
      db_path: 'Browser IndexedDB (WASM SQLite)',
      file_size_mb: sizeMb ?? 'N/A',
      permissions_ok: true,
      image_count: img?.n ?? 0,
      user_count: usr?.n ?? 0,
      can_export: true,
      can_import: true,
    };
  },

  async exportDB() {
    return await exportDatabase();
  },

  async importDB(json) {
    return await importDatabase(json);
  },

  async clearDB() {
    return await clearDatabase();
  },

  async hardResetApp() {
    return await hardResetApp();
  },

  i18n() {
    return { language: localStorage.getItem('pwa_language') || 'en', translations: {} };
  },

  // ── Images ─────────────────────────────────────────────────────────────────

  async getImages({ person='', tag='', scene='', folder='', path='',
                    dateFrom='', dateTo='', sort='newest',
                    limit=200, offset=0, unidentified=false, album=0 } = {}) {
    console.log('[LocalAdapter] getImages', { person, tag, scene, folder, path, dateFrom, dateTo, sort, limit, offset, unidentified, album });
    
    // We'll build a query that joins tags and people for each image
    let where = 'WHERE 1=1';
    const params = [];

    if (person) {
      where += ` AND i.id IN (
        SELECT DISTINCT f.image_id FROM faces f
        JOIN face_embeddings fe ON fe.face_id=f.id
        JOIN people p           ON fe.person_id=p.id
        WHERE p.name LIKE ?)`;
      params.push(`%${person}%`);
    }
    if (tag) {
      where += ` AND i.id IN (SELECT image_id FROM image_tags WHERE tag LIKE ?)`;
      params.push(`%${tag}%`);
    }
    if (scene) {
      where += ` AND i.scene_type LIKE ?`;
      params.push(`%${scene}%`);
    }
    if (folder || path) {
      where += ` AND (i.filepath LIKE ? OR i.filename LIKE ?)`;
      const p = `%${folder || path}%`;
      params.push(p, p);
    }
    if (dateFrom) {
      where += ` AND i.date_taken >= ?`;
      params.push(dateFrom);
    }
    if (dateTo) {
      where += ` AND i.date_taken <= ?`;
      params.push(dateTo);
    }
    if (unidentified) {
      where += ` AND i.id IN (
        SELECT DISTINCT f.image_id FROM faces f
        LEFT JOIN face_embeddings fe ON fe.face_id=f.id
        WHERE fe.person_id IS NULL)`;
    }
    if (album) {
      where += ` AND i.id IN (SELECT image_id FROM image_albums WHERE album_id=?)`;
      params.push(album);
    }

    const orderMap = {
      newest:          'i.id DESC',
      oldest:          'i.id ASC',
      date_taken_desc: 'i.date_taken DESC, i.id DESC',
      date_taken_asc:  'i.date_taken ASC,  i.id ASC',
      filename_az:     'i.filename ASC',
      most_faces:      'i.id DESC',
    };
    const orderBy = orderMap[sort] ?? 'i.id DESC';

    // Exclude thumbnail_blob — it's large base64 data loaded via fetchThumbnail() on demand.
    // Loading it here for every gallery page would bloat WASM SQLite memory significantly.
    const sql = `
      SELECT i.id, i.filename, i.filepath, i.local_path, i.width, i.height,
             i.date_taken, i.date_processed, i.description, i.scene_type, i.visibility,
             (SELECT GROUP_CONCAT(tag) FROM image_tags WHERE image_id = i.id) as ai_tags_csv,
             (SELECT GROUP_CONCAT(DISTINCT p.name) FROM faces f
              JOIN face_embeddings fe ON fe.face_id = f.id
              JOIN people p ON p.id = fe.person_id
              WHERE f.image_id = i.id) as people_names
      FROM images i
      ${where}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);

    try {
      const rows = await query(sql, params);
      console.log(`[LocalAdapter] getImages results: ${rows.length}`);
      
      // Map to UI-compatible objects
      const images = rows.map(r => ({
        ...r,
        ai_description: r.description, // map description -> ai_description
        ai_scene_type:  r.scene_type,  // map scene_type -> ai_scene_type
        ai_tags_list:   r.ai_tags_csv ? r.ai_tags_csv.split(',') : [],
        origin_path:    r.local_path || r.filepath,
        server_path:    r.filepath
      }));

      return _cache(images);
    } catch (err) {
      console.error('[LocalAdapter] getImages error:', err);
      throw err;
    }
  },

  async getImage(id) {
    const sql = `
      SELECT i.id, i.filename, i.filepath, i.local_path, i.width, i.height,
             i.date_taken, i.date_processed, i.description, i.scene_type, i.visibility,
             (SELECT GROUP_CONCAT(tag) FROM image_tags WHERE image_id = i.id) as ai_tags_csv,
             (SELECT GROUP_CONCAT(DISTINCT p.name) FROM faces f
              JOIN face_embeddings fe ON fe.face_id = f.id
              JOIN people p ON p.id = fe.person_id
              WHERE f.image_id = i.id) as people_names
      FROM images i
      WHERE i.id = ?
    `;
    const rows = await query(sql, [id]);
    if (rows[0]) {
      const r = rows[0];
      const img = {
        ...r,
        ai_description: r.description,
        ai_scene_type:  r.scene_type,
        ai_tags_list:   r.ai_tags_csv ? r.ai_tags_csv.split(',') : [],
        origin_path:    r.local_path || r.filepath,
        server_path:    r.filepath
      };
      _cache([img]);
      return img;
    }
    return null;
  },

  async fetchThumbnail(id) {
    const sid = String(id);
    if (thumbCache.has(sid)) return thumbCache.get(sid);
    const rows = await query('SELECT thumbnail_blob FROM images WHERE id=?', [id]);
    let b64 = rows[0]?.thumbnail_blob;
    if (b64 instanceof Uint8Array) b64 = uint8ToBase64(b64);
    if (b64) thumbCache.set(sid, b64);
    return b64;
  },

  async deleteImage(id) {
    await run('DELETE FROM images WHERE id=?', [id]);
    fileCache.delete(id);
    return { ok: true };
  },

  async deleteFace(imageId, faceId) {
    await run('DELETE FROM faces WHERE id=? AND image_id=?', [faceId, imageId]);
    return { ok: true };
  },

  async clearIdentifications(imageId) {
    await run(`
      UPDATE face_embeddings SET person_id = NULL 
      WHERE face_id IN (SELECT id FROM faces WHERE image_id = ?)
    `, [imageId]);
    _voyIndex = null;
    return { ok: true };
  },

  async clearDetections(imageId) {
    await run('DELETE FROM faces WHERE image_id = ?', [imageId]);
    _voyIndex = null;
    return { ok: true };
  },

  async reDetectFaces(imageId, params = {}) {
    console.log(`[LocalAdapter] reDetectFaces start | imageId=${imageId}`, params);
    try {
      // 1. Get the image record
      const rows = await query('SELECT * FROM images WHERE id = ?', [imageId]);
      if (rows.length === 0) throw new Error(`Image ${imageId} not found in LocalDB`);
      const imgRow = rows[0];
      console.log(`[LocalAdapter] Image record found: ${imgRow.filename} | filepath=${imgRow.filepath} | DB dims=${imgRow.width}x${imgRow.height}`);

      // 2. Get the engine and configure it
      const { faceEngineWeb } = await import('./FaceEngineWeb.js');
      
      // Ensure engine knows where to find models in this session
      const modelBase = (localStorage.getItem('remote_url') || window.location.origin) + '/models';
      console.log(`[LocalAdapter] Configuring engine modelBaseUrl: ${modelBase}`);
      faceEngineWeb.setModelBaseUrl(modelBase);
      
      // 3. Prepare the "file" (Try full filepath first, then thumbnail_blob)
      let fileObj = null;
      let sourceInfo = '';
      let effectiveMinFaceSize = params.min_face_size || 60;

      // Try fetching the full image from the server (if filepath looks like a URL or we are on the same origin)
      try {
        const fullUrl = toWebUrl(imgRow.filepath);
        console.log(`[LocalAdapter] Attempting to fetch full image from: ${fullUrl}`);
        const res = await fetch(fullUrl);
        if (res.ok) {
          const blob = await res.blob();
          fileObj = new File([blob], imgRow.filename || 'image.jpg', { type: blob.type || 'image/jpeg' });
          sourceInfo = 'Full File (Remote/Local URL)';
          console.log(`[LocalAdapter] Successfully loaded full image (${blob.size} bytes)`);
        } else {
          console.warn(`[LocalAdapter] Full image fetch failed (status ${res.status})`);
        }
      } catch (err) {
        console.warn(`[LocalAdapter] Full image fetch error: ${err.message}`);
      }

      // Fallback to thumbnail_blob if full file failed
      if (!fileObj && imgRow.thumbnail_blob) {
        console.log(`[LocalAdapter] Falling back to thumbnail_blob...`);
        const b64 = imgRow.thumbnail_blob.startsWith('data:') ? imgRow.thumbnail_blob : `data:image/jpeg;base64,${imgRow.thumbnail_blob}`;
        const res = await fetch(b64);
        const blob = await res.blob();
        fileObj = new File([blob], imgRow.filename || 'image.jpg', { type: 'image/jpeg' });
        sourceInfo = 'Thumbnail Blob';
        
        // CRITICAL: Scale down min_face_size if using a 200px thumbnail!
        // If original was e.g. 2000px and thumb is 200px, 60px in original is 6px in thumb.
        // If we don't know the original size or it's already reported as small, we use a conservative floor.
        const originalMax = Math.max(imgRow.width || 0, imgRow.height || 0);
        if (originalMax > 400) {
          const ratio = 200 / originalMax;
          effectiveMinFaceSize = Math.max(5, Math.round(effectiveMinFaceSize * ratio));
          console.log(`[LocalAdapter] Scaled min_face_size: ${params.min_face_size || 60} -> ${effectiveMinFaceSize} (ratio=${ratio.toFixed(3)})`);
        } else {
          effectiveMinFaceSize = Math.max(5, Math.min(effectiveMinFaceSize, 20));
          console.log(`[LocalAdapter] Small image detected, using conservative min_face_size: ${effectiveMinFaceSize}`);
        }
        
        console.log(`[LocalAdapter] Successfully loaded thumbnail blob (${blob.size} bytes)`);
      }

      if (!fileObj) {
        throw new Error('No image source available (full file and thumbnail both failed)');
      }

      // 4. Run the engine
      const settings = await this.settings();
      const { loadSyncSettings } = await import('./SyncManager.js');
      const syncCfg = loadSyncSettings();
      const thumb_size = syncCfg.thumbSize || 200;
      
      const det_retries = settings.face_recognition?.insightface?.det_retries ?? 1;
      let det_thresh = params.det_thresh || settings.face_recognition.insightface.detection_threshold;
      
      // If we are using a thumbnail, be significantly more lenient with threshold and min size
      if (sourceInfo === 'Thumbnail Blob') {
        det_thresh = Math.min(det_thresh, 0.3); // Lower threshold for thumbnails
        console.log(`[LocalAdapter] Using lenient det_thresh for thumbnail: ${det_thresh}`);
      }
      
      // VLM should run if explicitly requested in modal (!skip_vlm)
      // or if globally enabled AND not explicitly disabled.
      const vlm_enabled = params.skip_vlm === false || (settings.vlm.enabled && params.skip_vlm !== true);

      let vlm_keys = params.vlm_keys;
      if (vlm_enabled && !vlm_keys) {
        console.error('[LocalAdapter] VLM keys not passed to reDetectFaces, fetching from DB...');
        vlm_keys = await this.getVlmKeys();
      }

      console.error(`[LocalAdapter] Calling engine.processFile | source=${sourceInfo} | retries=${det_retries} | minFaceSize=${effectiveMinFaceSize} | thresh=${det_thresh} | vlm=${vlm_enabled} | provider=${settings.vlm.provider}`);
      const faceData = await faceEngineWeb.processFile(fileObj, {
        det_thresh:    det_thresh,
        min_face_size: effectiveMinFaceSize,
        det_model:     params.det_model || settings.face_recognition.insightface.det_model,
        max_retries:   det_retries,
        vlm_enabled:   vlm_enabled,
        vlm_provider:  settings.vlm.provider,
        vlm_model:     settings.vlm.model,
        vlm_prompt:    params.vlm_prompt,
        vlm_keys:      vlm_keys,
        thumb_size:    thumb_size,
      });

      console.error(`[LocalAdapter] Engine finished. Found ${faceData.faces?.length || 0} faces. VLM description present: ${!!faceData.description}. Updating DB...`);
      if (vlm_enabled && !faceData.description) {
        console.error('[LocalAdapter] CRITICAL: VLM was enabled but NO DESCRIPTION was returned in faceData!');
      }

      // 5. Update the database
      // First clear old detections if requested (standard server behavior)
      await this.clearDetections(imageId);

      // Re-import (this will update description/scene_type and add new faces)
      const result = await this.importProcessed({
        ...faceData,
        filepath: imgRow.filepath, // use existing filepath to match record
        filename: imgRow.filename
      });

      console.log(`[LocalAdapter] reDetectFaces COMPLETE for imageId=${imageId}`);
      return result;
    } catch (err) {
      console.error('[LocalAdapter] reDetectFaces CRITICAL FAILURE:', err);
      throw err;
    }
  },

  async getImageFaces(id) {
    console.log(`[LocalAdapter] getImageFaces for imageId=${id}`);
    let rows = [];
    try {
      rows = await query(`
        SELECT f.id, f.image_id,
               f.bbox_x1, f.bbox_y1, f.bbox_x2, f.bbox_y2,
               f.detection_confidence,
               fe.person_id, fe.embedding_dimension,
               p.name AS person_name,
               fe.verified
        FROM faces f
        LEFT JOIN face_embeddings fe ON fe.face_id=f.id
        LEFT JOIN people p           ON fe.person_id=p.id
        WHERE f.image_id=?
      `, [id]);
    } catch (err) {
      if (err.message?.includes('verified')) {
        console.warn('[LocalAdapter] verified column missing, falling back to legacy query');
        rows = await query(`
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
      } else {
        throw err;
      }
    }

    console.log(`[LocalAdapter] getImageFaces raw rows count: ${rows.length}`);

    // Map to the format the UI expects (matching server API)
    const mapped = rows.map(r => ({
      face_id: r.id,
      image_id: r.image_id,
      person_id: r.person_id,
      person_name: r.person_name,
      detection_confidence: r.detection_confidence,
      verified: !!r.verified,
      bbox: {
        left:   r.bbox_x1,
        top:    r.bbox_y1,
        right:  r.bbox_x2,
        bottom: r.bbox_y2
      }
    }));
    console.log('[LocalAdapter] getImageFaces mapped result sample:', mapped[0] || '(empty)');
    return mapped;
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
    const people = await query('SELECT id FROM people WHERE name=?', [name]);
    const person = people[0];
    if (!person) throw new Error('Failed to create or find person');
    
    await run('UPDATE face_embeddings SET person_id=? WHERE face_id=?', [person.id, face_id]);
    const countRows = await query('SELECT COUNT(*) AS n FROM face_embeddings WHERE person_id=?', [person.id]);
    const cnt = countRows[0]?.n ?? 0;
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
                          thumbnail_b64, embedding_dim = 512 }) {
    const fname = filename || filepath.split('/').pop();

    console.log(`[LocalAdapter] importProcessed: saving image ${fname} | filepath=${filepath} | dims=${width}x${height}`);
    console.log(`[LocalAdapter] VLM results:`, { description: description?.slice(0, 50) + '...', scene_type, tagsCount: tags?.length });

    // Upsert image record
    await run(`INSERT OR IGNORE INTO images
               (filename, filepath, width, height, date_taken, description, scene_type, thumbnail_blob)
               VALUES(?,?,?,?,?,?,?,?)`,
              [fname, filepath, width ?? null, height ?? null,
               date_taken ?? null, description ?? null, scene_type ?? null, thumbnail_b64 || null]);
    
    // Favor new VLM results if provided
    await run(`UPDATE images SET 
               description = COALESCE(?, description), 
               scene_type = COALESCE(?, scene_type),
               thumbnail_blob = COALESCE(?, thumbnail_blob)
               WHERE filepath = ?`,
              [description ?? null, scene_type ?? null, thumbnail_b64 || null, filepath]);

    const imgRows = await query('SELECT id FROM images WHERE filepath=?', [filepath]);
    const imageId = imgRows[0]?.id;
    if (!imageId) throw new Error(`Failed to insert image record for ${filepath}`);
    fileCache.set(imageId, filepath);
    if (thumbnail_b64) thumbCache.set(imageId, thumbnail_b64);

    // Tags
    if (tags && tags.length > 0) {
      console.log(`[LocalAdapter] Saving ${tags.length} tags for image ${imageId}`);
      for (const tag of tags)
        await run('INSERT OR IGNORE INTO image_tags(image_id, tag) VALUES(?,?)', [imageId, tag]);
    }

    // Faces + embeddings
    console.log(`[LocalAdapter] importProcessed: processing ${faces.length} faces for image ${imageId}`);
    let faceCount = 0;
    const people = [];
    for (const face of faces) {
      const x1 = face.bbox_left ?? 0;
      const y1 = face.bbox_top ?? 0;
      const x2 = face.bbox_right ?? 1;
      const y2 = face.bbox_bottom ?? 1;

      const faceRes = await run(
        `INSERT INTO faces(image_id, bbox_x1, bbox_y1, bbox_x2, bbox_y2, detection_confidence)
         VALUES(?,?,?,?,?,?)`,
        [imageId, x1, y1, x2, y2, face.detection_confidence ?? face.score ?? null],
      );
      
      const faceId = faceRes.lastInsertRowid || faceRes.changes?.lastId;
      
      if (faceId && face.embedding) {
        const f32 = face.embedding instanceof Float32Array
          ? face.embedding
          : new Float32Array(face.embedding);
        
        // Match against known people using Voy (WASM HNSW)
        const match = await _voyBestMatch(f32, 0.4);
        if (match) {
          console.log(`[LocalAdapter]     Face matched: ${match.name} (id=${match.person_id})`);
          people.push(match.name);
        }
        
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
    console.log(`[LocalAdapter] importProcessed DONE for image ${imageId}`);
    return { 
      ok: true, 
      image_id: imageId, 
      face_count: faceCount, 
      people,
      description: description || null,
      scene_type:  scene_type || null,
      tags: tags || []
    };
  },
};
