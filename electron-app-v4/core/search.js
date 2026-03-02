'use strict';

/**
 * search.js
 *
 * Face embedding search backed by one of three implementations, chosen by
 * what's available at runtime:
 *
 *   1. usearch  (WASM HNSW, ~300 KB) — universal: works in Node.js AND browser.
 *              Approximate nearest-neighbour, inner-product metric.
 *              Best default for all platforms including PWA / Capacitor mobile.
 *
 *   2. faiss-node (C++ FAISS, desktop/Electron only) — exact IndexFlatIP search.
 *              Faster than usearch for very large indexes (>500K vectors).
 *              Not available in browser.
 *
 *   3. Brute-force cosine (pure JS) — always available, zero deps.
 *              Plenty fast for <100K faces (~30 ms on V8 at 100K × 512D).
 *
 * Embeddings stored in SQLite as float32 blobs.
 * The Python app uses IndexFlatIP with L2-normalised vectors = cosine similarity.
 * Inner product of L2-normalised vectors = cosine similarity, so all three
 * backends are numerically equivalent.
 */

const Database = require('better-sqlite3');

// ── Backend auto-detection ────────────────────────────────────────────────────

let USearchIndex = null;
let FaissIndex   = null;

try { USearchIndex = require('usearch').Index;   } catch (_) {}
try { FaissIndex   = require('faiss-node').IndexFlatIP; } catch (_) {}

function backendName() {
  if (FaissIndex)   return 'faiss-node (C++ exact)';
  if (USearchIndex) return 'usearch (WASM HNSW approx.)';
  return 'brute-force cosine (pure JS)';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function dotProduct(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// ── VectorStore ───────────────────────────────────────────────────────────────

class VectorStore {
  /**
   * @param {string} dbPath  Path to face_recognition.db
   */
  constructor(dbPath) {
    this.dbPath      = dbPath;
    this.db          = null;
    this.vectors     = [];   // Float32Array[512] per entry (kept for brute-force)
    this.meta        = [];   // parallel array of metadata objects
    this._usearch    = null; // usearch.Index
    this._faiss      = null; // faiss-node index
    this._dim        = 0;
  }

  /**
   * Load all identified face embeddings from the database and build index.
   */
  load() {
    this.db = new Database(this.dbPath, { readonly: true });

    const rows = this.db.prepare(`
      SELECT
        fe.id            AS emb_id,
        fe.face_id,
        fe.person_id,
        fe.embedding_vector,
        fe.embedding_dimension,
        p.name           AS person_name,
        f.image_id,
        i.filepath
      FROM face_embeddings fe
      JOIN faces   f ON fe.face_id   = f.id
      JOIN images  i ON f.image_id   = i.id
      LEFT JOIN people p ON fe.person_id = p.id
      WHERE fe.embedding_vector IS NOT NULL
        AND fe.person_id IS NOT NULL
      ORDER BY fe.id
    `).all();

    this.vectors = [];
    this.meta    = [];

    for (const row of rows) {
      const blob = row.embedding_vector;
      const dim  = row.embedding_dimension;
      if (!blob || blob.length < dim * 4) continue;

      const vec = new Float32Array(blob.buffer, blob.byteOffset, dim);
      this.vectors.push(vec);
      this.meta.push({
        embId:      row.emb_id,
        faceId:     row.face_id,
        imageId:    row.image_id,
        personId:   row.person_id,
        personName: row.person_name || 'Unknown',
        filepath:   row.filepath,
      });
    }

    const n = this.vectors.length;
    if (n === 0) {
      console.log('[VectorStore] No embeddings loaded (train some faces first).');
      return;
    }

    this._dim = this.vectors[0].length;

    // ── Build index ────────────────────────────────────────────────────────────
    if (FaissIndex) {
      // faiss-node: exact IndexFlatIP, C++ native
      this._faiss = new FaissIndex(this._dim);
      const flat = new Float32Array(n * this._dim);
      for (let i = 0; i < n; i++) flat.set(this.vectors[i], i * this._dim);
      this._faiss.add(flat);

    } else if (USearchIndex) {
      // usearch: WASM HNSW, approximate, inner-product metric
      // distance stored = 1 - inner_product (lower = better)
      this._usearch = new USearchIndex({ metric: 'ip', dimensions: this._dim });
      for (let i = 0; i < n; i++) {
        this._usearch.add(BigInt(i), this.vectors[i]);
      }
    }
    // else: brute-force (no index to build)

    const peopleCount = new Set(this.meta.map(m => m.personId)).size;
    console.log(
      `[VectorStore] Loaded ${n} embeddings from ${peopleCount} people.` +
      `  Backend: ${backendName()}`
    );
  }

  /**
   * Find top-k most similar stored faces for a 512D L2-normalised query vector.
   *
   * @returns Array of { personName, personId, similarity, filepath, embId }
   */
  search(queryVec, k = 5) {
    if (this.vectors.length === 0) return [];
    k = Math.min(k, this.vectors.length);

    if (this._faiss)   return this._searchFaiss(queryVec, k);
    if (this._usearch) return this._searchUsearch(queryVec, k);
    return this._searchBruteForce(queryVec, k);
  }

  _searchFaiss(queryVec, k) {
    // faiss-node: returns { distances, labels } where labels are 0-based ints
    const { distances, labels } = this._faiss.search(queryVec, k);
    return labels
      .map((idx, i) => idx >= 0 ? { ...this.meta[idx], similarity: distances[i] } : null)
      .filter(Boolean);
  }

  _searchUsearch(queryVec, k) {
    // usearch ip metric: distance = 1 - inner_product
    const result = this._usearch.search(queryVec, k);
    const out = [];
    for (let i = 0; i < result.keys.length; i++) {
      const idx  = Number(result.keys[i]);
      const dist = result.distances[i];   // 1 - cosine_sim
      out.push({ ...this.meta[idx], similarity: 1 - dist });
    }
    return out.sort((a, b) => b.similarity - a.similarity);
  }

  _searchBruteForce(queryVec, k) {
    return this.vectors
      .map((v, i) => ({ i, similarity: dotProduct(queryVec, v) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k)
      .map(({ i, similarity }) => ({ ...this.meta[i], similarity }));
  }

  close() {
    if (this.db) { this.db.close(); this.db = null; }
  }
}

module.exports = { VectorStore, backendName };
