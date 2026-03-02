'use strict';

/**
 * search.js
 *
 * Loads face embeddings from the existing SQLite database and performs
 * cosine similarity search — compatible with the Python FAISS IndexFlatIP
 * (inner product on L2-normalized vectors = cosine similarity).
 *
 * For large databases (>100K faces) the optional `faiss-napi` package is
 * used if available.  Falls back to pure-JS brute force automatically.
 */

const Database = require('better-sqlite3');

// Try to load faiss-napi; fall back gracefully
let FaissIndex = null;
try {
  FaissIndex = require('faiss-napi').IndexFlatIP;
} catch (_) {
  // faiss-napi not installed — brute-force cosine will be used
}

// ── Dot product (= cosine similarity for L2-normalized vectors) ───────────────

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
    this.dbPath   = dbPath;
    this.db       = null;
    this.vectors  = [];   // Float32Array[512] per entry
    this.meta     = [];   // { embId, personId, personName, faceId, imageId, filepath }
    this.faissIdx = null; // optional faiss-napi index
  }

  /**
   * Load all identified face embeddings from the database.
   * Only includes rows with a non-null person_id (trained faces).
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

    console.log(
      `[VectorStore] Loaded ${this.vectors.length} embeddings ` +
      `from ${new Set(this.meta.map(m => m.personId)).size} people.`
    );

    // Build FAISS index if available (faster for >10K vectors)
    // faiss-napi requires plain JS Array (not Float32Array) for add/search
    if (FaissIndex && this.vectors.length > 0) {
      const dim  = this.vectors[0].length;
      this.faissIdx = new FaissIndex(dim);
      const flat = [];
      for (const v of this.vectors) for (let i = 0; i < v.length; i++) flat.push(v[i]);
      this.faissIdx.add(flat);
      console.log(`[VectorStore] FAISS index built (${this.vectors.length} vectors, dim=${dim}).`);
    }
  }

  /**
   * Find the top-k most similar stored faces for a query embedding.
   *
   * @param {Float32Array} queryVec  512D L2-normalized embedding
   * @param {number}       k         number of results
   * @returns Array of { personName, personId, similarity, filepath, embId }
   */
  search(queryVec, k = 5) {
    if (this.vectors.length === 0) return [];

    if (this.faissIdx) {
      return this._searchFaiss(queryVec, k);
    }
    return this._searchBruteForce(queryVec, k);
  }

  _searchBruteForce(queryVec, k) {
    const scores = this.vectors.map((v, i) => ({
      i,
      similarity: dotProduct(queryVec, v),
    }));
    scores.sort((a, b) => b.similarity - a.similarity);

    return scores.slice(0, k).map(({ i, similarity }) => ({
      ...this.meta[i],
      similarity,
    }));
  }

  _searchFaiss(queryVec, k) {
    // faiss-napi: requires plain Array, returns BigInt labels
    const query = Array.from(queryVec);
    const { labels, distances } = this.faissIdx.search(query, k);
    const results = [];
    for (let i = 0; i < labels.length; i++) {
      const idx = Number(labels[i]);   // BigInt → Number
      if (idx < 0) continue;
      results.push({ ...this.meta[idx], similarity: distances[i] });
    }
    return results;
  }

  /**
   * Return all stored embeddings and metadata (for debugging / export).
   */
  allEmbeddings() {
    return this.meta.map((m, i) => ({ ...m, vector: this.vectors[i] }));
  }

  close() {
    if (this.db) { this.db.close(); this.db = null; }
  }
}

module.exports = { VectorStore };
