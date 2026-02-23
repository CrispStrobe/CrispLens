"""
routers/api_keys.py — VLM API key management (system vs user scope).

Role rules:
  admin / mediamanager  — may use all providers + set system keys
  user                  — EU providers only; may not set system keys
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api_key_manager import PROVIDER_CONFIGS
from routers.deps import get_current_user, get_allowed_providers

router = APIRouter()


def _state():
    from fastapi_app import state
    return state


class KeyRequest(BaseModel):
    provider: str
    api_key:  str
    scope:    str = 'system'  # 'system' | 'user'


@router.get("/providers")
def list_providers(user=Depends(get_current_user)):
    allowed = get_allowed_providers(user.role)
    return {
        k: {
            'display_name': v['display_name'],
            'requires_key': v['requires_key'],
            'default_model': v.get('default_model'),
        }
        for k, v in PROVIDER_CONFIGS.items()
        if k in allowed
    }


@router.get("/status")
def key_status(user=Depends(get_current_user)):
    s = _state()
    allowed = get_allowed_providers(user.role)
    result = {}
    for provider in PROVIDER_CONFIGS:
        if provider not in allowed:
            continue
        sys_key  = s.api_key_manager.get_effective_key(provider, None)
        user_key = s.api_key_manager.get_effective_key(provider, user.username)
        result[provider] = {
            'has_system_key': sys_key is not None,
            'has_user_key':   user_key is not None and user_key != sys_key,
        }
    return result


@router.get("/models/{provider}")
def get_models(provider: str, user=Depends(get_current_user)):
    from vlm_providers import fetch_vlm_models
    s = _state()
    allowed = get_allowed_providers(user.role)
    if provider not in allowed:
        raise HTTPException(status_code=403, detail="Provider not allowed for your role")
    api_key = s.api_key_manager.get_effective_key(provider, user.username)
    models, error = fetch_vlm_models(provider, api_key)
    if error:
        raise HTTPException(status_code=400, detail=error)
    return models


@router.post("")
def save_key(body: KeyRequest, user=Depends(get_current_user)):
    s = _state()
    allowed = get_allowed_providers(user.role)
    if body.provider not in allowed:
        raise HTTPException(status_code=403, detail="Provider not allowed for your role")

    if body.scope == 'system':
        if user.role not in ('admin', 'mediamanager'):
            raise HTTPException(status_code=403, detail="Only admins and media managers may set system keys")
        ok, msg = s.api_key_manager.set_system_key(body.provider, body.api_key)
    else:
        ok, msg = s.api_key_manager.set_user_key(body.provider, body.api_key, user.username)

    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    return {"ok": True, "message": msg}


@router.post("/test/{provider}")
def test_key(provider: str, user=Depends(get_current_user)):
    """
    Quick-test the stored API key for a provider by making a lightweight API call.
    Uses fetch_vlm_models() which hits the provider's /models endpoint.
    For providers with hardcoded model lists (Anthropic), hits their auth endpoint directly.
    """
    s = _state()
    allowed = get_allowed_providers(user.role)
    if provider not in allowed:
        raise HTTPException(status_code=403, detail="Provider not allowed for your role")

    api_key = s.api_key_manager.get_effective_key(provider, user.username)
    if not api_key:
        raise HTTPException(status_code=400, detail="No API key configured for this provider")

    # For providers with hardcoded model lists we do a direct auth-check ping
    if provider == 'anthropic':
        import requests as _req
        try:
            r = _req.get(
                'https://api.anthropic.com/v1/models',
                headers={'x-api-key': api_key, 'anthropic-version': '2023-06-01'},
                timeout=8,
            )
            if r.status_code == 200:
                count = len(r.json().get('data', []))
                return {"ok": True, "message": f"Key valid — {count} models available"}
            raise HTTPException(status_code=400, detail=f"Anthropic API error {r.status_code}: {r.text[:200]}")
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Connection error: {e}")

    from vlm_providers import fetch_vlm_models
    models, error = fetch_vlm_models(provider, api_key)
    if error:
        raise HTTPException(status_code=400, detail=error)
    return {"ok": True, "message": f"Key valid — {len(models)} models available"}


@router.delete("/{provider}")
def delete_key(provider: str, scope: str = 'system', user=Depends(get_current_user)):
    s = _state()
    if scope == 'system':
        if user.role not in ('admin', 'mediamanager'):
            raise HTTPException(status_code=403, detail="Only admins and media managers may delete system keys")
        ok, msg = s.api_key_manager.delete_system_key(provider)
    else:
        ok, msg = s.api_key_manager.delete_user_key(provider, user.username)

    if not ok:
        raise HTTPException(status_code=404, detail=msg)
    return {"ok": True, "message": msg}
