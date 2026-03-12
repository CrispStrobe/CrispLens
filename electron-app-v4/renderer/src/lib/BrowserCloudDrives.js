/**
 * BrowserCloudDrives.js — Browser-native Internxt + Filen client.
 *
 * Ported from server/routes/cloud-drives.js to use SubtleCrypto + fetch so
 * cloud drives work in PWA / standalone (_localMode=true) without a v4 server.
 *
 * Auth flows are identical to the Node.js implementation:
 *   Internxt: EVP_BytesToKey(MD5) + AES-256-CBC + PBKDF2-SHA1
 *   Filen:    PBKDF2-SHA512 + AES-256-GCM
 */

// ─────────────────────────────────────────────────────────────────────────────
// Tiny MD5 (needed for Internxt's OpenSSL EVP_BytesToKey — not in SubtleCrypto)
// Adapted from the public-domain implementation by Paul Johnston.
// ─────────────────────────────────────────────────────────────────────────────
function md5(data /* Uint8Array */) {
  function safeAdd(x, y) { const l = (x & 0xffff) + (y & 0xffff); return (((x >> 16) + (y >> 16) + (l >> 16)) << 16) | (l & 0xffff); }
  function bitRotate(num, cnt) { return (num << cnt) | (num >>> (32 - cnt)); }
  function md5cmn(q, a, b, x, s, t) { return safeAdd(bitRotate(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b); }
  function md5ff(a, b, c, d, x, s, t) { return md5cmn((b & c) | (~b & d), a, b, x, s, t); }
  function md5gg(a, b, c, d, x, s, t) { return md5cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function md5hh(a, b, c, d, x, s, t) { return md5cmn(b ^ c ^ d, a, b, x, s, t); }
  function md5ii(a, b, c, d, x, s, t) { return md5cmn(c ^ (b | ~d), a, b, x, s, t); }

  // Pad message to 64-byte boundary
  const len = data.length;
  const extra = (64 - ((len + 9) % 64)) % 64;
  const padded = new Uint8Array(len + 9 + extra);
  padded.set(data);
  padded[len] = 0x80;
  const bitsLo = (len * 8) >>> 0;
  const bitsHi = Math.floor(len / 0x20000000);
  padded[padded.length - 8] = bitsLo & 0xff;
  padded[padded.length - 7] = (bitsLo >>> 8) & 0xff;
  padded[padded.length - 6] = (bitsLo >>> 16) & 0xff;
  padded[padded.length - 5] = (bitsLo >>> 24) & 0xff;
  padded[padded.length - 4] = bitsHi & 0xff;

  let [a, b, c, d] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];

  for (let i = 0; i < padded.length; i += 64) {
    const M = new Int32Array(16);
    for (let j = 0; j < 16; j++) M[j] = (padded[i+j*4]) | (padded[i+j*4+1]<<8) | (padded[i+j*4+2]<<16) | (padded[i+j*4+3]<<24);
    let [aa, bb, cc, dd] = [a, b, c, d];
    a = md5ff(a,b,c,d,M[0],7,-680876936);   d=md5ff(d,a,b,c,M[1],12,-389564586);  c=md5ff(c,d,a,b,M[2],17,606105819);   b=md5ff(b,c,d,a,M[3],22,-1044525330);
    a = md5ff(a,b,c,d,M[4],7,-176418897);   d=md5ff(d,a,b,c,M[5],12,1200080426);  c=md5ff(c,d,a,b,M[6],17,-1473231341); b=md5ff(b,c,d,a,M[7],22,-45705983);
    a = md5ff(a,b,c,d,M[8],7,1770035416);   d=md5ff(d,a,b,c,M[9],12,-1958414417); c=md5ff(c,d,a,b,M[10],17,-42063);     b=md5ff(b,c,d,a,M[11],22,-1990404162);
    a = md5ff(a,b,c,d,M[12],7,1804603682);  d=md5ff(d,a,b,c,M[13],12,-40341101);  c=md5ff(c,d,a,b,M[14],17,-1502002290);b=md5ff(b,c,d,a,M[15],22,1236535329);
    a = md5gg(a,b,c,d,M[1],5,-165796510);   d=md5gg(d,a,b,c,M[6],9,-1069501632);  c=md5gg(c,d,a,b,M[11],14,643717713);  b=md5gg(b,c,d,a,M[0],20,-373897302);
    a = md5gg(a,b,c,d,M[5],5,-701558691);   d=md5gg(d,a,b,c,M[10],9,38016083);    c=md5gg(c,d,a,b,M[15],14,-660478335); b=md5gg(b,c,d,a,M[4],20,-405537848);
    a = md5gg(a,b,c,d,M[9],5,568446438);    d=md5gg(d,a,b,c,M[14],9,-1019803690); c=md5gg(c,d,a,b,M[3],14,-187363961);  b=md5gg(b,c,d,a,M[8],20,1163531501);
    a = md5gg(a,b,c,d,M[13],5,-1444681467); d=md5gg(d,a,b,c,M[2],9,-51403784);    c=md5gg(c,d,a,b,M[7],14,1735328473);  b=md5gg(b,c,d,a,M[12],20,-1926607734);
    a = md5hh(a,b,c,d,M[5],4,-378558);      d=md5hh(d,a,b,c,M[8],11,-2022574463); c=md5hh(c,d,a,b,M[11],16,1839030562); b=md5hh(b,c,d,a,M[14],23,-35309556);
    a = md5hh(a,b,c,d,M[1],4,-1530992060); d=md5hh(d,a,b,c,M[4],11,1272893353);  c=md5hh(c,d,a,b,M[7],16,-155497632);  b=md5hh(b,c,d,a,M[10],23,-1094730640);
    a = md5hh(a,b,c,d,M[13],4,681279174);   d=md5hh(d,a,b,c,M[0],11,-358537222);  c=md5hh(c,d,a,b,M[3],16,-722521979);  b=md5hh(b,c,d,a,M[6],23,76029189);
    a = md5hh(a,b,c,d,M[9],4,-640364487);   d=md5hh(d,a,b,c,M[12],11,-421815835); c=md5hh(c,d,a,b,M[15],16,530742520);  b=md5hh(b,c,d,a,M[2],23,-995338651);
    a = md5ii(a,b,c,d,M[0],6,-198630844);   d=md5ii(d,a,b,c,M[7],10,1126891415);  c=md5ii(c,d,a,b,M[14],15,-1416354905);b=md5ii(b,c,d,a,M[5],21,-57434055);
    a = md5ii(a,b,c,d,M[12],6,1700485571);  d=md5ii(d,a,b,c,M[3],10,-1894986606); c=md5ii(c,d,a,b,M[10],15,-1051523);   b=md5ii(b,c,d,a,M[1],21,-2054922799);
    a = md5ii(a,b,c,d,M[8],6,1873313359);   d=md5ii(d,a,b,c,M[15],10,-30611744);  c=md5ii(c,d,a,b,M[6],15,-1560198380); b=md5ii(b,c,d,a,M[13],21,1309151649);
    a = md5ii(a,b,c,d,M[4],6,-145523070);   d=md5ii(d,a,b,c,M[11],10,-1120210379);c=md5ii(c,d,a,b,M[2],15,718787259);   b=md5ii(b,c,d,a,M[9],21,-343485551);
    a=safeAdd(a,aa); b=safeAdd(b,bb); c=safeAdd(c,cc); d=safeAdd(d,dd);
  }
  const out = new Uint8Array(16);
  [a,b,c,d].forEach((v,i) => { out[i*4]=(v)&0xff; out[i*4+1]=(v>>>8)&0xff; out[i*4+2]=(v>>>16)&0xff; out[i*4+3]=(v>>>24)&0xff; });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility helpers
// ─────────────────────────────────────────────────────────────────────────────
const enc = new TextEncoder();
const dec = new TextDecoder();

function hexToBytes(hex) {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.slice(i*2, i*2+2), 16);
  return b;
}
function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2,'0')).join('');
}
function concatU8(...args) {
  const out = new Uint8Array(args.reduce((s,a) => s + a.length, 0));
  let off = 0; for (const a of args) { out.set(a, off); off += a.length; }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internxt crypto (OpenSSL EVP_BytesToKey + AES-256-CBC + PBKDF2-SHA1)
// ─────────────────────────────────────────────────────────────────────────────
const APP_CRYPTO_SECRET = '6KYQBP847D4ATSFA';

function _getKeyAndIv(secret, salt) {
  const password = concatU8(enc.encode(secret), salt);
  const d0 = md5(password);
  const d1 = md5(concatU8(d0, password));
  const d2 = md5(concatU8(d1, password));
  return { key: concatU8(d0, d1), iv: d2 };
}

async function decryptTextWithKey(hexStr, secret) {
  const buf  = hexToBytes(hexStr);
  const salt = buf.slice(8, 16);
  const { key, iv } = _getKeyAndIv(secret, salt);
  const ck   = await crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, ck, buf.slice(16));
  return dec.decode(plain);
}

async function encryptTextWithKey(text, secret) {
  const salt = crypto.getRandomValues(new Uint8Array(8));
  const { key, iv } = _getKeyAndIv(secret, salt);
  const ck = await crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, ck, enc.encode(text)));
  return bytesToHex(concatU8(enc.encode('Salted__'), salt, ct));
}

const decryptText = hex  => decryptTextWithKey(hex, APP_CRYPTO_SECRET);
const encryptText = text => encryptTextWithKey(text, APP_CRYPTO_SECRET);

async function passToHash(password, saltHex) {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const km   = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 10000, hash: 'SHA-1' }, km, 256);
  return { salt: bytesToHex(salt), hash: bytesToHex(new Uint8Array(bits)) };
}

async function encryptPasswordHash(password, sKey) {
  const saltHex = await decryptText(sKey);
  const hashObj = await passToHash(password, saltHex);
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

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers (browser fetch, matching server jsonRequest)
// ─────────────────────────────────────────────────────────────────────────────
const INTERNXT_API = 'https://gateway.internxt.com/drive';
const INTERNXT_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json', 'internxt-client': 'internxt-cli' };

async function apiGet(url, extraHeaders = {}) {
  const r = await fetch(url, { method: 'GET', headers: { ...INTERNXT_HEADERS, ...extraHeaders } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || data.error || `HTTP ${r.status}`);
  return data;
}
async function apiPost(url, body, extraHeaders = {}) {
  const r = await fetch(url, { method: 'POST', headers: { ...INTERNXT_HEADERS, ...extraHeaders }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || data.error || `HTTP ${r.status}`);
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internxt: login + browse
// ─────────────────────────────────────────────────────────────────────────────
export async function internxtLogin(email, password, tfaCode) {
  const cleanEmail = email.toLowerCase().trim();
  const secDetails = await apiPost(`${INTERNXT_API}/auth/login`, { email: cleanEmail });
  const sKey = secDetails.sKey;
  if (!sKey) throw new Error(`Internxt login: sKey missing. Response: ${JSON.stringify(secDetails)}`);

  const encPasswordHash = await encryptPasswordHash(password, sKey);
  const keys = await generateKeys(password);
  const loginPayload = {
    email: cleanEmail, password: encPasswordHash,
    tfa: tfaCode?.trim() || undefined,
    keys: { ecc: { publicKey: keys.ecc.publicKey, privateKey: keys.ecc.privateKeyEncrypted } },
    privateKey: keys.privateKeyEncrypted, publicKey: keys.publicKey,
  };

  const accessRes = await apiPost(`${INTERNXT_API}/auth/login/access`, loginPayload);
  const tempToken = accessRes.newToken || accessRes.token;
  if (!tempToken) throw new Error(`Internxt auth: no token. Response: ${JSON.stringify(accessRes)}`);

  const hydrated = await apiGet(`${INTERNXT_API}/users/refresh`, { Authorization: `Bearer ${tempToken}` });
  const user = hydrated.user || {};
  const rootFolderUuid = user.rootFolderUuid || user.rootFolderId;
  // bridgeUser = email used as Basic-auth username for the network API
  // userId = user UUID used as Basic-auth password for the network API
  const bridgeUser = user.bridgeUser || user.email || cleanEmail;
  const userId     = user.userId || user.uuid || user.id;
  // Mnemonic is returned AES-256-CBC encrypted with the user's password — decrypt it now.
  // This is the same flow as server/routes/cloud-drives.js internxtLogin().
  let mnemonic = null;
  if (user.mnemonic) {
    try {
      mnemonic = await decryptTextWithKey(user.mnemonic, password);
      console.log('[BrowserCloud/internxt] Mnemonic decrypted OK');
    } catch (e) {
      console.warn('[BrowserCloud/internxt] Could not decrypt mnemonic:', e.message);
    }
  }
  return { token: hydrated.token, newToken: hydrated.newToken, user,
           rootFolderUuid, bridgeUser, userId, mnemonic };
}

async function internxtListFolder(bearerToken, folderUuid) {
  const auth = { Authorization: `Bearer ${bearerToken}` };
  const MAX  = 50;

  async function fetchAllPages(kind) {
    const all = [];
    let offset = 0;
    while (true) {
      const url = `${INTERNXT_API}/folders/content/${folderUuid}/${kind}?offset=${offset}&limit=${MAX}&sort=plainName&direction=ASC`;
      let res;
      try { res = await apiGet(url, auth); } catch (e) { console.error(`[BrowserCloud/internxt] ${kind} offset=${offset}:`, e.message); break; }
      const page = Array.isArray(res?.[kind]) ? res[kind] : Array.isArray(res?.result) ? res.result : Array.isArray(res) ? res : [];
      all.push(...page);
      if (page.length < MAX) break;
      offset += MAX;
    }
    return all;
  }

  const [folders, files] = await Promise.all([fetchAllPages('folders'), fetchAllPages('files')]);
  return { folders, files };
}

export async function internxtBrowse(tokenData, path) {
  const { token, newToken, rootFolderUuid } = tokenData;
  const bearer = newToken || token;
  const IMAGE_EXTS = new Set(['.jpg','.jpeg','.png','.webp','.gif','.bmp','.tiff','.heic','.heif','.avif']);

  let folderUuid = rootFolderUuid;
  let parentPath = null;

  if (path && path !== '/') {
    // path segments are UUIDs (e.g. /uuid1/uuid2)
    const parts = path.split('/').filter(Boolean);
    folderUuid = parts[parts.length - 1];
    parentPath = parts.length > 1 ? '/' + parts.slice(0, -1).join('/') : '/';
  }

  const { folders, files } = await internxtListFolder(bearer, folderUuid);

  const entries = [
    ...folders.map(f => ({
      name:   f.plainName || f.name,
      path:   `${path === '/' ? '' : path}/${f.uuid}`,
      is_dir: true,
    })),
    ...files.filter(f => IMAGE_EXTS.has('.' + (f.type || '').toLowerCase())).map(f => ({
      name:   (f.plainName || f.name) + (f.type ? '.' + f.type : ''),
      path:   `${path === '/' ? '' : path}/file/${f.uuid}`,
      is_dir: false,
      size:   f.size,
    })),
  ].sort((a, b) => (b.is_dir - a.is_dir) || a.name.localeCompare(b.name));

  return { path, parent: parentPath, entries };
}

// ─────────────────────────────────────────────────────────────────────────────
// Filen crypto (PBKDF2-SHA512 + AES-256-GCM)
// ─────────────────────────────────────────────────────────────────────────────
async function filenDeriveKeys(password, authVersion, salt) {
  const km      = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const saltBuf = enc.encode(salt);
  const bits    = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: saltBuf, iterations: 200000, hash: 'SHA-512' }, km, 512);
  const keyHex  = bytesToHex(new Uint8Array(bits));
  if (authVersion === 2) {
    const masterKey    = keyHex.slice(0, 64);
    const hashInput    = keyHex.slice(64);
    const hashBuf      = await crypto.subtle.digest('SHA-512', enc.encode(hashInput));
    const passwordHash = bytesToHex(new Uint8Array(hashBuf));
    return { masterKey, passwordHash };
  }
  return { masterKey: keyHex, passwordHash: keyHex };
}

async function filenDecryptMetadata(encrypted, masterKey) {
  if (!encrypted?.startsWith('002')) throw new Error('Not "002" format');
  const iv         = enc.encode(encrypted.slice(3, 15));
  const cipherBuf  = Uint8Array.from(atob(encrypted.slice(15)), c => c.charCodeAt(0));
  const ciphertext = cipherBuf.slice(0, -16);
  const tag        = cipherBuf.slice(-16);
  const combined   = concatU8(ciphertext, tag);

  const km  = await crypto.subtle.importKey('raw', enc.encode(masterKey), { name: 'PBKDF2' }, false, ['deriveBits']);
  const dkB = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(masterKey), iterations: 1, hash: 'SHA-512' }, km, 256);
  const dk  = new Uint8Array(dkB);
  const ck  = await crypto.subtle.importKey('raw', dk, { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, ck, combined);
  return dec.decode(plain);
}

// ─────────────────────────────────────────────────────────────────────────────
// Filen: login + browse
// ─────────────────────────────────────────────────────────────────────────────
const FILEN_API = 'https://gateway.filen.io';

async function filenFetch(method, path, { body, apiKey } = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const r = await fetch(`${FILEN_API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.status === false) throw new Error(data.message || `Filen HTTP ${r.status}`);
  return data.data ?? data;
}

export async function filenLogin(email, password, tfaCode) {
  const cleanEmail  = email.toLowerCase().trim();
  const authInfo    = await filenFetch('POST', '/v3/auth/info', { body: { email: cleanEmail } });
  const authVersion = authInfo.authVersion ?? 2;
  const salt        = authInfo.salt;
  if (!salt) throw new Error('Filen: no salt in auth/info response');

  const { masterKey, passwordHash } = await filenDeriveKeys(password, authVersion, salt);

  const loginData = await filenFetch('POST', '/v3/login', {
    body: { email: cleanEmail, password: passwordHash, authVersion, twoFactorCode: tfaCode?.trim() || 'XXXXXX' },
  });
  const apiKey = loginData.apiKey;
  if (!apiKey) throw new Error('Filen: no apiKey in login response');

  const rawKeys = Array.isArray(loginData.masterKeys) ? loginData.masterKeys
                : typeof loginData.masterKeys === 'string' ? [loginData.masterKeys] : [];
  const decryptedKeys = [];
  for (const k of rawKeys) {
    try { decryptedKeys.push(await filenDecryptMetadata(k, masterKey)); } catch {}
  }
  if (decryptedKeys.length === 0) decryptedKeys.push(masterKey);

  const baseFolder = await filenFetch('GET', '/v3/user/baseFolder', { apiKey });
  if (!baseFolder.uuid) throw new Error('Filen: no baseFolderUuid');

  return { apiKey, masterKeys: decryptedKeys, baseFolderUuid: baseFolder.uuid };
}

export async function filenBrowse(tokenData, path) {
  const { apiKey, masterKeys, baseFolderUuid } = tokenData;
  const IMAGE_EXTS = new Set(['.jpg','.jpeg','.png','.webp','.gif','.bmp','.tiff','.heic','.heif','.avif']);

  let folderUuid = baseFolderUuid;
  let parentPath = null;
  if (path && path !== '/') {
    const parts = path.split('/').filter(Boolean);
    folderUuid = parts[parts.length - 1];
    parentPath = parts.length > 1 ? '/' + parts.slice(0, -1).join('/') : '/';
  }

  async function tryDecrypt(encrypted) {
    for (let i = masterKeys.length - 1; i >= 0; i--) {
      try { return await filenDecryptMetadata(encrypted, masterKeys[i]); } catch {}
    }
    return null;
  }

  const data     = await filenFetch('POST', '/v3/dir/content', { body: { uuid: folderUuid, foldersOnly: false }, apiKey });
  const rawFolders = Array.isArray(data.folders) ? data.folders : [];
  const rawFiles   = Array.isArray(data.uploads) ? data.uploads : (Array.isArray(data.files) ? data.files : []);

  const folders = [];
  for (const f of rawFolders) {
    const name = await tryDecrypt(f.name);
    if (name) folders.push({ name, uuid: f.uuid, is_dir: true, path: `${path === '/' ? '' : path}/${f.uuid}` });
  }
  const files = [];
  for (const f of rawFiles) {
    try {
      const meta = JSON.parse(await tryDecrypt(f.metadata) || '{}');
      const name = meta.name || f.uuid;
      const ext  = name.includes('.') ? '.' + name.split('.').pop().toLowerCase() : '';
      if (IMAGE_EXTS.has(ext)) {
        files.push({ name, uuid: f.uuid, size: meta.size, is_dir: false, path: `${path === '/' ? '' : path}/file/${f.uuid}` });
      }
    } catch {}
  }

  const entries = [...folders, ...files].sort((a, b) => (b.is_dir - a.is_dir) || a.name.localeCompare(b.name));
  return { path, parent: parentPath, entries };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internxt: file download (browser SubtleCrypto AES-256-CTR)
// Mirrors server/routes/cloud-drives.js internxtDownloadFile() for Node.js
// ─────────────────────────────────────────────────────────────────────────────
const INTERNXT_NETWORK = 'https://gateway.internxt.com/network';

async function _bip39ToSeed(mnemonic) {
  const km   = await crypto.subtle.importKey('raw', enc.encode(mnemonic), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode('mnemonic'), iterations: 2048, hash: 'SHA-512' }, km, 512
  );
  return new Uint8Array(bits);
}

async function _internxtFileKey(mnemonic, bucketId, indexHex) {
  const seed         = await _bip39ToSeed(mnemonic);
  const bucketBytes  = hexToBytes(bucketId);
  const indexBytes   = hexToBytes(indexHex);
  // bucketKey = SHA-512(seed ‖ bucketIdBytes)
  const bucketKeyBuf = await crypto.subtle.digest('SHA-512', concatU8(seed, bucketBytes));
  const bucketKey    = new Uint8Array(bucketKeyBuf);
  // fileKey   = SHA-512(bucketKey[:32] ‖ indexBytes)[:32]
  const fileKeyBuf   = await crypto.subtle.digest('SHA-512', concatU8(bucketKey.slice(0, 32), indexBytes));
  const fileKey      = new Uint8Array(fileKeyBuf).slice(0, 32);
  const iv           = indexBytes.slice(0, 16);
  return { fileKey, iv };
}

/**
 * Download + decrypt an Internxt file in the browser.
 * tokenData must include: token (bearer), mnemonic, bridgeUser, userId
 * Returns { blob: Blob, name: string }
 */
export async function internxtDownloadFile(tokenData, fileUuid) {
  const { mnemonic, bridgeUser, userId } = tokenData;
  const bearer = tokenData.newToken || tokenData.token;
  if (!mnemonic) throw new Error('Internxt: mnemonic missing — unmount and remount the drive to re-authenticate');

  // Step 1: file meta → bucket + fileId + size + name
  const metaRes  = await apiGet(`${INTERNXT_API}/files/${fileUuid}/meta`, { Authorization: `Bearer ${bearer}` });
  const bucketId = metaRes.item?.bucket;
  const fileId   = metaRes.item?.id;
  const fileSize = parseInt(metaRes.item?.size || 0, 10);
  const name     = (metaRes.item?.plainName || '') + (metaRes.item?.type ? '.' + metaRes.item.type : fileUuid);
  if (!bucketId || !fileId) throw new Error('Internxt: missing bucket/fileId in meta response');

  // Step 2: network shard info (Basic auth: bridgeUser:userId)
  const basic    = btoa(`${bridgeUser}:${userId}`);
  const linkRes  = await fetch(`${INTERNXT_NETWORK}/buckets/${bucketId}/files/${fileId}/info`, {
    headers: { 'x-api-version': '2', Authorization: `Basic ${basic}` },
  });
  if (!linkRes.ok) throw new Error(`Internxt network info HTTP ${linkRes.status}`);
  const linkInfo   = await linkRes.json();
  const shardUrl   = linkInfo?.shards?.[0]?.url;
  const indexHex   = linkInfo?.index;
  if (!shardUrl)  throw new Error('Internxt: no shard URL in network info');
  if (!indexHex)  throw new Error('Internxt: no index in network info');

  // Step 3: download encrypted binary
  const encRes  = await fetch(shardUrl);
  if (!encRes.ok) throw new Error(`Internxt shard download HTTP ${encRes.status}`);
  const encData = new Uint8Array(await encRes.arrayBuffer());

  // Step 4: AES-256-CTR decrypt (SubtleCrypto — length:128 = full counter block, matches Node.js default)
  const { fileKey, iv } = await _internxtFileKey(mnemonic, bucketId, indexHex);
  const ck        = await crypto.subtle.importKey('raw', fileKey, { name: 'AES-CTR' }, false, ['decrypt']);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-CTR', counter: iv, length: 128 }, ck, encData);
  const trimmed   = fileSize > 0 ? decrypted.slice(0, fileSize) : decrypted;
  return { blob: new Blob([trimmed]), name };
}

// ─────────────────────────────────────────────────────────────────────────────
// Filen: file download (browser SubtleCrypto AES-256-GCM)
// Mirrors server/routes/cloud-drives.js filenDownloadFile() for Node.js
// ─────────────────────────────────────────────────────────────────────────────
const FILEN_EGEST = 'https://egest.filen.io';

/**
 * Download + decrypt a Filen file in the browser.
 * tokenData must include: apiKey, masterKeys (string[])
 * Returns { blob: Blob, name: string }
 */
export async function filenDownloadFile(tokenData, fileUuid) {
  const { apiKey, masterKeys } = tokenData;

  async function tryDecrypt(encrypted) {
    for (let i = masterKeys.length - 1; i >= 0; i--) {
      try { return await filenDecryptMetadata(encrypted, masterKeys[i]); } catch {}
    }
    return null;
  }

  // Step 1: file metadata
  const metadata = await filenFetch('POST', '/v3/file', { body: { uuid: fileUuid }, apiKey });
  const chunks   = parseInt(metadata.chunks || 0, 10);
  const region   = metadata.region;
  const bucket   = metadata.bucket;
  const encMeta  = metadata.metadata;
  if (!encMeta)  throw new Error('Filen: no metadata in file response');

  // Step 2: decrypt metadata → { key, name, size }
  const metaStr = await tryDecrypt(encMeta);
  if (!metaStr) throw new Error('Filen: could not decrypt file metadata');
  const meta = JSON.parse(metaStr);
  const name = meta.name || fileUuid;
  let fileKeyBytes;
  if (meta.key && meta.key.length === 32) {
    fileKeyBytes = enc.encode(meta.key);                                          // UTF-8 32-char key
  } else if (meta.key) {
    fileKeyBytes = Uint8Array.from(atob(meta.key), c => c.charCodeAt(0));         // base64-encoded key
  } else {
    throw new Error('Filen: no file key in decrypted metadata');
  }
  const ck = await crypto.subtle.importKey('raw', fileKeyBytes, { name: 'AES-GCM' }, false, ['decrypt']);

  // Step 3+4: download + decrypt each chunk (AES-256-GCM: iv[:12] ‖ ct ‖ tag[-16:])
  const decryptedChunks = [];
  for (let i = 0; i < chunks; i++) {
    const url       = `${FILEN_EGEST}/${region}/${bucket}/${fileUuid}/${i}`;
    const chunkRes  = await fetch(url);
    if (!chunkRes.ok) throw new Error(`Filen chunk ${i} HTTP ${chunkRes.status}`);
    const chunkData = new Uint8Array(await chunkRes.arrayBuffer());
    const iv        = chunkData.slice(0, 12);
    const ciphertext = chunkData.slice(12, -16);
    const tag       = chunkData.slice(-16);
    const combined  = concatU8(ciphertext, tag);   // SubtleCrypto expects ciphertext||tag
    const plain     = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, ck, combined);
    decryptedChunks.push(new Uint8Array(plain));
  }

  const totalLen = decryptedChunks.reduce((s, c) => s + c.length, 0);
  const out      = new Uint8Array(totalLen);
  let off = 0;
  for (const c of decryptedChunks) { out.set(c, off); off += c.length; }
  return { blob: new Blob([out]), name };
}
