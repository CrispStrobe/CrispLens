import { Capacitor, CapacitorHttp } from '@capacitor/core';

/** Helper to convert base64 to Blob for Capacitor native HTTP responses */
export function base64ToBlob(base64, contentType = '', sliceSize = 512) {
  const byteCharacters = atob(base64);
  const byteArrays = [];
  for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
    const slice = byteCharacters.slice(offset, offset + sliceSize);
    const byteNumbers = new Array(slice.length);
    for (let i = 0; i < slice.length; i++) byteNumbers[i] = slice.charCodeAt(i);
    byteArrays.push(new Uint8Array(byteNumbers));
  }
  return new Blob(byteArrays, { type: contentType });
}

/**
 * Robust fetch that bypasses CORS in Electron (via main process proxy)
 * and on Mobile (via Capacitor native HTTP).
 * Also falls back to server-side proxy if running in a browser.
 */
export async function robustFetch(url, options = {}) {
  // 1. Electron Proxy (highest priority for Desktop)
  if (typeof window !== 'undefined' && window.electronAPI?.proxyFetch) {
    console.log(`[RobustFetch] Electron: using proxyFetch for ${url}`);
    try {
      const res = await window.electronAPI.proxyFetch(url, options);
      if (!res.ok && res.error) throw new Error(res.error);
      return {
        ok: res.ok, status: res.status, statusText: res.statusText,
        json: async () => res.data,
        text: async () => typeof res.data === 'string' ? res.data : JSON.stringify(res.data),
        arrayBuffer: async () => {
          if (res.data instanceof Uint8Array) return res.data.buffer;
          if (typeof res.data === 'string') return new TextEncoder().encode(res.data).buffer;
          return new ArrayBuffer(0);
        },
        blob: async () => {
          if (res.data instanceof Uint8Array) return new Blob([res.data]);
          if (typeof res.data === 'string') return new Blob([res.data]);
          return new Blob([]);
        },
        headers: { get: (n) => res.headers[n] || res.headers[n.toLowerCase()] }
      };
    } catch (e) {
      console.warn('[RobustFetch] Electron proxy failed, falling back to fetch:', e.message);
    }
  }

  // 2. Capacitor Native HTTP (for mobile)
  if (Capacitor.isNativePlatform()) {
    console.log(`[RobustFetch] Native platform: using CapacitorHttp for ${url}`);
    try {
      const capOpts = {
        url,
        method: options.method || 'GET',
        headers: {
          ...options.headers,
          ...(options.credentials === 'include' ? { 'X-Capacitor-HTTP-Cookies': 'true' } : {})
        },
        data: options.method !== 'GET' && options.body ? (typeof options.body === 'string' ? JSON.parse(options.body) : options.body) : undefined,
      };

      const res = await CapacitorHttp.request(capOpts);
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        statusText: String(res.status),
        json: async () => res.data,
        text: async () => typeof res.data === 'string' ? res.data : JSON.stringify(res.data),
        arrayBuffer: async () => {
          if (typeof res.data === 'string') {
            const bin = atob(res.data.replace(/^data:[^;]+;base64,/, ''));
            const u8 = new Uint8Array(bin.length);
            for (let i=0; i<bin.length; i++) u8[i] = bin.charCodeAt(i);
            return u8.buffer;
          }
          return new ArrayBuffer(0);
        },
        blob: async () => {
          if (typeof res.data === 'string') {
            const contentType = res.headers['Content-Type'] || res.headers['content-type'] || 'application/octet-stream';
            return base64ToBlob(res.data.replace(/^data:[^;]+;base64,/, ''), contentType);
          }
          return res.data;
        },
        headers: { get: (name) => res.headers[name] || res.headers[name.toLowerCase()] }
      };
    } catch (err) {
      console.error('[RobustFetch] CapacitorHttp error:', err);
      throw err;
    }
  }

  // 3. Server-side Proxy (for standard browser pointing to a running server)
  // Check if we are in a browser and NOT on the same domain as the target
  const isTargetCrossDomain = !url.startsWith('/') && !url.startsWith(window.location.origin);
  if (typeof window !== 'undefined' && isTargetCrossDomain) {
    const remoteUrl = localStorage.getItem('remote_url') || '';
    const base = remoteUrl ? remoteUrl.replace(/\/$/, '') : window.location.origin;
    const proxyUrl = `${base}/api/proxy-fetch`;
    
    console.log(`[RobustFetch] Browser: using server proxy ${proxyUrl} for ${url}`);
    try {
      const res = await fetch(proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, options })
      });
      
      if (res.ok || res.status < 500) { // If server responded, use it
        return res;
      }
    } catch (e) {
      console.warn('[RobustFetch] Server proxy failed, falling back to direct fetch:', e.message);
    }
  }

  // 4. Standard fetch (subject to CORS)
  return fetch(url, options);
}
