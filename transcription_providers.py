"""
transcription_providers.py — Speech-to-text abstraction for video ingest.

Parallel structure to vlm_providers.py.  Default provider is `faster-whisper`
(local, no API cost).  Optional cloud providers: `openai` (Whisper API) and
`gladia` (SaaS).  All return a single unified TranscriptionResult.
"""
from __future__ import annotations

import logging
import os
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass
class TranscriptionSegment:
    start_sec: float
    end_sec:   float
    text:      str


@dataclass
class TranscriptionResult:
    provider:  str
    language:  str = ''
    text:      str = ''
    segments:  list[TranscriptionSegment] = field(default_factory=list)
    duration:  float = 0.0
    error:     str | None = None

    def to_dict(self) -> dict:
        return {
            'provider': self.provider,
            'language': self.language,
            'text':     self.text,
            'duration': self.duration,
            'segments': [s.__dict__ for s in self.segments],
            'error':    self.error,
        }


# ── Audio extraction (all providers need mono 16 kHz WAV/M4A) ────────────────
def _extract_audio(video_path: str, out_path: str, sample_rate: int = 16000) -> bool:
    """Pull the audio track into a 16 kHz mono WAV for the transcriber."""
    import shutil
    import subprocess
    if shutil.which('ffmpeg') is None:
        logger.error("ffmpeg missing — cannot extract audio")
        return False
    r = subprocess.run(
        ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
         '-i', video_path,
         '-vn', '-ac', '1', '-ar', str(sample_rate),
         '-c:a', 'pcm_s16le',
         out_path],
        capture_output=True, timeout=1800,
    )
    return r.returncode == 0 and Path(out_path).exists()


# ── Provider base ────────────────────────────────────────────────────────────
class TranscriptionProvider:
    name = 'base'

    def transcribe(self, media_path: str, language: str | None = None) -> TranscriptionResult:
        raise NotImplementedError


# ── faster-whisper (local, default) ──────────────────────────────────────────
class FasterWhisperProvider(TranscriptionProvider):
    name = 'faster_whisper'

    def __init__(self, model_size: str = 'base', device: str = 'auto', compute_type: str = 'int8'):
        self.model_size   = model_size
        self.device       = device
        self.compute_type = compute_type
        self._model = None

    def _ensure_model(self):
        if self._model is not None: return
        try:
            from faster_whisper import WhisperModel
        except ImportError as e:
            raise RuntimeError("faster-whisper not installed — add to requirements.txt") from e
        device = self.device
        if device == 'auto':
            try:
                import torch
                device = 'cuda' if torch.cuda.is_available() else 'cpu'
            except ImportError:
                device = 'cpu'
        compute = self.compute_type
        if device == 'cpu' and compute == 'float16':
            compute = 'int8'
        logger.info(f"Loading faster-whisper model={self.model_size} device={device} compute={compute}")
        self._model = WhisperModel(self.model_size, device=device, compute_type=compute)

    def transcribe(self, media_path: str, language: str | None = None) -> TranscriptionResult:
        res = TranscriptionResult(provider=self.name)
        try:
            self._ensure_model()
            with tempfile.TemporaryDirectory() as td:
                audio = str(Path(td) / 'audio.wav')
                if not _extract_audio(media_path, audio):
                    res.error = "ffmpeg audio extraction failed"
                    return res
                segs, info = self._model.transcribe(
                    audio, language=language, vad_filter=True, beam_size=1,
                )
                res.language = info.language or ''
                res.duration = float(info.duration or 0)
                parts: list[str] = []
                for s in segs:
                    res.segments.append(TranscriptionSegment(
                        start_sec=float(s.start), end_sec=float(s.end), text=s.text.strip(),
                    ))
                    parts.append(s.text.strip())
                res.text = ' '.join(parts).strip()
        except Exception as e:
            logger.exception(f"faster-whisper failed: {e}")
            res.error = str(e)
        return res


# ── OpenAI Whisper API (cloud) ───────────────────────────────────────────────
class OpenAIWhisperProvider(TranscriptionProvider):
    name = 'openai_whisper'

    def __init__(self, api_key: str, model: str = 'whisper-1'):
        self.api_key = api_key
        self.model   = model

    def transcribe(self, media_path: str, language: str | None = None) -> TranscriptionResult:
        res = TranscriptionResult(provider=self.name)
        try:
            from openai import OpenAI
        except ImportError:
            res.error = "openai SDK not installed"
            return res
        try:
            client = OpenAI(api_key=self.api_key)
            with tempfile.TemporaryDirectory() as td:
                audio = str(Path(td) / 'audio.wav')
                if not _extract_audio(media_path, audio):
                    res.error = "ffmpeg audio extraction failed"
                    return res
                with open(audio, 'rb') as fh:
                    rsp = client.audio.transcriptions.create(
                        model=self.model,
                        file=fh,
                        language=language,
                        response_format='verbose_json',
                    )
                res.language = getattr(rsp, 'language', '') or ''
                res.text     = getattr(rsp, 'text', '') or ''
                res.duration = float(getattr(rsp, 'duration', 0) or 0)
                for s in (getattr(rsp, 'segments', None) or []):
                    res.segments.append(TranscriptionSegment(
                        start_sec=float(s.get('start') or 0),
                        end_sec=float(s.get('end') or 0),
                        text=(s.get('text') or '').strip(),
                    ))
        except Exception as e:
            logger.exception(f"OpenAI Whisper failed: {e}")
            res.error = str(e)
        return res


# ── Gladia (cloud SaaS) ──────────────────────────────────────────────────────
class GladiaProvider(TranscriptionProvider):
    name = 'gladia'
    UPLOAD_URL  = 'https://api.gladia.io/v2/upload'
    TRANSCRIBE_URL = 'https://api.gladia.io/v2/transcription'

    def __init__(self, api_key: str, timeout: int = 1800):
        self.api_key = api_key
        self.timeout = timeout

    def transcribe(self, media_path: str, language: str | None = None) -> TranscriptionResult:
        import requests
        res = TranscriptionResult(provider=self.name)
        try:
            with tempfile.TemporaryDirectory() as td:
                audio = str(Path(td) / 'audio.wav')
                if not _extract_audio(media_path, audio):
                    res.error = "ffmpeg audio extraction failed"
                    return res
                with open(audio, 'rb') as fh:
                    up = requests.post(
                        self.UPLOAD_URL,
                        headers={'x-gladia-key': self.api_key},
                        files={'audio': (Path(audio).name, fh, 'audio/wav')},
                        timeout=self.timeout,
                    )
                up.raise_for_status()
                audio_url = up.json().get('audio_url')
                if not audio_url:
                    res.error = f"Gladia upload returned no audio_url: {up.text[:200]}"
                    return res
                body = {'audio_url': audio_url}
                if language: body['language'] = language
                start = requests.post(
                    self.TRANSCRIBE_URL,
                    headers={'x-gladia-key': self.api_key, 'Content-Type': 'application/json'},
                    json=body, timeout=60,
                )
                start.raise_for_status()
                result_url = start.json().get('result_url')
                deadline = time.time() + self.timeout
                while time.time() < deadline:
                    time.sleep(2)
                    poll = requests.get(result_url,
                                        headers={'x-gladia-key': self.api_key},
                                        timeout=30)
                    poll.raise_for_status()
                    data = poll.json()
                    if data.get('status') == 'done':
                        tr = data.get('result', {}).get('transcription', {}) or {}
                        res.text     = tr.get('full_transcript', '') or ''
                        res.language = tr.get('languages', [''])[0] if tr.get('languages') else ''
                        for u in tr.get('utterances', []) or []:
                            res.segments.append(TranscriptionSegment(
                                start_sec=float(u.get('start') or 0),
                                end_sec=float(u.get('end') or 0),
                                text=(u.get('text') or '').strip(),
                            ))
                        return res
                    if data.get('status') == 'error':
                        res.error = f"Gladia error: {data.get('error_code')}"
                        return res
                res.error = "Gladia poll timeout"
        except Exception as e:
            logger.exception(f"Gladia failed: {e}")
            res.error = str(e)
        return res


# ── Factory ──────────────────────────────────────────────────────────────────
def make_provider(
    provider: str = 'faster_whisper',
    config: dict | None = None,
) -> TranscriptionProvider | None:
    """Build a provider from config.yaml transcription: block or an override."""
    cfg = config or {}
    provider = (provider or 'faster_whisper').lower()
    try:
        if provider == 'faster_whisper':
            return FasterWhisperProvider(
                model_size  = cfg.get('whisper_model_size', 'base'),
                device      = cfg.get('whisper_device', 'auto'),
                compute_type= cfg.get('whisper_compute_type', 'int8'),
            )
        if provider in ('openai', 'openai_whisper'):
            key = cfg.get('openai_api_key') or os.getenv('OPENAI_API_KEY', '')
            if not key:
                logger.error("OpenAI Whisper: OPENAI_API_KEY missing")
                return None
            return OpenAIWhisperProvider(key, cfg.get('openai_model', 'whisper-1'))
        if provider == 'gladia':
            key = cfg.get('gladia_api_key') or os.getenv('GLADIA_API_KEY', '')
            if not key:
                logger.error("Gladia: GLADIA_API_KEY missing")
                return None
            return GladiaProvider(key)
    except Exception as e:
        logger.exception(f"make_provider({provider}) failed: {e}")
        return None
    logger.warning(f"Unknown transcription provider: {provider!r}")
    return None
