/**
 * api.js — Typed fetch wrappers for all FastAPI endpoints.
 */

// On Desktop, we use relative paths (/api). 
// On Mobile, we need the full URL of the remote VPS.
let BASE = '/api';

export function setRemoteBase(url) {
  BASE = url.replace(/\/$/, '') + '/api';
}

async function _fetch(method, path, body) {
  // 'include': always send cookies, even cross-origin.
  // The Electron main process uses session.webRequest to fix ACAO:* → actual origin so
  // Chromium accepts cross-origin credentialed responses without server changes.
  const opts = {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    credentials: 'include',
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(BASE + path, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

const get  = (path)        => _fetch('GET',    path);
const post = (path, body)  => _fetch('POST',   path, body);
const put  = (path, body)  => _fetch('PUT',    path, body);
const patch = (path, body) => _fetch('PATCH',  path, body);
const del  = (path)        => _fetch('DELETE', path);

// ── Images ────────────────────────────────────────────────────────────────────

export function fetchImages({ person='', tag='', scene='', folder='', path='', dateFrom='', dateTo='', sort='newest', limit=200, offset=0, unidentified=false, album=0 } = {}) {
  const q = new URLSearchParams({ person, tag, scene, folder, path, date_from: dateFrom, date_to: dateTo, sort, limit, offset, unidentified, album });
  return get(`/images?${q}`);
}

export function fetchImage(id) { return get(`/images/${id}`); }

export function thumbnailUrl(id, size = 200) { return `${BASE}/images/${id}/thumbnail?size=${size}`; }
export function previewUrl(id)               { return `${BASE}/images/${id}/preview`; }
export function fullUrl(id)                  { return `${BASE}/images/${id}/full`; }
export function downloadUrl(id)              { return `${BASE}/images/${id}/download`; }

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

export function patchMetadata(id, { description='', scene_type='', tags_csv='' }) {
  return patch(`/images/${id}/metadata`, { description, scene_type, tags_csv });
}

export function renameImage(id, new_filename) {
  return post(`/images/${id}/rename`, { new_filename });
}

export function deleteImage(id)   { return del(`/images/${id}`); }
export function openInOs(id)      { return post(`/images/${id}/open`); }
export function openFolderInOs(id) { return post(`/images/${id}/open-folder`); }
export function fetchExif(id)     { return get(`/images/${id}/exif`); }
export function fetchImageFaces(id) { return get(`/images/${id}/faces`); }
export function deleteFace(imageId, faceId) { return del(`/images/${imageId}/faces/${faceId}`); }
export function clearIdentifications(imageId) { return post(`/images/${imageId}/clear-identifications`, {}); }
export function clearDetections(imageId) { return post(`/images/${imageId}/clear-detections`, {}); }
export function reDetectFaces(imageId, params = {}) {
  const defaults = { det_thresh: 0.5, min_face_size: 60, rec_thresh: 0.4, skip_vlm: true, det_model: 'auto', max_size: 0 };
  return post(`/images/${imageId}/re-detect`, { ...defaults, ...params });
}
export function addManualFace(imageId, bbox, rec_thresh = null) {
  return post(`/images/${imageId}/faces/manual`, { bbox, rec_thresh });
}

// ── People ────────────────────────────────────────────────────────────────────

export function fetchPeople()        { return get('/people'); }
export function fetchPerson(id)      { return get(`/people/${id}`); }
export function renamePerson(id, name) { return put(`/people/${id}`, { name }); }
export function mergePeople(source_id, target_id) { return post('/people/merge', { source_id, target_id }); }
export function reassignFace(face_id, new_name) { return post('/people/reassign-face', { face_id, new_name }); }
export function deletePerson(id)     { return del(`/people/${id}`); }

// ── Search ────────────────────────────────────────────────────────────────────

export function searchImages(q, limit = 50) {
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

/**
 * Mode C: import pre-computed thumbnail + embeddings from local Electron processing.
 * VPS does FAISS person-matching only.
 */
export function importProcessed(data) {
  return post('/ingest/import-processed', data);
}

/**
 * Mode B: upload a full local image to VPS for processing.
 * Accepts an ArrayBuffer (from IPC readLocalFile) and the original local path.
 */
export async function uploadLocal(buffer, localPath, visibility = 'shared', detParams = {}) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), localPath.split('/').pop() || 'image.jpg');
  form.append('local_path', localPath);
  form.append('visibility', visibility);
  if (detParams.det_thresh    != null) form.append('det_thresh',    String(detParams.det_thresh));
  if (detParams.min_face_size != null) form.append('min_face_size', String(detParams.min_face_size));
  if (detParams.rec_thresh    != null) form.append('rec_thresh',    String(detParams.rec_thresh));
  if (detParams.det_model)             form.append('det_model',     detParams.det_model);
  if (detParams.max_size      != null) form.append('max_size',      String(detParams.max_size));
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

/**
 * Stream batch processing via Server-Sent Events.
 * Returns an EventSource-like object.
 * onEvent(data) — called for each SSE message
 * Returns the EventSource so caller can close() it.
 */
export function streamBatchFiles(paths, onEvent) {
  return _streamSSE(`${BASE}/process/batch-files`, { paths }, onEvent);
}

export function streamBatch(folder, recursive, onEvent, detParams = {}) {
  return _streamSSE(`${BASE}/process/batch`, { folder, recursive, ...detParams }, onEvent);
}

function _streamSSE(url, body, onEvent) {
  // SSE via POST body — use fetch + ReadableStream (EventSource only supports GET)
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

export function fetchHealth() { return get('/health'); }

export function login(username, password) { return post('/auth/login', { username, password }); }
export function logout()                  { return post('/auth/logout'); }
export function fetchMe()                 { return get('/auth/me'); }

// ── User management (admin only) ──────────────────────────────────────────────

export function listUsers()                         { return get('/users'); }
export function createUser(username, password, role, allowed_folders = []) {
  return post('/users', { username, password, role, allowed_folders });
}
export function updateUser(userId, changes)         { return _fetch('PATCH', `/users/${userId}`, changes); }
export function deleteUser(userId)                  { return del(`/users/${userId}`); }
export function resetUserLock(userId)               { return post(`/users/${userId}/reset-lock`, {}); }

// ── Image sharing ─────────────────────────────────────────────────────────────

export function getImageShares(imageId)             { return get(`/images/${imageId}/shares`); }
export function shareImage(imageId, userIds)        { return post(`/images/${imageId}/share`, { user_ids: userIds }); }
export function unshareImage(imageId, userId)       { return del(`/images/${imageId}/share/${userId}`); }
export function setImageVisibility(imageId, visibility) {
  return post(`/images/${imageId}/visibility`, { visibility });
}

// ── Settings ──────────────────────────────────────────────────────────────────

export function fetchSettings()                     { return get('/settings'); }
export function saveSettings(body)                  { return put('/settings', body); }
export function fetchTranslations()                 { return get('/settings/i18n'); }
export function checkCredentials(username, password){ return post('/settings/check-credentials', { username, password }); }
export function fetchDbStatus()                     { return get('/settings/db-status'); }
export function fetchEngineStatus()                 { return get('/settings/engine-status'); }
export function reloadEngine()                      { return post('/settings/reload-engine', {}); }
export function fetchUserVlmPrefs()                 { return get('/settings/user-vlm'); }

// ── Admin operations ──────────────────────────────────────────────────────────

/**
 * Stream the server update (fix_db.sh) output.
 * Returns a native Response whose body is an SSE stream.
 * The caller reads from response.body (ReadableStream).
 */
/** Raw fetch for the SSE test endpoint — no body needed. */
export function testAdminStream() {
  return fetch(`${BASE}/admin/test-stream`, { credentials: 'include' });
}

export function streamServerUpdate(root_password, fix_db_path = '') {
  return fetch(`${BASE}/admin/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ root_password, fix_db_path }),
  });
}

/** Return last N lines of the server application log (30 s timeout covers body). */
export async function fetchServerLogs(lines = 300) {
  const controller = new AbortController();
  // Keep the timeout active through res.json() — not just the headers phase.
  const tid = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`${BASE}/admin/logs?lines=${lines}`, {
      credentials: 'include',
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      let detail = text;
      try { detail = JSON.parse(text).detail || text; } catch { /* keep raw */ }
      clearTimeout(tid);
      throw new Error(`[HTTP ${res.status}] ${detail}`);
    }
    const data = await res.json();   // timeout still armed while reading body
    clearTimeout(tid);
    return data;
  } catch (e) {
    clearTimeout(tid);
    if (e.name === 'AbortError') throw new Error('Request timed out (30 s) — check Apache mod_deflate');
    throw e;
  }
}

export function saveUserVlmPrefs(prefs)             { return put('/settings/user-vlm', prefs); }
export function fetchUserDetPrefs()                 { return get('/settings/user-detection'); }
export function saveUserDetPrefs(prefs)             { return put('/settings/user-detection', prefs); }
export function changePassword(current_password, new_password) {
  return post('/auth/change-password', { current_password, new_password });
}

// ── API keys ──────────────────────────────────────────────────────────────────

export function fetchProviders()              { return get('/api-keys/providers'); }
export function fetchKeyStatus()              { return get('/api-keys/status'); }
export function fetchVlmModels(provider)      { return get(`/api-keys/models/${provider}`); }
export function saveApiKey(provider, api_key, scope = 'system') {
  return post('/api-keys', { provider, api_key, scope });
}
export function deleteApiKey(provider, scope = 'system') {
  return del(`/api-keys/${provider}?scope=${scope}`);
}
export function testApiKey(provider) { return post(`/api-keys/test/${provider}`, {}); }

// ── Tags & Stats ──────────────────────────────────────────────────────────────

export function fetchTags()       { return get('/tags'); }
export function fetchTagsStats()  { return get('/tags/stats'); }
export function fetchDatesStats() { return get('/dates/stats'); }
export function fetchFoldersStats() { return get('/folders/stats'); }
export function fetchSceneTypes() { return get('/scene-types'); }
export function fetchStats()      { return get('/stats'); }

// ── Duplicates ────────────────────────────────────────────────────────────────

export function fetchDuplicateStats() {
  return get('/duplicates/stats');
}

export function fetchDuplicateGroups(method = 'hash', threshold = 8) {
  const q = new URLSearchParams({ method, threshold });
  return get(`/duplicates/groups?${q}`);
}

export function resolveDuplicate(keep_id, delete_ids, action = 'delete_file', merge_faces = true) {
  return post('/duplicates/resolve', { keep_id, delete_ids, action, merge_faces });
}

export function resolveDuplicateBatch(groups, action = 'delete_file', merge_faces = true) {
  return post('/duplicates/resolve-batch', { groups, action, merge_faces });
}

export function scanPhash(onEvent) {
  const ctrl = new AbortController();
  fetch(`${BASE}/duplicates/scan-phash`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    signal: ctrl.signal,
  }).then(async res => {
    // Non-streaming response (imagehash not available)
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

/**
 * Request a cleanup script from the server and trigger a browser download.
 * files: [{origin_path, server_path, kept_origin_path, filename}]
 * format: 'bash' | 'powershell' | 'json'
 * action: 'trash' | 'delete' | 'symlink'
 */
export async function downloadCleanupScript(files, format = 'bash', action = 'trash') {
  const resp = await fetch(`${BASE}/duplicates/cleanup-script`, {
    method:      'POST',
    headers:     { 'Content-Type': 'application/json' },
    credentials: 'include',
    body:         JSON.stringify({ files, format, action }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
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

/**
 * Ingest (download + process) files from a cloud drive via SSE.
 * paths: string[]  (paths within the drive)
 * Returns { close() } to abort.
 */
export function ingestCloudDrive(driveId, paths, recursive, visibility, onEvent) {
  return _streamSSE(
    `${BASE}/cloud-drives/${driveId}/ingest`,
    { paths, recursive, visibility },
    onEvent,
  );
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

/**
 * Add filesystem paths to the DB via SSE (same pattern as streamBatch).
 * paths: string[]  (files or directories)
 * recursive: bool
 * onEvent(data) called per SSE message.
 * Returns { close() } to abort.
 */
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

export function fetchEditFormats() { return get('/edit/formats'); }

export function cropImage(image_id, x, y, width, height, saveAs = 'replace', newFilename = null) {
  return post('/edit/crop', { image_id, x, y, width, height, save_as: saveAs, new_filename: newFilename });
}

export function convertImages(params) {
  return post('/edit/convert', params);
}

export function adjustImage(params) {
  return post('/edit/adjust', params);
}

// ── BFL AI Image Editing ──────────────────────────────────────────────────────

// register=false by default → file saved to disk, NOT added to DB.
// Call registerBflFile() later to add to DB when the user explicitly requests it.
export function outpaintImage(params)  { return post('/bfl/outpaint',  { register: false, ...params }); }
export function inpaintImage(params)   { return post('/bfl/inpaint',   { register: false, ...params }); }
export function aiEditImage(params)    { return post('/bfl/edit',      { register: false, ...params }); }
export function generateImage(params)  { return post('/bfl/generate',  { register: false, ...params }); }
export function canvasSizeImage(params) { return post('/edit/canvas-size', params); }

/** URL to preview a generated file by server path (requires credentials). */
export function bflPreviewUrl(filepath) {
  return `${BASE}/bfl/preview?path=${encodeURIComponent(filepath)}`;
}

/** Register a previously-generated file in the images DB. Returns { new_image_id }. */
export function registerBflFile(filepath) {
  return post('/bfl/register', { filepath });
}

/** Download a generated file (fetches with auth, triggers browser download). */
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

export function fetchUnidentifiedFaces(limit = 500) {
  return get(`/faces/unidentified?limit=${limit}`);
}
export function fetchFaceClusters(threshold = 0.55, limit = 500, includeIdentified = false) {
  const q = new URLSearchParams({ threshold, limit, include_identified: includeIdentified });
  return get(`/faces/clusters?${q}`);
}
export function faceCropUrl(imageId, faceId, size = 128) {
  return `${BASE}/faces/face-crop?image_id=${imageId}&face_id=${faceId}&size=${size}`;
}
export function assignCluster(faceIds, personName) {
  return post('/faces/assign-cluster', { face_ids: faceIds, person_name: personName });
}

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

export function addToAlbum(albumId, imageIds) {
  return post(`/albums/${albumId}/images`, { image_ids: imageIds });
}

export function removeFromAlbum(albumId, imageIds) {
  return _fetch('DELETE', `/albums/${albumId}/images`, { image_ids: imageIds });
}

// ── Watch folders ─────────────────────────────────────────────────────────────

export function fetchWatchFolders()        { return get('/watchfolders'); }
export function addWatchFolder(data)       { return post('/watchfolders', data); }
export function updateWatchFolder(id, data){ return put(`/watchfolders/${id}`, data); }
export function deleteWatchFolder(id)      { return del(`/watchfolders/${id}`); }

/**
 * Trigger a scan of a watch folder via SSE.
 * Returns { close() } to abort.
 */
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
