#!/usr/bin/env node
'use strict';
/**
 * tools/test-filen.js — standalone test for Filen auth flow.
 * Usage: node tools/test-filen.js <email> <password> [tfa_code]
 * Or:   EMAIL=x PASS=y node tools/test-filen.js
 *
 * Auth flow (from filen-python/services/auth.py + crypto.py + api.py):
 *   1. POST /v3/auth/info {email}            → {authVersion, salt}
 *   2. PBKDF2-SHA512(password, salt, 200000, 64) → derive masterKey + passwordHash
 *   3. POST /v3/login {email, password, authVersion, twoFactorCode} → {apiKey, masterKeys}
 *   4. decrypt each masterKey with decrypt_metadata_002(encrypted, localMasterKey)
 *   5. GET /v3/user/baseFolder (Bearer: apiKey) → {uuid}
 *   6. POST /v3/dir/content {uuid}            → {folders, uploads}
 */

const crypto = require('crypto');
const https  = require('https');

const FILEN_API = 'https://gateway.filen.io';

// ── Crypto helpers ────────────────────────────────────────────────────────────

/** PBKDF2-SHA512 wrapper */
function pbkdf2(password, salt, iterations, len) {
  return new Promise((resolve, reject) =>
    crypto.pbkdf2(password, salt, iterations, len, 'sha512', (e, k) => e ? reject(e) : resolve(k))
  );
}

/**
 * Filen key derivation (matches filen-python crypto.py derive_keys()).
 * Returns { masterKey: hexStr, passwordHash: hexStr }
 */
async function deriveKeys(password, authVersion, salt) {
  const derived  = await pbkdf2(password, salt, 200000, 64);
  const keyHex   = derived.toString('hex').toLowerCase();

  if (authVersion === 2) {
    const masterKey    = keyHex.slice(0, 64);
    const passwordHash = crypto.createHash('sha512')
      .update(keyHex.slice(64))
      .digest('hex')
      .toLowerCase();
    return { masterKey, passwordHash };
  }
  // v1: full hex for both
  return { masterKey: keyHex, passwordHash: keyHex };
}

/**
 * Decrypt Filen "002" metadata format (matches filen-python crypto.py decrypt_metadata_002()).
 * Format: "002" + 12-char IV + base64(ciphertext + 16-byte GCM tag)
 * Key: PBKDF2-SHA512(masterKey, masterKey, 1, 32)
 */
async function decryptMetadata002(encrypted, masterKey) {
  if (!encrypted.startsWith('002')) throw new Error('Invalid metadata version: ' + encrypted.slice(0, 10));
  const iv         = encrypted.slice(3, 15);           // 12-char ASCII string used as IV
  const cipherBuf  = Buffer.from(encrypted.slice(15), 'base64');
  const ciphertext = cipherBuf.slice(0, -16);
  const tag        = cipherBuf.slice(-16);

  const dk = await pbkdf2(masterKey, masterKey, 1, 32);

  const dec = crypto.createDecipheriv('aes-256-gcm', dk, Buffer.from(iv, 'utf8'));
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ciphertext), dec.final()]).toString('utf8');
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function apiRequest(method, path, { body, apiKey } = {}) {
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
        console.log(`  ← HTTP ${res.statusCode} ${method} ${path}`);
        if (res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
        }
        if (data?.status === false) {
          return reject(new Error(data.message || 'Filen API error'));
        }
        resolve(data?.data ?? data);
      });
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// ── Auth flow ─────────────────────────────────────────────────────────────────

async function filenLogin(email, password, tfaCode) {
  const cleanEmail = email.toLowerCase().trim();

  console.log('\n[1] auth/info → POST /v3/auth/info');
  const authInfo    = await apiRequest('POST', '/v3/auth/info', { body: { email: cleanEmail } });
  console.log('  authVersion:', authInfo.authVersion, '  salt length:', authInfo.salt?.length);
  const authVersion = authInfo.authVersion ?? 2;
  const salt        = authInfo.salt;
  if (!salt) throw new Error('No salt in auth/info response');

  console.log('\n[2] deriving keys (PBKDF2-SHA512, 200000 iter)');
  const { masterKey, passwordHash } = await deriveKeys(password, authVersion, salt);
  console.log('  masterKey (first 16 hex):', masterKey.slice(0, 16) + '…');
  console.log('  passwordHash (first 16):', passwordHash.slice(0, 16) + '…');

  console.log('\n[3] login → POST /v3/login');
  const loginData = await apiRequest('POST', '/v3/login', {
    body: {
      email:         cleanEmail,
      password:      passwordHash,
      authVersion:   authVersion,
      twoFactorCode: tfaCode?.trim() || 'XXXXXX',
    }
  });
  console.log('  response keys:', Object.keys(loginData).join(', '));
  const apiKey = loginData.apiKey;
  if (!apiKey) throw new Error('No apiKey in login response');
  console.log('  apiKey (first 16):', apiKey.slice(0, 16) + '…');

  console.log('\n[4] decrypting master keys');
  const rawKeys       = Array.isArray(loginData.masterKeys) ? loginData.masterKeys
                      : typeof loginData.masterKeys === 'string' ? [loginData.masterKeys] : [];
  console.log('  encrypted master keys count:', rawKeys.length);
  const decryptedKeys = [];
  for (const enc of rawKeys) {
    try {
      const dec = await decryptMetadata002(enc, masterKey);
      decryptedKeys.push(dec);
      console.log('  ✓ key decrypted, length:', dec.length);
    } catch (e) {
      console.warn('  ✗ key decryption failed:', e.message);
    }
  }
  if (decryptedKeys.length === 0) {
    console.warn('  No keys decrypted — falling back to local masterKey');
    decryptedKeys.push(masterKey);
  }

  console.log('\n[5] base folder → GET /v3/user/baseFolder');
  const baseFolder     = await apiRequest('GET', '/v3/user/baseFolder', { apiKey });
  const baseFolderUuid = baseFolder.uuid;
  console.log('  baseFolderUuid:', baseFolderUuid);

  return { email: cleanEmail, apiKey, masterKeys: decryptedKeys, baseFolderUuid, userId: loginData.id };
}

async function listFolder(apiKey, masterKeys, folderUuid) {
  console.log(`\n[6] dir/content → POST /v3/dir/content (uuid=${folderUuid})`);
  const data = await apiRequest('POST', '/v3/dir/content', {
    body: { uuid: folderUuid, foldersOnly: false },
    apiKey,
  });

  const folders = Array.isArray(data.folders) ? data.folders : [];
  const files   = Array.isArray(data.uploads) ? data.uploads : (Array.isArray(data.files) ? data.files : []);
  console.log(`  folders: ${folders.length}, files: ${files.length}`);

  // Decrypt a few names
  const topKey = masterKeys[masterKeys.length - 1]; // use latest master key
  for (const f of folders.slice(0, 3)) {
    try {
      const name = await decryptMetadata002(f.name, topKey);
      console.log(`  📁 ${name}  (${f.uuid})`);
    } catch { console.log(`  📁 [decrypt failed]  (${f.uuid})`); }
  }
  const IMAGE_EXTS = new Set(['.jpg','.jpeg','.png','.webp','.gif','.heic','.heif','.avif','.bmp','.tiff']);
  let imgCount = 0;
  for (const f of files) {
    try {
      const meta = await decryptMetadata002(f.metadata, topKey);
      const parsed = JSON.parse(meta);
      const ext = ('.' + (parsed.name || '').split('.').pop()).toLowerCase();
      if (IMAGE_EXTS.has(ext)) {
        imgCount++;
        if (imgCount <= 3) console.log(`  🖼 ${parsed.name}  (${f.uuid})`);
      }
    } catch {}
  }
  if (imgCount > 3) console.log(`  … and ${imgCount - 3} more images`);
  else if (imgCount === 0) console.log('  (no image files in root — normal for cloud storage)');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const email    = process.argv[2] || process.env.EMAIL;
  const password = process.argv[3] || process.env.PASS;
  const tfa      = process.argv[4] || process.env.TFA || '';

  if (!email || !password) {
    console.error('Usage: node tools/test-filen.js <email> <password> [tfa_code]');
    process.exit(1);
  }

  console.log('=== Filen Auth Test ===');
  console.log('Email:', email);
  console.log('API:  ', FILEN_API);

  try {
    const session = await filenLogin(email, password, tfa);
    console.log('\n✅ Login successful!');
    console.log('  baseFolderUuid:', session.baseFolderUuid);
    console.log('  masterKeys count:', session.masterKeys.length);

    await listFolder(session.apiKey, session.masterKeys, session.baseFolderUuid);

    console.log('\n✅ All steps passed.');
  } catch (e) {
    console.error('\n❌', e.message);
    process.exit(1);
  }
}

main();
