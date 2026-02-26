# vlm_providers.py - Robust multi-VLM support with retries and fallbacks
import base64
from typing import Dict, List, Optional, Any, Tuple
import requests
import json
import logging
import time
from pathlib import Path
from dataclasses import dataclass

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Check available libraries
try:
    import anthropic
    ANTHROPIC_AVAILABLE = True
except ImportError:
    ANTHROPIC_AVAILABLE = False
    logger.info("anthropic library not available")

try:
    import openai
    OPENAI_AVAILABLE = True
except ImportError:
    OPENAI_AVAILABLE = False
    logger.info("openai library not available")

@dataclass
class VLMConfig:
    """Configuration for VLM provider."""
    max_retries: int = 3
    timeout_seconds: int = 30
    max_image_size_mb: float = 5.0
    supported_formats: set = None
    
    def __post_init__(self):
        if self.supported_formats is None:
            self.supported_formats = {'.jpg', '.jpeg', '.png', '.webp', '.gif'}


class VLMProvider:
    """Base class for VLM providers with robust error handling."""
    
    def __init__(self, config: VLMConfig = None):
        self.config = config or VLMConfig()
    
    def _validate_image(self, image_path: str) -> tuple[bool, str]:
        """Validate image file before processing."""
        try:
            path = Path(image_path)
            
            # Check existence
            if not path.exists():
                return False, f"Image file not found: {image_path}"
            
            # Check file size
            size_mb = path.stat().st_size / (1024 * 1024)
            if size_mb > self.config.max_image_size_mb:
                return False, f"Image too large: {size_mb:.2f}MB (max: {self.config.max_image_size_mb}MB)"
            
            # Check format
            ext = path.suffix.lower()
            if ext not in self.config.supported_formats:
                return False, f"Unsupported format: {ext}. Supported: {self.config.supported_formats}"
            
            # Check if file is readable
            with open(image_path, 'rb') as f:
                # Read first few bytes to verify it's a valid image
                header = f.read(16)
                if not header:
                    return False, "Image file is empty"
            
            return True, "OK"
            
        except Exception as e:
            return False, f"Image validation error: {str(e)}"
    
    def _read_image_base64(self, image_path: str) -> Optional[str]:
        """Read image and convert to base64."""
        try:
            with open(image_path, 'rb') as f:
                image_data = base64.b64encode(f.read()).decode('utf-8')
            return image_data
        except Exception as e:
            logger.error(f"Failed to read image {image_path}: {e}")
            return None
    
    def _extract_json(self, text: str) -> Optional[Dict]:
        """Extract JSON from text with multiple strategies."""
        import re
        
        # Strategy 1: Find JSON code block
        json_block = re.search(r'```(?:json)?\s*(\{[\s\S]*?\})\s*```', text)
        if json_block:
            try:
                return json.loads(json_block.group(1))
            except json.JSONDecodeError:
                pass
        
        # Strategy 2: Find first complete JSON object
        json_match = re.search(r'\{[\s\S]*\}', text)
        if json_match:
            try:
                return json.loads(json_match.group())
            except json.JSONDecodeError:
                pass
        
        # Strategy 3: Try parsing the entire text
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass
        
        logger.warning("Could not extract valid JSON from VLM response")
        return None
    
    def _get_media_type(self, image_path: str) -> str:
        """Get MIME type for image."""
        ext = Path(image_path).suffix.lower()
        media_types = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.webp': 'image/webp',
            '.gif': 'image/gif'
        }
        return media_types.get(ext, 'image/jpeg')
    
    def enrich_image(self, image_path: str, prompt: str) -> Dict[str, Any]:
        """
        Enrich image with AI analysis.
        
        Returns:
            Dict with keys: description, scene_type, tags, error (if failed)
        """
        raise NotImplementedError


class AnthropicVLM(VLMProvider):
    """Anthropic Claude Vision with robust error handling."""
    
    DEFAULT_MODEL = "claude-3-5-sonnet-20241022"
    FALLBACK_MODEL = "claude-3-haiku-20240307"
    
    def __init__(self, api_key: str, model: str = None, config: VLMConfig = None):
        super().__init__(config)
        
        if not ANTHROPIC_AVAILABLE:
            raise ImportError("anthropic library not installed. Install: pip install anthropic")
        
        if not api_key:
            raise ValueError("API key required for Anthropic")
        
        try:
            self.client = anthropic.Anthropic(api_key=api_key)
            self.model = model or self.DEFAULT_MODEL
            logger.info(f"Initialized Anthropic VLM with model: {self.model}")
        except Exception as e:
            raise ValueError(f"Failed to initialize Anthropic client: {e}")
    
    def enrich_image(self, image_path: str, prompt: str) -> Dict[str, Any]:
        """Enrich image using Claude Vision."""
        # Validate image
        valid, msg = self._validate_image(image_path)
        if not valid:
            return {"error": msg}
        
        # Read image
        image_data = self._read_image_base64(image_path)
        if not image_data:
            return {"error": "Failed to read image file"}
        
        media_type = self._get_media_type(image_path)
        
        # Retry logic
        for attempt in range(self.config.max_retries):
            try:
                logger.info(f"Calling Anthropic API (attempt {attempt + 1}/{self.config.max_retries})")
                
                message = self.client.messages.create(
                    model=self.model,
                    max_tokens=1024,
                    timeout=self.config.timeout_seconds,
                    messages=[{
                        "role": "user",
                        "content": [
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": media_type,
                                    "data": image_data
                                }
                            },
                            {"type": "text", "text": prompt}
                        ]
                    }]
                )
                
                # Extract response
                response_text = message.content[0].text
                
                # Parse JSON
                result = self._extract_json(response_text)
                if result:
                    logger.info("Successfully enriched image with Anthropic")
                    return result
                else:
                    # Return raw text if JSON extraction failed
                    return {
                        "description": response_text[:500],
                        "scene_type": "unknown",
                        "tags": [],
                        "raw_response": response_text
                    }
                
            except anthropic.RateLimitError as e:
                logger.warning(f"Rate limit hit: {e}")
                if attempt < self.config.max_retries - 1:
                    time.sleep(2 ** attempt)  # Exponential backoff
                    continue
                return {"error": "Rate limit exceeded"}
            
            except anthropic.APIError as e:
                logger.error(f"Anthropic API error: {e}")
                if attempt < self.config.max_retries - 1:
                    time.sleep(1)
                    continue
                return {"error": f"API error: {str(e)}"}
            
            except Exception as e:
                logger.error(f"Unexpected error calling Anthropic: {e}")
                if attempt < self.config.max_retries - 1:
                    time.sleep(1)
                    continue
                return {"error": f"Unexpected error: {str(e)}"}
        
        return {"error": "Failed after all retries"}


class OpenAIVLM(VLMProvider):
    """OpenAI GPT-4 Vision with robust error handling."""
    
    DEFAULT_MODEL = "gpt-4o"  # Updated to latest model
    FALLBACK_MODELS = ["gpt-4o-mini", "gpt-4-turbo", "gpt-4-vision-preview"]
    
    def __init__(self, api_key: str, endpoint: str = None, 
                 model: str = None, config: VLMConfig = None):
        super().__init__(config)
        
        if not OPENAI_AVAILABLE:
            raise ImportError("openai library not installed. Install: pip install openai")
        
        if not api_key:
            raise ValueError("API key required for OpenAI")
        
        try:
            # Handle custom endpoints (Azure, Ollama, etc.)
            if endpoint and endpoint != "https://api.openai.com/v1":
                self.client = openai.OpenAI(
                    api_key=api_key,
                    base_url=endpoint
                )
            else:
                self.client = openai.OpenAI(api_key=api_key)
            
            self.model = model or self.DEFAULT_MODEL
            logger.info(f"Initialized OpenAI VLM with model: {self.model}")
        except Exception as e:
            raise ValueError(f"Failed to initialize OpenAI client: {e}")
    
    def enrich_image(self, image_path: str, prompt: str) -> Dict[str, Any]:
        """Enrich image using OpenAI Vision."""
        # Validate image
        valid, msg = self._validate_image(image_path)
        if not valid:
            return {"error": msg}
        
        # Read image
        image_data = self._read_image_base64(image_path)
        if not image_data:
            return {"error": "Failed to read image file"}
        
        # Retry logic with fallback models
        models_to_try = [self.model] + [m for m in self.FALLBACK_MODELS if m != self.model]
        
        for model in models_to_try:
            for attempt in range(self.config.max_retries):
                try:
                    logger.info(f"Calling OpenAI API with {model} (attempt {attempt + 1}/{self.config.max_retries})")
                    
                    response = self.client.chat.completions.create(
                        model=model,
                        messages=[
                            {
                                "role": "user",
                                "content": [
                                    {"type": "text", "text": prompt},
                                    {
                                        "type": "image_url",
                                        "image_url": {
                                            "url": f"data:image/jpeg;base64,{image_data}",
                                            "detail": "high"
                                        }
                                    }
                                ]
                            }
                        ],
                        max_tokens=1024,
                        timeout=self.config.timeout_seconds
                    )
                    
                    # Extract response
                    content = response.choices[0].message.content
                    
                    # Parse JSON
                    result = self._extract_json(content)
                    if result:
                        logger.info(f"Successfully enriched image with OpenAI ({model})")
                        return result
                    else:
                        return {
                            "description": content[:500],
                            "scene_type": "unknown",
                            "tags": [],
                            "raw_response": content
                        }
                    
                except openai.RateLimitError as e:
                    logger.warning(f"Rate limit hit: {e}")
                    if attempt < self.config.max_retries - 1:
                        time.sleep(2 ** attempt)
                        continue
                    break  # Try next model
                
                except openai.APIError as e:
                    logger.error(f"OpenAI API error with {model}: {e}")
                    if "does not support" in str(e).lower():
                        break  # Try next model
                    if attempt < self.config.max_retries - 1:
                        time.sleep(1)
                        continue
                    break
                
                except Exception as e:
                    logger.error(f"Unexpected error calling OpenAI: {e}")
                    if attempt < self.config.max_retries - 1:
                        time.sleep(1)
                        continue
                    break
        
        return {"error": "Failed with all models after all retries"}


class OllamaVLM(VLMProvider):
    """Local Ollama with vision models (llava, bakllava, etc)."""
    
    DEFAULT_MODEL = "llava"
    FALLBACK_MODELS = ["llava:13b", "bakllava", "llava:7b"]
    
    def __init__(self, endpoint: str = None, model: str = None, config: VLMConfig = None):
        super().__init__(config)
        
        self.endpoint = (endpoint or "http://localhost:11434").rstrip('/')
        self.model = model or self.DEFAULT_MODEL
        
        # Test connection
        try:
            response = requests.get(f"{self.endpoint}/api/tags", timeout=5)
            if response.status_code == 200:
                available_models = [m['name'] for m in response.json().get('models', [])]
                logger.info(f"Connected to Ollama. Available models: {available_models}")
                
                # Check if requested model is available
                if self.model not in available_models:
                    logger.warning(f"Model '{self.model}' not found. Available: {available_models}")
            else:
                logger.warning(f"Ollama connection test returned status {response.status_code}")
        except Exception as e:
            logger.warning(f"Could not connect to Ollama at {self.endpoint}: {e}")
    
    def enrich_image(self, image_path: str, prompt: str) -> Dict[str, Any]:
        """Enrich image using Ollama."""
        # Validate image
        valid, msg = self._validate_image(image_path)
        if not valid:
            return {"error": msg}
        
        # Read image
        image_data = self._read_image_base64(image_path)
        if not image_data:
            return {"error": "Failed to read image file"}
        
        # Try models
        models_to_try = [self.model] + [m for m in self.FALLBACK_MODELS if m != self.model]
        
        for model in models_to_try:
            for attempt in range(self.config.max_retries):
                try:
                    logger.info(f"Calling Ollama with {model} (attempt {attempt + 1}/{self.config.max_retries})")
                    
                    response = requests.post(
                        f"{self.endpoint}/api/generate",
                        json={
                            "model": model,
                            "prompt": prompt,
                            "images": [image_data],
                            "stream": False
                        },
                        timeout=self.config.timeout_seconds
                    )
                    
                    if response.status_code == 200:
                        data = response.json()
                        content = data.get('response', '')
                        
                        # Parse JSON
                        result = self._extract_json(content)
                        if result:
                            logger.info(f"Successfully enriched image with Ollama ({model})")
                            return result
                        else:
                            return {
                                "description": content[:500],
                                "scene_type": "unknown",
                                "tags": [],
                                "raw_response": content
                            }
                    
                    elif response.status_code == 404:
                        logger.warning(f"Model {model} not found in Ollama")
                        break  # Try next model
                    
                    else:
                        logger.error(f"Ollama error: {response.status_code} - {response.text}")
                        if attempt < self.config.max_retries - 1:
                            time.sleep(1)
                            continue
                        break
                    
                except requests.Timeout:
                    logger.warning(f"Ollama request timeout (attempt {attempt + 1})")
                    if attempt < self.config.max_retries - 1:
                        continue
                    break
                
                except requests.ConnectionError as e:
                    logger.error(f"Cannot connect to Ollama at {self.endpoint}: {e}")
                    return {"error": f"Ollama connection failed: {str(e)}"}
                
                except Exception as e:
                    logger.error(f"Unexpected error calling Ollama: {e}")
                    if attempt < self.config.max_retries - 1:
                        time.sleep(1)
                        continue
                    break
        
        return {"error": "Failed with all models after all retries"}


# ============================================================================
# OPENAI-COMPATIBLE BASE CLASS (Nebius, Scaleway, OpenRouter, Mistral, Groq, Poe)
# ============================================================================

class OpenAICompatibleVLM(VLMProvider):
    """
    Base class for all OpenAI-compatible providers.
    Subclasses just set BASE_URL and DEFAULT_MODEL.
    """

    BASE_URL: str = ""
    DEFAULT_MODEL: str = ""

    def __init__(self, api_key: str, model: str = None, config: VLMConfig = None):
        super().__init__(config)

        if not OPENAI_AVAILABLE:
            raise ImportError("openai library not installed. Install: pip install openai")

        if not api_key:
            raise ValueError(f"API key required for {self.__class__.__name__}")

        try:
            self.client = openai.OpenAI(api_key=api_key, base_url=self.BASE_URL)
            self.model = model or self.DEFAULT_MODEL
            logger.info(f"Initialized {self.__class__.__name__} with model: {self.model}")
        except Exception as e:
            raise ValueError(f"Failed to initialize {self.__class__.__name__}: {e}")

    def enrich_image(self, image_path: str, prompt: str) -> Dict[str, Any]:
        """Enrich image using the OpenAI-compatible vision API."""
        valid, msg = self._validate_image(image_path)
        if not valid:
            return {"error": msg}

        image_data = self._read_image_base64(image_path)
        if not image_data:
            return {"error": "Failed to read image file"}

        media_type = self._get_media_type(image_path)

        for attempt in range(self.config.max_retries):
            try:
                logger.info(
                    f"Calling {self.__class__.__name__} API with {self.model} "
                    f"(attempt {attempt + 1}/{self.config.max_retries})"
                )
                response = self.client.chat.completions.create(
                    model=self.model,
                    messages=[{
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:{media_type};base64,{image_data}"
                                }
                            }
                        ]
                    }],
                    max_tokens=1024,
                    timeout=self.config.timeout_seconds
                )

                content = response.choices[0].message.content
                result = self._extract_json(content)
                if result:
                    logger.info(f"Successfully enriched image with {self.__class__.__name__}")
                    return result
                return {
                    "description": content[:500],
                    "scene_type": "unknown",
                    "tags": [],
                    "raw_response": content
                }

            except openai.RateLimitError as e:
                logger.warning(f"Rate limit hit: {e}")
                if attempt < self.config.max_retries - 1:
                    time.sleep(2 ** attempt)
                    continue
                return {"error": "Rate limit exceeded"}

            except openai.APIError as e:
                logger.error(f"{self.__class__.__name__} API error: {e}")
                if attempt < self.config.max_retries - 1:
                    time.sleep(1)
                    continue
                return {"error": f"API error: {str(e)}"}

            except Exception as e:
                logger.error(f"Unexpected error calling {self.__class__.__name__}: {e}")
                if attempt < self.config.max_retries - 1:
                    time.sleep(1)
                    continue
                return {"error": f"Unexpected error: {str(e)}"}

        return {"error": "Failed after all retries"}


class NebiusVLM(OpenAICompatibleVLM):
    BASE_URL = "https://api.tokenfactory.nebius.com/v1"
    DEFAULT_MODEL = "Qwen/Qwen2-VL-72B-Instruct"


class ScalewayVLM(OpenAICompatibleVLM):
    BASE_URL = "https://api.scaleway.ai/v1"
    DEFAULT_MODEL = "pixtral-12b-2409"


class OpenRouterVLM(OpenAICompatibleVLM):
    BASE_URL = "https://openrouter.ai/api/v1"
    DEFAULT_MODEL = "anthropic/claude-3.5-sonnet"


class MistralVLM(OpenAICompatibleVLM):
    BASE_URL = "https://api.mistral.ai/v1"
    DEFAULT_MODEL = "ministral-14b-2512"


class GroqVLM(OpenAICompatibleVLM):
    BASE_URL = "https://api.groq.com/openai/v1"
    DEFAULT_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"


class PoeVLM(OpenAICompatibleVLM):
    BASE_URL = "https://api.poe.com/v1"
    DEFAULT_MODEL = "claude-3-5-sonnet"


# ============================================================================
# MODEL DISCOVERY
# ============================================================================

# ============================================================================
# Hardcoded model lists (providers with no /models endpoint or restricted access)
# ============================================================================

# Anthropic: no public /models endpoint
_ANTHROPIC_MODELS = [
    "claude-opus-4-5-20251101",
    "claude-sonnet-4-5-20251101",
    "claude-haiku-4-5-20251001",
    "claude-3-5-sonnet-20241022",
    "claude-3-haiku-20240307",
]

# Mistral: hardcoded list of vision-capable models (avoids live API dependency).
# Source: https://docs.mistral.ai/capabilities/vision/
_MISTRAL_VLM_MODELS = [
    "mistral-large-2512",    # Mistral Large 3
    "mistral-medium-2508",   # Mistral Medium 3.1
    "mistral-small-2506",    # Mistral Small 3.2
    "ministral-14b-2512",    # Ministral 3 14B
    "ministral-8b-2512",     # Ministral 3 8B
    "ministral-3b-2512",     # Ministral 3 3B
]

# Groq: /models endpoint requires elevated API permissions (403 for standard keys).
# List vision-capable models explicitly.
_GROQ_VLM_MODELS = [
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "meta-llama/llama-4-maverick-17b-128e-instruct",
    "llama-3.2-90b-vision-preview",
    "llama-3.2-11b-vision-preview",
]

# ============================================================================
# Per-provider vision model filters
# Applied to the raw model list fetched from each provider's /models endpoint.
# Returns True if a model ID looks like a vision/multimodal model.
# When NO models pass the filter we fall back to the full list (better than empty).
# ============================================================================

def _is_vision_model(provider: str, model_id: str) -> bool:
    """Return True if model_id is likely a vision-capable model for the given provider.

    NOTE: providers whose API returns modality metadata (openrouter, poe) are filtered
    directly in fetch_vlm_models() using that metadata — this function is not called
    for those providers.
    """
    mid = model_id.lower()

    if provider == 'openai':
        # GPT-4o family (all vision), GPT-4 Turbo, GPT-4 Vision legacy
        return any(k in mid for k in ('gpt-4o', 'gpt-4-turbo', 'gpt-4-vision', 'o1'))

    if provider == 'nebius':
        # Nebius uses HuggingFace-style IDs (e.g. google/gemma-3-27b-it).
        #   'vl'             → Qwen2.5-VL (qwen2.5-vl-72b), future *-vl-* models
        #   'internvl'       → InternVL family
        #   'llava'          → LLaVA family
        #   'pixtral'        → Pixtral
        #   'vision'         → explicit vision suffix
        #   'gemma-3'        → google/gemma-3-27b-it (and -fast variant) — Gemma 3 is multimodal
        #   'nemotron-nano-v2' → nvidia/Nemotron-Nano-V2-12b (V2 = Vision 2.0)
        return any(k in mid for k in ('vl', 'llava', 'pixtral', 'internvl', 'vision',
                                       'gemma-3', 'nemotron-nano-v2'))

    if provider == 'scaleway':
        # Scaleway uses plain model IDs (no org prefix, no capabilities metadata).
        #   'pixtral'        → pixtral-12b-2409
        #   'gemma-3'        → gemma-3-27b-it (Gemma 3 is multimodal)
        #   'mistral-small-3'→ mistral-small-3.2-24b-instruct-2506 (vision-capable)
        #   'holo2'          → holo2-30b-a3b (vision model)
        #   'vl'             → future *-vl-* models
        #   'llava'          → LLaVA family
        #   'vision'         → explicit vision suffix
        return any(k in mid for k in ('pixtral', 'llava', 'vl', 'vision',
                                       'gemma-3', 'mistral-small-3', 'holo2'))

    if provider == 'mistral':
        # Mistral exposes capabilities.vision — handled in fetch_vlm_models directly.
        # This branch is only reached as a fallback if the metadata was absent.
        return 'pixtral' in mid

    if provider == 'ollama':
        # Keyword rules — ordered by generality:
        #   'llava'          → llava, llava:7b, llava-phi3, bakllava (b-a-k-LLAVA)
        #   'vision'         → llama3.2-vision, granite3.2-vision, phi-3-vision, phi-4-vision, …
        #   'vl'             → qwen3-vl, qwen2.5-vl, qwen2.5vl, internvl, cogvlm, smolvlm, …
        #   'moondream'      → moondream, moondream2
        #   'pixtral'        → pixtral:12b
        #   'minicpm-v'      → minicpm-v (just '-v', not caught by 'vl')
        #   'gemma3'         → gemma3:4b/12b/27b (all Gemma 3 variants are multimodal in Ollama)
        #   'mistral-small3' → mistral-small3.1:24b, mistral-small3.2:24b
        # NOT matched: 'llama-3.2' (hyphen) which is text-only; vision variant uses 'vision' above.
        return any(k in mid for k in ('llava', 'vision', 'vl', 'moondream',
                                       'pixtral', 'minicpm-v', 'gemma3', 'mistral-small3'))

    # For providers not listed (should not happen), keep everything
    return True


def fetch_vlm_models(provider: str, api_key: Optional[str] = None,
                     timeout: int = 10) -> Tuple[List[str], Optional[str]]:
    """
    Fetch available VLM-capable models from a provider's API endpoint.

    Returns:
        (model_ids, error_message) — error_message is None on success
    """
    # --- Hardcoded lists (no live fetch needed) ---
    if provider == 'anthropic':
        return _ANTHROPIC_MODELS, None

    if provider == 'mistral':
        logger.info(f"Mistral: returning {len(_MISTRAL_VLM_MODELS)} hardcoded vision models")
        return _MISTRAL_VLM_MODELS, None

    if provider == 'groq':
        # Groq's /models endpoint returns 403 for standard API keys.
        # Return the known vision model list directly.
        logger.info(f"Groq: returning {len(_GROQ_VLM_MODELS)} hardcoded VLM models")
        return _GROQ_VLM_MODELS, None

    # --- Live fetch providers ---
    # (endpoint_url, needs_bearer_auth)
    _endpoints = {
        'openai':     ('https://api.openai.com/v1/models',               True),
        'nebius':     ('https://api.tokenfactory.nebius.com/v1/models',   True),
        'scaleway':   ('https://api.scaleway.ai/v1/models',               True),
        'openrouter': ('https://openrouter.ai/api/v1/models',             False),  # public
        'poe':        ('https://api.poe.com/v1/models',                   True),
        'ollama':     ('http://localhost:11434/api/tags',                  False),
        # mistral handled above via hardcoded list — not here
    }

    if provider not in _endpoints:
        return [], f"No models endpoint configured for: {provider}"

    url, needs_auth = _endpoints[provider]

    headers: Dict[str, str] = {}
    if needs_auth and api_key:
        headers['Authorization'] = f'Bearer {api_key}'

    try:
        response = requests.get(url, headers=headers, timeout=timeout)
        response.raise_for_status()
        data = response.json()

        if provider == 'ollama':
            # {"models": [{"name": "llava:latest", ...}]}
            all_ids = [m['name'] for m in data.get('models', [])]

        elif provider == 'openrouter':
            # OpenRouter provides architecture metadata — filter on image in modality string
            # e.g. "text+image+file->text"
            all_models = data.get('data', [])
            vision_ids = [
                m['id'] for m in all_models
                if 'image' in m.get('architecture', {}).get('modality', '')
            ]
            all_ids = vision_ids if vision_ids else [m['id'] for m in all_models]
            logger.info(f"OpenRouter: {len(data.get('data',[]))} total, "
                        f"{len(all_ids)} with image modality")

        elif provider == 'poe':
            # Poe provides input_modalities and output_modalities lists.
            # Keep models that accept image input AND produce text output — this
            # includes VLMs (Claude, GPT-4o, Gemini…) but excludes image/video
            # generators (Flux, Runway, Kling, Sora…) which output image/video only.
            all_models = data.get('data', [])
            vision_ids = [
                m['id'] for m in all_models
                if 'image' in m.get('architecture', {}).get('input_modalities', [])
                and 'text' in m.get('architecture', {}).get('output_modalities', [])
            ]
            all_ids = vision_ids if vision_ids else [m['id'] for m in all_models]
            logger.info(f"Poe: {len(all_models)} total, "
                        f"{len(all_ids)} accept image input and output text")

        else:
            # Standard OpenAI format: {"data": [{"id": "...", ...}]}
            # (openai, nebius, scaleway, poe-compat — these return bare model objects)
            all_ids = [m['id'] for m in data.get('data', [])]

        # Providers already filtered by native metadata above — skip keyword filter
        _metadata_filtered = {'openrouter', 'poe'}

        if provider in _metadata_filtered:
            pass  # already filtered
        elif provider == 'ollama':
            vision_ids = [mid for mid in all_ids if _is_vision_model(provider, mid)]
            if vision_ids:
                logger.info(f"Ollama: {len(all_ids)} installed models, "
                            f"{len(vision_ids)} look like vision model(s)")
                all_ids = vision_ids
            else:
                logger.info(f"Ollama: {len(all_ids)} installed models, "
                            f"none matched vision filter — showing all")
        else:
            # Keyword filter for providers with no modality metadata (openai, nebius, scaleway)
            vision_ids = [mid for mid in all_ids if _is_vision_model(provider, mid)]
            if vision_ids:
                logger.info(f"{provider}: {len(all_ids)} total models, "
                            f"filtered to {len(vision_ids)} vision model(s)")
                all_ids = vision_ids
            else:
                logger.info(f"{provider}: {len(all_ids)} total models "
                            f"(no vision filter match — showing all)")

        all_ids.sort()
        if not all_ids:
            return [], "No models returned by the API"

        logger.info(f"Fetched {len(all_ids)} models from {provider}")
        return all_ids, None

    except requests.Timeout:
        return [], f"Request timed out after {timeout}s"
    except requests.ConnectionError as e:
        return [], f"Connection error: {str(e)[:120]}"
    except requests.HTTPError as e:
        status = e.response.status_code
        if status == 401:
            return [], "Authentication failed — check your API key"
        if status == 403:
            return [], "Access denied — check API key permissions"
        return [], f"HTTP {status}: {e.response.text[:200]}"
    except Exception as e:
        return [], f"Unexpected error: {str(e)}"


def create_vlm_provider(provider: str, api_key: Optional[str] = None,
                       endpoint: Optional[str] = None,
                       model: Optional[str] = None,
                       config: VLMConfig = None) -> Optional[VLMProvider]:
    """
    Factory function to create VLM provider with validation.

    Args:
        provider: Provider identifier (see PROVIDER_CONFIGS keys)
        api_key:  API key (required for most providers)
        endpoint: Custom endpoint override (for openai / ollama)
        model:    Model name (optional, uses per-provider defaults)
        config:   VLM configuration (optional)

    Returns:
        VLMProvider instance or None if creation fails
    """
    provider = provider.lower().strip()

    _openai_compat = {
        'nebius':     NebiusVLM,
        'scaleway':   ScalewayVLM,
        'openrouter': OpenRouterVLM,
        'mistral':    MistralVLM,
        'groq':       GroqVLM,
        'poe':        PoeVLM,
    }

    try:
        if provider == 'anthropic':
            if not api_key:
                logger.error("API key required for Anthropic")
                return None
            return AnthropicVLM(api_key, model, config)

        elif provider == 'openai':
            if not api_key:
                logger.error("API key required for OpenAI")
                return None
            return OpenAIVLM(api_key, endpoint, model, config)

        elif provider == 'ollama':
            return OllamaVLM(endpoint, model, config)

        elif provider in _openai_compat:
            if not api_key:
                logger.error(f"API key required for {provider}")
                return None
            cls = _openai_compat[provider]
            return cls(api_key, model, config)

        else:
            logger.error(f"Unknown VLM provider: {provider}")
            return None

    except Exception as e:
        logger.error(f"Failed to create VLM provider '{provider}': {e}")
        return None


# Utility function for testing
def test_vlm_provider(provider: VLMProvider, image_path: str) -> Dict[str, Any]:
    """Test a VLM provider with a sample image."""
    test_prompt = """Analyze this image and provide:
1. A brief description (1-2 sentences)
2. Scene type (indoor/outdoor/portrait/group/landscape/etc)
3. 5-10 relevant tags

Format as JSON:
{
  "description": "...",
  "scene_type": "...",
  "tags": ["tag1", "tag2", ...]
}"""
    
    logger.info(f"Testing VLM provider with image: {image_path}")
    result = provider.enrich_image(image_path, test_prompt)
    
    if "error" in result:
        logger.error(f"Test failed: {result['error']}")
    else:
        logger.info(f"Test successful: {json.dumps(result, indent=2)}")
    
    return result