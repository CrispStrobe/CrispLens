'use strict';

/**
 * cloud-drives.js — Cloud/network drive management for v4 Node server.
 *
 * Supported types: internxt, filen (cloud auth), smb, sftp (network mounts).
 * SMB/SFTP: stub only — no native mount support in Node without OS tools.
 * Internxt: full auth + browse via their REST API.
 * Filen: stub — requires their custom E2E encrypted protocol.
 */

const express = require('express');
const crypto  = require('crypto');
const https   = require('https');
const http    = require('http');
const { getDb }       = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

// ── DB helpers ────────────────────────────────────────────────────────────────

function ensureTable(db) {
  db.prepare(`CREATE TABLE IF NOT EXISTS cloud_drives (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id    INTEGER,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL,
    config      TEXT DEFAULT '{}',
    is_mounted  INTEGER DEFAULT 0,
    token       TEXT,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`).run();
}

function getAll(db)     { ensureTable(db); return db.prepare('SELECT id,name,type,is_mounted,owner_id FROM cloud_drives ORDER BY name').all(); }
function getOne(db, id) { ensureTable(db); return db.prepare('SELECT * FROM cloud_drives WHERE id=?').get(Number(id)); }
function cfgOf(drive)   { try { return JSON.parse(drive.config || '{}'); } catch { return {}; } }

// ── CRUD ──────────────────────────────────────────────────────────────────────

router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  res.json(getAll(db));
});

router.post('/', requireAuth, (req, res) => {
  const db = getDb();
  ensureTable(db);
  const { name, type, config = {}, mount_point, scope, allowed_roles, auto_mount } = req.body || {};
  if (!name?.trim() || !type) return res.status(400).json({ detail: 'name and type required' });
  const r = db.prepare(
    'INSERT INTO cloud_drives (owner_id, name, type, config) VALUES (?,?,?,?)'
  ).run(req.user?.userId || null, name.trim(), type, JSON.stringify(config));
  res.json({ ok: true, id: r.lastInsertRowid });
});

router.put('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const drive = getOne(db, req.params.id);
  if (!drive) return res.status(404).json({ detail: 'Not found' });
  const { name, type, config = {} } = req.body || {};
  db.prepare('UPDATE cloud_drives SET name=?, type=?, config=? WHERE id=?')
    .run(name || drive.name, type || drive.type, JSON.stringify(config), drive.id);
  res.json({ ok: true });
});

router.delete('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const drive = getOne(db, req.params.id);
  if (!drive) return res.status(404).json({ detail: 'Not found' });
  db.prepare('DELETE FROM cloud_drives WHERE id=?').run(drive.id);
  res.json({ ok: true });
});

router.get('/:id/config', requireAuth, (req, res) => {
  const db = getDb();
  const drive = getOne(db, req.params.id);
  if (!drive) return res.status(404).json({ detail: 'Not found' });
  res.json(cfgOf(drive));
});

// ── Internxt helpers ──────────────────────────────────────────────────────────

const INTERNXT_API = 'https://api.internxt.com';

function internxtDerivePassword(plainPassword, saltHex) {
  // Internxt auth: SHA-256(password) → uppercase hex → PBKDF2(sha256, salt, 10000, 32)
  const sha256hex = crypto.createHash('sha256').update(plainPassword, 'utf8').digest('hex').toUpperCase();
  return crypto.pbkdf2Sync(Buffer.from(sha256hex, 'utf8'), Buffer.from(saltHex, 'hex'), 10000, 32, 'sha256').toString('hex');
}

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: body }); }
      });
    }).on('error', reject);
  });
}

function httpsPost(url, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
    }, res => {
      let out = '';
      res.on('data', d => out += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(out) }); }
        catch { resolve({ status: res.statusCode, data: out }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function internxtLogin(email, password, tfaCode) {
  // Step 1: get salt
  const saltResp = await httpsGet(
    `${INTERNXT_API}/api/auth/login/${encodeURIComponent(email)}`,
    { 'internxt-client': 'node-v4', 'internxt-version': '1.0.0' }
  );
  if (saltResp.status !== 200 || !saltResp.data?.salt) {
    throw new Error(saltResp.data?.message || saltResp.data?.error || `Auth step 1 failed (${saltResp.status})`);
  }
  const salt = saltResp.data.salt;

  // Step 2: login with derived password
  const derived = internxtDerivePassword(password, salt);
  const loginPayload = { email, password: derived };
  if (tfaCode?.trim()) loginPayload.tfa = tfaCode.trim();

  const loginResp = await httpsPost(
    `${INTERNXT_API}/api/auth/login`,
    loginPayload,
    { 'internxt-client': 'node-v4', 'internxt-version': '1.0.0' }
  );
  if (loginResp.status !== 200 || !loginResp.data?.token) {
    throw new Error(loginResp.data?.message || loginResp.data?.error || `Auth step 2 failed (${loginResp.status})`);
  }
  return loginResp.data;  // { token, newToken, user: { rootFolderId, ... } }
}

async function internxtListFolder(token, folderId) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'internxt-client': 'node-v4',
    'internxt-version': '1.0.0',
  };

  // List subfolders
  const foldersResp = await httpsGet(
    `${INTERNXT_API}/api/storage/v2/folders/${folderId}?limit=200&offset=0`,
    headers
  );
  const folders = Array.isArray(foldersResp.data?.children) ? foldersResp.data.children : [];

  // List files
  const filesResp = await httpsGet(
    `${INTERNXT_API}/api/storage/v2/folders/${folderId}/files?limit=200&offset=0`,
    headers
  );
  const files = Array.isArray(filesResp.data) ? filesResp.data
              : Array.isArray(filesResp.data?.files) ? filesResp.data.files : [];

  return { folders, files };
}

// ── Test connection ────────────────────────────────────────────────────────────

router.post('/test', requireAuth, async (req, res) => {
  const { type, config = {} } = req.body || {};
  try {
    if (type === 'internxt') {
      const { email, password, tfa_code } = config;
      if (!email || !password) return res.status(400).json({ ok: false, message: 'Email and password required' });
      await internxtLogin(email, password, tfa_code);
      return res.json({ ok: true, message: 'Internxt login successful' });
    }
    if (type === 'filen') {
      return res.json({ ok: false, message: 'Filen: not yet implemented in v4 server — use v2 backend' });
    }
    if (type === 'smb' || type === 'sftp') {
      return res.json({ ok: false, message: `${type.toUpperCase()}: network mount not supported in v4 — use v2 backend with OS-level mount support` });
    }
    return res.status(400).json({ ok: false, message: `Unknown drive type: ${type}` });
  } catch (e) {
    console.error('[cloud-drives/test]', type, e.message);
    return res.json({ ok: false, message: e.message });
  }
});

// ── Mount / unmount ───────────────────────────────────────────────────────────

router.post('/:id/mount', requireAuth, async (req, res) => {
  const db = getDb();
  const drive = getOne(db, req.params.id);
  if (!drive) return res.status(404).json({ detail: 'Not found' });
  const cfg = cfgOf(drive);

  try {
    if (drive.type === 'internxt') {
      const authData = await internxtLogin(cfg.email, cfg.password, cfg.tfa_code);
      const token = authData.newToken || authData.token;
      const rootFolderId = authData.user?.rootFolderId || authData.user?.root_folder_id;
      db.prepare('UPDATE cloud_drives SET is_mounted=1, token=? WHERE id=?')
        .run(JSON.stringify({ token, rootFolderId }), drive.id);
      return res.json({ ok: true, message: 'Connected to Internxt' });
    }
    return res.json({ ok: false, message: `${drive.type}: mount not implemented in v4` });
  } catch (e) {
    console.error('[cloud-drives/mount]', drive.type, e.message);
    return res.json({ ok: false, message: e.message });
  }
});

router.post('/:id/unmount', requireAuth, (req, res) => {
  const db = getDb();
  const drive = getOne(db, req.params.id);
  if (!drive) return res.status(404).json({ detail: 'Not found' });
  db.prepare('UPDATE cloud_drives SET is_mounted=0, token=NULL WHERE id=?').run(drive.id);
  res.json({ ok: true });
});

// ── Browse ────────────────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set(['.jpg','.jpeg','.png','.webp','.gif','.bmp','.tiff','.heic','.heif','.avif']);

router.get('/:id/browse', requireAuth, async (req, res) => {
  const db = getDb();
  const drive = getOne(db, req.params.id);
  if (!drive) return res.status(404).json({ detail: 'Not found' });
  if (!drive.is_mounted) return res.status(400).json({ detail: 'Drive not connected — connect it first' });

  const browsePath = req.query.path || '/';

  try {
    if (drive.type === 'internxt') {
      const tokenData = JSON.parse(drive.token || '{}');
      if (!tokenData.token) return res.status(400).json({ detail: 'Token missing — reconnect drive' });

      // Determine folder ID from path
      let folderId = tokenData.rootFolderId;
      if (browsePath !== '/' && browsePath !== '') {
        // Path is stored as /<folderId> for Internxt
        const match = browsePath.match(/^\/(\d+)(?:\/|$)/);
        if (match) folderId = Number(match[1]);
      }

      const { folders, files } = await internxtListFolder(tokenData.token, folderId);

      const entries = [
        ...folders.map(f => ({
          name:   f.name,
          path:   `/${folderId}/${f.id}`,
          is_dir: true,
        })),
        ...files
          .filter(f => IMAGE_EXTS.has(('.' + (f.type || '')).toLowerCase()))
          .map(f => ({
            name:    f.name + (f.type ? '.' + f.type : ''),
            path:    `/${folderId}/file/${f.fileId || f.id}`,
            is_dir:  false,
            is_image: true,
            size:    f.size,
          })),
      ].sort((a, b) => (b.is_dir - a.is_dir) || a.name.localeCompare(b.name));

      const parent = browsePath === '/' || browsePath === `/${folderId}`
        ? null
        : `/${folderId}`;

      return res.json({ path: browsePath, parent, entries });
    }

    return res.status(400).json({ detail: `Browse not implemented for type: ${drive.type}` });
  } catch (e) {
    console.error('[cloud-drives/browse]', drive.type, e.message);
    return res.status(500).json({ detail: e.message });
  }
});

module.exports = router;
