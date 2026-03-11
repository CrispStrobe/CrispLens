'use strict';

/**
 * cloud-drives.js — Cloud/network drive management for v4 Node server.
 *
 * Supported types: internxt, filen, smb, sftp.
 * SMB/SFTP: stub only — no native mount support in Node without OS tools.
 *
 * Internxt auth (matches internxt-cli/services/auth.py + crypto.py):
 *   1. POST /auth/login {email} → {sKey}
 *   2. decrypt(sKey) → salt → PBKDF2(pass,salt) → hash → encrypt(hash)
 *   3. POST /auth/login/access {email, password, keys} → {newToken}
 *   4. GET /users/refresh Bearer:newToken → {token, newToken, user:{rootFolderId}}
 *
 * Filen auth (matches filen-python/services/auth.py + crypto.py):
 *   1. POST /v3/auth/info {email} → {authVersion, salt}
 *   2. PBKDF2-SHA512(pass, salt, 200000, 64) → masterKey + passwordHash
 *   3. POST /v3/login {email, password, authVersion, twoFactorCode} → {apiKey, masterKeys}
 *   4. decrypt each masterKey via AES-256-GCM "002" format
 *   5. GET /v3/user/baseFolder → {uuid}
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
 * List folders and (image) files in a folder by UUID, with pagination.
 * Internxt API max limit=50 per page. Loops until all items fetched.
 * Response shapes: { folders:[...] } for folders, { files:[...] } for files.
 */
async function internxtListFolder(bearerToken, folderUuid) {
  const auth = { Authorization: `Bearer ${bearerToken}` };
  const MAX = 50;

  async function fetchAllPages(kind) {
    const all = [];
    let offset = 0;
    while (true) {
      const url = `${DRIVE_API_URL}/folders/content/${folderUuid}/${kind}?offset=${offset}&limit=${MAX}&sort=plainName&direction=ASC`;
      let res;
      try {
        res = await apiGet(url, auth);
      } catch (e) {
        console.error(`[internxt] listFolder ${kind} offset=${offset} ERROR:`, e.message);
        break;
      }
      // API returns { folders:[...] } or { files:[...] } or legacy { result:[...] } or bare array
      const page = Array.isArray(res?.[kind])   ? res[kind]
                 : Array.isArray(res?.result)   ? res.result
                 : Array.isArray(res?.children) ? res.children
                 : Array.isArray(res)           ? res : [];
      console.log(`[internxt] listFolder ${kind} offset=${offset} → ${page.length} items`);
      if (page.length === 0) break;
      all.push(...page);
      if (page.length < MAX) break;
      offset += MAX;
    }
    return all;
  }

  const [folders, files] = await Promise.all([
    fetchAllPages('folders'),
    fetchAllPages('files'),
  ]);
  console.log(`[internxt] listFolder ${folderUuid} total: ${folders.length} folders, ${files.length} files`);
  return { folders, files };
}

// ── Filen constants ───────────────────────────────────────────────────────────
const FILEN_API = 'https://gateway.filen.io';
const IMAGE_EXTS_SET = new Set(['.jpg','.jpeg','.png','.webp','.gif','.bmp','.tiff','.heic','.heif','.avif']);

// ── Filen crypto (ported from filen-python/services/crypto.py) ────────────────

function _pbkdf2(password, salt, iterations, len) {
  return new Promise((resolve, reject) =>
    crypto.pbkdf2(password, salt, iterations, len, 'sha512', (e, k) => e ? reject(e) : resolve(k))
  );
}

/**
 * Derive login keys from password + salt.
 * Matches filen-python crypto.py derive_keys().
 */
async function filenDeriveKeys(password, authVersion, salt) {
  const derived = await _pbkdf2(password, salt, 200000, 64);
  const keyHex  = derived.toString('hex').toLowerCase();
  if (authVersion === 2) {
    const masterKey    = keyHex.slice(0, 64);
    const passwordHash = crypto.createHash('sha512').update(keyHex.slice(64)).digest('hex').toLowerCase();
    return { masterKey, passwordHash };
  }
  return { masterKey: keyHex, passwordHash: keyHex };
}

/**
 * Decrypt Filen "002" metadata (AES-256-GCM).
 * Format: "002" + 12-char ASCII IV + base64(ciphertext + 16-byte GCM tag)
 * Key:    PBKDF2-SHA512(masterKey, masterKey, 1, 32)
 * Matches filen-python crypto.py decrypt_metadata_002().
 */
async function filenDecryptMetadata(encrypted, masterKey) {
  if (!encrypted?.startsWith('002')) throw new Error('Not "002" format: ' + String(encrypted).slice(0,15));
  const iv        = Buffer.from(encrypted.slice(3, 15), 'utf8');
  const cipherBuf = Buffer.from(encrypted.slice(15), 'base64');
  const ciphertext = cipherBuf.slice(0, -16);
  const tag        = cipherBuf.slice(-16);
  const dk = await _pbkdf2(masterKey, masterKey, 1, 32);
  const dec = crypto.createDecipheriv('aes-256-gcm', dk, iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ciphertext), dec.final()]).toString('utf8');
}

// ── Filen API helper ──────────────────────────────────────────────────────────

function filenRequest(method, path, { body, apiKey } = {}) {
  return new Promise((resolve, reject) => {
    const bodyBuf = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    if (bodyBuf) headers['Content-Length'] = bodyBuf.length;
    const req = https.request({
      hostname: 'gateway.filen.io', port: 443, path, method, headers,
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(raw); } catch { data = raw; }
        if (res.statusCode >= 400) return reject(new Error(`Filen HTTP ${res.statusCode}: ${raw.slice(0,200)}`));
        if (data?.status === false) return reject(new Error(data.message || 'Filen API error'));
        resolve(data?.data ?? data);
      });
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

/**
 * Full Filen login flow. Returns { email, apiKey, masterKeys:string[], baseFolderUuid, userId }.
 */
async function filenLogin(email, password, tfaCode) {
  const cleanEmail = email.toLowerCase().trim();

  console.log('[filen] Step 1: auth/info');
  const authInfo    = await filenRequest('POST', '/v3/auth/info', { body: { email: cleanEmail } });
  const authVersion = authInfo.authVersion ?? 2;
  const salt        = authInfo.salt;
  if (!salt) throw new Error('Filen: no salt in auth/info response');

  console.log('[filen] Step 2: deriving keys (authVersion=' + authVersion + ')');
  const { masterKey, passwordHash } = await filenDeriveKeys(password, authVersion, salt);

  console.log('[filen] Step 3: login');
  const loginData = await filenRequest('POST', '/v3/login', {
    body: { email: cleanEmail, password: passwordHash, authVersion, twoFactorCode: tfaCode?.trim() || 'XXXXXX' },
  });
  const apiKey = loginData.apiKey;
  if (!apiKey) throw new Error('Filen: no apiKey in login response');

  console.log('[filen] Step 4: decrypting master keys');
  const rawKeys       = Array.isArray(loginData.masterKeys) ? loginData.masterKeys
                      : typeof loginData.masterKeys === 'string' ? [loginData.masterKeys] : [];
  const decryptedKeys = [];
  for (const enc of rawKeys) {
    try {
      decryptedKeys.push(await filenDecryptMetadata(enc, masterKey));
    } catch (e) {
      console.warn('[filen] master key decrypt failed:', e.message);
    }
  }
  if (decryptedKeys.length === 0) decryptedKeys.push(masterKey); // fallback

  console.log('[filen] Step 5: base folder');
  const baseFolder = await filenRequest('GET', '/v3/user/baseFolder', { apiKey });
  const baseFolderUuid = baseFolder.uuid;
  if (!baseFolderUuid) throw new Error('Filen: no baseFolderUuid');

  console.log('[filen] Login OK — baseFolderUuid:', baseFolderUuid);
  return { email: cleanEmail, apiKey, masterKeys: decryptedKeys, baseFolderUuid, userId: String(loginData.id || '') };
}

/**
 * List a Filen folder (POST /v3/dir/content), decrypting names.
 * Returns { folders:[{name,uuid}], files:[{name,uuid,size}] }
 */
async function filenListFolder(apiKey, masterKeys, folderUuid) {
  const data    = await filenRequest('POST', '/v3/dir/content', { body: { uuid: folderUuid, foldersOnly: false }, apiKey });
  const rawFolders = Array.isArray(data.folders) ? data.folders : [];
  const rawFiles   = Array.isArray(data.uploads)  ? data.uploads  : (Array.isArray(data.files) ? data.files : []);

  // Decrypt with most recent master key first, fall back through all keys
  async function tryDecrypt(enc) {
    for (let i = masterKeys.length - 1; i >= 0; i--) {
      try { return await filenDecryptMetadata(enc, masterKeys[i]); } catch {}
    }
    return null;
  }

  const folders = [];
  for (const f of rawFolders) {
    const name = await tryDecrypt(f.name);
    if (name) folders.push({ name, uuid: f.uuid });
  }

  const files = [];
  for (const f of rawFiles) {
    const metaStr = await tryDecrypt(f.metadata);
    if (!metaStr) continue;
    try {
      const meta = JSON.parse(metaStr);
      const ext  = ('.' + (meta.name || '').split('.').pop()).toLowerCase();
      if (IMAGE_EXTS_SET.has(ext)) {
        files.push({ name: meta.name, uuid: f.uuid, size: f.size ?? meta.size });
      }
    } catch {}
  }

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
  const drives = getAll(db);
  console.log(`[cloud-drives] GET / — user=${req.user?.username} → ${drives.length} drives: ${drives.map(d => `${d.name}(${d.type},mounted=${d.is_mounted})`).join(', ') || 'none'}`);
  res.json(drives);
});

router.post('/', requireAuth, (req, res) => {
  const db = getDb();
  ensureTable(db);
  const { name, type, config = {} } = req.body || {};
  if (!name?.trim() || !type) return res.status(400).json({ detail: 'name and type required' });
  // Strip plaintext password from log, keep email
  const safeConfig = { ...config, password: config.password ? '***' : undefined };
  console.log(`[cloud-drives] POST / — user=${req.user?.username} name="${name}" type=${type} config=${JSON.stringify(safeConfig)}`);
  const r = db.prepare(
    'INSERT INTO cloud_drives (owner_id, name, type, config) VALUES (?,?,?,?)'
  ).run(req.user?.userId || null, name.trim(), type, JSON.stringify(config));
  console.log(`[cloud-drives] created id=${r.lastInsertRowid}`);
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
  console.log(`[cloud-drives] POST /test — user=${req.user?.username} type=${type} email=${config.email || '?'}`);
  try {
    if (type === 'internxt') {
      const { email, password, tfa_code } = config;
      if (!email || !password) return res.status(400).json({ ok: false, message: 'Email and password required' });
      await internxtLogin(email, password, tfa_code);
      return res.json({ ok: true, message: 'Internxt login successful' });
    }
    if (type === 'filen') {
      const { email, password, tfa_code } = config;
      if (!email || !password) return res.status(400).json({ ok: false, message: 'Email and password required' });
      await filenLogin(email, password, tfa_code);
      return res.json({ ok: true, message: 'Filen login successful' });
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
  console.log(`[cloud-drives] POST /${req.params.id}/mount — user=${req.user?.username} type=${drive.type} name="${drive.name}" email=${cfg.email || '?'}`);

  try {
    if (drive.type === 'internxt') {
      const authData = await internxtLogin(cfg.email, cfg.password, cfg.tfa_code);
      // Store newToken as bearer + rootFolderUuid for browse
      // rootFolderId is already a UUID; root_folder_id is the legacy numeric ID
      const tokenData = {
        token:          authData.newToken || authData.token,
        rootFolderUuid: authData.user?.rootFolderId || authData.user?.rootFolderUuid,
      };
      db.prepare('UPDATE cloud_drives SET is_mounted=1, token=? WHERE id=?')
        .run(JSON.stringify(tokenData), drive.id);
      return res.json({ ok: true, message: 'Connected to Internxt' });
    }
    if (drive.type === 'filen') {
      const authData = await filenLogin(cfg.email, cfg.password, cfg.tfa_code);
      const tokenData = {
        apiKey:          authData.apiKey,
        masterKeys:      authData.masterKeys,
        baseFolderUuid:  authData.baseFolderUuid,
        userId:          authData.userId,
      };
      db.prepare('UPDATE cloud_drives SET is_mounted=1, token=? WHERE id=?')
        .run(JSON.stringify(tokenData), drive.id);
      return res.json({ ok: true, message: 'Connected to Filen' });
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

const IMAGE_EXTS = IMAGE_EXTS_SET; // alias

router.get('/:id/browse', requireAuth, async (req, res) => {
  const db = getDb();
  const drive = getOne(db, req.params.id);
  if (!drive) return res.status(404).json({ detail: 'Not found' });
  if (!drive.is_mounted) return res.status(400).json({ detail: 'Drive not connected — connect it first' });

  const browsePath = req.query.path || '/';
  console.log(`[cloud-drives] GET /${req.params.id}/browse — user=${req.user?.username} type=${drive.type} name="${drive.name}" path="${browsePath}"`);

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
      console.log(`[internxt] browse "${browsePath}" folderUuid=${folderUuid}: raw ${folders.length} folders, ${files.length} files`);
      if (folders[0]) console.log(`[internxt]   folder[0] keys:`, Object.keys(folders[0]), '  plainName:', folders[0].plainName, '  uuid:', folders[0].uuid);
      if (files[0])   console.log(`[internxt]   file[0] keys:`,   Object.keys(files[0]),   '  plainName:', files[0].plainName,   '  type:', files[0].type, '  uuid:', files[0].uuid);

      const entries = [
        ...folders.map(f => ({
          name:   f.plainName || f.plain_name || f.name,
          path:   `${browsePath === '/' ? '' : browsePath}/${f.uuid}`,
          is_dir: true,
        })),
        ...files.map(f => {
          const ext = ('.' + (f.type || '')).toLowerCase();
          const isImage = IMAGE_EXTS.has(ext);
          return {
            name:     (f.plainName || f.plain_name || f.name) + (f.type ? '.' + f.type : ''),
            path:     `${browsePath === '/' ? '' : browsePath}/file/${f.uuid}`,
            is_dir:   false,
            is_image: isImage,
            size:     f.size,
          };
        }),
      ].sort((a, b) => (b.is_dir - a.is_dir) || a.name.localeCompare(b.name));

      return res.json({ path: browsePath, parent: parentPath, entries });
    }

    if (drive.type === 'filen') {
      const tokenData = JSON.parse(drive.token || '{}');
      if (!tokenData.apiKey) return res.status(400).json({ detail: 'Token missing — reconnect drive' });

      // Path format: '/' = root, '/{uuid}' = subfolder
      let folderUuid = tokenData.baseFolderUuid;
      let parentPath = null;
      if (browsePath !== '/' && browsePath !== '') {
        const parts = browsePath.replace(/^\//, '').split('/').filter(Boolean);
        if (parts.length > 0) {
          folderUuid = parts[parts.length - 1];
          parentPath = parts.length > 1 ? '/' + parts.slice(0, -1).join('/') : '/';
        }
      }

      const { folders, files } = await filenListFolder(tokenData.apiKey, tokenData.masterKeys, folderUuid);

      const entries = [
        ...folders.map(f => ({
          name:   f.name,
          path:   `${browsePath === '/' ? '' : browsePath}/${f.uuid}`,
          is_dir: true,
        })),
        ...files.map(f => ({
          name:     f.name,
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
