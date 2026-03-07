/* VLM_MODULE_VERSION: v4.0.260307.1200 */
/**
 * VlmWeb.js — Direct Cloud VLM access from the browser/mobile app.
 * 
 * This is a faithful port of vlm_providers.py, allowing Standalone (Local) mode
 * to generate image descriptions and tags by calling provider APIs directly.
 */

import { Capacitor, CapacitorHttp } from '@capacitor/core';

// Helper for native-safe fetch
async function crossFetch(url, options = {}) {
  if (Capacitor.isNativePlatform()) {
    console.log(`[crossFetch] Native platform detected, using CapacitorHttp for: ${url}`);
    
    // Map fetch options to CapacitorHttp options
    const capOptions = {
      url,
      method: options.method || 'GET',
      headers: options.headers || {},
      data: options.body ? (typeof options.body === 'string' ? JSON.parse(options.body) : options.body) : undefined,
    };
    
    try {
      const response = await CapacitorHttp.request(capOptions);
      
      // Mock a fetch-like response object
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        statusText: String(response.status),
        json: async () => response.data,
        text: async () => typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
      };
    } catch (err) {
      console.error('[crossFetch] Native HTTP error:', err);
      throw err;
    }
  }
  
  return fetch(url, options);
}

const OPENAI_COMPATIBLE = {
  'openai':     'https://api.openai.com/v1',
  'nebius':     'https://api.tokenfactory.nebius.com/v1',
  'scaleway':   'https://api.scaleway.ai/v1',
  'openrouter': 'https://openrouter.ai/api/v1',
  'mistral':    'https://api.mistral.ai/v1',
  'groq':       'https://api.groq.com/openai/v1',
  'poe':        'https://api.poe.com/v1',
};

export const DEFAULT_MODELS = {
  'anthropic':  'claude-3-5-sonnet-20241022',
  'openai':     'gpt-4o',
  'nebius':     'Qwen/Qwen2-VL-72B-Instruct',
  'scaleway':   'pixtral-12b-2409',
  'openrouter': 'anthropic/claude-3.5-sonnet',
  'mistral':    'ministral-14b-2512',
  'groq':       'meta-llama/llama-4-scout-17b-16e-instruct',
  'poe':        'claude-3-5-sonnet',
  'google':     'gemini-1.5-flash'
};

console.log("%c[VlmWeb] Module Loaded | Version: v4.0.260307.1200", "color: #4090d0; font-weight: bold");
export class VlmClientWeb {
  async _resizeImage(image, maxDimension) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width <= maxDimension && height <= maxDimension) {
          resolve(null); // No resize needed
          return;
        }

        if (width > height) {
          height = Math.round((height * maxDimension) / width);
          width = maxDimension;
        } else {
          width = Math.round((width * maxDimension) / height);
          height = maxDimension;
        }

        console.log(`[VlmWeb] Resizing browser image from ${img.width}x${img.height} to ${width}x${height}`);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.85).split(',')[1]);
      };
      img.onerror = reject;
      
      if (typeof image === 'string') {
        img.src = image.startsWith('data:') ? image : `data:image/jpeg;base64,${image}`;
      } else if (image instanceof Blob) {
        const reader = new FileReader();
        reader.onload = (e) => { img.src = e.target.result; };
        reader.onerror = reject;
        reader.readAsDataURL(image);
      } else {
        reject(new Error('Unsupported image format for resize'));
      }
    });
  }

  constructor() {
    this.keys = {}; // provider -> key
  }

  setKeys(keys) {
    this.keys = keys;
  }

  /**
   * Fetch available models from a provider.
   */
  async fetchModels(provider) {
    const key = this.keys[provider];
    if (!key && provider !== 'openrouter') {
      console.warn(`[VlmWeb] No API key for ${provider}, cannot fetch live models.`);
      return [];
    }

    try {
      if (provider === 'google') {
        const res = await crossFetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
        const data = await res.json();
        return (data.models || [])
          .filter(m => m.supportedGenerationMethods.includes('generateContent') && m.name.includes('vision'))
          .map(m => m.name.replace('models/', ''));
      }

      let url, headers = { 'Content-Type': 'application/json' };
      if (provider === 'openai') url = 'https://api.openai.com/v1/models';
      else if (provider === 'openrouter') url = 'https://openrouter.ai/api/v1/models';
      else if (OPENAI_COMPATIBLE[provider]) url = `${OPENAI_COMPATIBLE[provider]}/models`;
      else return [];

      if (key) headers['Authorization'] = `Bearer ${key}`;
      
      const res = await crossFetch(url, { headers });
      const data = await res.json();
      const allModels = data.data || data.models || [];
      
      // Simple heuristic for vision models
      const keywords = ['vision', 'vl', 'gpt-4o', 'pixtral', 'claude-3'];
      return allModels
        .map(m => m.id || m.name)
        .filter(id => keywords.some(k => id.toLowerCase().includes(k)));
    } catch (err) {
      console.error(`[VlmWeb] Failed to fetch models for ${provider}:`, err);
      return [];
    }
  }

  /**
   * Actual validation of an API key by making a minimal request.
   */
  async testKey(provider, key) {
    if (!key) throw new Error('No key provided');
    
    try {
      if (provider === 'google') {
        const res = await crossFetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error.message || 'Invalid Key');
        return { ok: true, message: 'Google API key is valid' };
      }

      if (provider === 'anthropic') {
        // Minimal messages call with 1 token limit
        const res = await crossFetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
            'dangerously-allow-browser': 'true'
          },
          body: JSON.stringify({
            model: 'claude-3-haiku-20240307',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'Hi' }]
          })
        });
        const data = await res.json();
        if (data.error) {
          if (data.error.type === 'authentication_error') throw new Error('Invalid API Key');
          // Other errors (rate limit, etc) usually mean the key is at least valid
          return { ok: true, message: `Key accepted, but provider returned: ${data.error.message}` };
        }
        return { ok: true, message: 'Anthropic API key is valid' };
      }

      const baseUrl = OPENAI_COMPATIBLE[provider];
      if (baseUrl) {
        // Test by fetching models list — usually requires valid auth
        const res = await crossFetch(`${baseUrl}/models`, {
          headers: { 'Authorization': `Bearer ${key}` }
        });
        const data = await res.json();
        if (res.status === 401 || data.error) {
          throw new Error(data.error?.message || 'Authentication failed');
        }
        return { ok: true, message: `${provider} API key is valid` };
      }

      return { ok: true, message: `Key stored for ${provider} (actual validation not implemented for this provider)` };
    } catch (err) {
      console.error(`[VlmWeb] Validation failed for ${provider}:`, err);
      throw err;
    }
  }

  /**
   * Enrich an image using a Cloud VLM.
   */
  async enrichImage(image, provider, model, prompt, maxDimension = 0) {
    console.error(`[VlmWeb] enrichImage START | provider=${provider} | model=${model || 'default'}`);
    const key = this.keys[provider];
    if (!key) {
      console.error(`[VlmWeb] Missing API key for provider: ${provider}. Available keys for: ${Object.keys(this.keys).join(', ')}`);
      throw new Error(`API key for ${provider} not found. Please add it in Settings.`);
    }

    let base64;
    
    // Handle defaults for Mistral/Groq if not explicitly set
    if (!maxDimension || maxDimension === 0) {
      if (provider === 'mistral') maxDimension = 900;
      if (provider === 'groq') maxDimension = 1024;
    }

    try {
      if (maxDimension > 0) {
        console.log(`[VlmWeb] Checking if resize needed (max ${maxDimension}px)...`);
        const resized = await this._resizeImage(image, maxDimension);
        if (resized) {
          base64 = resized;
          console.log(`[VlmWeb] Image resized successfully. New length: ${base64.length}`);
        }
      }
      
      if (!base64) {
        base64 = typeof image === 'string' ? image.replace(/^data:[^;]+;base64,/, '') : await this._toBase64(image);
        console.log(`[VlmWeb] Using original image. Length: ${base64.length} chars (~${Math.round(base64.length * 0.75 / 1024)} KB)`);
      }
    } catch (err) {
      console.error('[VlmWeb] Image preparation failed:', err);
      // Fallback to basic conversion if resize failed
      try {
        base64 = typeof image === 'string' ? image.replace(/^data:[^;]+;base64,/, '') : await this._toBase64(image);
      } catch (inner) {
        throw new Error(`Image conversion failed: ${err.message}`);
      }
    }

    const modelId = model || DEFAULT_MODELS[provider];
    console.log(`[VlmWeb] Using modelId: ${modelId}`);

    try {
      let result;
      if (provider === 'anthropic') {
        result = await this._callAnthropic(key, modelId, base64, prompt);
      } else if (provider === 'google') {
        result = await this._callGemini(key, modelId, base64, prompt);
      } else if (OPENAI_COMPATIBLE[provider]) {
        result = await this._callOpenAICompatible(provider, key, modelId, base64, prompt);
      } else {
        throw new Error(`Provider "${provider}" is not yet supported in Standalone web mode.`);
      }
      console.log('[VlmWeb] enrichImage SUCCESS');
      return result;
    } catch (err) {
      console.error(`[VlmWeb] enrichImage CRITICAL ERROR (${provider}):`, err);
      // Re-throw with more context
      throw new Error(`VLM Provider Error (${provider}): ${err.message}`);
    }
  }

  async _toBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async _callAnthropic(key, model, base64, prompt) {
    console.log(`[VlmWeb] Calling Anthropic API | model=${model} | prompt="${prompt.slice(0, 30)}..."`);
    const res = await crossFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'dangerously-allow-browser': 'true'
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
            { type: 'text', text: `${prompt}\nRespond in valid JSON: { "description": "...", "scene_type": "...", "tags": ["tag1", "tag2"] }` }
          ]
        }]
      })
    });
    console.log(`[VlmWeb] Anthropic response received | status=${res.status} ${res.statusText}`);
    const data = await res.json();
    if (data.error) {
      console.error('[VlmWeb] Anthropic API returned ERROR:', data.error);
      throw new Error(data.error.message || 'Unknown Anthropic error');
    }
    if (!data.content || data.content.length === 0) {
      console.error('[VlmWeb] Anthropic returned EMPTY content:', data);
      throw new Error('Anthropic returned empty content');
    }
    const result = this._parseJson(data.content[0].text);
    return result;
  }

  async _callOpenAICompatible(provider, key, model, base64, prompt) {
    const baseUrl = OPENAI_COMPATIBLE[provider];
    console.error(`[VlmWeb] Calling OpenAI-compatible API | provider=${provider} | baseUrl=${baseUrl} | model=${model}`);
    
    const body = {
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `${prompt}\nIMPORTANT: Respond with a valid JSON object ONLY. No markdown, no extra text. Format: {"description": "...", "scene_type": "...", "tags": ["tag1", "tag2"]}` },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } }
        ]
      }]
    };

    if (provider === 'openai') {
      body.response_format = { type: "json_object" };
    }

    const res = await crossFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    
    console.error(`[VlmWeb] ${provider} response received | status=${res.status} ${res.statusText}`);
    const data = await res.json();
    if (data.error) {
      console.error(`[VlmWeb] ${provider} API returned ERROR:`, data.error);
      throw new Error(data.error.message || JSON.stringify(data.error));
    }
    
    if (!data.choices || data.choices.length === 0) {
      console.error(`[VlmWeb] ${provider} returned NO choices:`, data);
      throw new Error(`${provider} returned no choices`);
    }

    const msg = data.choices[0].message;
    const content = msg?.content ?? msg?.text ?? null;
    console.error(`[VlmWeb] ${provider} raw content:`, content);
    if (content === null || content === undefined) {
      throw new Error(`${provider} returned null content (model may not support vision or hit a content filter)`);
    }
    const result = this._parseJson(content);
    return result;
  }

  async _callGemini(key, model, base64, prompt) {
    console.log(`[VlmWeb] Calling Gemini API | model=${model}`);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    const res = await crossFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: `${prompt}\nRespond in valid JSON: { "description": "...", "scene_type": "...", "tags": ["tag1", "tag2"] }` },
            { inline_data: { mime_type: 'image/jpeg', data: base64 } }
          ]
        }],
        generationConfig: { response_mime_type: "application/json" }
      })
    });
    console.log(`[VlmWeb] Gemini response received | status=${res.status} ${res.statusText}`);
    const data = await res.json();
    if (data.error) {
      console.error('[VlmWeb] Gemini API returned ERROR:', data.error);
      throw new Error(data.error.message || 'Unknown Gemini error');
    }
    if (!data.candidates || data.candidates.length === 0) {
      console.error('[VlmWeb] Gemini returned NO candidates:', data);
      throw new Error('Gemini returned no candidates');
    }
    const result = JSON.parse(data.candidates[0].content.parts[0].text);
    return result;
  }

  _parseJson(text) {
    if (text == null) return { description: '', scene_type: 'unknown', tags: [] };
    const textStr = String(text);
    try {
      console.log('[VlmWeb] Attempting to parse JSON from:', textStr.slice(0, 100) + '...');
      
      let clean = textStr.trim();
      
      // Basic validation: must contain at least one { and one }
      if (clean.includes('{') && clean.includes('}')) {
        // Clean up common VLM artifacts like ```json ... ```
        if (clean.includes('```')) {
          const match = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
          if (match) clean = match[1];
        }
        
        const match = clean.match(/\{[\s\S]*\}/);
        if (match) clean = match[0];

        try {
          const parsed = JSON.parse(clean);
          return {
            description: parsed.description || parsed.caption || parsed.text || '',
            scene_type:  parsed.scene_type || parsed.category || 'unknown',
            tags:        Array.isArray(parsed.tags) ? parsed.tags : []
          };
        } catch (inner) {
          console.warn('[VlmWeb] inner JSON.parse failed:', inner.message);
        }
      }
      
      // Fallback: return raw text as description if it doesn't look like JSON or parse failed
      return { 
        description: textStr.slice(0, 1000), 
        scene_type: 'unknown', 
        tags: [] 
      };
    } catch (e) {
      console.warn('[VlmWeb] _parseJson critical failure:', e.message);
      return { description: textStr.slice(0, 1000), scene_type: 'unknown', tags: [] };
    }
  }
}

export const vlmClientWeb = new VlmClientWeb();
export default vlmClientWeb;
