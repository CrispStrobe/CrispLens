#!/usr/bin/env node
'use strict';
/**
 * tools/test-internxt.js — standalone test for Internxt auth flow.
 * Usage: node tools/test-internxt.js <email> <password> [tfa_code]
 * Or:   EMAIL=x PASS=y node tools/test-internxt.js
 */

const crypto = require('crypto');
const https  = require('https');
const http   = require('http');

// ── Constants (from internxt-cli config.py) ───────────────────────────────────
const DRIVE_API_URL     = 'https://gateway.internxt.com/drive';
const APP_CRYPTO_SECRET = '6KYQBP847D4ATSFA';
const HEADERS = {
  'Content-Type':    'application/json',
  'Accept':          'application/json',
  'internxt-client': 'internxt-cli',
};

// ── Crypto helpers ────────────────────────────────────────────────────────────

function _getKeyAndIv(secret, salt) {
  const password = Buffer.concat([Buffer.from(secret, 'latin1'), salt]);
  const d0 = crypto.createHash('md5').update(password).digest();
  const d1 = crypto.createHash('md5').update(Buffer.concat([d0, password])).digest();
  const d2 = crypto.createHash('md5').update(Buffer.concat([d1, password])).digest();
  return { key: Buffer.concat([d0, d1]), iv: d2 };
}

function decryptTextWithKey(encryptedHex, secret) {
  const buf  = Buffer.from(encryptedHex, 'hex');
  const salt = buf.slice(8, 16);
  const { key, iv } = _getKeyAndIv(secret, salt);
  const dec  = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([dec.update(buf.slice(16)), dec.final()]).toString('utf8');
}

function encryptTextWithKey(text, secret) {
  const salt = crypto.randomBytes(8);
  const { key, iv } = _getKeyAndIv(secret, salt);
  const enc  = crypto.createCipheriv('aes-256-cbc', key, iv);
  const ct   = Buffer.concat([enc.update(Buffer.from(text, 'utf8')), enc.final()]);
  return Buffer.concat([Buffer.from('Salted__'), salt, ct]).toString('hex');
}

const decryptText = hex  => decryptTextWithKey(hex, APP_CRYPTO_SECRET);
const encryptText = text => encryptTextWithKey(text, APP_CRYPTO_SECRET);

function passToHash(password, saltHex) {
  return new Promise((resolve, reject) => {
    const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
    crypto.pbkdf2(password, salt, 10000, 32, 'sha1', (err, key) => {
      if (err) return reject(err);
      resolve({ salt: salt.toString('hex'), hash: key.toString('hex') });
    });
  });
}

async function encryptPasswordHash(password, sKey) {
  const saltHex = decryptText(sKey);
  console.log(`  decrypted sKey → saltHex (${saltHex.length} chars): ${saltHex.slice(0,16)}…`);
  const hashObj = await passToHash(password, saltHex);
  console.log(`  PBKDF2 hash (${hashObj.hash.length} chars): ${hashObj.hash.slice(0,16)}…`);
  return encryptText(hashObj.hash);
}

function generateKeys(password) {
  const encPk = encryptTextWithKey('placeholder-private-key-for-login', password);
  return {
    privateKeyEncrypted: encPk,
    publicKey: 'placeholder-public-key-for-login',
    ecc: { publicKey: 'placeholder-ecc-public-key', privateKeyEncrypted: encPk },
    kyber: { publicKey: null, privateKeyEncrypted: null },
  };
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function jsonRequest(method, url, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const bodyBuf = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const reqHeaders = { ...HEADERS, ...headers, ...(bodyBuf ? { 'Content-Length': bodyBuf.length } : {}) };

    const req = https.request({
      hostname: u.hostname,
      port:     443,
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
        console.log(`  ← HTTP ${res.statusCode} ${method} ${u.pathname}`);
        if (res.statusCode >= 400) {
          const msg = (typeof data === 'object' && (data.message || data.error)) || `HTTP ${res.statusCode}: ${raw.slice(0,200)}`;
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

// ── Auth flow ─────────────────────────────────────────────────────────────────

async function internxtLogin(email, password, tfaCode) {
  const cleanEmail = email.toLowerCase().trim();

  console.log('\n[1] security_details → POST /auth/login');
  const secDetails = await apiPost(`${DRIVE_API_URL}/auth/login`, { email: cleanEmail });
  console.log('  response keys:', Object.keys(secDetails).join(', '));
  const sKey = secDetails.sKey;
  if (!sKey) throw new Error(`sKey missing. Full response: ${JSON.stringify(secDetails)}`);
  console.log(`  sKey (${sKey.length} chars): ${sKey.slice(0,32)}…`);

  console.log('\n[2] encrypting password hash');
  const encPasswordHash = await encryptPasswordHash(password, sKey);
  console.log(`  encPasswordHash (${encPasswordHash.length} chars): ${encPasswordHash.slice(0,32)}…`);
  const keys = generateKeys(password);

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

  console.log('\n[3] login/access → POST /auth/login/access');
  const accessRes = await apiPost(`${DRIVE_API_URL}/auth/login/access`, loginPayload);
  console.log('  response keys:', Object.keys(accessRes).join(', '));
  const tempToken = accessRes.newToken || accessRes.token;
  if (!tempToken) throw new Error(`No token in access response: ${JSON.stringify(accessRes).slice(0,300)}`);
  console.log(`  tempToken: ${tempToken.slice(0,32)}…`);

  console.log('\n[4] hydration → GET /users/refresh');
  const hydrated = await apiGet(`${DRIVE_API_URL}/users/refresh`, { Authorization: `Bearer ${tempToken}` });
  console.log('  response keys:', Object.keys(hydrated).join(', '));
  const user = hydrated.user || {};
  console.log('  user keys:', Object.keys(user).join(', '));
  console.log('  rootFolderUuid:', user.rootFolderUuid);
  console.log('  rootFolderId:',  user.rootFolderId);
  console.log('  root_folder_id:', user.root_folder_id);
  console.log('  uuid:', user.uuid);
  console.log('  email:', user.email);

  return { token: hydrated.token, newToken: hydrated.newToken, user };
}

async function resolveRootFolderUuid(bearerToken) {
  console.log('\n[4b] resolving root folder UUID → GET /folders/meta?path=/');
  const auth = { Authorization: `Bearer ${bearerToken}` };
  try {
    const meta = await apiGet(`${DRIVE_API_URL}/folders/meta?path=/`, auth);
    console.log('  folder meta keys:', Object.keys(meta).join(', '));
    console.log('  uuid:', meta.uuid, '  plainName:', meta.plainName);
    return meta.uuid;
  } catch (e) {
    console.warn('  /folders/meta?path=/ failed:', e.message);
    // Try /users/root-folder
    try {
      const rf = await apiGet(`${DRIVE_API_URL}/users/root-folder`, auth);
      console.log('  root-folder keys:', Object.keys(rf).join(', '));
      return rf.uuid || rf.id;
    } catch (e2) {
      console.warn('  /users/root-folder failed:', e2.message);
      return null;
    }
  }
}

async function listFolder(bearerToken, folderUuid) {
  console.log(`\n[5] list folder ${folderUuid}`);
  const auth = { Authorization: `Bearer ${bearerToken}` };
  const foldersUrl = `${DRIVE_API_URL}/folders/content/${folderUuid}/folders?offset=0&limit=50&sort=plainName&direction=ASC`;
  const filesUrl   = `${DRIVE_API_URL}/folders/content/${folderUuid}/files?offset=0&limit=50&sort=plainName&direction=ASC`;

  const [foldersRes, filesRes] = await Promise.all([
    apiGet(foldersUrl, auth).catch(e => { console.warn('  folders error:', e.message); return {}; }),
    apiGet(filesUrl,   auth).catch(e => { console.warn('  files error:',   e.message); return {}; }),
  ]);

  const folders = Array.isArray(foldersRes?.result) ? foldersRes.result
                : Array.isArray(foldersRes?.children) ? foldersRes.children
                : Array.isArray(foldersRes) ? foldersRes : [];
  const files   = Array.isArray(filesRes?.result) ? filesRes.result
                : Array.isArray(filesRes?.files)   ? filesRes.files
                : Array.isArray(filesRes)            ? filesRes : [];

  console.log(`  folders: ${folders.length}, files: ${files.length}`);
  folders.slice(0, 5).forEach(f => console.log(`    📁 ${f.plainName || f.name}  (${f.uuid})`));
  files.slice(0, 5).forEach(f => console.log(`    📄 ${f.plainName || f.name}.${f.type}  (${f.uuid})`));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const email    = process.argv[2] || process.env.EMAIL;
  const password = process.argv[3] || process.env.PASS;
  const tfa      = process.argv[4] || process.env.TFA || '';

  if (!email || !password) {
    console.error('Usage: node tools/test-internxt.js <email> <password> [tfa_code]');
    console.error('   Or: EMAIL=x PASS=y node tools/test-internxt.js');
    process.exit(1);
  }

  console.log('=== Internxt Auth Test ===');
  console.log('Email:', email);
  console.log('API:  ', DRIVE_API_URL);

  try {
    const session = await internxtLogin(email, password, tfa);
    console.log('\n✅ Login successful!');
    console.log('  newToken:', session.newToken?.slice(0, 32) + '…');
    console.log('  rootFolderUuid:', session.user.rootFolderUuid);

    // rootFolderId is already a UUID (rootFolderUuid doesn't exist in API response)
    const rootUuid = session.user.rootFolderId || session.user.rootFolderUuid || await resolveRootFolderUuid(session.newToken);
    console.log('\n  resolved rootFolderUuid:', rootUuid);
    await listFolder(session.newToken, rootUuid);

    console.log('\n✅ All steps passed.');
  } catch (e) {
    console.error('\n❌', e.message);
    process.exit(1);
  }
}

main();
