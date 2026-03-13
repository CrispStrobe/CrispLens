/**
 * BflWeb.js — Direct Black Forest Labs (BFL) access from the browser/mobile app.
 *
 * Allows Standalone (Local) mode to generate, outpaint, and inpaint images
 * by calling the BFL API directly, bypassing the Node.js server.
 */

import { robustFetch } from './RobustFetch.js';

const BFL_API_BASE = 'https://api.bfl.ai/v1';

const GENERATE_ENDPOINTS = {
  'flux-kontext-pro': '/flux-kontext-pro',
  'flux-pro-1.1':     '/flux-pro-1.1',
  'flux-pro':         '/flux-pro',
  'flux-dev':         '/flux-dev',
  'flux-2-klein-4b':  '/flux-2-klein-4b',
  'flux-2-klein-9b':  '/flux-2-klein-9b',
  'flux-2-pro':       '/flux-2-pro',
  'flux-2-max':       '/flux-2-max',
  'flux-2-flex':      '/flux-2-flex',
};

const FILL_ENDPOINT    = '/flux-pro-1.0-fill';
const KONTEXT_ENDPOINT = '/flux-kontext-pro';

export class BflClientWeb {
  constructor() {
    this.apiKey = null;
  }

  setKey(key) {
    this.apiKey = key;
  }

  async _toBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async _imgToB64Jpeg(imageSource) {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      if (imageSource instanceof Blob) i.src = URL.createObjectURL(imageSource);
      else i.src = imageSource;
    });

    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const b64 = canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
    if (imageSource instanceof Blob) URL.revokeObjectURL(img.src);
    return b64;
  }

  async _buildMaskPng(width, height, bgFill, rectFill, rect) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    // bgFill: 0 = black, 255 = white
    ctx.fillStyle = `rgb(${bgFill},${bgFill},${bgFill})`;
    ctx.fillRect(0, 0, width, height);

    if (rect && rect.w > 0 && rect.h > 0) {
      ctx.fillStyle = `rgb(${rectFill},${rectFill},${rectFill})`;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    }

    return canvas.toDataURL('image/png').split(',')[1];
  }

  async _submit(endpoint, payload) {
    if (!this.apiKey) throw new Error('BFL API key not set');
    const url = BFL_API_BASE + endpoint;
    const res = await robustFetch(url, {
      method: 'POST',
      headers: { 'x-key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`BFL submit error ${res.status}: ${text}`);
    }
    return res.json();
  }

  async _poll(id) {
    const url = `${BFL_API_BASE}/get_result?id=${id}`;
    const start = Date.now();
    while (Date.now() - start < 180000) {
      const res = await robustFetch(url, { headers: { 'x-key': this.apiKey } });
      if (!res.ok) throw new Error(`BFL poll error ${res.status}`);
      const data = await res.json();
      if (data.status === 'Ready') return data.result.sample || data.result.image;
      if (data.status === 'Failed') throw new Error(`BFL task failed: ${JSON.stringify(data.result)}`);
      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error('BFL task timed out');
  }

  async generate(params) {
    const { model, prompt, aspect_ratio, width, height, seed, steps, guidance } = params;
    const endpoint = GENERATE_ENDPOINTS[model] || KONTEXT_ENDPOINT;
    const isFlux2 = model.startsWith('flux-2-');
    
    const payload = { prompt, output_format: 'jpeg' };
    if (seed != null) payload.seed = seed;
    if (isFlux2) {
      payload.width = width || 1024;
      payload.height = height || 1024;
      if (model === 'flux-2-flex') {
        if (steps != null) payload.steps = steps;
        if (guidance != null) payload.guidance = guidance;
      }
    } else {
      payload.aspect_ratio = aspect_ratio || '1:1';
    }

    const task = await this._submit(endpoint, payload);
    const imageUrl = await this._poll(task.id);
    return imageUrl;
  }

  async outpaint(params) {
    const { image_id, image_blob, prompt, add_top, add_bottom, add_left, add_right } = params;
    // Standalone mode must provide image_blob since it can't read from server by image_id
    if (!image_blob) throw new Error('image_blob required for standalone outpaint');

    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = URL.createObjectURL(image_blob);
    });

    const origW = img.width;
    const origH = img.height;
    const newW = Math.round((origW + (add_left|0) + (add_right|0)) / 16) * 16;
    const newH = Math.round((origH + (add_top|0) + (add_bottom|0)) / 16) * 16;

    const canvas = document.createElement('canvas');
    canvas.width = newW;
    canvas.height = newH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, newW, newH);
    ctx.drawImage(img, add_left|0, add_top|0);
    const imageB64 = canvas.toDataURL('image/jpeg', 0.95).split(',')[1];
    URL.revokeObjectURL(img.src);

    const maskB64 = await this._buildMaskPng(newW, newH, 255, 0, { x: add_left|0, y: add_top|0, w: origW, h: origH });

    const payload = {
      image: imageB64,
      mask: maskB64,
      prompt: prompt || 'Extend the image naturally...',
      output_format: 'jpeg'
    };

    const task = await this._submit(FILL_ENDPOINT, payload);
    return await this._poll(task.id);
  }

  async inpaint(params) {
    const { image_blob, prompt, mask_x, mask_y, mask_w, mask_h } = params;
    if (!image_blob) throw new Error('image_blob required for standalone inpaint');

    const imageB64 = await this._imgToB64Jpeg(image_blob);
    
    // Get natural dimensions
    const img = await new Promise((res) => {
      const i = new Image(); i.onload = () => res(i); i.src = URL.createObjectURL(image_blob);
    });
    const maskB64 = await this._buildMaskPng(img.width, img.height, 0, 255, { x: mask_x, y: mask_y, w: mask_w, h: mask_h });
    URL.revokeObjectURL(img.src);

    const payload = {
      image: imageB64,
      mask: maskB64,
      prompt,
      output_format: 'jpeg'
    };

    const task = await this._submit(FILL_ENDPOINT, payload);
    return await this._poll(task.id);
  }

  async edit(params) {
    const { image_blob, prompt, model } = params;
    if (!image_blob) throw new Error('image_blob required for standalone AI edit');

    const imageB64 = await this._imgToB64Jpeg(image_blob);
    const endpoint = GENERATE_ENDPOINTS[model] || KONTEXT_ENDPOINT;

    const payload = {
      image: imageB64,
      prompt,
      output_format: 'jpeg'
    };

    const task = await this._submit(endpoint, payload);
    return await this._poll(task.id);
  }
}

export const bflClientWeb = new BflClientWeb();
export default bflClientWeb;
