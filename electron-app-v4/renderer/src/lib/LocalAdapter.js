/* LOCAL_ADAPTER_VERSION: v4.0.260308.2450 */
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

let _voyIndex       = null;   // built Voy index (null = not yet built or invalidated)
let _voyFailed      = false;  // true after a permanent init failure — skip WASM, use brute-force
let _voyInitPromise = null;   // in-flight init (prevents concurrent duplicate inits)

// Embedding cache: refreshed whenever the Voy index is (re)built.
// Shared by both Voy and brute-force so the DB is only queried once per batch.
let _embCache      = null;    // Array<EmbeddingRow> | null

async function _ensureVoyWasm(mod) {
  // voy-search v0.6.3 is a wasm-bindgen "bundler" target.
  // Vite's `assetsInclude: ['**/*.wasm']` rewrites its static WASM import to a URL
  // namespace `{ default: "…wasm" }`, so __wbg_set_wasm() receives a URL object
  // and wasm.voy_new is undefined.
  //
  // Fix: probe, then manually fetch+instantiate the binary.
  //
  // CRITICAL: WebAssembly.instantiate(compiledModule, imports) returns a
  // WebAssembly.Instance *directly* (not {instance, module}).
  // WebAssembly.instantiate(buffer, imports) returns {instance, module}.
  // Always pass the raw buffer to get the destructurable form.

  const Voy = mod.Voy;
  if (typeof Voy !== 'function') throw new Error('Voy class not found in module');

  let wasmOk = false;
  try {
    new Voy({ embeddings: [] }); // probe — calls wasm.voy_new internally
    wasmOk = true;
  } catch (e) {
    if (!String(e).includes('voy_new') && !String(e).includes('exports')) throw e;
  }
  if (wasmOk) return Voy;

  if (typeof mod.__wbg_set_wasm !== 'function')
    throw new Error('Voy __wbg_set_wasm not found — incompatible package version');

  const wasmCandidates = [
    new URL('/assets/voy_search_bg.wasm', window.location.origin).href,
    new URL('voy-search/voy_search_bg.wasm', import.meta.url).href,
  ];
  for (const url of wasmCandidates) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const buf = await resp.arrayBuffer();

      // Discover import module names (e.g. "./voy_search_bg.js")
      const compiled     = await WebAssembly.compile(buf);
      const importMods   = [...new Set(WebAssembly.Module.imports(compiled).map(i => i.module))];
      const wasmImports  = {};
      for (const m of importMods) wasmImports[m] = mod;

      // Pass raw buffer — gives {instance, module}; passing a compiled Module gives instance directly
      const { instance } = await WebAssembly.instantiate(buf, wasmImports);
      mod.__wbg_set_wasm(instance.exports);
      console.log('[LocalAdapter] Voy WASM instantiated from', url);
      return Voy;
    } catch (e) {
      console.warn('[LocalAdapter] Voy WASM init attempt failed for', url, ':', e.message);
    }
  }
  throw new Error('Voy WASM could not be initialized from any candidate URL');
}

async function _initVoyOnce() {
  const mod = await import('voy-search');
  const Voy = await _ensureVoyWasm(mod);

  const items = await _loadAllEmbeddings();
  _embCache = items; // warm the embedding cache for brute-force too

  if (items.length === 0) {
    console.warn('[LocalAdapter] Voy: 0 known-person embeddings found — no faces have been identified yet. Face matching will find nothing until you assign names to faces.');
    // Build empty index anyway so Voy is marked ready (not retried on every face)
  }

  const embeddings = items.map(p => ({
    id:         String(p.face_id),
    title:      p.person_name,
    url:        JSON.stringify({ image_id: p.image_id, filename: p.filename }),
    embeddings: Array.from(p.vec),
  }));
  _voyIndex = new Voy({ embeddings });
  console.log(`[LocalAdapter] Voy index built: ${embeddings.length} known-person embeddings`);
  return _voyIndex;
}

/**
 * Return the live Voy index, initializing once if necessary.
 * Concurrent callers share the same in-flight promise.
 * If WASM fails permanently, returns null (caller falls back to brute-force).
 */
async function _getVoyIndex(forceRebuild = false) {
  if (_voyFailed && !forceRebuild) return null;
  if (_voyIndex  && !forceRebuild) return _voyIndex;

  if (!_voyInitPromise) {
    _voyInitPromise = _initVoyOnce()
      .catch(err => {
        console.warn('[LocalAdapter] Voy WASM init failed, brute-force only:', err.message);
        _voyFailed = true;
        _voyIndex  = null;
        return null;
      })
      .finally(() => { _voyInitPromise = null; });
  }
  return _voyInitPromise;
}

function _cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}

/**
 * Brute-force cosine fallback — works in all browsers.
 * Uses the in-memory _embCache (loaded by _getVoyIndex) when available
 * to avoid a redundant DB query per face during batch processing.
 */
async function _bruteForceMatch(embedding, threshold = 0.4) {
  const items = _embCache ?? await _loadAllEmbeddings();
  if (items.length === 0) return null;
  let best = null, bestSim = -1;
  for (const item of items) {
    const sim = _cosine(embedding, item.vec);
    if (sim > bestSim) { bestSim = sim; best = item; }
  }
  console.log(`[LocalAdapter] bruteForce: ${items.length} vecs, best=${best?.person_name} sim=${bestSim.toFixed(4)} thresh=${threshold}`);
  return (best && bestSim >= threshold)
    ? { person_id: best.person_id, name: best.person_name }
    : null;
}

/** Best-matching person using Voy HNSW, falling back to brute-force cosine.
 *
 * voy-search v0.6.3 returns `{ neighbors: Neighbor[] }`.
 * IMPORTANT: `Neighbor` = { id: string, title: string, url: string }
 * There is NO `score` field — confirmed via runtime test.
 * We use Voy for ranking (fast HNSW) and verify threshold via _cosine() on _embCache.
 */
async function _voyBestMatch(embedding, threshold = 0.4) {
  const index = await _getVoyIndex();
  if (index) {
    try {
      const result    = index.search(Array.from(embedding), 1);
      const neighbors = result?.neighbors ?? [];
      if (neighbors.length > 0) {
        const best = neighbors[0];
        // Voy gives ranking but no score — look up embedding from cache and compute cosine
        const items = _embCache ?? await _loadAllEmbeddings();
        const cached = items.find(e => String(e.face_id) === String(best.id));
        if (cached) {
          const sim = _cosine(embedding, cached.vec);
          console.log(`[LocalAdapter] Voy top-1: face_id=${best.id} name=${best.title} cosine=${sim.toFixed(4)} threshold=${threshold}`);
          if (sim >= threshold) return { person_id: cached.person_id, name: best.title };
          console.log(`[LocalAdapter] Voy match below threshold — no match`);
          return null;
        }
        // face_id not in cache (shouldn't happen) — fall through to brute-force
        console.warn(`[LocalAdapter] Voy returned face_id=${best.id} but not found in _embCache, falling back`);
      } else {
        console.log('[LocalAdapter] Voy: no neighbors returned');
        return null;
      }
    } catch (err) {
      console.warn('[LocalAdapter] Voy search error, falling back to brute-force:', err.message);
    }
  }
  return _bruteForceMatch(embedding, threshold);
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
      // Strip from the object so Svelte reactive state doesn't hold 21× 30KB blobs.
      // The data is now in thumbCache and will be served via fetchThumbnail().
      delete img.thumbnail_blob;
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

/** Load all face embeddings from SQLite for the search index.
 *
 * Uses LEFT JOIN so orphaned embeddings (whose face row was deleted by
 * clearDetections) are still returned. This is critical for re-detection:
 * after clearDetections removes the old face row the embedding becomes
 * orphaned, but it still holds the person_id assignment and should be
 * used to match the newly detected face.
 */
async function _loadAllEmbeddings() {
  // IMPORTANT: only load embeddings that are assigned to a known person.
  // Unidentified faces (person_id IS NULL) must NOT be included — they would
  // match at high cosine similarity and return person_id=null, which is useless
  // and falsely prevents the face from appearing as unidentified in the UI.
  const rows = await query(`
    SELECT fe.id, fe.person_id, p.name, fe.embedding_vector,
           COALESCE(f.image_id, -1) AS image_id,
           COALESCE(i.filename, '') AS filename
    FROM face_embeddings fe
    INNER JOIN people p ON p.id = fe.person_id
    LEFT JOIN faces f   ON f.id = fe.face_id
    LEFT JOIN images i  ON i.id = f.image_id
    WHERE fe.embedding_vector IS NOT NULL
      AND fe.person_id IS NOT NULL
      AND (p.name IS NOT NULL AND p.name != '' AND p.name != 'Unknown')
  `);
  const result = rows.map(r => ({
    face_id: r.id,
    person_id: r.person_id,
    person_name: r.name,
    image_id: r.image_id,
    filename: r.filename,
    vec: _csvToFloat32(r.embedding_vector),
  }));
  // Group by person for diagnostic logging
  const byPerson = {};
  for (const e of result) byPerson[e.person_name] = (byPerson[e.person_name] || 0) + 1;
  console.log(`[LocalAdapter] _loadAllEmbeddings: ${result.length} known-person embeddings`, byPerson);
  return result;
}

function _csvToFloat32(str) {
  if (!str) return new Float32Array(0);
  const parts = str.split(',');
  const arr = new Float32Array(parts.length);
  for (let i = 0; i < parts.length; i++) arr[i] = +parts[i];
  return arr;
}

// ── Health / Auth (mocked — local mode has no server session) ─────────────────

/**
 * If a description was accidentally stored as a raw JSON string (VLM parse fallback bug),
 * extract just the .description text from it.
 */
function _unwrapDescription(val) {
  if (!val || typeof val !== 'string') return val;
  const t = val.trim();
  if (!t.startsWith('{')) return val;
  try {
    const obj = JSON.parse(t);
    if (typeof obj.description === 'string') return obj.description;
  } catch { /* not JSON — return as-is */ }
  return val;
}

/** Insert faces + tags + embeddings for an already-existing image row. Returns importProcessed result shape. */
async function _insertFacesForImage(imageId, faces, tags, description, scene_type, thumbnail_b64) {
  if (tags && tags.length > 0) {
    for (const tag of tags)
      await run('INSERT OR IGNORE INTO image_tags(image_id, tag) VALUES(?,?)', [imageId, tag]);
  }
  let faceCount = 0;
  const people = [];
  for (const face of faces) {
    const x1 = face.bbox_left ?? 0;
    const y1 = face.bbox_top ?? 0;
    const x2 = face.bbox_right ?? 1;
    const y2 = face.bbox_bottom ?? 1;
    const faceRes = await run(
      `INSERT INTO faces(image_id, bbox_x1, bbox_y1, bbox_x2, bbox_y2, detection_confidence, face_thumbnail)
       VALUES(?,?,?,?,?,?,?)`,
      [imageId, x1, y1, x2, y2, face.detection_confidence ?? face.score ?? null, face.face_crop_b64 || null],
    );
    const faceId = faceRes.lastInsertRowid || faceRes.changes?.lastId;
    if (faceId && face.embedding) {
      const f32 = face.embedding instanceof Float32Array ? face.embedding : new Float32Array(face.embedding);
      const match = await _voyBestMatch(f32, 0.4);
      if (match) people.push(match.name);
      const embStr = Array.from(f32).join(',');
      await run(
        `INSERT OR REPLACE INTO face_embeddings (face_id, person_id, embedding_vector, embedding_dimension) VALUES(?,?,?,?)`,
        [faceId, match?.person_id ?? null, embStr, f32.length],
      );
      if (match) await run('UPDATE people SET total_appearances=total_appearances+1 WHERE id=?', [match.person_id]);
      faceCount++;
    }
  }
  _voyIndex = null; _embCache = null; _voyFailed = false;
  return { ok: true, image_id: imageId, face_count: faceCount, people, description: description || null, scene_type: scene_type || null, tags: tags || [] };
}

console.log("%c[LocalAdapter] Module Loaded | Version: v4.0.260308.2300", "color: #e07030; font-weight: bold");
export const localAdapter = {

  health() {
    return { ok: true, version: 'local', backend: 'capacitor-sqlite', model_ready: true };
  },

  /** Check if an image already exists in the DB by hash or filepath. Returns image_id or null. */
  async checkDuplicate(file_hash, filepath) {
    if (file_hash) {
      const rows = await query('SELECT id FROM images WHERE file_hash=?', [file_hash]);
      if (rows.length > 0) { console.log(`[LocalAdapter] checkDuplicate: hash match → imageId=${rows[0].id}`); return rows[0].id; }
    }
    if (filepath) {
      const rows = await query('SELECT id FROM images WHERE filepath=?', [filepath]);
      if (rows.length > 0) { console.log(`[LocalAdapter] checkDuplicate: filepath match → imageId=${rows[0].id}`); return rows[0].id; }
    }
    return null;
  },

  me() {
    return { username: 'local', role: 'admin' };
  },

  async getFaceCrop(imageId, faceId, size = 128) {
    console.log(`[LocalAdapter] getFaceCrop imageId=${imageId} faceId=${faceId} size=${size}`);
    try {
      // 1. Get face coordinates + stored thumbnail
      const rows = await query('SELECT bbox_x1, bbox_y1, bbox_x2, bbox_y2, face_thumbnail FROM faces WHERE id = ?', [faceId]);
      if (rows.length === 0) throw new Error('Face not found');
      const { bbox_x1, bbox_y1, bbox_x2, bbox_y2, face_thumbnail } = rows[0];

      // 2. Use stored face thumbnail if available (high-res crop from original image)
      if (face_thumbnail) {
        const b64str = face_thumbnail instanceof Uint8Array ? uint8ToBase64(face_thumbnail) : face_thumbnail;
        const dataUri = b64str.startsWith('data:') ? b64str : `data:image/jpeg;base64,${b64str}`;
        // Re-encode at requested size if needed
        const img = await new Promise((resolve, reject) => {
          const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = dataUri;
        });
        const canvas = new OffscreenCanvas(size, size);
        canvas.getContext('2d').drawImage(img, 0, 0, size, size);
        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
        return URL.createObjectURL(blob);
      }

      // 3. Fallback: extract from gallery thumbnail (lower quality)
      const imgRows = await query('SELECT filepath, thumbnail_blob FROM images WHERE id = ?', [imageId]);
      if (imgRows.length === 0) throw new Error('Image not found');
      const { filepath, thumbnail_blob } = imgRows[0];

      let imgSource = '';
      if (thumbnail_blob) {
        imgSource = thumbnail_blob.startsWith('data:') ? thumbnail_blob : `data:image/jpeg;base64,${thumbnail_blob}`;
      } else if (!Capacitor.isNativePlatform()) {
        throw new Error('No thumbnail stored and file not accessible in browser mode');
      } else {
        imgSource = toWebUrl(filepath);
      }

      const img = await new Promise((resolve, reject) => {
        const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = imgSource;
      });

      // Crop using normalized bbox coordinates
      const x = bbox_x1 * img.width,  y = bbox_y1 * img.height;
      const w = (bbox_x2 - bbox_x1) * img.width, h = (bbox_y2 - bbox_y1) * img.height;
      console.warn(`[LocalAdapter] getFaceCrop: no face_thumbnail stored, falling back to ${Math.round(img.width)}×${Math.round(img.height)} gallery thumbnail (degraded quality)`);

      const canvas = new OffscreenCanvas(size, size);
      canvas.getContext('2d').drawImage(img, x, y, w, h, 0, 0, size, size);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
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
    console.log('[LocalAdapter] settings() — loading ALL preferences from SQLite...');
    try {
      const rows = await query('SELECT key, value FROM settings WHERE key LIKE "pref_%"');
      const prefs = {};
      for (const row of rows) prefs[row.key.replace('pref_', '')] = row.value;

      // Sync prefs: primary source is SQLite; fallback to localStorage for legacy
      const lsSync  = (() => { try { return JSON.parse(localStorage.getItem('crisplens_sync_settings') || '{}'); } catch { return {}; } })();
      const thumbSz  = parseInt(prefs.thumb_size   ?? lsSync.thumbSize   ?? '600');
      const maxItems = parseInt(prefs.max_items    ?? lsSync.maxItems    ?? '500');
      const maxSizeMb= parseInt(prefs.max_size_mb  ?? lsSync.maxSizeMb  ?? '500');

      const result = {
        ui: {
          language: prefs.language || localStorage.getItem('pwa_language') || 'en',
        },
        face_recognition: {
          insightface: {
            det_model:               prefs.det_model || 'auto',
            recognition_threshold:   parseFloat(prefs.rec_threshold || '0.4'),
            detection_threshold:     parseFloat(prefs.det_threshold || '0.5'),
            det_retries:             parseInt(prefs.det_retries || '1'),
            det_size:                parseInt(prefs.det_size || '640'),
          },
        },
        processing: { backend: 'local' },
        inference: {
          ort_use_coreml: prefs.ort_use_coreml === 'true' || prefs.ort_use_coreml === true,
        },
        vlm: {
          enabled:  prefs.vlm_enabled === 'true' || prefs.vlm_enabled === true,
          provider: prefs.vlm_provider || 'openrouter',
          model:    prefs.vlm_model || '',
        },
        sync: {
          thumb_size:   thumbSz,
          max_items:    maxItems,
          max_size_mb:  maxSizeMb,
        },
      };

      console.log('[LocalAdapter] settings() loaded from SQLite:');
      console.log('  language:', result.ui.language);
      console.log('  det_model:', result.face_recognition.insightface.det_model,
                  '| det_thresh:', result.face_recognition.insightface.detection_threshold,
                  '| rec_thresh:', result.face_recognition.insightface.recognition_threshold);
      console.log('  vlm enabled:', result.vlm.enabled, '| provider:', result.vlm.provider, '| model:', result.vlm.model);
      console.log('  sync thumb_size:', result.sync.thumb_size, '| max_items:', result.sync.max_items, '| max_size_mb:', result.sync.max_size_mb);
      console.log('  raw SQLite rows:', rows.length, '→', rows.map(r => `${r.key}=${r.value}`).join(', '));
      return result;
    } catch (err) {
      console.error('[LocalAdapter] settings() FAILED:', err);
      throw err;
    }
  },

  async saveSettings(body) {
    console.log('[LocalAdapter] saveSettings() — persisting to SQLite:', JSON.stringify(body));
    const mapping = {
      'language':     body.language,
      'det_model':    body.det_model,
      'rec_threshold':body.rec_threshold !== undefined ? String(body.rec_threshold) : undefined,
      'det_threshold':body.det_threshold !== undefined ? String(body.det_threshold) : undefined,
      'det_size':     body.det_size      !== undefined ? String(body.det_size)      : undefined,
      'det_retries':  body.det_retries   !== undefined ? String(body.det_retries)   : undefined,
      'vlm_enabled':  body.vlm_enabled   !== undefined ? (body.vlm_enabled ? 'true' : 'false') : undefined,
      'vlm_provider': body.vlm_provider,
      'vlm_model':    body.vlm_model,
      // Sync/offline preferences
      'thumb_size':   body.thumb_size    !== undefined ? String(body.thumb_size)    : undefined,
      'max_items':    body.max_items     !== undefined ? String(body.max_items)     : undefined,
      'max_size_mb':  body.max_size_mb   !== undefined ? String(body.max_size_mb)   : undefined,
      'ort_use_coreml': body.ort_use_coreml !== undefined ? (body.ort_use_coreml ? 'true' : 'false') : undefined,
    };

    const written = [];
    for (const [key, value] of Object.entries(mapping)) {
      if (value !== undefined) {
        await run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [`pref_${key}`, value]);
        written.push(`pref_${key}=${value}`);
      }
    }
    console.log('[LocalAdapter] saveSettings() wrote', written.length, 'keys:', written.join(', '));
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
    const trimmed = (value || '').trim();
    if (!trimmed) throw new Error(`Key for ${provider} is empty`);
    await run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [`vlm_key_${provider}`, trimmed]);
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

  async i18n() {
    try {
      const rows = await query('SELECT value FROM settings WHERE key=?', ['pref_language']);
      const language = rows[0]?.value || localStorage.getItem('pwa_language') || 'en';
      return { language, translations: {} };
    } catch {
      return { language: localStorage.getItem('pwa_language') || 'en', translations: {} };
    }
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

    // thumbnail_blob is fetched here to populate thumbCache, but _cache() strips it
    // from the returned objects so Svelte reactive state doesn't hold 20+ large blobs.
    const sql = `
      SELECT i.id, i.filename, i.filepath, i.local_path, i.width, i.height,
             i.date_taken, i.date_processed, i.description, i.scene_type, i.visibility,
             i.thumbnail_blob,
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
        ai_description:  _unwrapDescription(r.description),
        ai_scene_type:   r.scene_type,
        ai_tags_list:    r.ai_tags_csv ? r.ai_tags_csv.split(',') : [],
        origin_path:     r.local_path || r.filepath,
        server_path:     r.filepath,
        // Convert people_names CSV → detected_people array (face_id unavailable here; populated properly in getImage)
        detected_people: r.people_names
          ? r.people_names.split(',').map(name => ({ name: name.trim(), face_id: null }))
          : [],
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
             i.thumbnail_blob,
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
      // Build detected_people array ({name, face_id}) for MetaPanel
      const faceRows = await query(`
        SELECT f.id AS face_id, p.name
        FROM faces f
        JOIN face_embeddings fe ON fe.face_id = f.id
        JOIN people p ON p.id = fe.person_id
        WHERE f.image_id = ? AND p.name IS NOT NULL AND p.name != ''
        ORDER BY f.id
      `, [id]);
      const img = {
        ...r,
        ai_description:  _unwrapDescription(r.description),
        ai_scene_type:   r.scene_type,
        ai_tags_list:    r.ai_tags_csv ? r.ai_tags_csv.split(',') : [],
        origin_path:     r.local_path || r.filepath,
        server_path:     r.filepath,
        detected_people: faceRows,
        face_count:      (await query('SELECT COUNT(*) AS n FROM faces WHERE image_id=?', [id]))[0]?.n ?? 0,
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
      const modelBase = (localStorage.getItem('remote_url') || window.location.origin) + '/models/';
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
      console.log(`[LocalAdapter] reDetectFaces thumb_size=${thumb_size} (from syncSettings.thumbSize=${syncCfg.thumbSize ?? 'not set, using default 200'})`);
      console.log(`[LocalAdapter] reDetectFaces full syncSettings:`, JSON.stringify(syncCfg));
      
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

      // 5. Update the database — use overwrite mode so importProcessed
      // properly cascade-deletes old face_embeddings+faces then re-inserts.
      // Preserve original image dimensions and file_hash from the DB row
      // (faceData was computed from the thumbnail which has different dims/hash).
      const result = await this.importProcessed({
        ...faceData,
        filepath:        imgRow.filepath,
        filename:        imgRow.filename,
        local_path:      imgRow.local_path ?? null,
        width:           imgRow.width  || faceData.width,
        height:          imgRow.height || faceData.height,
        file_hash:       imgRow.file_hash ?? faceData.file_hash,
        // Preserve existing VLM data if this re-run didn't produce new data
        description:     faceData.description ?? imgRow.description ?? null,
        scene_type:      faceData.scene_type  ?? imgRow.scene_type  ?? null,
        duplicate_mode:  'overwrite',
      });

      console.log(`[LocalAdapter] reDetectFaces COMPLETE for imageId=${imageId}`);
      return result;
    } catch (err) {
      console.error(`%c[LocalAdapter] reDetectFaces CRITICAL FAILURE | imageId=${imageId} | error=${err.message}`, 'color: #ff0000; font-weight: bold');
      console.error(err.stack);
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
    
    // Ensure row exists — face may have been detected without an embedding stored
    await run('INSERT OR IGNORE INTO face_embeddings(face_id, person_id, embedding_dimension) VALUES(?,?,?)',
      [face_id, person.id, 0]);
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

  async importProcessed({ filepath, filename, local_path, file_hash, width, height, date_taken,
                          faces = [], description, scene_type, tags = [],
                          thumbnail_b64, embedding_dim = 512,
                          duplicate_mode = 'skip' }) {
    const fname = filename || filepath?.split('/').pop() || 'unknown';
    // Sanitize filepath: never store blob: URLs (Capacitor Camera webPath — revoked on reload).
    // FaceEngineWeb already returns a hash-based 'browser:...' path; other callers may pass
    // bare filenames or native paths which are fine.
    const safeFilepath = (filepath && !filepath.startsWith('blob:')) ? filepath : (filename || fname);
    // Unwrap description if it was accidentally stored as a raw JSON string (VLM parse fallback)
    description = _unwrapDescription(description);

    console.log(`[LocalAdapter] importProcessed: ${fname} | filepath=${safeFilepath} | local_path=${local_path || '—'} | hash=${file_hash ? file_hash.slice(0,12)+'…' : '—'} | dims=${width}x${height} | dup_mode=${duplicate_mode}`);
    console.log(`[LocalAdapter] VLM results:`, { description: (description || '').slice(0, 50) + '...', scene_type, tagsCount: tags?.length });

    // ── Duplicate detection ────────────────────────────────────────────────
    // Check by file_hash first (most reliable), then by filepath.
    let existingId = null;
    if (file_hash) {
      const hashRows = await query('SELECT id FROM images WHERE file_hash=?', [file_hash]);
      if (hashRows.length > 0) existingId = hashRows[0].id;
    }
    if (!existingId) {
      const fpRows = await query('SELECT id FROM images WHERE filepath=?', [safeFilepath]);
      if (fpRows.length > 0) existingId = fpRows[0].id;
    }

    if (existingId !== null) {
      if (duplicate_mode === 'skip') {
        console.log(`[LocalAdapter] Duplicate detected (imageId=${existingId}) — skipping (mode=skip)`);
        return { ok: true, image_id: existingId, face_count: 0, people: [], skipped: true };
      }
      if (duplicate_mode === 'overwrite') {
        console.log(`[LocalAdapter] Duplicate detected (imageId=${existingId}) — overwriting (mode=overwrite)`);
        // Delete existing faces + embeddings so they are re-inserted below
        await run('DELETE FROM face_embeddings WHERE face_id IN (SELECT id FROM faces WHERE image_id=?)', [existingId]);
        await run('DELETE FROM faces WHERE image_id=?', [existingId]);
        await run('DELETE FROM image_tags WHERE image_id=?', [existingId]);
        // Update the image row in-place
        await run(`UPDATE images SET filename=?,local_path=?,file_hash=?,width=?,height=?,date_taken=?,description=?,scene_type=?,thumbnail_blob=? WHERE id=?`,
          [fname, local_path ?? null, file_hash ?? null, width ?? null, height ?? null,
           date_taken ?? null, description ?? null, scene_type ?? null, thumbnail_b64 || null, existingId]);
        const imageId = existingId;
        fileCache.set(imageId, safeFilepath);
        if (thumbnail_b64) thumbCache.set(imageId, thumbnail_b64);
        // Fall through to face insertion below using existingId
        return await _insertFacesForImage(imageId, faces, tags, description, scene_type, thumbnail_b64);
      }
      // 'always_add' falls through — insert with new filepath variant
      console.log(`[LocalAdapter] Duplicate detected (imageId=${existingId}) — inserting anyway (mode=always_add)`);
    }

    // Upsert image record
    await run(`INSERT OR IGNORE INTO images
               (filename, filepath, local_path, file_hash, width, height, date_taken, description, scene_type, thumbnail_blob)
               VALUES(?,?,?,?,?,?,?,?,?,?)`,
              [fname, safeFilepath, local_path ?? null, file_hash ?? null,
               width ?? null, height ?? null,
               date_taken ?? null, description ?? null, scene_type ?? null, thumbnail_b64 || null]);

    // Update VLM/thumbnail if provided (handles re-run case when INSERT OR IGNORE is a no-op)
    if (description || scene_type || thumbnail_b64) {
      const updates = [];
      const params = [];
      if (description) { updates.push('description = ?'); params.push(description); }
      if (scene_type) { updates.push('scene_type = ?'); params.push(scene_type); }
      if (thumbnail_b64) { updates.push('thumbnail_blob = ?'); params.push(thumbnail_b64); }
      if (local_path) { updates.push('local_path = ?'); params.push(local_path); }
      if (file_hash) { updates.push('file_hash = ?'); params.push(file_hash); }

      if (updates.length > 0) {
        params.push(safeFilepath);
        await run(`UPDATE images SET ${updates.join(', ')} WHERE filepath = ?`, params);
      }
    }

    const imgRows = await query('SELECT id FROM images WHERE filepath=?', [safeFilepath]);
    const imageId = imgRows[0]?.id;
    if (!imageId) throw new Error(`Failed to insert image record for ${safeFilepath}`);
    fileCache.set(imageId, safeFilepath);
    if (thumbnail_b64) thumbCache.set(imageId, thumbnail_b64);

    console.log(`[LocalAdapter] importProcessed: imageId=${imageId}, processing ${faces.length} faces`);
    return await _insertFacesForImage(imageId, faces, tags, description, scene_type, thumbnail_b64);
  },
};
