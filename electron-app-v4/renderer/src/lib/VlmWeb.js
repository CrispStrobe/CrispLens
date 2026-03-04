/**
 * VlmWeb.js — Direct Cloud VLM access from the browser/mobile app.
 * 
 * This is a faithful port of vlm_providers.py, allowing Standalone (Local) mode
 * to generate image descriptions and tags by calling provider APIs directly.
 */

const OPENAI_COMPATIBLE = {
  'openai':     'https://api.openai.com/v1',
  'nebius':     'https://api.tokenfactory.nebius.com/v1',
  'scaleway':   'https://api.scaleway.ai/v1',
  'openrouter': 'https://openrouter.ai/api/v1',
  'mistral':    'https://api.mistral.ai/v1',
  'groq':       'https://api.groq.com/openai/v1',
  'poe':        'https://api.poe.com/v1',
};

const DEFAULT_MODELS = {
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

export class VlmClientWeb {
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
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
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
      
      const res = await fetch(url, { headers });
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
   * Enrich an image using a Cloud VLM.
   */
  async enrichImage(image, provider, model, prompt) {
    const key = this.keys[provider];
    if (!key) throw new Error(`API key for ${provider} not found in local storage.`);

    const base64 = typeof image === 'string' ? image.replace(/^data:[^;]+;base64,/, '') : await this._toBase64(image);
    const modelId = model || DEFAULT_MODELS[provider];

    if (provider === 'anthropic') {
      return this._callAnthropic(key, modelId, base64, prompt);
    } else if (provider === 'google') {
      return this._callGemini(key, modelId, base64, prompt);
    } else if (OPENAI_COMPATIBLE[provider]) {
      return this._callOpenAICompatible(provider, key, modelId, base64, prompt);
    } else {
      throw new Error(`Provider ${provider} not yet supported in Standalone web mode.`);
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
    const res = await fetch('https://api.anthropic.com/v1/messages', {
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
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return this._parseJson(data.content[0].text);
  }

  async _callOpenAICompatible(provider, key, model, base64, prompt) {
    const baseUrl = OPENAI_COMPATIBLE[provider];
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: `${prompt}\nRespond in valid JSON: { "description": "...", "scene_type": "...", "tags": ["tag1", "tag2"] }` },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } }
          ]
        }],
        response_format: { type: "json_object" }
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    return JSON.parse(data.choices[0].message.content);
  }

  async _callGemini(key, model, base64, prompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    const res = await fetch(url, {
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
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return JSON.parse(data.candidates[0].content.parts[0].text);
  }

  _parseJson(text) {
    try {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
      return { description: text, scene_type: 'unknown', tags: [] };
    } catch {
      return { description: text, scene_type: 'unknown', tags: [] };
    }
  }
}

export const vlmClientWeb = new VlmClientWeb();
export default vlmClientWeb;
