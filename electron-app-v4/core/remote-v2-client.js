'use strict';

/**
 * remote-v2-client.js — HTTP client for the v2 FastAPI face-recognition server.
 *
 * Supports two transfer modes:
 *   'shared_path'   — send the filepath string; remote server reads file from disk
 *   'upload_bytes'  — upload raw image bytes via multipart POST
 *
 * Auth: session-cookie (POST /api/auth/login); refreshes on 401.
 */

const path = require('path');
const fs   = require('fs');

class RemoteV2Client {
  constructor(baseUrl, username, password) {
    this.baseUrl  = baseUrl.replace(/\/$/, '');
    this.username = username;
    this.password = password;
    this._cookie  = null;
  }

  // ── Auth ─────────────────────────────────────────────────────────────────────

  async ensureAuth() {
    if (this._cookie) return;
    await this._login();
  }

  async _login() {
    const url = `${this.baseUrl}/api/auth/login`;
    console.log(`[remote-v2] POST ${url} (user=${this.username})`);

    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username: this.username, password: this.password }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Remote v2 auth failed: HTTP ${res.status} — ${body}`);
    }
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      this._cookie = setCookie.split(';')[0];
      console.log(`[remote-v2] auth OK, cookie set`);
    } else {
      throw new Error('Remote v2 auth: no Set-Cookie in response');
    }
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────────────

  async _fetch(urlPath, init = {}, doAuth = true) {
    if (doAuth) await this.ensureAuth();
    const headers = { ...(init.headers || {}) };
    if (this._cookie) headers['Cookie'] = this._cookie;

    const url = `${this.baseUrl}${urlPath}`;
    const res = await fetch(url, { ...init, headers });

    if (res.status === 401 && doAuth) {
      // Session expired — re-login once and retry
      this._cookie = null;
      await this._login();
      headers['Cookie'] = this._cookie;
      return fetch(url, { ...init, headers });
    }
    return res;
  }

  async _get(urlPath) {
    const res = await this._fetch(urlPath);
    if (!res.ok) throw new Error(`GET ${urlPath} → ${res.status}`);
    return res.json();
  }

  async _post(urlPath, body) {
    const res = await this._fetch(urlPath, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`POST ${urlPath} → ${res.status}: ${text}`);
    }
    return res.json();
  }

  // ── High-level methods ────────────────────────────────────────────────────────

  /**
   * Process a single image on the remote server by uploading its bytes.
   * Always uses upload_bytes — no shared filesystem assumption.
   */
  async processFilepath(filepath, opts = {}) {
    const buf = fs.readFileSync(filepath);
    return this.processBytes(buf, path.basename(filepath), opts);
  }

  /**
   * Send raw image bytes to remote v2 (POST /api/process/bytes).
   * Requires the v2 server to have the /process/bytes endpoint.
   */
  async processBytes(buf, filename, opts = {}) {
    const form = new FormData();
    form.append('file', new Blob([buf]), filename);
    for (const [k, v] of Object.entries(opts)) {
      if (v !== undefined && v !== null) form.append(k, String(v));
    }
    const res = await this._fetch('/api/process/bytes', { method: 'POST', body: form });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`processBytes → ${res.status}: ${text}`);
    }
    return res.json();
  }

  /**
   * POST pre-computed face data (512D embeddings + thumbnail) to the remote server.
   * Remote server skips detection — runs only FAISS person-matching and stores to DB.
   * data format matches local_processor.py / FaceEngine.extractFaceData() output.
   */
  async importProcessed(data) {
    return this._post('/api/ingest/import-processed', data);
  }

  /**
   * Trigger re-detection on the remote server for an existing image_id.
   * Remote server looks up the image by ID in its DB.
   */
  async reDetect(imageId, params = {}) {
    return this._post(`/api/images/${imageId}/re-detect`, params);
  }

  /**
   * Batch-process a list of filepaths via SSE stream from the remote server.
   * onEvent(event) called for each SSE event object { type, data }.
   * Returns a Promise that resolves when the stream ends.
   */
  async batchProcessSSE(paths, opts = {}, onEvent) {
    await this.ensureAuth();
    const headers = {
      'Content-Type': 'application/json',
      'Accept':       'text/event-stream',
    };
    if (this._cookie) headers['Cookie'] = this._cookie;

    const res = await fetch(`${this.baseUrl}/api/process/batch-files`, {
      method:  'POST',
      headers,
      body:    JSON.stringify({ paths, ...opts }),
    });

    if (res.status === 401) {
      this._cookie = null;
      await this._login();
      return this.batchProcessSSE(paths, opts, onEvent);
    }
    if (!res.ok) throw new Error(`batchProcessSSE → ${res.status}`);

    // Read SSE stream line by line
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete last line
      let eventType = 'message', dataLines = [];
      for (const line of lines) {
        if (line.startsWith('event:')) eventType = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        else if (line === '') {
          if (dataLines.length) {
            const raw = dataLines.join('\n');
            let data = raw;
            try { data = JSON.parse(raw); } catch {}
            if (onEvent) onEvent({ type: eventType, data });
            eventType = 'message'; dataLines = [];
          }
        }
      }
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _client = null;
let _clientKey = '';

/**
 * Return (or create) a RemoteV2Client based on the current flat settings.
 * Pass the flat settings object directly to avoid circular deps with settings.js.
 */
function getRemoteClient(flatSettings) {
  const url  = (flatSettings.remote_v2_url  || '').trim();
  const user = (flatSettings.remote_v2_user || '').trim();
  const pass = (flatSettings.remote_v2_pass || '').trim();
  const key  = `${url}|${user}`;
  if (!url) throw new Error('remote_v2_url is not configured');
  if (key !== _clientKey) {
    _client    = new RemoteV2Client(url, user, pass);
    _clientKey = key;
  }
  return _client;
}

module.exports = { RemoteV2Client, getRemoteClient };
