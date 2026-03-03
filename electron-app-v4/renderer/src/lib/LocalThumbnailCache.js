/**
 * LocalThumbnailCache.js — Canvas-based thumbnail generator + Cache API storage.
 *
 * Replaces GET /api/images/:id/thumbnail in standalone (local SQLite) mode.
 * Generates JPEG thumbnails via Canvas.drawImage + toDataURL, caches them
 * in the browser's Cache API (survives page reloads in Capacitor WKWebView).
 *
 * Usage:
 *   const dataUrl = await localThumb(nativePath, size);
 *   // → data:image/jpeg;base64,...  or  blob:capacitor://localhost/...
 */

import { Capacitor } from '@capacitor/core';

const THUMB_CACHE_NAME = 'crisplens-local-thumbs-v1';

// Snap size to standard buckets to maximise cache hit rate
const BUCKETS = [150, 200, 300, 400, 600, 800];
function _snap(size) {
  return BUCKETS.find(b => b >= size) ?? BUCKETS[BUCKETS.length - 1];
}

// In-memory LRU (path+size → blob URL) — avoids re-decoding on same page load
const _memCache = new Map();
const MEM_MAX = 500;

function _memKey(filepath, size) { return `${size}:${filepath}`; }

/** Generate or retrieve a cached thumbnail for a native filepath. Returns a URL string. */
export async function localThumb(filepath, size = 200) {
  if (!filepath) return '';
  const snapped = _snap(size);
  const memKey = _memKey(filepath, snapped);

  // 1. Memory cache
  if (_memCache.has(memKey)) return _memCache.get(memKey);

  // 2. Cache API (persistent across reloads)
  const cacheKey = `local-thumb://${snapped}/${encodeURIComponent(filepath)}`;
  if ('caches' in globalThis) {
    try {
      const cache = await caches.open(THUMB_CACHE_NAME);
      const cached = await cache.match(cacheKey);
      if (cached) {
        const blob = await cached.blob();
        const url = URL.createObjectURL(blob);
        _putMem(memKey, url);
        return url;
      }
    } catch { /* ignore cache errors */ }
  }

  // 3. Generate via Canvas
  const webUrl = Capacitor.convertFileSrc(filepath);
  const dataUrl = await _generateCanvas(webUrl, snapped);
  if (!dataUrl) return webUrl; // fallback to full-res if canvas fails

  // Store in Cache API as blob
  if ('caches' in globalThis) {
    try {
      const blob = await _dataUrlToBlob(dataUrl);
      const cache = await caches.open(THUMB_CACHE_NAME);
      await cache.put(cacheKey, new Response(blob, { headers: { 'Content-Type': 'image/jpeg' } }));
      const url = URL.createObjectURL(blob);
      _putMem(memKey, url);
      return url;
    } catch { /* ignore */ }
  }

  return dataUrl;
}

function _putMem(key, url) {
  if (_memCache.size >= MEM_MAX) {
    const oldest = _memCache.keys().next().value;
    const oldUrl = _memCache.get(oldest);
    if (oldUrl?.startsWith('blob:')) URL.revokeObjectURL(oldUrl);
    _memCache.delete(oldest);
  }
  _memCache.set(key, url);
}

function _generateCanvas(webUrl, size) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const aspect = img.naturalHeight / img.naturalWidth;
        const w = size;
        const h = Math.round(size * aspect);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = webUrl;
  });
}

function _dataUrlToBlob(dataUrl) {
  const [header, b64] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return Promise.resolve(new Blob([arr], { type: mime }));
}

/** Clear the thumbnail cache (call when DB is cleared). */
export async function clearLocalThumbCache() {
  _memCache.clear();
  if ('caches' in globalThis) {
    await caches.delete(THUMB_CACHE_NAME);
  }
}
