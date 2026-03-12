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

  // 3. Browser Standalone: try direct fetch first, then fallback to proxy
  const isTargetCrossDomain = typeof window !== 'undefined' && !url.startsWith('/') && !url.startsWith(window.location.origin);
  
  if (isTargetCrossDomain) {
    console.log(`[RobustFetch] Standalone: trying direct fetch for ${url}`);
    try {
      // We set a timeout for the direct fetch attempt to avoid hanging if CORS preflight stalls
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout for direct attempt
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);
      
      // If we got a response (even a 404/500), we return it. 
      // If it's a CORS failure, fetch() would have thrown a TypeError.
      console.log(`[RobustFetch] Direct fetch success (status ${res.status}) for ${url}`);
      return res;
    } catch (err) {
      if (err.name === 'AbortError') {
        console.warn(`[RobustFetch] Direct fetch timed out for ${url}, falling back to proxy`);
      } else {
        console.warn(`[RobustFetch] Direct fetch failed (CORS?) for ${url}, trying server proxy:`, err.message);
      }
      
      const remoteUrl = localStorage.getItem('remote_url') || '';
      const base = remoteUrl ? remoteUrl.replace(/\/$/, '') : window.location.origin;
      const proxyUrl = `${base}/api/proxy-fetch`;
      
      try {
        // Sanitize options for JSON serialization
        const safeOptions = {};
        if (options.method) safeOptions.method = options.method;
        if (options.headers) safeOptions.headers = options.headers;
        if (typeof options.body === 'string') safeOptions.body = options.body;

        const res = await fetch(proxyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, options: safeOptions }),
          credentials: 'include'
        });
        
        console.log(`[RobustFetch] Server proxy returned status ${res.status} for ${url}`);
        return res;
      } catch (proxyErr) {
        console.error('[RobustFetch] Server proxy critical failure:', proxyErr.message);
        throw err; // throw the original direct fetch error
      }
    }
  }

  // 4. Same-origin fetch
  return fetch(url, options);
}
