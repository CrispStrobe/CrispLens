'use strict';

/**
 * cloud-drives.js — Cloud/network drive management for v4 Node server.
 *
 * Supported types: internxt, filen (cloud auth), smb, sftp (network mounts).
 * SMB/SFTP: stub only — no native mount support in Node without OS tools.
 * Internxt: full auth + browse via their REST API (modern "Hydrated Login" flow).
 * Filen: stub — requires their custom E2E encrypted protocol.
 *
 * Internxt auth matches internxt-cli/services/auth.py + crypto.py exactly:
 *   1. POST /auth/login  {email}  → {sKey}  (encrypted salt)
 *   2. decrypt sKey → salt; PBKDF2(password, salt) → hash; encrypt(hash) → encryptedPasswordHash
 *   3. POST /auth/login/access  {email, password: encryptedPasswordHash, keys, ...}  → {newToken}
 *   4. GET  /users/refresh  Bearer: newToken  → {token, newToken, user: {rootFolderUuid, ...}}
 */

const express = require('express');
const crypto  = require('crypto');
const https   = require('https');
const http    = require('http');
const { getDb }       = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

// ── Internxt constants ────────────────────────────────────────────────────────
// Matches internxt-cli/config/config.py
const DRIVE_API_URL     = 'https://gateway.internxt.com/drive';
const APP_CRYPTO_SECRET = '6KYQBP847D4ATSFA';
const INTERNXT_HEADERS  = {
  'Content-Type': 'application/json',
  'Accept':       'application/json',
  'internxt-client': 'internxt-cli',
};

// ── Crypto helpers (ported from internxt-cli/services/crypto.py) ──────────────

/**
 * OpenSSL EVP_BytesToKey-compatible key+IV derivation (MD5 x3).
 * Matches Python _get_key_and_iv_from().
 */
function _getKeyAndIv(secret, salt) {
  const password = Buffer.concat([Buffer.from(secret, 'latin1'), salt]);
  const d0 = crypto.createHash('md5').update(password).digest();
  const d1 = crypto.createHash('md5').update(Buffer.concat([d0, password])).digest();
  const d2 = crypto.createHash('md5').update(Buffer.concat([d1, password])).digest();
  return { key: Buffer.concat([d0, d1]), iv: d2 };
}

/**
 * AES-256-CBC decrypt of an OpenSSL "Salted__" hex-encoded string.
 * Matches Python decrypt_text_with_key().
 */
function decryptTextWithKey(encryptedHex, secret) {
  const buf  = Buffer.from(encryptedHex, 'hex');
  const salt = buf.slice(8, 16);           // skip "Salted__" (8 bytes)
  const { key, iv } = _getKeyAndIv(secret, salt);
  const dec  = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([dec.update(buf.slice(16)), dec.final()]).toString('utf8');
}

/**
 * AES-256-CBC encrypt → OpenSSL "Salted__" hex-encoded string.
 * Matches Python encrypt_text_with_key().
 */
function encryptTextWithKey(text, secret) {
  const salt = crypto.randomBytes(8);
  const { key, iv } = _getKeyAndIv(secret, salt);
  const enc  = crypto.createCipheriv('aes-256-cbc', key, iv);
  const ct   = Buffer.concat([enc.update(Buffer.from(text, 'utf8')), enc.final()]);
  return Buffer.concat([Buffer.from('Salted__'), salt, ct]).toString('hex');
}

const decryptText = (hex)  => decryptTextWithKey(hex, APP_CRYPTO_SECRET);
const encryptText = (text) => encryptTextWithKey(text, APP_CRYPTO_SECRET);

/**
 * PBKDF2-SHA1 (10 000 iter, 32 bytes). Matches Python pass_to_hash().
 * Returns { salt: hexString, hash: hexString }.
 */
function passToHash(password, saltHex) {
  return new Promise((resolve, reject) => {
    const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
    crypto.pbkdf2(password, salt, 10000, 32, 'sha1', (err, key) => {
      if (err) return reject(err);
      resolve({ salt: salt.toString('hex'), hash: key.toString('hex') });
    });
  });
}

/**
 * Derives the encrypted password hash from a plaintext password and the sKey
 * returned by the Internxt API. Matches Python encrypt_password_hash().
 *
 * Flow: decrypt(sKey) → saltHex → PBKDF2(password, salt) → encrypt(hashHex)
 */
async function encryptPasswordHash(password, sKey) {
  const saltHex  = decryptText(sKey);
  const hashObj  = await passToHash(password, saltHex);
  return encryptText(hashObj.hash);
}

/**
 * Placeholder key pairs (same as internxt-cli generate_keys).
 * The Internxt backend validates the payload structure but doesn't use the
 * placeholder values for drive-browse access.
 */
function generateKeys(password) {
  const encPk = encryptTextWithKey('placeholder-private-key-for-login', password);
  return {
    privateKeyEncrypted: encPk,
    publicKey: 'placeholder-public-key-for-login',
    revocationCertificate: 'placeholder-revocation-cert-for-login',
    ecc:   { publicKey: 'placeholder-ecc-public-key', privateKeyEncrypted: encPk },
    kyber: { publicKey: null, privateKeyEncrypted: null },
  };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function jsonRequest(method, url, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u   = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const bodyBuf = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const reqHeaders = {
      ...INTERNXT_HEADERS,
      ...headers,
      ...(bodyBuf ? { 'Content-Length': bodyBuf.length } : {}),
    };
    const req = mod.request({
      hostname: u.hostname,
      port:     u.port || (u.protocol === 'https:' ? 443 : 80),
      path:     u.pathname + u.search,
      method,
      headers:  reqHeaders,
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(raw); } catch { data = raw; }
        if (res.statusCode >= 400) {
          const msg = (typeof data === 'object' && (data.message || data.error)) || `HTTP ${res.statusCode}`;
          return reject(new Error(msg));
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

const apiGet  = (url, headers) => jsonRequest('GET',  url, { headers });
const apiPost = (url, body, headers) => jsonRequest('POST', url, { body, headers });

// ── Internxt auth flow ────────────────────────────────────────────────────────

/**
 * Full "Hydrated Login" matching internxt-cli auth.py do_login().
 * Returns { token, newToken, user: { rootFolderUuid, ... } }
 */
async function internxtLogin(email, password, tfaCode) {
  const cleanEmail = email.toLowerCase().trim();

  // Step 1: security_details → sKey
  console.log('[internxt] Step 1: security_details for', cleanEmail);
  const secDetails = await apiPost(`${DRIVE_API_URL}/auth/login`, { email: cleanEmail });
  const sKey = secDetails.sKey;
  if (!sKey) throw new Error(`Login failed: sKey missing. Response: ${JSON.stringify(secDetails)}`);

  // Step 2: client-side crypto
  console.log('[internxt] Step 2: encrypting password hash');
  const encPasswordHash = await encryptPasswordHash(password, sKey);
  const keys = generateKeys(password);

  // Step 3: login/access
  const loginPayload = {
    email:      cleanEmail,
    password:   encPasswordHash,
    tfa:        tfaCode?.trim() || undefined,
    keys: {
      ecc: { publicKey: keys.ecc.publicKey, privateKey: keys.ecc.privateKeyEncrypted },
    },
    privateKey: keys.privateKeyEncrypted,
    publicKey:  keys.publicKey,
  };
  console.log('[internxt] Step 3: login/access');
  const accessRes  = await apiPost(`${DRIVE_API_URL}/auth/login/access`, loginPayload);
  const tempToken  = accessRes.newToken || accessRes.token;
  if (!tempToken) throw new Error(`Auth access failed — no token. Response: ${JSON.stringify(accessRes)}`);

  // Step 4: hydration via /users/refresh
  console.log('[internxt] Step 4: hydrating session');
  const hydrated = await apiGet(`${DRIVE_API_URL}/users/refresh`, { Authorization: `Bearer ${tempToken}` });

  console.log('[internxt] Login successful, rootFolderUuid:', hydrated.user?.rootFolderUuid);
  return {
    token:    hydrated.token,
    newToken: hydrated.newToken,
    user:     hydrated.user,
  };
}

/**
 * List folders and (image) files in a folder by UUID.
 * Matches internxt-cli api.py get_folder_folders() / get_folder_files().
 */
async function internxtListFolder(bearerToken, folderUuid) {
  const auth = { Authorization: `Bearer ${bearerToken}` };
  const foldersUrl = `${DRIVE_API_URL}/folders/content/${folderUuid}/folders?offset=0&limit=200&sort=plainName&direction=ASC`;
  const filesUrl   = `${DRIVE_API_URL}/folders/content/${folderUuid}/files?offset=0&limit=200&sort=plainName&direction=ASC`;

  const [foldersRes, filesRes] = await Promise.all([
    apiGet(foldersUrl, auth).catch(() => ({})),
    apiGet(filesUrl,   auth).catch(() => ({})),
  ]);

  const folders = Array.isArray(foldersRes?.result) ? foldersRes.result
                : Array.isArray(foldersRes?.children) ? foldersRes.children
                : Array.isArray(foldersRes) ? foldersRes : [];

  const files   = Array.isArray(filesRes?.result) ? filesRes.result
                : Array.isArray(filesRes?.files)   ? filesRes.files
                : Array.isArray(filesRes)            ? filesRes : [];

  return { folders, files };
}

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
  const { name, type, config = {} } = req.body || {};
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
      // Store newToken as bearer + rootFolderUuid for browse
      const tokenData = {
        token:          authData.newToken || authData.token,
        rootFolderUuid: authData.user?.rootFolderUuid || authData.user?.root_folder_id,
      };
      db.prepare('UPDATE cloud_drives SET is_mounted=1, token=? WHERE id=?')
        .run(JSON.stringify(tokenData), drive.id);
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

      // Path format: '/' = root, '/{uuid}' = specific folder, '/{parentUuid}/{uuid}' for nested
      let folderUuid = tokenData.rootFolderUuid;
      let parentPath = null;

      if (browsePath !== '/' && browsePath !== '') {
        // Extract the last UUID segment as current folder
        const parts = browsePath.replace(/^\//, '').split('/').filter(Boolean);
        if (parts.length > 0) {
          folderUuid = parts[parts.length - 1];
          // Parent = everything except last segment
          parentPath = parts.length > 1 ? '/' + parts.slice(0, -1).join('/') : '/';
        }
      }

      const { folders, files } = await internxtListFolder(tokenData.token, folderUuid);

      const entries = [
        ...folders.map(f => ({
          name:   f.plainName || f.name,
          path:   `${browsePath === '/' ? '' : browsePath}/${f.uuid}`,
          is_dir: true,
        })),
        ...files
          .filter(f => {
            const ext = ('.' + (f.type || '')).toLowerCase();
            return IMAGE_EXTS.has(ext);
          })
          .map(f => ({
            name:     (f.plainName || f.name) + (f.type ? '.' + f.type : ''),
            path:     `${browsePath === '/' ? '' : browsePath}/file/${f.uuid}`,
            is_dir:   false,
            is_image: true,
            size:     f.size,
          })),
      ].sort((a, b) => (b.is_dir - a.is_dir) || a.name.localeCompare(b.name));

      return res.json({ path: browsePath, parent: parentPath, entries });
    }

    return res.status(400).json({ detail: `Browse not implemented for type: ${drive.type}` });
  } catch (e) {
    console.error('[cloud-drives/browse]', drive.type, e.message);
    return res.status(500).json({ detail: e.message });
  }
});

module.exports = router;
