/**
 * VlmData.js — Shared VLM provider and model metadata.
 * 
 * Matches the definitions in electron-app-v4/server/routes/misc.js
 */

export const VLM_PROVIDERS = {
  anthropic:   { display_name: 'Anthropic (Claude)',    is_eu: false },
  openai:      { display_name: 'OpenAI (GPT-4 Vision)', is_eu: false },
  groq:        { display_name: 'Groq (fast inference)', is_eu: false },
  openrouter:  { display_name: 'OpenRouter',            is_eu: false },
  mistral:     { display_name: 'Mistral (EU)',          is_eu: true  },
  nebius:      { display_name: 'Nebius (EU)',           is_eu: true  },
  scaleway:    { display_name: 'Scaleway (EU)',         is_eu: true  },
  bfl:         { display_name: 'Black Forest Labs (EU)',is_eu: true  },
  ollama:      { display_name: 'Ollama (local)',        is_eu: true  },
  google:      { display_name: 'Google Gemini',         is_eu: false },
};

export const VLM_MODELS = {
  anthropic:  ['claude-3-5-sonnet-20241022', 'claude-3-haiku-20240307', 'claude-opus-4-6'],
  openai:     ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
  groq:       ['meta-llama/llama-4-scout-17b-16e-instruct', 'llama-3.2-11b-vision-preview'],
  openrouter: ['anthropic/claude-3.5-sonnet', 'google/gemini-2.0-flash-001', 'openai/gpt-4o'],
  mistral:    ['pixtral-large-latest', 'pixtral-12b-2409'],
  nebius:     ['Qwen/Qwen2-VL-72B-Instruct', 'Qwen/Qwen2.5-VL-72B-Instruct'],
  scaleway:   ['llama-3.2-11b-vision-instruct', 'pixtral-12b-2409-v2'],
  bfl:        ['flux-kontext-pro', 'flux-pro-1.1', 'flux-dev'],
  ollama:     ['llava', 'llava-llama3', 'llava:13b', 'moondream'],
  google:     ['gemini-1.5-flash', 'gemini-1.5-pro'],
};
