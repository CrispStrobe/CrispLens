/**
 * vector-manager.js (v3-proto)
 * Wraps faiss-napi and better-sqlite3 for high-speed face lookup.
 */

'use strict';

const { Index } = require('faiss-napi');
const Database = require('better-sqlite3');
const path = require('path');

class VectorManager {
  constructor(indexPath, dbPath) {
    this.indexPath = indexPath;
    this.dbPath = dbPath;
    this.index = null;
    this.db = null;
  }

  async init() {
    console.log(`Loading FAISS index from ${this.indexPath}...`);
    this.index = Index.read(this.indexPath);
    console.log(`Index loaded. Total vectors: ${this.index.ntotal}`);

    console.log(`Connecting to metadata DB: ${this.dbPath}...`);
    this.db = new Database(this.dbPath);
    console.log('Database connected.');
  }

  /**
   * Search for a face by its 512D embedding.
   */
  search(embedding, k = 5) {
    if (!this.index) throw new Error('Index not initialized');

    // faiss-napi search returns { labels, distances }
    // labels are the indices (IDs) in the FAISS index
    const results = this.index.search(Array.from(embedding), k);
    
    const matches = [];
    for (let i = 0; i < results.labels.length; i++) {
      const id = results.labels[i];
      const distance = results.distances[i];
      
      if (id < 0) continue; // No match

      // Look up person metadata in SQLite
      // [NOTE] Adjust query based on your actual schema (e.g., table 'faces' or 'people')
      const person = this.db.prepare(`
        SELECT p.name, f.image_path 
        FROM faces f 
        JOIN people p ON f.person_id = p.id 
        WHERE f.id = ?
      `).get(Number(id));

      matches.push({
        id: Number(id),
        distance,
        name: person ? person.name : 'Unknown',
        image_path: person ? person.image_path : null
      });
    }

    return matches;
  }
}

module.exports = { VectorManager };
