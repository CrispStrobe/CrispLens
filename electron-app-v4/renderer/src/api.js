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
    const files = [];
    const params = {};
    const blobToBase64 = (blob) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    for (const [key, value] of formData.entries()) {
      if (value instanceof Blob || value instanceof File) {
        const base64 = await blobToBase64(value);
        files.push({ key, data: base64, name: value.name || 'file.jpg' });
      } else {
        params[key] = String(value);
      }
    }
    try {
      const res = await CapacitorHttp.upload({
        url, files, params,
        headers: { ...options.headers, ...(options.credentials === 'include' ? { 'X-Capacitor-HTTP-Cookies': 'true' } : {}) }
      });
      return {
        ok: res.status >= 200 && res.status < 300, status: res.status,
        json: async () => res.data,
        text: async () => typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
      };
    } catch (err) {
      throw new Error(err.message || JSON.stringify(err));
    }
  }
  return fetch(url, { ...options, method: 'POST', body: formData });
}

/** Fetch an image as an Object URL (bypassing CORS/Cookie issues on mobile) */
export async function fetchImageAsUrl(url) {
  if (Capacitor.isNativePlatform()) {
    try {
      const res = await CapacitorHttp.get({ url, responseType: 'blob', headers: { 'X-Capacitor-HTTP-Cookies': 'true' } });
      if (typeof res.data === 'string') {
        const contentType = res.headers['Content-Type'] || res.headers['content-type'] || 'image/jpeg';
        if (res.data.startsWith('data:')) return res.data;
        return URL.createObjectURL(base64ToBlob(res.data, contentType));
      }
      return res.data instanceof Blob ? URL.createObjectURL(res.data) : url;
    } catch (e) { return url; }
  }
  return url;
}

// ── Mode ──────────────────────────────────────────────────────────────────────

const _inElectron = typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined';
const _inCapacitor = typeof window !== 'undefined' && typeof (window.Capacitor ?? (globalThis.Capacitor)) !== 'undefined'
  && (globalThis.Capacitor?.isNativePlatform?.() ?? false);

let _localMode = false;
{
  const legacy = localStorage.getItem('db_mode');
  if (legacy !== null && localStorage.getItem('data_source') === null) {
    localStorage.setItem('data_source', legacy);
    localStorage.removeItem('db_mode');
  }
  const stored = localStorage.getItem('data_source');
  if (stored !== null) {
    _localMode = stored === 'local';
  } else if (_inCapacitor) {
    _localMode = true;
    localStorage.setItem('data_source', 'local');
  }
}

export function setLocalMode(enabled) {
  _localMode = enabled;
  localStorage.setItem('data_source', enabled ? 'local' : 'server');
}
export function isLocalMode() { return _localMode; }

// ── Server base URL ───────────────────────────────────────────────────────────
let BASE = (localStorage.getItem('remote_url') || '').replace(/\/$/, '') + '/api';
if (BASE === '/api') BASE = window.location.origin + '/api';

export function setRemoteBase(url) {
  BASE = url.replace(/\/$/, '') + '/api';
}

/** Helper to block server calls in standalone mode and route to localAdapter. */
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

/** Standard fetch that is guarded in standalone mode. */
async function _fetch(method, path, body) {
  const g = _guard(`_fetch ${method} ${path}`);
  if (g) return g;
  return _fetchDirect(method, path, body);
}

/** Explicit server fetch that bypasses _localMode checks. Used for FS/Cloud/Batch/BFL features. */
async function _fetchDirect(method, path, body, extraHeaders = {}) {
  const fullUrl = BASE + path;
  console.log(`[api] fetch: ${method} ${fullUrl}`, body ? '(with body)' : '');
  const opts = {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders },
    credentials: 'include',
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  try {
    const res = await robustFetch(fullUrl, opts);
    console.log(`[api] response: ${method} ${path} → ${res.status}`);
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  } catch (err) {
    const errMsg = err.message || JSON.stringify(err);
    console.error(`[api] ${method} ${path} error:`, errMsg);
    throw new Error(errMsg);
  }
}

async function _fetchDirectMultipart(method, path, formData, extraHeaders = {}) {
  const fullUrl = BASE + path;
  console.log(`[api] fetchMultipart: ${method} ${fullUrl}`);
  try {
    const res = await robustUpload(fullUrl, formData, { headers: extraHeaders, credentials: 'include' });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    }
    return res.json();
  } catch (err) { throw new Error(err.message); }
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

// ── Image response normalizer ────────────────────────────────────────────────

function normalizeImage(img) {
  if (!img || typeof img !== 'object') return img;
  if (img.star_rating == null && img.rating != null) img.star_rating = img.rating;
  if (img.rating      == null && img.star_rating != null) img.rating = img.star_rating;
  if (img.star_rating == null) img.star_rating = 0;
  if (img.rating      == null) img.rating      = 0;
  if (img.color_flag == null && img.flag      != null) img.color_flag = img.flag;
  if (img.flag       == null && img.color_flag != null) img.flag = img.color_flag;
  if (typeof img.ai_tags === 'string')
    img.ai_tags = img.ai_tags ? img.ai_tags.split(',').map(t => t.trim()).filter(Boolean) : [];
  if (!Array.isArray(img.ai_tags)) img.ai_tags = [];
  if (typeof img.ai_description === 'string' && img.ai_description.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(img.ai_description);
      if (parsed && typeof parsed.description === 'string') {
        img.ai_description = parsed.description;
        if (!img.ai_scene_type && parsed.scene_type) img.ai_scene_type = parsed.scene_type;
        if ((!img.ai_tags || !img.ai_tags.length) && Array.isArray(parsed.tags)) img.ai_tags = parsed.tags;
      }
    } catch { }
  }
  return img;
}

// ── API Methods ───────────────────────────────────────────────────────────────

export async function fetchImages(params = {}) {
  const g = _guard('fetchImages', () => localAdapter.getImages(params));
  if (g) return g;
  const { person='', tag='', scene='', folder='', path='', dateFrom='', dateTo='', sort='newest', limit=200, offset=0, unidentified=false, album=0, creator='', search_fields='' } = params;
  const q = new URLSearchParams({ person, tag, scene, folder, path, date_from: dateFrom, date_to: dateTo, sort, limit, offset, unidentified, album, creator, search_fields });
  try {
    const data = await get(`/images?${q}`);
    const images = Array.isArray(data) ? data : (data.images ?? []);
    return images.map(normalizeImage);
  } catch (e) {
    if (!navigator.onLine || /fetch|network|Failed/i.test(e.message)) return syncManager.getImages({ sort, limit, offset, person, tag });
    throw e;
  }
}

export function fetchImage(id) {
  const g = _guard('fetchImage', () => localAdapter.getImage(id));
  if (g) return g;
  return get(`/images/${id}`).then(normalizeImage);
}

const _THUMB_BUCKETS = [150, 200, 300, 400, 600, 800, 1000];
function _snapSize(size) { return _THUMB_BUCKETS.find(b => b >= size) ?? _THUMB_BUCKETS[_THUMB_BUCKETS.length - 1]; }
function _localImgUrl(id) {
  const b64 = thumbCache.get(String(id));
  if (b64) return b64.startsWith('data:') ? b64 : `data:image/jpeg;base64,${b64}`;
  if (Capacitor.isNativePlatform()) return toWebUrl(fileCache.get(String(id)) || '');
  return ''; 
}

export function thumbnailUrl(id, size = 200) { return _localMode ? _localImgUrl(id) : `${BASE}/images/${id}/thumbnail?size=${_snapSize(size)}`; }
export function previewUrl(id) { return _localMode ? _localImgUrl(id) : `${BASE}/images/${id}/preview`; }
export function fullUrl(id) { return _localMode ? _localImgUrl(id) : `${BASE}/images/${id}/full`; }
export function downloadUrl(id) { return `${BASE}/images/${id}/download`; }

export function downloadImage(id, filename) {
  const a = Object.assign(document.createElement('a'), { href: downloadUrl(id), download: filename || `image_${id}` });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

export function patchMetadata(id, params) {
  const g = _guard('patchMetadata', () => localAdapter.patchMetadata(id, params));
  if (g) return g;
  return patch(`/images/${id}/metadata`, params);
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

export function renameImage(id, new_filename) { return post(`/images/${id}/rename`, { new_filename }); }
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
  return post(`/images/${imageId}/re-detect`, params);
}
export function addManualFace(imageId, bbox, rec_thresh = null) {
  const g = _guard('addManualFace', () => ({ ok: true }));
  if (g) return g;
  return post(`/images/${imageId}/faces/manual`, { bbox, rec_thresh });
}

export async function fetchPeople() {
  const g = _guard('fetchPeople', () => localAdapter.getPeople());
  if (g) return g;
  try { return await get('/people'); }
  catch (e) {
    if (!navigator.onLine || /fetch|network|Failed/i.test(e.message)) return syncManager.getPeople();
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

export function searchImages(q, limit = 50) {
  const g = _guard('searchImages', () => localAdapter.searchImages(q, limit));
  if (g) return g;
  return get(`/search?q=${encodeURIComponent(q)}&limit=${limit}`);
}

export function processSingle(filepath, force = false, skipFaces = false, skipVlm = false, detModel = 'auto') {
  return post('/process/single', { filepath, force, skip_faces: skipFaces, skip_vlm: skipVlm, det_model: detModel });
}
export function trainPerson(person_name, image_paths) { return post('/process/train', { person_name, image_paths }); }
export function trainFromFolder(folder) { return post('/process/train/folder', { folder }); }
export function scanFolder(folder, recursive = true) { return postD('/process/scan-folder', { folder, recursive }); }

export function importProcessed(data) {
  const g = _guard('importProcessed', () => localAdapter.importProcessed(data));
  if (g) return g;
  return post('/ingest/import-processed', data);
}

export async function uploadLocal(buffer, localPath, visibility = 'shared', detParams = {}, { tagIds = [], newTagNames = [], albumId = null, newAlbumName = null, creator = null, copyright = null } = {}) {
  const h = await _bflHeaders();
  const form = new FormData();
  form.append('file', new Blob([buffer]), localPath.split('/').pop() || 'image.jpg');
  form.append('local_path', localPath);
  form.append('visibility', visibility);
  for (const [k, v] of Object.entries(detParams)) { if (v !== null) form.append(k, String(v)); }
  if (tagIds.length) form.append('tag_ids', JSON.stringify(tagIds));
  if (newTagNames.length) form.append('new_tag_names', JSON.stringify(newTagNames));
  if (albumId != null) form.append('album_id', String(albumId));
  if (newAlbumName) form.append('new_album_name', newAlbumName);
  if (creator) form.append('creator', creator);
  if (copyright) form.append('copyright', copyright);
  return _fetchDirectMultipart('POST', '/ingest/upload-local', form, h);
}

export function streamBatchFiles(paths, onEvent) { return _streamSSE(`${BASE}/process/batch-files`, { paths }, onEvent); }
export function streamBatch(folder, recursive, onEvent, detParams = {}) { return _streamSSE(`${BASE}/process/batch`, { folder, recursive, ...detParams }, onEvent); }

function _streamSSE(url, body, onEvent) {
  const ctrl = new AbortController();
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body), signal: ctrl.signal })
    .then(async res => {
      const reader = res.body.getReader(), decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n'); buffer = lines.pop();
        for (const chunk of lines) {
          const dataLine = chunk.split('\n').find(l => l.startsWith('data: '));
          if (dataLine) try { onEvent(JSON.parse(dataLine.slice(6))); } catch { }
        }
      }
    }).catch(err => { if (err.name !== 'AbortError') console.error('SSE error:', err); });
  return { close: () => ctrl.abort() };
}

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

export function listUsers()                         { return getD('/users'); }
export function createUser(username, password, role, allowed_folders = []) { return postD('/users', { username, password, role, allowed_folders }); }
export function updateUser(userId, changes)         { return _fetchDirect('PATCH', `/users/${userId}`, changes); }
export function deleteUser(userId)                  { return delD(`/users/${userId}`); }
export function resetUserLock(userId)               { return postD(`/users/${userId}/reset-lock`, {}); }

export function getImageShares(imageId)             { return get(`/images/${imageId}/shares`); }
export function shareImage(imageId, userIds)        { return post(`/images/${imageId}/share`, { user_ids: userIds }); }
export function unshareImage(imageId, userId)       { return del(`/images/${imageId}/share/${userId}`); }
export function setImageVisibility(imageId, visibility) { return post(`/images/${imageId}/visibility`, { visibility }); }

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
  return get(`/settings/i18n${nocache ? `?t=${Date.now()}` : ''}`);
}
export function checkCredentials(username, password){ return postD('/settings/check-credentials', { username, password }); }
export function fetchDbStatus()                     { const g = _guard('fetchDbStatus', () => localAdapter.dbStatus()); if (g) return g; return getD('/settings/db-status'); }
export function exportDB()     { const g = _guard('exportDB', () => localAdapter.exportDB()); if (g) return g; return getD('/settings/db-export'); }
export function importDB(json) { const g = _guard('importDB', () => localAdapter.importDB(json)); if (g) return g; return postD('/settings/db-import', { tables: json.tables ?? json }); }
export function clearDB()      { const g = _guard('clearDB', () => localAdapter.clearDB()); if (g) return g; return postD('/settings/db-clear', {}); }
export function hardResetApp() { const g = _guard('hardResetApp', () => localAdapter.hardResetApp()); if (g) return g; return postD('/settings/hard-reset', {}); }
export function fetchEngineStatus() {
  const g = _guard('fetchEngineStatus', () => ({ ok: true, ready: true, model: 'buffalo_l', backend: 'onnxruntime-web' }));
  if (g) return g;
  return get('/settings/engine-status');
}
export function reloadEngine() { return post('/settings/reload-engine', {}); }
export function fetchUserVlmPrefs()                 { const g = _guard('fetchUserVlmPrefs', () => localAdapter.fetchUserVlmPrefs()); if (g) return g; return get('/settings/user-vlm'); }
export function saveUserVlmPrefs(prefs)             { const g = _guard('saveUserVlmPrefs', () => localAdapter.saveUserVlmPrefs(prefs)); if (g) return g; return put('/settings/user-vlm', prefs); }
export function fetchUserDetPrefs()                 { const g = _guard('fetchUserDetPrefs', () => localAdapter.fetchUserDetPrefs()); if (g) return g; return get('/settings/user-detection'); }
export function saveUserDetPrefs(prefs)             { const g = _guard('saveUserDetPrefs', () => localAdapter.saveUserDetPrefs(prefs)); if (g) return g; return put('/settings/user-detection', prefs); }
export function changePassword(current_password, new_password) { return post('/auth/change-password', { current_password, new_password }); }

export function testAdminJson() {
  const g = _guard('testAdminJson', () => new Response('{}', { status: 200 }));
  if (g) return g;
  return fetch(`${BASE}/admin/test-json`, { credentials: 'include' });
}
export function streamServerUpdate(fix_db_path = '', opts = {}) {
  const g = _guard('streamServerUpdate', () => new Response('data: [DONE]\n\n', { status: 200 }));
  if (g) return g;
  return fetch(`${BASE}/admin/update`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ fix_db_path }), ...opts });
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

export function fetchProviders()              { const g = _guard('fetchProviders', () => localAdapter.getProviders()); if (g) return g; return getD('/api-keys/providers'); }
export function fetchKeyStatus()              { const g = _guard('fetchKeyStatus', () => localAdapter.getKeyStatus()); if (g) return g; return getD('/api-keys/status'); }
export async function fetchVlmModels(provider) {
  const g = _guard('fetchVlmModels', () => localAdapter.getVlmModels(provider));
  if (g) return g;
  const d = await getD(`/api-keys/models/${provider}`); return d.models ?? d;
}
export function saveApiKey(provider, api_key, scope = 'system') {
  const g = _guard('saveApiKey', () => localAdapter.saveApiKey(provider, api_key));
  if (g) return g;
  return postD('/api-keys', { provider, key_value: api_key, scope });
}
export function deleteApiKey(provider, scope = 'system') {
  const g = _guard('deleteApiKey', () => localAdapter.deleteApiKey(provider));
  if (g) return g;
  return delD(`/api-keys/${provider}?scope=${scope}`);
}
export function testApiKey(provider) {
  const g = _guard('testApiKey', () => localAdapter.testApiKey(provider));
  if (g) return g;
  return postD(`/api-keys/test/${provider}`, {});
}

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

export function fetchDuplicateStats() {
  const g = _guard('fetchDuplicateStats', () => ({}));
  if (g) return g;
  return get('/duplicates/stats');
}
export function fetchDuplicateGroups(method = 'hash', threshold = 8) {
  const g = _guard('fetchDuplicateGroups', () => []);
  if (g) return g;
  return get(`/duplicates/groups?method=${method}&threshold=${threshold}`);
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
  const g = _guard('scanPhash'); if (g) { onEvent({ done: true, available: false }); return { close: () => {} }; }
  return _streamSSE(`${BASE}/duplicates/scan-phash`, {}, onEvent);
}
export async function downloadCleanupScript(files, format = 'bash', action = 'trash') {
  const g = _guard('downloadCleanupScript'); if (g) return g;
  const resp = await fetch(`${BASE}/duplicates/cleanup-script`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ files, format, action }) });
  if (!resp.ok) throw new Error(`cleanup-script → ${resp.status}`);
  const blob = await resp.blob(), ext = { bash: 'sh', powershell: 'ps1', json: 'json' }[format] ?? 'txt', url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: `crisp_cleanup.${ext}` }); a.click(); URL.revokeObjectURL(url);
}
export function scanHashes(onEvent) {
  const g = _guard('scanHashes'); if (g) { onEvent({ done: true, count: 0 }); return { close: () => {} }; }
  return _streamSSE(`${BASE}/duplicates/scan-hashes`, {}, onEvent);
}

function _cloudGuard(name, localFn) {
  if (_localMode) {
    return (async () => {
      try { return await localFn(); }
      catch (err) { console.error(`[api] LOCAL CLOUD ERROR for ${name}:`, err.message || err); throw err; }
    })();
  }
  return null;
}
export function fetchCloudDrives() { const g = _cloudGuard('fetchCloudDrives', () => localAdapter.cloudDrives()); if (g) return g; return getD('/cloud-drives'); }
export function createCloudDrive(body) { const g = _cloudGuard('createCloudDrive', () => localAdapter.createCloudDrive(body)); if (g) return g; return postD('/cloud-drives', body); }
export function updateCloudDrive(id, body) { const g = _cloudGuard('updateCloudDrive', () => localAdapter.updateCloudDrive(id, body)); if (g) return g; return putD(`/cloud-drives/${id}`, body); }
export function deleteCloudDrive(id) { const g = _cloudGuard('deleteCloudDrive', () => localAdapter.deleteCloudDrive(id)); if (g) return g; return delD(`/cloud-drives/${id}`); }
export function getCloudDriveConfig(id) { const g = _cloudGuard('getCloudDriveConfig', () => localAdapter.getCloudDriveConfig(id)); if (g) return g; return getD(`/cloud-drives/${id}/config`); }
export function testCloudDrive(type, config) { const g = _cloudGuard('testCloudDrive', () => localAdapter.testCloudDrive(type, config)); if (g) return g; return postD('/cloud-drives/test', { type, config }); }
export function mountCloudDrive(id) { const g = _cloudGuard('mountCloudDrive', () => localAdapter.mountCloudDrive(id)); if (g) return g; return postD(`/cloud-drives/${id}/mount`, {}); }
export function unmountCloudDrive(id) { const g = _cloudGuard('unmountCloudDrive', () => localAdapter.unmountCloudDrive(id)); if (g) return g; return postD(`/cloud-drives/${id}/unmount`, {}); }
export function browseCloudDrive(id, path = '/') { const g = _cloudGuard('browseCloudDrive', () => localAdapter.browseCloudDrive(id, path)); if (g) return g; return getD(`/cloud-drives/${id}/browse?path=${encodeURIComponent(path)}`); }
export function ingestCloudDrive(driveId, paths, recursive, visibility, onEvent, detParams = {}) { return _streamSSE(`${BASE}/cloud-drives/${driveId}/ingest`, { paths, recursive, visibility, ...detParams }, onEvent); }
export function downloadCloudFile(driveId, filePath) { return `${BASE}/cloud-drives/${driveId}/download-file?path=${encodeURIComponent(filePath)}`; }
export async function downloadCloudFileBlob(driveId, filePath) {
  const g = _cloudGuard('downloadCloudFileBlob', () => localAdapter.downloadCloudFile(driveId, filePath));
  if (g) return g;
  const url = downloadCloudFile(driveId, filePath), resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error(`Cloud download HTTP ${resp.status}`);
  const blob = await resp.blob(), cd = resp.headers.get('Content-Disposition') || '';
  const name = cd.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/)?.[1]?.replace(/['"]/g, '') || filePath.split('/').pop();
  return { blob, name };
}
export function renameCloudDriveItem(driveId, path, newName) { return postD(`/cloud-drives/${driveId}/rename`, { path, new_name: newName }); }
export function trashCloudDriveItem(driveId, path) { return postD(`/cloud-drives/${driveId}/trash`, { path }); }
export function deleteCloudDriveItem(driveId, path) { return _fetchDirect('DELETE', `/cloud-drives/${driveId}/item`, { path }); }

export function copyFilesystem(paths, destDir) { return postD('/filesystem/copy', { paths, dest_dir: destDir }); }
export function moveFilesystem(paths, destDir) { return postD('/filesystem/move', { paths, dest_dir: destDir }); }
export function browseFilesystem(path = '') {
  const g = _guard('browseFilesystem', () => ({ path: path || '/', entries: [], parent: null }));
  if (g) return g;
  return getD(`/filesystem/browse?path=${encodeURIComponent(path)}`);
}
export function addToDb(paths, recursive, onEvent, visibility = 'shared', detParams = {}) { return _streamSSE(`${BASE}/filesystem/add`, { paths, recursive, visibility, ...detParams }, onEvent); }

export function fetchEditFormats() { const g = _guard('fetchEditFormats', () => ({ formats: ['jpg', 'png', 'webp'] })); if (g) return g; return get('/edit/formats'); }
export function cropImage(image_id, x, y, width, height, saveAs = 'replace', newFilename = null) { const g = _guard('cropImage', () => ({ ok: true })); if (g) return g; return post('/edit/crop', { image_id, x, y, width, height, save_as: saveAs, new_filename: newFilename }); }
export function convertImages(params) { const g = _guard('convertImages', () => ({ ok: true })); if (g) return g; return post('/edit/convert', params); }
export function adjustImage(params) { const g = _guard('adjustImage', () => ({ ok: true })); if (g) return g; return post('/edit/adjust', params); }
export function cloneImageMetadata(sourceId, targetId) { const g = _guard('cloneImageMetadata', () => localAdapter.cloneImageMetadata(sourceId, targetId)); if (g) return g; return Promise.resolve({ ok: true }); }

export async function outpaintImage(params) { const h = await _bflHeaders(); return _fetchDirect('POST', '/bfl/outpaint', { register_in_db: false, ...params }, h); }
export async function inpaintImage(params) { const h = await _bflHeaders(); return _fetchDirect('POST', '/bfl/inpaint', { register_in_db: false, ...params }, h); }
export async function aiEditImage(params) { const h = await _bflHeaders(); return _fetchDirect('POST', '/bfl/edit', { register_in_db: false, ...params }, h); }
export async function generateImage(params) {
  const h = await _bflHeaders();
  return _fetchDirect('POST', '/bfl/generate', { register_in_db: false, ...params }, h);
}
async function _bflHeaders() {
  if (!isLocalMode()) return {};
  try {
    const keys = await localAdapter.getKeyStatus();
    if (keys.bfl?.has_user_key || keys.bfl?.has_system_key) {
      const keyObj = await localAdapter.getApiKey('bfl', keys.bfl.has_user_key ? 'user' : 'system');
      if (keyObj?.key_value) return { 'X-BFL-API-Key': keyObj.key_value };
    }
  } catch {}
  return {};
}
export function canvasSizeImage(params) { return post('/edit/canvas-size', params); }
export function bflPreviewUrl(filepath) { return `${BASE}/bfl/preview?path=${encodeURIComponent(filepath)}`; }
export function registerBflFile(filepath) { return postD('/bfl/register', { filepath }); }
export async function downloadBflFile(filepath, filename) {
  const url = bflPreviewUrl(filepath), resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
  const blob = await resp.blob(), objectUrl = URL.createObjectURL(blob), a = Object.assign(document.createElement('a'), { href: objectUrl, download: filename || filepath.split('/').pop() || 'result.jpg' });
  a.click(); URL.revokeObjectURL(objectUrl);
}
export function convertBatch(params, onEvent) { return _streamSSE(`${BASE}/edit/convert-batch`, params, onEvent); }

export function fetchEvents(gapHours = 4, limit = 200) { return get(`/events?gap_hours=${gapHours}&limit=${limit}`); }
export function fetchUnidentifiedFaces(limit = 500) { return get(`/faces/unidentified?limit=${limit}`); }
export function fetchFaceClusters(threshold = 0.55, limit = 500, includeIdentified = false) {
  const g = _guard('fetchFaceClusters', () => localAdapter.fetchFaceClusters(threshold, limit, includeIdentified)); if (g) return g;
  return get(`/faces/clusters?threshold=${threshold}&limit=${limit}&include_identified=${includeIdentified}`);
}
export function faceCropUrl(imageId, faceId, size = 128) { return _localMode ? `local-crop://${imageId}/${faceId}?size=${size}` : `${BASE}/faces/face-crop?image_id=${imageId}&face_id=${faceId}&size=${size}`; }
export function assignCluster(faceIds, personName) { const g = _guard('assignCluster', () => localAdapter.assignCluster(faceIds, personName)); if (g) return g; return post('/faces/assign-cluster', { face_ids: faceIds, person_name: personName }); }
export function reIdentifyFaces(faceIds, recThresh) { const g = _guard('reIdentifyFaces', () => localAdapter.reIdentifyFaces(faceIds, recThresh)); if (g) return g; return post('/faces/re-identify', { face_ids: faceIds?.length ? faceIds : undefined, rec_thresh: recThresh }); }

export function patchRating(id, rating) { return patch(`/images/${id}/rating`, { rating }); }
export function patchFlag(id, flag)     { return patch(`/images/${id}/flag`,   { flag }); }
export function rotateImage(id, direction) { return patch(`/images/${id}/rotate`, { direction }); }

export function fetchAlbums() { const g = _guard('fetchAlbums', () => localAdapter.getAlbums()); if (g) return g; return get('/albums'); }
export function createAlbum(name, description = '') { return post('/albums', { name, description }); }
export function updateAlbum(id, data) { return put(`/albums/${id}`, data); }
export function deleteAlbum(id) { return del(`/albums/${id}`); }
export function fetchAlbumImages(id, { sort = 'sort_order', limit = 500, offset = 0 } = {}) { return get(`/albums/${id}/images?sort=${sort}&limit=${limit}&offset=${offset}`); }
export function addToAlbum(albumId, imageIds) { return post(`/albums/${albumId}/images`, { image_ids: imageIds }); }
export function removeFromAlbum(albumId, imageIds) { return _fetch('DELETE', `/albums/${albumId}/images`, { image_ids: imageIds }); }

export function fetchWatchFolders()        { return get('/watchfolders'); }
export function addWatchFolder(data)       { return post('/watchfolders', data); }
export function updateWatchFolder(id, data){ return put(`/watchfolders/${id}`, data); }
export function deleteWatchFolder(id)      { return del(`/watchfolders/${id}`); }
export function scanWatchFolder(id, onEvent) { return _streamSSE(`${BASE}/watchfolders/${id}/scan`, {}, onEvent); }

export function createBatchJob(params)      { return _fetchDirect('POST', '/batch-jobs', params); }
export function listBatchJobs()             { return _fetchDirect('GET', '/batch-jobs'); }
export function getBatchJob(id)             { return _fetchDirect('GET', `/batch-jobs/${id}`); }
export function deleteBatchJob(id)          { return _fetchDirect('DELETE', `/batch-jobs/${id}`); }
export function cancelBatchJob(id)          { return _fetchDirect('POST', `/batch-jobs/${id}/cancel`, {}); }
export function fetchBatchJobLogs(id, { limit = 100, offset = 0 } = {}) { return _fetchDirect('GET', `/batch-jobs/${id}/logs?limit=${limit}&offset=${offset}`); }
export function addFileToBatchJob(jobId, data) { return _fetchDirect('POST', `/batch-jobs/${jobId}/add-file`, data); }
export async function uploadBatchFile(buffer, localPath) {
  const form = new FormData(); form.append('file', new Blob([buffer]), localPath.split('/').pop() || 'image.jpg'); form.append('local_path', localPath);
  return _fetchDirectMultipart('POST', '/batch-jobs/upload-file', form);
}
export function startBatchJob(id, onEvent, retry = false) { return _streamSSE(`${BASE}/batch-jobs/${id}/start${retry ? '?retry=true' : ''}`, {}, onEvent); }

export async function fetchThumbnail(id) {
  if (isLocalMode()) return localAdapter.fetchThumbnail(id);
  const res = await get(`/images/${id}/thumbnail`);
  return res.thumbnail_blob || res;
}
