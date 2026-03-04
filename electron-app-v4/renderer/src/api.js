/**
 * api.js — Typed fetch wrappers for all FastAPI/v4-Node endpoints.
 *
 * Three modes, controlled by localStorage key 'db_mode':
 *   'server' (default) — HTTP fetch to a v4 Node.js or v2 FastAPI server
 *   'local'            — @capacitor-community/sqlite directly on-device (no server)
 *
 * All Svelte components use this file unchanged regardless of mode.
 */

import syncManager from './lib/SyncManager.js';
import { localAdapter, fileCache, toWebUrl } from './lib/LocalAdapter.js';
import { localThumb } from './lib/LocalThumbnailCache.js';

export { localThumb };

// ── Mode ──────────────────────────────────────────────────────────────────────

let _localMode = localStorage.getItem('db_mode') === 'local';
// Default to server mode if no mode is stored
if (localStorage.getItem('db_mode') === null) {
  _localMode = false;
  localStorage.setItem('db_mode', 'server');
}
console.log(`[api] Initializing. localMode=${_localMode} (db_mode=${localStorage.getItem('db_mode')})`);

/** Switch to local SQLite mode (standalone Capacitor — no server needed). */
export function setLocalMode(enabled) {
  console.log(`[api] setLocalMode(${enabled})`);
  _localMode = enabled;
  localStorage.setItem('db_mode', enabled ? 'local' : 'server');
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
    console.log(`[api] Standalone mode: intercepting call to ${msg}.`);
    return fallbackFn ? Promise.resolve(fallbackFn()) : Promise.resolve(null);
  }
  return null;
}

async function _fetch(method, path, body) {
  if (_localMode) {
    console.warn(`[api] _fetch(${method}, ${path}) called in local mode!`);
    throw new Error('Server calls disabled in standalone mode');
  }
  
  const fullUrl = BASE + path;
  console.log(`[api] fetch: ${method} ${fullUrl}`, body ? '(with body)' : '');

  const opts = {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    credentials: 'include',
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(fullUrl, opts);
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
    console.error(`[api] ${method} ${path} error:`, err);
    throw err;
  }
}

const get  = (path)        => _fetch('GET',    path);
const post = (path, body)  => _fetch('POST',   path, body);
const put  = (path, body)  => _fetch('PUT',    path, body);
const patch = (path, body) => _fetch('PATCH',  path, body);
const del  = (path)        => _fetch('DELETE', path);

// ── Images ────────────────────────────────────────────────────────────────────

export async function fetchImages(params = {}) {
  const g = _guard('fetchImages', () => localAdapter.getImages(params));
  if (g) return g;

  const { person='', tag='', scene='', folder='', path='', dateFrom='', dateTo='',
          sort='newest', limit=200, offset=0, unidentified=false, album=0 } = params;
  const q = new URLSearchParams({ person, tag, scene, folder, path, date_from: dateFrom,
                                   date_to: dateTo, sort, limit, offset, unidentified, album });
  try {
    const data = await get(`/images?${q}`);
    return Array.isArray(data) ? data : (data.images ?? []);
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
  return get(`/images/${id}`);
}

const _THUMB_BUCKETS = [150, 200, 300, 400, 600, 800, 1000];
function _snapSize(size) {
  return _THUMB_BUCKETS.find(b => b >= size) ?? _THUMB_BUCKETS[_THUMB_BUCKETS.length - 1];
}
export function thumbnailUrl(id, size = 200) {
  if (_localMode) return toWebUrl(fileCache.get(id) || '');
  return `${BASE}/images/${id}/thumbnail?size=${_snapSize(size)}`;
}
export function previewUrl(id) {
  if (_localMode) return toWebUrl(fileCache.get(id) || '');
  return `${BASE}/images/${id}/preview`;
}
export function fullUrl(id) {
  if (_localMode) return toWebUrl(fileCache.get(id) || '');
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
  const { description='', scene_type='', tags_csv='' } = params;
  return patch(`/images/${id}/metadata`, { description, scene_type, tags_csv });
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
export function deleteFace(imageId, faceId) { return del(`/images/${imageId}/faces/${faceId}`); }
export function clearIdentifications(imageId) {
  const g = _guard('clearIdentifications', () => ({ ok: true }));
  if (g) return g;
  return post(`/images/${imageId}/clear-identifications`, {});
}
export function clearDetections(imageId) {
  const g = _guard('clearDetections', () => ({ ok: true }));
  if (g) return g;
  return post(`/images/${imageId}/clear-detections`, {});
}
export function reDetectFaces(imageId, params = {}) {
  const g = _guard('reDetectFaces', () => ({ ok: true }));
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

export async function uploadLocal(buffer, localPath, visibility = 'shared', detParams = {}, { tagIds = [], newTagNames = [], albumId = null, newAlbumName = null } = {}) {
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
  const res = await fetch(`${BASE}/ingest/upload-local`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`upload-local → ${res.status}: ${text}`);
  }
  return res.json();
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
export function fetchEngineStatus()                 {
  const g = _guard('fetchEngineStatus', () => ({ ok: true, ready: true, model: 'buffalo_l', backend: 'onnxruntime-web' }));
  if (g) return g;
  return get('/settings/engine-status');
}
export function reloadEngine()                      { return post('/settings/reload-engine', {}); }
export function fetchUserVlmPrefs()                 { const g = _guard('fetchUserVlmPrefs', () => ({ effective: {}, global: {} })); if (g) return g; return get('/settings/user-vlm'); }
export function saveUserVlmPrefs(prefs)             { const g = _guard('saveUserVlmPrefs', () => ({})); if (g) return g; return put('/settings/user-vlm', prefs); }
export function fetchUserDetPrefs()                 { const g = _guard('fetchUserDetPrefs', () => ({ effective: {}, global: {} })); if (g) return g; return get('/settings/user-detection'); }
export function saveUserDetPrefs(prefs)             { const g = _guard('saveUserDetPrefs', () => ({})); if (g) return g; return put('/settings/user-detection', prefs); }
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
export function fetchTagsStats()  {
  const g = _guard('fetchTagsStats', () => []);
  if (g) return g;
  return get('/tags/stats');
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

export function fetchCloudDrives() { return get('/cloud-drives'); }
export function getCloudDriveConfig(id) { return get(`/cloud-drives/${id}/config`); }
export function browseCloudDrive(id, path = '/') {
  const q = new URLSearchParams({ path });
  return get(`/cloud-drives/${id}/browse?${q}`);
}
export function ingestCloudDrive(driveId, paths, recursive, visibility, onEvent) {
  return _streamSSE(`${BASE}/cloud-drives/${driveId}/ingest`, { paths, recursive, visibility }, onEvent);
}
export function renameCloudDriveItem(driveId, path, newName) {
  return post(`/cloud-drives/${driveId}/rename`, { path, new_name: newName });
}
export function trashCloudDriveItem(driveId, path) {
  return post(`/cloud-drives/${driveId}/trash`, { path });
}
export function deleteCloudDriveItem(driveId, path) {
  return fetch(`${BASE}/cloud-drives/${driveId}/item`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ path }),
  }).then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(new Error(e.detail || JSON.stringify(e)))));
}

// ── Filesystem browser ────────────────────────────────────────────────────────

export function browseFilesystem(path = '') {
  const q = new URLSearchParams({ path });
  return get(`/filesystem/browse?${q}`);
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
  const q = new URLSearchParams({ threshold, limit, include_identified: includeIdentified });
  return get(`/faces/clusters?${q}`);
}
export function faceCropUrl(imageId, faceId, size = 128) { return `${BASE}/faces/face-crop?image_id=${imageId}&face_id=${faceId}&size=${size}`; }
export function assignCluster(faceIds, personName) { return post('/faces/assign-cluster', { face_ids: faceIds, person_name: personName }); }

// ── Ratings, flags, rotation ──────────────────────────────────────────────────

export function patchRating(id, rating) { return patch(`/images/${id}/rating`, { rating }); }
export function patchFlag(id, flag)     { return patch(`/images/${id}/flag`,   { flag }); }
export function rotateImage(id, direction) { return patch(`/images/${id}/rotate`, { direction }); }

// ── Albums ────────────────────────────────────────────────────────────────────

export function fetchAlbums() { return get('/albums'); }
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
