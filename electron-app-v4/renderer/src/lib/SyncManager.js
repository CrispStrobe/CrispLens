/**
 * SyncManager.js — offline sync for browser / mobile (Capacitor)
 *
 * Two-layer local storage:
 *   • IndexedDB  — image metadata + people list + person embeddings + push queue
 *   • Cache API  — thumbnails (binary blobs, served by SW CacheFirst policy)
 *
 * The service worker (vite-plugin-pwa, CacheFirst for thumbnail endpoints)
 * automatically caches thumbnails as they are viewed.
 * Calling `sync()` explicitly prefetches metadata + thumbnails for the last
 * N images so the gallery works fully offline.
 *
 * Bidirectional:
 *   Pull  — `sync()` downloads images, people, person embeddings from server
 *   Push  — `pushPending()` uploads locally-processed images queued offline
 *
 * Size management:
 *   • `maxItems`  — keep at most this many images in IDB + thumbnail cache
 *   • `maxSizeMb` — evict oldest entries when estimated cache exceeds this
 */

const IDB_NAME    = 'crisplens-offline-v1';
const IDB_VERSION = 2;   // V2 adds person_embeddings + pending_push stores
const THUMB_CACHE = 'crisplens-thumbnails';   // must match vite.config.js workbox cacheName
const SYNC_SETTINGS_KEY = 'crisplens_sync_settings';

// Thumb size buckets (must match api.js _THUMB_BUCKETS)
const _THUMB_BUCKETS = [150, 200, 300, 400, 600, 800, 1000];
function _snapSize(size) {
  return _THUMB_BUCKETS.find(b => b >= size) ?? _THUMB_BUCKETS.at(-1);
}

// ── IndexedDB helpers ─────────────────────────────────────────────────────────

function _req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror   = () => reject(r.error);
  });
}

function _txComplete(tx) {
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}

/** Decode base64 string → Float32Array (for server-sent embeddings). */
function _b64ToFloat32(b64) {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const u8  = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Float32Array(buf);
}

/** Cosine similarity between two Float32Arrays (L2-normalised vectors). */
function _cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
}

function _openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      // ── V1 stores (created fresh or already exist) ──────────────────────────
      if (!db.objectStoreNames.contains('images')) {
        const store = db.createObjectStore('images', { keyPath: 'id' });
        store.createIndex('synced_at', 'synced_at', { unique: false });
        store.createIndex('created_at', 'created_at', { unique: false });
      }
      if (!db.objectStoreNames.contains('people')) {
        db.createObjectStore('people', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      // ── V2 additions ────────────────────────────────────────────────────────
      if (e.oldVersion < 2) {
        // One representative 512D embedding per known person (for offline recognition)
        db.createObjectStore('person_embeddings', { keyPath: 'id' });
        // Outbound queue: locally-processed payloads awaiting push to server
        const ps = db.createObjectStore('pending_push', { keyPath: 'id', autoIncrement: true });
        ps.createIndex('queued_at', 'queued_at', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// ── SyncManager ───────────────────────────────────────────────────────────────

class SyncManager {
  constructor() {
    this._db        = null;
    this.syncing    = false;
    this._cancelled = false;
  }

  async _getDB() {
    if (!this._db) this._db = await _openDB();
    return this._db;
  }

  // ── Pull (server → local) ──────────────────────────────────────────────────

  /**
   * Download the last `maxItems` images + people + person embeddings from the
   * API server and cache them locally. Thumbnails are prefetched so the SW
   * CacheFirst policy stores them for offline viewing.
   *
   * @param {object} opts
   *   apiBase     — e.g. 'http://192.168.1.5:7861' or '' for same-origin
   *   maxItems    — max images to keep (default 500)
   *   maxSizeMb   — evict oldest when cache exceeds this (default 500)
   *   thumbSize   — thumbnail pixel size to prefetch (default 200)
   *   onProgress  — fn({ phase, done, total, cancelled })
   */
  async sync({ apiBase = '', maxItems = 500, maxSizeMb = 500, thumbSize = 200, onProgress } = {}) {
    if (this.syncing) return;
    this.syncing = true;
    this._cancelled = false;

    const base    = apiBase.replace(/\/$/, '');
    const apiPath = base + '/api';

    const progress = (phase, done, total) => onProgress?.({ phase, done, total, cancelled: this._cancelled });

    try {
      // ── 1. Fetch image metadata ─────────────────────────────────────────────
      progress('metadata', 0, maxItems);
      const resp = await fetch(`${apiPath}/images?sort=newest&limit=${maxItems}&offset=0`, {
        credentials: 'include',
      });
      if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
      const raw    = await resp.json();
      const images = (Array.isArray(raw) ? raw : raw.images ?? []).slice(0, maxItems);

      // ── 2. Fetch people list ────────────────────────────────────────────────
      const peopleResp = await fetch(`${apiPath}/people`, { credentials: 'include' });
      const people = peopleResp.ok ? (await peopleResp.json()) : [];

      // ── 3. Store metadata in IndexedDB ──────────────────────────────────────
      const db  = await this._getDB();
      const now = Date.now();
      const tx  = db.transaction(['images', 'people', 'meta'], 'readwrite');
      for (const img of images) {
        tx.objectStore('images').put({ ...img, synced_at: now });
      }
      for (const p of people) {
        tx.objectStore('people').put({ ...p, synced_at: now });
      }
      tx.objectStore('meta').put({ key: 'last_sync', value: now, count: images.length });
      await _txComplete(tx);

      // ── 4. Fetch + store person embeddings (for offline recognition) ─────────
      progress('embeddings', 0, people.length);
      await this._pullEmbeddings(apiPath);

      // ── 5. Prefetch thumbnails (SW CacheFirst policy will cache them) ────────
      const snap = _snapSize(thumbSize);
      for (let i = 0; i < images.length; i++) {
        if (this._cancelled) break;
        progress('thumbnails', i, images.length);
        const url = `${base}/api/images/${images[i].id}/thumbnail?size=${snap}`;
        try { await fetch(url, { credentials: 'include' }); } catch { /* ignore */ }
      }
      progress('thumbnails', images.length, images.length);

      // ── 6. Evict if over size limit ─────────────────────────────────────────
      await this._evictToSize(db, maxItems, maxSizeMb);

      progress('done', images.length, images.length);
    } finally {
      this.syncing = false;
    }
  }

  cancel() { this._cancelled = true; }

  /** Pull representative embeddings per person from server, store in IDB. */
  async _pullEmbeddings(apiPath) {
    try {
      const resp = await fetch(`${apiPath}/people/embeddings`, { credentials: 'include' });
      if (!resp.ok) return;
      const people = await resp.json();
      const db = await this._getDB();
      const tx = db.transaction('person_embeddings', 'readwrite');
      for (const p of people) {
        tx.objectStore('person_embeddings').put({
          id:        p.id,
          name:      p.name,
          dim:       p.dim ?? 512,
          embedding: _b64ToFloat32(p.embedding),
          synced_at: Date.now(),
        });
      }
      await _txComplete(tx);
    } catch { /* embeddings are optional — don't fail sync if endpoint missing */ }
  }

  // ── Push (local → server) ──────────────────────────────────────────────────

  /**
   * Add an import-processed payload to the outbound push queue.
   * Called by ProcessView when importProcessed() fails due to network error.
   */
  async queueForPush(payload) {
    const db = await this._getDB();
    const tx = db.transaction('pending_push', 'readwrite');
    tx.objectStore('pending_push').add({ payload, queued_at: Date.now(), retries: 0 });
    await _txComplete(tx);
  }

  /**
   * Flush the pending-push queue to the server.
   * Successful items are deleted; failed items have their retry count incremented.
   *
   * @param {string} apiBase  — server base URL (e.g. 'http://host:7861' or '')
   * @param {function} onProgress  — fn({ done, total, pushed, failed })
   * @returns {{ pushed: number, failed: number }}
   */
  async pushPending(apiBase = '', onProgress) {
    const base = apiBase.replace(/\/$/, '');
    const db   = await this._getDB();
    const pending = await _req(
      db.transaction('pending_push', 'readonly').objectStore('pending_push').getAll()
    );
    let pushed = 0, failed = 0;

    for (let i = 0; i < pending.length; i++) {
      const item = pending[i];
      onProgress?.({ done: i, total: pending.length, pushed, failed });
      try {
        const resp = await fetch(`${base}/api/ingest/import-processed`, {
          method:      'POST',
          headers:     { 'Content-Type': 'application/json' },
          credentials: 'include',
          body:        JSON.stringify(item.payload),
        });
        if (!resp.ok) throw new Error(String(resp.status));
        // Remove successfully pushed item
        const tx = db.transaction('pending_push', 'readwrite');
        tx.objectStore('pending_push').delete(item.id);
        await _txComplete(tx);
        pushed++;
      } catch {
        failed++;
        // Increment retry counter (item stays in queue)
        const tx = db.transaction('pending_push', 'readwrite');
        tx.objectStore('pending_push').put({ ...item, retries: (item.retries || 0) + 1 });
        await _txComplete(tx);
      }
    }
    onProgress?.({ done: pending.length, total: pending.length, pushed, failed });
    return { pushed, failed };
  }

  /** Number of items waiting to be pushed to the server. */
  async getPendingCount() {
    try {
      const db = await this._getDB();
      return _req(db.transaction('pending_push', 'readonly').objectStore('pending_push').count());
    } catch { return 0; }
  }

  // ── Offline recognition ────────────────────────────────────────────────────

  /**
   * Find the best matching person for a given 512D embedding using locally
   * cached person embeddings. Returns null if no match above threshold.
   *
   * @param {Float32Array} embedding  — 512D ArcFace vector (L2-normalised)
   * @param {number} threshold        — minimum cosine similarity (default 0.4)
   */
  async searchPersons(embedding, threshold = 0.4) {
    try {
      const db = await this._getDB();
      const people = await _req(
        db.transaction('person_embeddings', 'readonly').objectStore('person_embeddings').getAll()
      );
      let best = null, bestSim = threshold;
      for (const p of people) {
        const sim = _cosine(embedding, p.embedding);
        if (sim > bestSim) { best = p; bestSim = sim; }
      }
      return best ? { person_id: best.id, name: best.name, similarity: bestSim } : null;
    } catch { return null; }
  }

  // ── Read (offline fallback) ────────────────────────────────────────────────

  /** Get images from IndexedDB. Supports sort=newest|oldest and basic pagination. */
  async getImages({ sort = 'newest', limit = 200, offset = 0, person = '', tag = '' } = {}) {
    console.log('[SyncManager] getImages offline fallback', { sort, limit, offset, person, tag });
    try {
      const db    = await this._getDB();
      const store = db.transaction('images', 'readonly').objectStore('images');
      let all     = await _req(store.getAll());
      console.log(`[SyncManager] Retrieved ${all.length} total images from IndexedDB`);

      // Sort
      if (sort === 'newest' || sort === 'date_taken_desc') {
        all.sort((a, b) => b.id - a.id);
      } else {
        all.sort((a, b) => a.id - b.id);
      }

      // Basic person filter (match against stored people array)
      if (person) {
        const lp = person.toLowerCase();
        all = all.filter(img =>
          (img.people ?? []).some(p => (p.name ?? '').toLowerCase().includes(lp))
        );
      }

      // Basic tag filter
      if (tag) {
        const lt = tag.toLowerCase();
        all = all.filter(img =>
          (img.tags ?? []).some(t => (t.name ?? t ?? '').toLowerCase().includes(lt))
        );
      }

      const slice = all.slice(offset, offset + limit);
      console.log(`[SyncManager] Returning ${slice.length} images after filter/sort`);
      return slice;
    } catch (err) {
      console.error('[SyncManager] getImages error:', err);
      throw err;
    }
  }

  /** Get all people from IndexedDB. */
  async getPeople() {
    const db = await this._getDB();
    return _req(db.transaction('people', 'readonly').objectStore('people').getAll());
  }

  /** Check if any data is cached. */
  async hasCachedData() {
    try {
      const db = await this._getDB();
      const count = await _req(db.transaction('images', 'readonly').objectStore('images').count());
      return count > 0;
    } catch { return false; }
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  async getStats() {
    try {
      const db           = await this._getDB();
      const meta         = await _req(db.transaction('meta', 'readonly').objectStore('meta').get('last_sync'));
      const count        = await _req(db.transaction('images', 'readonly').objectStore('images').count());
      const embCount     = await _req(db.transaction('person_embeddings', 'readonly').objectStore('person_embeddings').count());
      const pendingPush  = await _req(db.transaction('pending_push', 'readonly').objectStore('pending_push').count());
      const sizeMb       = await this._estimateSizeMb();
      return {
        count,
        sizeMb,
        lastSync: meta?.value ?? null,
        embCount,
        pendingPush,
      };
    } catch {
      return { count: 0, sizeMb: 0, lastSync: null, embCount: 0, pendingPush: 0 };
    }
  }

  // ── Eviction ───────────────────────────────────────────────────────────────

  async _estimateSizeMb() {
    if (!('caches' in globalThis)) return 0;
    try {
      const cache  = await caches.open(THUMB_CACHE);
      const keys   = await cache.keys();
      // Each thumbnail is roughly 10–30 KB; use 20 KB as average estimate
      const estMb  = (keys.length * 20) / 1024;
      return Math.round(estMb * 10) / 10;
    } catch { return 0; }
  }

  async _evictToSize(db, maxItems, maxSizeMb) {
    // Remove oldest IDB entries beyond maxItems
    const store = db.transaction('images', 'readwrite').objectStore('images');
    let all     = await _req(store.index('synced_at').getAll());
    if (all.length > maxItems) {
      all.sort((a, b) => a.synced_at - b.synced_at);  // oldest first
      const toRemove = all.slice(0, all.length - maxItems);
      const tx2 = db.transaction('images', 'readwrite');
      for (const img of toRemove) tx2.objectStore('images').delete(img.id);
      await _txComplete(tx2);
    }

    // Evict thumbnail cache entries if over size
    if ('caches' in globalThis) {
      const cache = await caches.open(THUMB_CACHE);
      const keys  = await cache.keys();
      const estMb = (keys.length * 20) / 1024;
      if (estMb > maxSizeMb) {
        // Delete oldest (cache.keys() preserves insertion order)
        const toDelete = Math.ceil(keys.length - (maxSizeMb / 20 * 1024));
        for (let i = 0; i < toDelete; i++) await cache.delete(keys[i]);
      }
    }
  }

  // ── Clear ──────────────────────────────────────────────────────────────────

  async clear() {
    const db = await this._getDB();
    const tx = db.transaction(['images', 'people', 'meta', 'person_embeddings', 'pending_push'], 'readwrite');
    tx.objectStore('images').clear();
    tx.objectStore('people').clear();
    tx.objectStore('meta').clear();
    tx.objectStore('person_embeddings').clear();
    // Note: pending_push is NOT cleared — queued offline work should survive a cache clear
    await _txComplete(tx);
    if ('caches' in globalThis) {
      const cache = await caches.open(THUMB_CACHE);
      const keys  = await cache.keys();
      for (const k of keys) await cache.delete(k);
    }
  }
}

// ── Sync settings helpers ─────────────────────────────────────────────────────

export function loadSyncSettings() {
  try {
    return JSON.parse(localStorage.getItem(SYNC_SETTINGS_KEY) || '{}');
  } catch { return {}; }
}

export function saveSyncSettings(s) {
  localStorage.setItem(SYNC_SETTINGS_KEY, JSON.stringify(s));
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const syncManager = new SyncManager();
export default syncManager;
