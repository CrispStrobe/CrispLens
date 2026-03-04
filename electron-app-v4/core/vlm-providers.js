'use strict';

/**
 * vlm-providers.js — Node.js implementation of Cloud VLM access.
 * 
 * Ported from VlmWeb.js. Provides server-side image enrichment.
 */

const fs = require('fs');

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

class VlmClient {
  constructor() {
    this.keys = {}; // provider -> key
  }

  setKeys(keys) {
    this.keys = keys;
  }

  /**
   * Enrich an image using a Cloud VLM.
   */
  async enrichImage(imagePath, provider, model, prompt) {
    console.log(`[VlmClient] enrichImage start. Provider: ${provider}, Model: ${model || 'default'}`);
    const key = this.keys[provider];
    if (!key) {
      throw new Error(`API key for ${provider} not found in database.`);
    }

    // Read image and convert to base64
    const buffer = fs.readFileSync(imagePath);
    const base64 = buffer.toString('base64');
    
    const modelId = model || DEFAULT_MODELS[provider];

    try {
      if (provider === 'anthropic') {
        return await this._callAnthropic(key, modelId, base64, prompt);
      } else if (provider === 'google') {
        return await this._callGemini(key, modelId, base64, prompt);
      } else if (OPENAI_COMPATIBLE[provider]) {
        return await this._callOpenAICompatible(provider, key, modelId, base64, prompt);
      } else {
        throw new Error(`Provider ${provider} not yet supported in Node.js backend.`);
      }
    } catch (err) {
      console.error(`[VlmClient] Error in enrichImage for ${provider}:`, err.message);
      throw err;
    }
  }

  async _callAnthropic(key, model, base64, prompt) {
    console.log('[VlmClient] Calling Anthropic API...');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
            { type: 'text', text: `${prompt}
Respond in valid JSON: { "description": "...", "scene_type": "...", "tags": ["tag1", "tag2"] }` }
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
    console.log(`[VlmClient] Calling OpenAI-compatible API (${provider}) at ${baseUrl}...`);
    
    const body = {
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `${prompt}
IMPORTANT: Respond with a valid JSON object ONLY. No markdown, no extra text. Format: {"description": "...", "scene_type": "...", "tags": ["tag1", "tag2"]}` },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } }
        ]
      }]
    };

    if (provider === 'openai') {
      body.response_format = { type: "json_object" };
    }

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    
    const content = data.choices[0].message.content;
    return this._parseJson(content);
  }

  async _callGemini(key, model, base64, prompt) {
    console.log('[VlmClient] Calling Gemini API...');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: `${prompt}
Respond in valid JSON: { "description": "...", "scene_type": "...", "tags": ["tag1", "tag2"] }` },
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
      let clean = text.trim();
      if (clean.includes('```')) {
        const match = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (match) clean = match[1];
      }
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) clean = match[0];

      const parsed = JSON.parse(clean);
      return {
        description: parsed.description || parsed.caption || parsed.text || '',
        scene_type:  parsed.scene_type || parsed.category || 'unknown',
        tags:        Array.isArray(parsed.tags) ? parsed.tags : []
      };
    } catch (e) {
      console.warn('[VlmClient] JSON parse failed, falling back to raw:', e.message);
      return { description: text, scene_type: 'unknown', tags: [] };
    }
  }
}

module.exports = { vlmClient: new VlmClient(), DEFAULT_MODELS };
