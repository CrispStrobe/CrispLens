/**
 * api.js — Typed fetch wrappers for all FastAPI/v4-Node endpoints.
 *
 * Three modes, controlled by localStorage key 'data_source':
 *   'server' (default) — HTTP fetch to a v4 Node.js or v2 FastAPI server
 *   'local'            — @capacitor-community/sqlite directly on-device (no server)
 *
 * All Svelte components use this file unchanged regardless of mode.
 */

import syncManager from './lib/SyncManager.js';
import { localAdapter, fileCache, thumbCache, toWebUrl } from './lib/LocalAdapter.js';
import { localThumb } from './lib/LocalThumbnailCache.js';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { robustFetch, base64ToBlob } from './lib/RobustFetch.js';

export { localThumb, robustFetch };

// ── Native-safe Fetch ────────────────────────────────────────────────────────
// On iOS/Android, standard fetch() often fails due to CORS (capacitor://localhost).
// Capacitor's built-in native HTTP bypasses this.

/** Specific helper for multipart uploads on mobile */
async function robustUpload(url, formData, options = {}) {
  if (Capacitor.isNativePlatform()) {
    console.log(`[api] Native platform: using CapacitorHttp.upload for ${url}`);
    
    // Extract file and other fields from FormData
    const files = [];
    const params = {};
    
    // Helper to read blob as base64
    const blobToBase64 = (blob) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });

    for (const [key, value] of formData.entries()) {
      if (value instanceof Blob || value instanceof File) {
        const base64 = await blobToBase64(value);
        console.log(`[api] Upload: converting field "${key}" to base64 (${base64.length} chars)`);
        files.push({ 
          key, 
          data: base64, 
          name: value.name || 'file.jpg' 
        });
      } else {
        console.log(`[api] Upload: adding form field "${key}" = "${value}"`);
        params[key] = String(value);
      }
    }

    try {
      const res = await CapacitorHttp.upload({
        url,
        files,
        params,
        headers: {
          ...options.headers,
          ...(options.credentials === 'include' ? { 'X-Capacitor-HTTP-Cookies': 'true' } : {})
        }
      });

      console.log(`[api] CapacitorHttp.upload response: ${res.status}`);
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        json: async () => res.data,
        text: async () => typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
      };
    } catch (err) {
      const errMsg = err.message || JSON.stringify(err);
      console.error('[api] CapacitorHttp.upload fatal error:', errMsg);
      throw new Error(errMsg);
    }
  }
  
  return fetch(url, { ...options, method: 'POST', body: formData });
}

/** Helper to convert base64 to Blob for Capacitor native HTTP responses */

/** Fetch an image as an Object URL (bypassing CORS/Cookie issues on mobile) */
export async function fetchImageAsUrl(url) {
  if (Capacitor.isNativePlatform()) {
    try {
      const res = await CapacitorHttp.get({ 
        url, 
        responseType: 'blob',
        headers: { 'X-Capacitor-HTTP-Cookies': 'true' } 
      });
      
      if (typeof res.data === 'string') {
        // Native platform often returns base64 string for binary data
        const contentType = res.headers['Content-Type'] || res.headers['content-type'] || 'image/jpeg';
        // If it's already a data URL, return it
        if (res.data.startsWith('data:')) return res.data;
        // Otherwise convert base64 to Object URL
        const blob = base64ToBlob(res.data, contentType);
        return URL.createObjectURL(blob);
      }
      
      if (res.data instanceof Blob) {
        return URL.createObjectURL(res.data);
      }
      
      return url;
    } catch (e) {
      const errMsg = e.message || JSON.stringify(e);
      console.error('[api] fetchImageAsUrl failed:', errMsg);
      return url;
    }
  }
  return url;
}

// ── Mode ──────────────────────────────────────────────────────────────────────

const _inElectron = typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined';
const _inCapacitor = typeof window !== 'undefined' && typeof (window.Capacitor ?? (globalThis.Capacitor)) !== 'undefined'
  && (globalThis.Capacitor?.isNativePlatform?.() ?? false);

// ── Mode detection ────────────────────────────────────────────────────────────
// _localMode=true  →  use browser-side WASM SQLite / LocalAdapter (no server needed)
// _localMode=false →  use HTTP API (v4 Node, v2 FastAPI, Electron embedded, remote)
//
// Axis 1: Data Source — controlled by localStorage key 'data_source' ('local'|'server')
// Axis 2: API Server  — controlled by localStorage key 'remote_url' (URL string)
// Axis 3: Inference   — controlled by localStorage key 'crisp_processing_backend'
//
// Default: Capacitor native → local; everything else → server.
// User can always switch via Settings and the choice is persisted in localStorage.
// Cloud drives and filesystem browse are SERVER features — they ignore _localMode
// and always use _fetchDirect, so they work regardless of which mode is chosen.

let _localMode = false;

{
  // One-time migration from old key 'db_mode' to 'data_source'
  const legacy = localStorage.getItem('db_mode');
  if (legacy !== null && localStorage.getItem('data_source') === null) {
    localStorage.setItem('data_source', legacy);
    localStorage.removeItem('db_mode');
    console.log(`[api] Migrated db_mode=${legacy} → data_source=${legacy}`);
  }

  const stored = localStorage.getItem('data_source');
  if (stored !== null) {
    // Respect explicit user choice in all contexts.
    _localMode = stored === 'local';
    console.log(`[api] Restored data_source=${stored} → localMode=${_localMode}`);
  } else if (_inCapacitor) {
    // Capacitor first run: default to local (no server needed on mobile).
    _localMode = true;
    localStorage.setItem('data_source', 'local');
    console.log('[api] Capacitor first run — defaulting to standalone local mode');
  } else {
    // Browser/Electron first run: default to server.
    _localMode = false;
    console.log('[api] Browser/Electron first run — defaulting to server mode');
  }
}

console.log(`[api] Initializing. localMode=${_localMode} inElectron=${_inElectron} inCapacitor=${_inCapacitor}`);

/** Switch between local WASM SQLite and server mode. Persisted in localStorage. */
export function setLocalMode(enabled) {
  console.log(`[api] setLocalMode(${enabled})`);
  _localMode = enabled;
  localStorage.setItem('data_source', enabled ? 'local' : 'server');
}

export function isLocalMode() { return _localMode; }

// ── Server base URL ───────────────────────────────────────────────────────────
// On Desktop, we use relative paths (/api).
// On Mobile pointing at a remote server, we need the full URL.
let BASE = (localStorage.getItem('remote_url') || '').replace(/\/$/, '') + '/api';
if (BASE === '/api') {
  BASE = window.location.origin + '/api';
}
console.log(`[api] BASE set to: ${BASE}`);

export function setRemoteBase(url) {
  const newBase = url.replace(/\/$/, '') + '/api';
  console.log(`[api] setRemoteBase: ${BASE} → ${newBase}`);
  BASE = newBase;
}

/** Helper to block server calls in standalone mode and log them. */
function _guard(msg, fallbackFn = null) {
  if (_localMode) {
    console.log(`[api] STANDALONE INTERCEPT: ${msg}`);
    if (fallbackFn) {
      return (async () => {
        try {
          const result = await fallbackFn();
          console.log(`[api] STANDALONE RESULT for ${msg}:`, result);
          return result;
        } catch (err) {
          console.error(`[api] STANDALONE ERROR for ${msg}:`, err.message || err);
          throw err;
        }
      })();
    }
    return Promise.resolve(null);
  }
  return null;
}

async function _fetch(method, path, body) {
  // Cloud drives and filesystem browse are SERVER features — they should work
  // regardless of _localMode.  Primary image/people data is guarded by _guard().
  return _fetchDirect(method, path, body);
}

/** Explicit server-only fetch that bypasses _localMode checks. Used for FS/Cloud/Batch features. */
async function _fetchDirect(method, path, body) {
  const fullUrl = BASE + path;
  console.log(`[api] fetchDirect: ${method} ${fullUrl}`, body ? '(with body)' : '');

  const opts = {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    credentials: 'include',
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  try {
    const res = await robustFetch(fullUrl, opts);
    console.log(`[api] response: ${method} ${path} → ${res.status} ${res.statusText}`);
    
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      console.error(`[api] error response: ${text}`);
      throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const data = await res.json();
      return data;
    }
    return res.text();
  } catch (err) {
    const errMsg = err.message || JSON.stringify(err);
    console.error(`[api] ${method} ${path} error:`, errMsg);
    throw new Error(errMsg);
  }
}

const get  = (path)        => _fetch('GET',    path);
const post = (path, body)  => _fetch('POST',   path, body);
const put  = (path, body)  => _fetch('PUT',    path, body);
const patch = (path, body) => _fetch('PATCH',  path, body);
const del  = (path)        => _fetch('DELETE', path);

const getD  = (path)       => _fetchDirect('GET',    path);
const postD = (path, body) => _fetchDirect('POST',   path, body);
const putD  = (path, body) => _fetchDirect('PUT',    path, body);
const delD  = (path)       => _fetchDirect('DELETE', path);

// ── Image response normalizer (v2 ↔ v4 compat) ───────────────────────────────
// Ensures field aliases are always present regardless of which server responded.

function normalizeImage(img) {
  if (!img || typeof img !== 'object') return img;
  // Rating aliases: v2 uses star_rating, v4 uses rating — expose both
  if (img.star_rating == null && img.rating != null) img.star_rating = img.rating;
  if (img.rating      == null && img.star_rating != null) img.rating = img.star_rating;
  if (img.star_rating == null) img.star_rating = 0;
  if (img.rating      == null) img.rating      = 0;
  // Flag aliases: v2 uses color_flag, v4 uses flag — expose both
  if (img.color_flag == null && img.flag      != null) img.color_flag = img.flag;
  if (img.flag       == null && img.color_flag != null) img.flag = img.color_flag;
  // ai_tags: v2 returns a CSV string, v4 returns an array — always give array
  if (typeof img.ai_tags === 'string')
    img.ai_tags = img.ai_tags ? img.ai_tags.split(',').map(t => t.trim()).filter(Boolean) : [];
  if (!Array.isArray(img.ai_tags)) img.ai_tags = [];
  // ai_description: if stored as raw JSON (VLM parse fallback), salvage the description text
  if (typeof img.ai_description === 'string' && img.ai_description.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(img.ai_description);
      if (parsed && typeof parsed.description === 'string') {
        img.ai_description = parsed.description;
        if (!img.ai_scene_type && parsed.scene_type) img.ai_scene_type = parsed.scene_type;
        if ((!img.ai_tags || !img.ai_tags.length) && Array.isArray(parsed.tags)) img.ai_tags = parsed.tags;
      }
    } catch { /* leave as-is if not valid JSON */ }
  }
  return img;
}

// ── Images ────────────────────────────────────────────────────────────────────

export async function fetchImages(params = {}) {
  const g = _guard('fetchImages', () => localAdapter.getImages(params));
  if (g) return g;

  const { person='', tag='', scene='', folder='', path='', dateFrom='', dateTo='',
          sort='newest', limit=200, offset=0, unidentified=false, album=0,
          creator='', search_fields='' } = params;
  const q = new URLSearchParams({ person, tag, scene, folder, path, date_from: dateFrom,
                                   date_to: dateTo, sort, limit, offset, unidentified, album,
                                   creator, search_fields });
  try {
    const data = await get(`/images?${q}`);
    const images = Array.isArray(data) ? data : (data.images ?? []);
    return images.map(normalizeImage);
  } catch (e) {
    if (!navigator.onLine || /fetch|network|Failed/i.test(e.message)) {
      return syncManager.getImages({ sort, limit, offset, person, tag });
    }
    throw e;
  }
}

export function fetchImage(id) {
  const g = _guard('fetchImage', () => localAdapter.getImage(id));
  if (g) return g;
  return get(`/images/${id}`).then(normalizeImage);
}

const _THUMB_BUCKETS = [150, 200, 300, 400, 600, 800, 1000];
function _snapSize(size) {
  return _THUMB_BUCKETS.find(b => b >= size) ?? _THUMB_BUCKETS[_THUMB_BUCKETS.length - 1];
}
// In standalone browser mode, images can only be displayed from their stored
// thumbnail_blob (base64 JPEG in SQLite). File paths are not browser-accessible
// so toWebUrl() cannot work — returning '' lets the UI show a placeholder.
// On native Capacitor (iOS/Android), toWebUrl() converts to a file:// URL that
// WKWebView/WebView can load.
function _localImgUrl(id) {
  const b64 = thumbCache.get(String(id));
  if (b64) return b64.startsWith('data:') ? b64 : `data:image/jpeg;base64,${b64}`;
  if (Capacitor.isNativePlatform()) return toWebUrl(fileCache.get(String(id)) || '');
  return ''; // browser-only standalone: no accessible file path
}

export function thumbnailUrl(id, size = 200) {
  if (_localMode) return _localImgUrl(id);
  return `${BASE}/images/${id}/thumbnail?size=${_snapSize(size)}`;
}
export function previewUrl(id) {
  if (_localMode) return _localImgUrl(id);
  return `${BASE}/images/${id}/preview`;
}
export function fullUrl(id) {
  if (_localMode) return _localImgUrl(id);
  return `${BASE}/images/${id}/full`;
}
export function downloadUrl(id) { return `${BASE}/images/${id}/download`; }

/** Force-download the original image file via a hidden <a> click. */
export function downloadImage(id, filename) {
  const a = Object.assign(document.createElement('a'), {
    href: downloadUrl(id),
    download: filename || `image_${id}`,
  });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export function patchMetadata(id, params) {
  const g = _guard('patchMetadata', () => localAdapter.patchMetadata(id, params));
  if (g) return g;
  const { description='', scene_type='', tags_csv='', creator='', copyright='' } = params;
  return patch(`/images/${id}/metadata`, { description, scene_type, tags_csv, creator, copyright });
}

export function batchEditImages(ids, changes) {
  const g = _guard('batchEditImages', () => localAdapter.batchEditImages(ids, changes));
  if (g) return g;
  return post(`/images/batch-edit`, { ids, changes });
}

export function fetchCreators() {
  const g = _guard('fetchCreators', () => localAdapter.fetchCreators());
  if (g) return g;
  return get(`/images/creators`);
}

export function fetchCopyrights() {
  const g = _guard('fetchCopyrights', () => localAdapter.fetchCopyrights());
  if (g) return g;
  return get(`/images/copyrights`);
}

export function renameImage(id, new_filename) {
  return post(`/images/${id}/rename`, { new_filename });
}

export function deleteImage(id) {
  const g = _guard('deleteImage', () => localAdapter.deleteImage(id));
  if (g) return g;
  return del(`/images/${id}`);
}
export function openInOs(id)      { return post(`/images/${id}/open`); }
export function openFolderInOs(id) { return post(`/images/${id}/open-folder`); }
export function fetchExif(id)     {
  const g = _guard('fetchExif', () => ({}));
  if (g) return g;
  return get(`/images/${id}/exif`);
}
export function fetchImageFaces(id) {
  const g = _guard('fetchImageFaces', () => localAdapter.getImageFaces(id));
  if (g) return g;
  return get(`/images/${id}/faces`);
}
export function deleteFace(imageId, faceId) { 
  const g = _guard('deleteFace', () => localAdapter.deleteFace(imageId, faceId));
  if (g) return g;
  return del(`/images/${imageId}/faces/${faceId}`); 
}
export function clearIdentifications(imageId) {
  const g = _guard('clearIdentifications', () => localAdapter.clearIdentifications(imageId));
  if (g) return g;
  return post(`/images/${imageId}/clear-identifications`, {});
}
export function clearDetections(imageId) {
  const g = _guard('clearDetections', () => localAdapter.clearDetections(imageId));
  if (g) return g;
  return post(`/images/${imageId}/clear-detections`, {});
}
export function reDetectFaces(imageId, params = {}) {
  const g = _guard('reDetectFaces', () => localAdapter.reDetectFaces(imageId, params));
  if (g) return g;
  const defaults = { det_thresh: 0.5, min_face_size: 60, rec_thresh: 0.4, skip_vlm: true, det_model: 'auto', max_size: 0 };
  return post(`/images/${imageId}/re-detect`, { ...defaults, ...params });
}
export function addManualFace(imageId, bbox, rec_thresh = null) {
  const g = _guard('addManualFace', () => ({ ok: true }));
  if (g) return g;
  return post(`/images/${imageId}/faces/manual`, { bbox, rec_thresh });
}

// ── People ────────────────────────────────────────────────────────────────────

export async function fetchPeople() {
  const g = _guard('fetchPeople', () => localAdapter.getPeople());
  if (g) return g;
  try {
    return await get('/people');
  } catch (e) {
    if (!navigator.onLine || /fetch|network|Failed/i.test(e.message))
      return syncManager.getPeople();
    throw e;
  }
}
export function fetchPerson(id) {
  const g = _guard('fetchPerson', () => localAdapter.getPerson(id));
  if (g) return g;
  return get(`/people/${id}`);
}
export function renamePerson(id, name) {
  const g = _guard('renamePerson', () => localAdapter.renamePerson(id, name));
  if (g) return g;
  return put(`/people/${id}`, { name });
}
export function mergePeople(source_id, target_id) {
  const g = _guard('mergePeople', () => localAdapter.mergePeople(source_id, target_id));
  if (g) return g;
  return post('/people/merge', { source_id, target_id });
}
export function reassignFace(face_id, new_name) {
  const g = _guard('reassignFace', () => localAdapter.reassignFace(face_id, new_name));
  if (g) return g;
  return post('/people/reassign-face', { face_id, new_name });
}
export function deletePerson(id) {
  const g = _guard('deletePerson', () => localAdapter.deletePerson(id));
  if (g) return g;
  return del(`/people/${id}`);
}

// ── Search ────────────────────────────────────────────────────────────────────

export function searchImages(q, limit = 50) {
  const g = _guard('searchImages', () => localAdapter.searchImages(q, limit));
  if (g) return g;
  return get(`/search?q=${encodeURIComponent(q)}&limit=${limit}`);
}

// ── Processing ────────────────────────────────────────────────────────────────

export function processSingle(filepath, force = false, skipFaces = false, skipVlm = false, detModel = 'auto') {
  return post('/process/single', { filepath, force, skip_faces: skipFaces, skip_vlm: skipVlm, det_model: detModel });
}

export function trainPerson(person_name, image_paths) {
  return post('/process/train', { person_name, image_paths });
}

export function trainFromFolder(folder) {
  return post('/process/train/folder', { folder });
}

export function scanFolder(folder, recursive = true) {
  return post('/process/scan-folder', { folder, recursive });
}

// ── Hybrid ingest ─────────────────────────────────────────────────────────────

export function importProcessed(data) {
  const g = _guard('importProcessed', () => localAdapter.importProcessed(data));
  if (g) return g;
  return post('/ingest/import-processed', data);
}

export async function uploadLocal(buffer, localPath, visibility = 'shared', detParams = {}, { tagIds = [], newTagNames = [], albumId = null, newAlbumName = null, creator = null, copyright = null } = {}) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), localPath.split('/').pop() || 'image.jpg');
  form.append('local_path', localPath);
  form.append('visibility', visibility);
  if (detParams.det_thresh    != null) form.append('det_thresh',    String(detParams.det_thresh));
  if (detParams.min_face_size != null) form.append('min_face_size', String(detParams.min_face_size));
  if (detParams.rec_thresh    != null) form.append('rec_thresh',    String(detParams.rec_thresh));
  if (detParams.det_model)             form.append('det_model',     detParams.det_model);
  if (detParams.max_size      != null) form.append('max_size',      String(detParams.max_size));
  if (detParams.skip_faces)            form.append('skip_faces',    'true');
  if (detParams.skip_vlm)              form.append('skip_vlm',      'true');
  if (tagIds.length)                   form.append('tag_ids',       JSON.stringify(tagIds));
  if (newTagNames.length)              form.append('new_tag_names', JSON.stringify(newTagNames));
  if (albumId != null)                 form.append('album_id',      String(albumId));
  if (newAlbumName)                    form.append('new_album_name', newAlbumName);
  if (creator)                         form.append('creator',        creator);
  if (copyright)                       form.append('copyright',      copyright);
  
  try {
    const res = await robustUpload(`${BASE}/ingest/upload-local`, form, {
      credentials: 'include',
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`upload-local → ${res.status}: ${text}`);
    }
    return res.json();
  } catch (err) {
    const errMsg = err.message || JSON.stringify(err);
    console.error('[api] upload-local error:', errMsg);
    throw new Error(errMsg);
  }
}

export function streamBatchFiles(paths, onEvent) {
  return _streamSSE(`${BASE}/process/batch-files`, { paths }, onEvent);
}

export function streamBatch(folder, recursive, onEvent, detParams = {}) {
  return _streamSSE(`${BASE}/process/batch`, { folder, recursive, ...detParams }, onEvent);
}

function _streamSSE(url, body, onEvent) {
  const ctrl = new AbortController();
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
    signal: ctrl.signal,
  }).then(async res => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop();
      for (const chunk of lines) {
        const dataLine = chunk.split('\n').find(l => l.startsWith('data: '));
        if (dataLine) {
          try { onEvent(JSON.parse(dataLine.slice(6))); } catch { /* ignore */ }
        }
      }
    }
  }).catch(err => {
    if (err.name !== 'AbortError') console.error('SSE error:', err);
  });
  return { close: () => ctrl.abort() };
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export function fetchHealth() {
  const g = _guard('fetchHealth', () => localAdapter.health());
  if (g) return g;
  return get('/health');
}

export function login(username, password) { return post('/auth/login', { username, password }); }
export function logout()                  { return post('/auth/logout'); }
export function fetchMe() {
  const g = _guard('fetchMe', () => localAdapter.me());
  if (g) return g;
  return get('/auth/me');
}

// ── User management (admin only) ──────────────────────────────────────────────

export function listUsers()                         { const g = _guard('listUsers', () => localAdapter.listUsers()); if (g) return g; return get('/users'); }
export function createUser(username, password, role, allowed_folders = []) {
  const g = _guard('createUser', () => localAdapter.createUser(username, password, role));
  if (g) return g;
  return post('/users', { username, password, role, allowed_folders });
}
export function updateUser(userId, changes)         {
  const g = _guard('updateUser', () => localAdapter.updateUser(userId, changes));
  if (g) return g;
  return _fetch('PATCH', `/users/${userId}`, changes);
}
export function deleteUser(userId)                  {
  const g = _guard('deleteUser', () => localAdapter.deleteUser(userId));
  if (g) return g;
  return del(`/users/${userId}`);
}
export function resetUserLock(userId)               {
  const g = _guard('resetUserLock', () => ({ ok: true }));
  if (g) return g;
  return post(`/users/${userId}/reset-lock`, {});
}

// ── Image sharing ─────────────────────────────────────────────────────────────

export function getImageShares(imageId)             { return get(`/images/${imageId}/shares`); }
export function shareImage(imageId, userIds)        { return post(`/images/${imageId}/share`, { user_ids: userIds }); }
export function unshareImage(imageId, userId)       { return del(`/images/${imageId}/share/${userId}`); }
export function setImageVisibility(imageId, visibility) {
  return post(`/images/${imageId}/visibility`, { visibility });
}

// ── Settings ──────────────────────────────────────────────────────────────────

export function fetchSettings() {
  const g = _guard('fetchSettings', () => localAdapter.settings());
  if (g) return g;
  return get('/settings');
}
export function saveSettings(body) {
  const g = _guard('saveSettings', () => localAdapter.saveSettings(body));
  if (g) return g;
  return put('/settings', body);
}
export function fetchTranslations(nocache = false) {
  const g = _guard('fetchTranslations', () => localAdapter.i18n());
  if (g) return g;
  const q = nocache ? `?t=${Date.now()}` : '';
  return get(`/settings/i18n${q}`);
}
export function checkCredentials(username, password){ return post('/settings/check-credentials', { username, password }); }
export function fetchDbStatus()                     { const g = _guard('fetchDbStatus', () => localAdapter.dbStatus()); if (g) return g; return get('/settings/db-status'); }
export function exportDB()     { const g = _guard('exportDB', () => localAdapter.exportDB()); if (g) return g; return get('/settings/db-export'); }
export function importDB(json) { const g = _guard('importDB', () => localAdapter.importDB(json)); if (g) return g; return post('/settings/db-import', { tables: json.tables ?? json }); }
export function clearDB()      { const g = _guard('clearDB', () => localAdapter.clearDB()); if (g) return g; return post('/settings/db-clear', {}); }
export function hardResetApp() { const g = _guard('hardResetApp', () => localAdapter.hardResetApp()); if (g) return g; return post('/settings/hard-reset', {}); }
export function fetchEngineStatus() {
  const g = _guard('fetchEngineStatus', () => ({ ok: true, ready: true, model: 'buffalo_l', backend: 'onnxruntime-web' }));
  if (g) return g;
  return get('/settings/engine-status');
}
export function reloadEngine()                      { return post('/settings/reload-engine', {}); }
export function fetchUserVlmPrefs()                 { const g = _guard('fetchUserVlmPrefs', () => localAdapter.fetchUserVlmPrefs()); if (g) return g; return get('/settings/user-vlm'); }
export function saveUserVlmPrefs(prefs)             { const g = _guard('saveUserVlmPrefs', () => localAdapter.saveUserVlmPrefs(prefs)); if (g) return g; return put('/settings/user-vlm', prefs); }
export function fetchUserDetPrefs()                 { const g = _guard('fetchUserDetPrefs', () => localAdapter.fetchUserDetPrefs()); if (g) return g; return get('/settings/user-detection'); }
export function saveUserDetPrefs(prefs)             { const g = _guard('saveUserDetPrefs', () => localAdapter.saveUserDetPrefs(prefs)); if (g) return g; return put('/settings/user-detection', prefs); }
export function changePassword(current_password, new_password) {
  return post('/auth/change-password', { current_password, new_password });
}

// ── Admin operations ──────────────────────────────────────────────────────────

export function testAdminJson() {
  const g = _guard('testAdminJson', () => new Response('{}', { status: 200 }));
  if (g) return g;
  return fetch(`${BASE}/admin/test-json`, { credentials: 'include' });
}

export function streamServerUpdate(fix_db_path = '', opts = {}) {
  const g = _guard('streamServerUpdate', () => new Response('data: [DONE]\n\n', { status: 200 }));
  if (g) return g;
  return fetch(`${BASE}/admin/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ fix_db_path }),
    ...opts,
  });
}

export function fetchServerLogs(lines = 50, opts = {}) {
  const g = _guard('fetchServerLogs', () => new Response('data: [DONE]\n\n', { status: 200 }));
  if (g) return g;
  return fetch(`${BASE}/admin/logs?lines=${lines}`, { credentials: 'include', ...opts });
}

export function fetchServerLogsJson(lines = 50) {
  const g = _guard('fetchServerLogsJson', () => ({ lines: [] }));
  if (g) return g;
  return fetch(`${BASE}/admin/logs-json?lines=${lines}`, { credentials: 'include' }).then(r => r.json());
}

// ── API keys ──────────────────────────────────────────────────────────────────

export function fetchProviders()              { const g = _guard('fetchProviders', () => localAdapter.getProviders()); if (g) return g; return get('/api-keys/providers'); }
export function fetchKeyStatus()              { const g = _guard('fetchKeyStatus', () => localAdapter.getKeyStatus()); if (g) return g; return get('/api-keys/status'); }
export async function fetchVlmModels(provider) {
  const g = _guard('fetchVlmModels', () => localAdapter.getVlmModels(provider));
  if (g) return g;
  const d = await get(`/api-keys/models/${provider}`); return d.models ?? d;
}
export function saveApiKey(provider, api_key, scope = 'system') {
  const g = _guard('saveApiKey', () => localAdapter.saveApiKey(provider, api_key));
  if (g) return g;
  return post('/api-keys', { provider, key_value: api_key, scope });
}
export function deleteApiKey(provider, scope = 'system') {
  const g = _guard('deleteApiKey', () => localAdapter.deleteApiKey(provider));
  if (g) return g;
  return del(`/api-keys/${provider}?scope=${scope}`);
}
export function testApiKey(provider) {
  const g = _guard('testApiKey', () => localAdapter.testApiKey(provider));
  if (g) return g;
  return post(`/api-keys/test/${provider}`, {});
}

// ── Tags & Stats ──────────────────────────────────────────────────────────────

export function fetchTags() {
  const g = _guard('fetchTags', () => localAdapter.getTags());
  if (g) return g;
  return get('/tags');
}
export function fetchTagsStats() {
  const g = _guard('fetchTagsStats', () => localAdapter.getTagsStats());
  if (g) return g;
  return get('/tags/stats');
}
export function fetchCreatorsStats() {
  const g = _guard('fetchCreatorsStats', () => []); // not implemented locally yet
  if (g) return g;
  return get('/creators/stats');
}

export function fetchDatesStats() {
  const g = _guard('fetchDatesStats', () => []);
  if (g) return g;
  return get('/dates/stats');
}
export function fetchFoldersStats() {
  const g = _guard('fetchFoldersStats', () => []);
  if (g) return g;
  return get('/folders/stats');
}
export function fetchSceneTypes() {
  const g = _guard('fetchSceneTypes', () => []);
  if (g) return g;
  return get('/scene-types');
}
export function fetchStats() {
  const g = _guard('fetchStats', () => localAdapter.getStats());
  if (g) return g;
  return get('/stats');
}

// ── Duplicates ────────────────────────────────────────────────────────────────

export function fetchDuplicateStats() {
  const g = _guard('fetchDuplicateStats', () => ({}));
  if (g) return g;
  return get('/duplicates/stats');
}

export function fetchDuplicateGroups(method = 'hash', threshold = 8) {
  const g = _guard('fetchDuplicateGroups', () => []);
  if (g) return g;
  const q = new URLSearchParams({ method, threshold });
  return get(`/duplicates/groups?${q}`);
}

export function resolveDuplicate(keep_id, delete_ids, action = 'delete_file', merge_faces = true) {
  const g = _guard('resolveDuplicate', () => ({ ok: true }));
  if (g) return g;
  return post('/duplicates/resolve', { keep_id, delete_ids, action, merge_faces });
}

export function resolveDuplicateBatch(groups, action = 'delete_file', merge_faces = true) {
  const g = _guard('resolveDuplicateBatch', () => ({ ok: true }));
  if (g) return g;
  return post('/duplicates/resolve-batch', { groups, action, merge_faces });
}

export function scanPhash(onEvent) {
  const g = _guard('scanPhash');
  if (g) {
    onEvent({ done: true, available: false });
    return { close: () => {} };
  }
  const ctrl = new AbortController();
  fetch(`${BASE}/duplicates/scan-phash`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    signal: ctrl.signal,
  }).then(async res => {
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const data = await res.json();
      onEvent({ done: true, available: data.available ?? true, error: data.error });
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop();
      for (const chunk of lines) {
        const dataLine = chunk.split('\n').find(l => l.startsWith('data: '));
        if (dataLine) {
          try { onEvent(JSON.parse(dataLine.slice(6))); } catch { /* ignore */ }
        }
      }
    }
  }).catch(err => {
    if (err.name !== 'AbortError') console.error('scanPhash SSE error:', err);
  });
  return { close: () => ctrl.abort() };
}

export async function downloadCleanupScript(files, format = 'bash', action = 'trash') {
  const g = _guard('downloadCleanupScript');
  if (g) return g;
  const resp = await fetch(`${BASE}/duplicates/cleanup-script`, {
    method:      'POST',
    headers:     { 'Content-Type': 'application/json' },
    credentials: 'include',
    body:         JSON.stringify({ files, format, action }),
  });
  if (!resp.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`cleanup-script → ${resp.status}: ${text}`);
  }
  const blob = await resp.blob();
  const ext  = { bash: 'sh', powershell: 'ps1', json: 'json' }[format] ?? 'txt';
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href:     url,
    download: `crisp_cleanup.${ext}`,
  });
  a.click();
  URL.revokeObjectURL(url);
}

export function scanHashes(onEvent) {
  const g = _guard('scanHashes');
  if (g) {
    onEvent({ done: true, count: 0 });
    return { close: () => {} };
  }
  const ctrl = new AbortController();
  fetch(`${BASE}/duplicates/scan-hashes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    signal: ctrl.signal,
  }).then(async res => {
    const reader = res.body.getReader();
    const dec    = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        for (const dataLine of part.split('\n')) {
          if (dataLine.startsWith('data: '))
            try { onEvent(JSON.parse(dataLine.slice(6))); } catch { /* ignore */ }
        }
      }
    }
  }).catch(err => {
    if (err.name !== 'AbortError') console.error('scanHashes SSE error:', err);
  });
  return { close: () => ctrl.abort() };
}

// ── Cloud drives ──────────────────────────────────────────────────────────────
// Routing strategy:
//   _localMode=true (standalone — no server):
//     → LocalAdapter → BrowserCloudDrives.js (direct browser fetch, SubtleCrypto)
//     Both Internxt and Filen have web apps that make direct browser API calls,
//     so their APIs allow CORS from any origin.
//     SMB/SFTP require OS-level TCP mounts — those throw a clear error.
//
//   _localMode=false (server available):
//     → getD/postD to v4 Node.js or v2 FastAPI server

function _cloudGuard(name, localFn) {
  if (_localMode) {
    return (async () => {
      try { return await localFn(); }
      catch (err) { console.error(`[api] LOCAL CLOUD ERROR for ${name}:`, err.message || err); throw err; }
    })();
  }
  return null;
}

export function fetchCloudDrives() {
  const g = _cloudGuard('fetchCloudDrives', () => localAdapter.cloudDrives());
  if (g) return g;
  return getD('/cloud-drives');
}
export function createCloudDrive(body) {
  const g = _cloudGuard('createCloudDrive', () => localAdapter.createCloudDrive(body));
  if (g) return g;
  return postD('/cloud-drives', body);
}
export function updateCloudDrive(id, body) {
  const g = _cloudGuard('updateCloudDrive', () => localAdapter.updateCloudDrive(id, body));
  if (g) return g;
  return putD(`/cloud-drives/${id}`, body);
}
export function deleteCloudDrive(id) {
  const g = _cloudGuard('deleteCloudDrive', () => localAdapter.deleteCloudDrive(id));
  if (g) return g;
  return delD(`/cloud-drives/${id}`);
}
export function getCloudDriveConfig(id) {
  const g = _cloudGuard('getCloudDriveConfig', () => localAdapter.getCloudDriveConfig(id));
  if (g) return g;
  return getD(`/cloud-drives/${id}/config`);
}
export function testCloudDrive(type, config) {
  const g = _cloudGuard('testCloudDrive', () => localAdapter.testCloudDrive(type, config));
  if (g) return g;
  return postD('/cloud-drives/test', { type, config });
}
export function mountCloudDrive(id) {
  const g = _cloudGuard('mountCloudDrive', () => localAdapter.mountCloudDrive(id));
  if (g) return g;
  return postD(`/cloud-drives/${id}/mount`, {});
}
export function unmountCloudDrive(id) {
  const g = _cloudGuard('unmountCloudDrive', () => localAdapter.unmountCloudDrive(id));
  if (g) return g;
  return postD(`/cloud-drives/${id}/unmount`, {});
}
export function browseCloudDrive(id, path = '/') {
  const g = _cloudGuard('browseCloudDrive', () => localAdapter.browseCloudDrive(id, path));
  if (g) return g;
  const q = new URLSearchParams({ path });
  return getD(`/cloud-drives/${id}/browse?${q}`);
}
export function ingestCloudDrive(driveId, paths, recursive, visibility, onEvent, detParams = {}) {
  // Ingest (SSE) is server-only — no LocalAdapter equivalent
  return _streamSSE(`${BASE}/cloud-drives/${driveId}/ingest`, { paths, recursive, visibility, ...detParams }, onEvent);
}
export function downloadCloudFile(driveId, filePath) {
  // Returns the server download URL — used in server mode (v4/v2 backend running)
  const q = new URLSearchParams({ path: filePath });
  return `${BASE}/cloud-drives/${driveId}/download-file?${q}`;
}

/**
 * Download a cloud file and return { blob: Blob, name: string }.
 * In local mode: uses BrowserCloudDrives.js (direct E2E decrypt in browser).
 * In server mode: fetches via the server's download-file endpoint.
 */
export async function downloadCloudFileBlob(driveId, filePath) {
  const g = _cloudGuard('downloadCloudFileBlob', () => localAdapter.downloadCloudFile(driveId, filePath));
  if (g) return g;
  // Server mode: stream through the server download endpoint
  const url  = downloadCloudFile(driveId, filePath);
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error(`Cloud download HTTP ${resp.status}`);
  const blob = await resp.blob();
  const cd   = resp.headers.get('Content-Disposition') || '';
  const name = cd.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/)?.[1]?.replace(/['"]/g, '')
             || filePath.split('/').pop();
  return { blob, name };
}

export function renameCloudDriveItem(driveId, path, newName) {
  // rename/trash/delete item ops are server-only for now (rare in WASM mode)
  return postD(`/cloud-drives/${driveId}/rename`, { path, new_name: newName });
}
export function trashCloudDriveItem(driveId, path) {
  return postD(`/cloud-drives/${driveId}/trash`, { path });
}
export function deleteCloudDriveItem(driveId, path) {
  return _fetchDirect('DELETE', `/cloud-drives/${driveId}/item`, { path });
}

// ── Filesystem browser ────────────────────────────────────────────────────────

export function copyFilesystem(paths, destDir) {
  return post('/filesystem/copy', { paths, dest_dir: destDir });
}
export function moveFilesystem(paths, destDir) {
  return post('/filesystem/move', { paths, dest_dir: destDir });
}

export function browseFilesystem(path = '') {
  // In local mode, filesystem browse requires a server session.
  // Return empty so the view shows gracefully instead of 401.
  const g = _guard('browseFilesystem', () => ({ path: path || '/', entries: [], parent: null }));
  if (g) return g;
  const q = new URLSearchParams({ path });
  return getD(`/filesystem/browse?${q}`);
}
export function addToDb(paths, recursive, onEvent, visibility = 'shared', detParams = {}) {
  const ctrl = new AbortController();
  fetch(`${BASE}/filesystem/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ paths, recursive, visibility, ...detParams }),
    signal: ctrl.signal,
  }).then(async res => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop();
      for (const chunk of lines) {
        const dataLine = chunk.split('\n').find(l => l.startsWith('data: '));
        if (dataLine) {
          try { onEvent(JSON.parse(dataLine.slice(6))); } catch { /* ignore */ }
        }
      }
    }
  }).catch(err => {
    if (err.name !== 'AbortError') console.error('addToDb SSE error:', err);
  });
  return { close: () => ctrl.abort() };
}

// ── Editing (crop / convert) ──────────────────────────────────────────────────

export function fetchEditFormats() {
  const g = _guard('fetchEditFormats', () => ({ formats: ['jpg', 'png', 'webp'] }));
  if (g) return g;
  return get('/edit/formats');
}
export function cropImage(image_id, x, y, width, height, saveAs = 'replace', newFilename = null) {
  const g = _guard('cropImage', () => ({ ok: true }));
  if (g) return g;
  return post('/edit/crop', { image_id, x, y, width, height, save_as: saveAs, new_filename: newFilename });
}
export function convertImages(params) {
  const g = _guard('convertImages', () => ({ ok: true }));
  if (g) return g;
  return post('/edit/convert', params);
}
export function adjustImage(params) {
  const g = _guard('adjustImage', () => ({ ok: true }));
  if (g) return g;
  return post('/edit/adjust', params);
}
export function cloneImageMetadata(sourceId, targetId) {
  const g = _guard('cloneImageMetadata', () => localAdapter.cloneImageMetadata(sourceId, targetId));
  if (g) return g;
  return Promise.resolve({ ok: true }); // server mode: metadata preserved by server
}

// ── BFL AI Image Editing ──────────────────────────────────────────────────────

export function outpaintImage(params)  { return post('/bfl/outpaint',  { register_in_db: false, ...params }); }
export function inpaintImage(params)   { return post('/bfl/inpaint',   { register_in_db: false, ...params }); }
export function aiEditImage(params)    { return post('/bfl/edit',      { register_in_db: false, ...params }); }
export function generateImage(params)  { return post('/bfl/generate',  { register_in_db: false, ...params }); }
export function canvasSizeImage(params) { return post('/edit/canvas-size', params); }
export function bflPreviewUrl(filepath) { return `${BASE}/bfl/preview?path=${encodeURIComponent(filepath)}`; }
export function registerBflFile(filepath) { return post('/bfl/register', { filepath }); }
export async function downloadBflFile(filepath, filename) {
  const url = bflPreviewUrl(filepath);
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
  const blob = await resp.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename || filepath.split('/').pop() || 'result.jpg';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(objectUrl);
}
export function convertBatch(params, onEvent) {
  const ctrl = new AbortController();
  fetch(`${BASE}/edit/convert-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(params),
    signal: ctrl.signal,
  }).then(async res => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop();
      for (const chunk of lines) {
        const dataLine = chunk.split('\n').find(l => l.startsWith('data: '));
        if (dataLine) {
          try { onEvent(JSON.parse(dataLine.slice(6))); } catch { /* ignore */ }
        }
      }
    }
  }).catch(err => {
    if (err.name !== 'AbortError') console.error('convertBatch SSE error:', err);
  });
  return { close: () => ctrl.abort() };
}

// ── Events ────────────────────────────────────────────────────────────────────

export function fetchEvents(gapHours = 4, limit = 200) {
  const q = new URLSearchParams({ gap_hours: gapHours, limit });
  return get(`/events?${q}`);
}

// ── Face clusters ─────────────────────────────────────────────────────────────

export function fetchUnidentifiedFaces(limit = 500) { return get(`/faces/unidentified?limit=${limit}`); }
export function fetchFaceClusters(threshold = 0.55, limit = 500, includeIdentified = false) {
  const g = _guard('fetchFaceClusters', () => localAdapter.fetchFaceClusters(threshold, limit, includeIdentified));
  if (g) return g;
  const q = new URLSearchParams({ threshold, limit, include_identified: includeIdentified });
  return get(`/faces/clusters?${q}`);
}
export function faceCropUrl(imageId, faceId, size = 128) {
  if (_localMode) {
    // In standalone mode, we return a special marker that lazySrc or our adapter can handle
    return `local-crop://${imageId}/${faceId}?size=${size}`;
  }
  return `${BASE}/faces/face-crop?image_id=${imageId}&face_id=${faceId}&size=${size}`;
}
export function assignCluster(faceIds, personName) {
  const g = _guard('assignCluster', () => localAdapter.assignCluster(faceIds, personName));
  if (g) return g;
  return post('/faces/assign-cluster', { face_ids: faceIds, person_name: personName });
}
export function reIdentifyFaces(faceIds, recThresh) {
  const g = _guard('reIdentifyFaces', () => localAdapter.reIdentifyFaces(faceIds, recThresh));
  if (g) return g;
  return post('/faces/re-identify', { face_ids: faceIds?.length ? faceIds : undefined, rec_thresh: recThresh });
}

// ── Ratings, flags, rotation ──────────────────────────────────────────────────

export function patchRating(id, rating) { return patch(`/images/${id}/rating`, { rating }); }
export function patchFlag(id, flag)     { return patch(`/images/${id}/flag`,   { flag }); }
export function rotateImage(id, direction) { return patch(`/images/${id}/rotate`, { direction }); }

// ── Albums ────────────────────────────────────────────────────────────────────

export function fetchAlbums() {
  const g = _guard('fetchAlbums', () => localAdapter.getAlbums());
  if (g) return g;
  return get('/albums');
}
export function createAlbum(name, description = '') { return post('/albums', { name, description }); }
export function updateAlbum(id, data) { return put(`/albums/${id}`, data); }
export function deleteAlbum(id) { return del(`/albums/${id}`); }
export function fetchAlbumImages(id, { sort = 'sort_order', limit = 500, offset = 0 } = {}) {
  const q = new URLSearchParams({ sort, limit, offset });
  return get(`/albums/${id}/images?${q}`);
}
export function addToAlbum(albumId, imageIds) { return post(`/albums/${albumId}/images`, { image_ids: imageIds }); }
export function removeFromAlbum(albumId, imageIds) { return _fetch('DELETE', `/albums/${albumId}/images`, { image_ids: imageIds }); }

// ── Watch folders ─────────────────────────────────────────────────────────────

export function fetchWatchFolders()        { return get('/watchfolders'); }
export function addWatchFolder(data)       { return post('/watchfolders', data); }
export function updateWatchFolder(id, data){ return put(`/watchfolders/${id}`, data); }
export function deleteWatchFolder(id)      { return del(`/watchfolders/${id}`); }
export function scanWatchFolder(id, onEvent) {
  const ctrl = new AbortController();
  fetch(`${BASE}/watchfolders/${id}/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    signal: ctrl.signal,
  }).then(async res => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop();
      for (const chunk of lines) {
        const dataLine = chunk.split('\n').find(l => l.startsWith('data: '));
        if (dataLine) {
          try { onEvent(JSON.parse(dataLine.slice(6))); } catch { /* ignore */ }
        }
      }
    }
  }).catch(err => {
    if (err.name !== 'AbortError') console.error('scanWatchFolder SSE error:', err);
  });
  return { close: () => ctrl.abort() };
}

// ── Batch Jobs ─────────────────────────────────────────────────────────────────

export function createBatchJob(params)      { return post('/batch-jobs', params); }
export function listBatchJobs()             { return get('/batch-jobs'); }
export function getBatchJob(id)             { return get(`/batch-jobs/${id}`); }
export function deleteBatchJob(id)          { return del(`/batch-jobs/${id}`); }
export function cancelBatchJob(id)          { return post(`/batch-jobs/${id}/cancel`, {}); }
export function fetchBatchJobLogs(id, { limit = 100, offset = 0 } = {}) {
  return get(`/batch-jobs/${id}/logs?limit=${limit}&offset=${offset}`);
}
export function addFileToBatchJob(jobId, data) { return post(`/batch-jobs/${jobId}/add-file`, data); }
export async function uploadBatchFile(buffer, localPath) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), localPath.split('/').pop() || 'image.jpg');
  form.append('local_path', localPath);
  const res = await fetch(`${BASE}/batch-jobs/upload-file`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  });
  if (!res.ok) throw new Error(`uploadBatchFile → ${res.status}`);
  return res.json();
}
export function startBatchJob(id, onEvent, retry = false) {
  const q = retry ? '?retry=true' : '';
  return _streamSSE(`${BASE}/batch-jobs/${id}/start${q}`, {}, onEvent);
}

export async function fetchThumbnail(id) {
  if (isLocalMode()) return localAdapter.fetchThumbnail(id);
  const res = await get(`/images/${id}/thumbnail`);
  return res.thumbnail_blob || res;
}