/**
 * VlmClientWeb.js — Direct Cloud VLM access from the browser/mobile app.
 * 
 * This allows Standalone (Local) mode to generate image descriptions and tags
 * by calling provider APIs directly using locally-stored API keys.
 */

export class VlmClientWeb {
  constructor() {
    this.keys = {}; // provider -> key
  }

  setKeys(keys) {
    this.keys = keys;
  }

  /**
   * Enrich an image using a Cloud VLM.
   * @param {Blob|string} image - image blob or base64 data
   * @param {string} provider - 'anthropic' | 'openai' | 'google' | 'groq'
   * @param {string} model - specific model ID
   * @param {string} prompt - the analysis prompt
   */
  async enrichImage(image, provider, model, prompt) {
    const key = this.keys[provider];
    if (!key) throw new Error(`API key for ${provider} not found in local storage.`);

    const base64 = typeof image === 'string' ? image.replace(/^data:[^;]+;base64,/, '') : await this._toBase64(image);

    switch (provider) {
      case 'anthropic':
        return this._callAnthropic(key, model || 'claude-3-5-sonnet-20240620', base64, prompt);
      case 'openai':
        return this._callOpenAI(key, model || 'gpt-4o-mini', base64, prompt);
      case 'google':
        return this._callGemini(key, model || 'gemini-1.5-flash', base64, prompt);
      default:
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

  async _callOpenAI(key, model, base64, prompt) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
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
    if (data.error) throw new Error(data.error.message);
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
