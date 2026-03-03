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

// ── Person-matching helpers ───────────────────────────────────────────────────

/** Load all person embeddings from SQLite as { person_id, name, vec: Float32Array }[]. */
async function _loadPersonEmbeddings() {
  const rows = await query(`
    SELECT fe.person_id, p.name,
           fe.embedding_vector
    FROM face_embeddings fe
    JOIN people p ON p.id = fe.person_id
    WHERE fe.person_id IS NOT NULL
      AND fe.embedding_vector IS NOT NULL
  `);
  return rows.map(r => ({
    person_id: r.person_id,
    name: r.name,
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

function _cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
}

/** Return the best-matching person above threshold, or null. */
function _cosineBestMatch(embedding, knownPeople, threshold = 0.4) {
  let best = null, bestSim = threshold;
  for (const p of knownPeople) {
    if (p.vec.length !== embedding.length) continue;
    const sim = _cosine(embedding, p.vec);
    if (sim > bestSim) { best = p; bestSim = sim; }
  }
  return best;
}

// ── Health / Auth (mocked — local mode has no server session) ─────────────────

export const localAdapter = {

  health() {
    return { ok: true, version: 'local', backend: 'capacitor-sqlite', model_ready: true };
  },

  me() {
    return { username: 'local', role: 'admin' };
  },

  settings() {
    return {
      ui:               { language: localStorage.getItem('lang') || 'en' },
      face_recognition: { insightface: { det_model: 'auto', recognition_threshold: 0.4 } },
      processing:       { backend: 'local' },
    };
  },

  i18n() {
    return { language: localStorage.getItem('lang') || 'en', translations: {} };
  },

  // ── Images ─────────────────────────────────────────────────────────────────

  async getImages({ person='', tag='', scene='', folder='', path='',
                    dateFrom='', dateTo='', sort='newest',
                    limit=200, offset=0, unidentified=false, album=0 } = {}) {
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

    return _cache(await query(sql, params));
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
    return { ok: true };
  },

  async deletePerson(id) {
    await run('UPDATE face_embeddings SET person_id=NULL WHERE person_id=?', [id]);
    await run('DELETE FROM people WHERE id=?', [id]);
    return { ok: true };
  },

  async mergePeople(source_id, target_id) {
    await run('UPDATE face_embeddings SET person_id=? WHERE person_id=?', [target_id, source_id]);
    await run('DELETE FROM people WHERE id=?', [source_id]);
    const cnt = (await query('SELECT COUNT(*) AS n FROM face_embeddings WHERE person_id=?',
                             [target_id]))[0]?.n ?? 0;
    await run('UPDATE people SET total_appearances=? WHERE id=?', [cnt, target_id]);
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

    // Load all known person embeddings once for matching this image's faces
    const knownPeople = await _loadPersonEmbeddings();

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
        // Match against known people (cosine similarity)
        const match = _cosineBestMatch(f32, knownPeople, 0.4);
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

    return { ok: true, image_id: imageId, face_count: faceCount };
  },
};
