"""
video_processing.py — Frame extraction for video ingest.

Uses ffmpeg for scene-change detection + evenly-spaced fallback sampling,
then dedupes visually similar frames via perceptual hashing (imagehash).

Intended to be called once per video by face_recognition_core.  The caller
then runs the existing InsightFace pipeline on each returned frame.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

VIDEO_EXTENSIONS = {'.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.mpg', '.mpeg'}


@dataclass
class VideoFrame:
    """A single extracted frame, ready to pass to the face detector."""
    frame_index: int        # 0-based position in the extracted sequence
    timestamp_ms: int       # offset from video start
    is_keyframe: bool       # True if sampled by scene-change, False if evenly-spaced fallback
    path: str               # on-disk jpeg path (in a caller-provided tempdir)
    phash: str | None = None


@dataclass
class VideoInfo:
    """Probed metadata about a video file."""
    duration_sec: float = 0.0
    fps: float = 0.0
    frame_count: int = 0
    width: int = 0
    height: int = 0
    codec: str = ''
    frames: list[VideoFrame] = field(default_factory=list)


def is_video(path: str | os.PathLike) -> bool:
    return Path(path).suffix.lower() in VIDEO_EXTENSIONS


def _ffprobe(path: str) -> dict:
    """Run ffprobe and return the video stream info dict, or {} on error."""
    try:
        out = subprocess.check_output(
            ['ffprobe', '-v', 'error',
             '-select_streams', 'v:0',
             '-show_entries', 'stream=codec_name,width,height,r_frame_rate,nb_frames,duration:format=duration',
             '-of', 'json', path],
            stderr=subprocess.DEVNULL, timeout=30,
        )
        return json.loads(out or b'{}')
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError, json.JSONDecodeError) as e:
        logger.warning(f"ffprobe failed for {path}: {e}")
        return {}


def _parse_fps(rate: str) -> float:
    """Parse ffprobe's fractional r_frame_rate (e.g. '30000/1001' → 29.97)."""
    try:
        if '/' in rate:
            num, den = rate.split('/', 1)
            d = float(den)
            return float(num) / d if d else 0.0
        return float(rate)
    except (ValueError, ZeroDivisionError):
        return 0.0


def probe(path: str) -> VideoInfo:
    """Read video duration / fps / dimensions via ffprobe."""
    data = _ffprobe(path)
    info = VideoInfo()
    streams = data.get('streams') or []
    if streams:
        s = streams[0]
        info.codec = s.get('codec_name', '') or ''
        info.width = int(s.get('width') or 0)
        info.height = int(s.get('height') or 0)
        info.fps = _parse_fps(s.get('r_frame_rate', '0/0'))
        nb = s.get('nb_frames')
        if nb and nb.isdigit():
            info.frame_count = int(nb)
        dur = s.get('duration')
        if dur:
            try: info.duration_sec = float(dur)
            except ValueError: pass
    # format-level duration is more reliable on some containers
    fmt = data.get('format') or {}
    if not info.duration_sec and fmt.get('duration'):
        try: info.duration_sec = float(fmt['duration'])
        except ValueError: pass
    if not info.frame_count and info.duration_sec and info.fps:
        info.frame_count = int(info.duration_sec * info.fps)
    return info


def _compute_phash(image_path: str) -> str | None:
    """pHash of an extracted frame, or None if imagehash is unavailable."""
    try:
        import imagehash
        from PIL import Image
        with Image.open(image_path) as im:
            return str(imagehash.phash(im))
    except Exception as e:
        logger.debug(f"phash failed for {image_path}: {e}")
        return None


def _dedupe_by_phash(frames: list[VideoFrame], min_distance: int = 4) -> list[VideoFrame]:
    """Drop frames whose pHash is within `min_distance` of an earlier-kept frame."""
    try:
        import imagehash
    except ImportError:
        return frames
    kept: list[VideoFrame] = []
    kept_hashes = []
    for fr in frames:
        if not fr.phash:
            kept.append(fr); continue
        h = imagehash.hex_to_hash(fr.phash)
        if any((h - kh) <= min_distance for kh in kept_hashes):
            try: os.unlink(fr.path)
            except OSError: pass
            continue
        kept.append(fr)
        kept_hashes.append(h)
    for i, fr in enumerate(kept):
        fr.frame_index = i
    return kept


def extract_frames(
    video_path: str,
    out_dir: str | os.PathLike,
    max_frames: int = 10,
    scene_threshold: float = 0.3,
    min_fallback_interval_sec: float = 1.0,
    dedup_distance: int = 4,
) -> VideoInfo:
    """
    Extract up to `max_frames` representative JPEG frames into `out_dir`.

    Strategy:
      1. ffmpeg scene-change filter (`select='gt(scene,threshold)'`) — catches
         cuts, speaker changes, camera moves.
      2. If fewer than max_frames were found, fill with evenly-spaced samples
         across the full duration (1 fps floor via `min_fallback_interval_sec`).
      3. pHash-dedupe to drop near-identical frames.
      4. Clip the final list to `max_frames`.

    Returns a VideoInfo with the extracted frames populated.
    """
    if shutil.which('ffmpeg') is None:
        raise RuntimeError("ffmpeg not found on PATH — install it via apt/brew/yum")
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    info = probe(video_path)
    if info.duration_sec <= 0:
        logger.warning(f"Video has zero/unknown duration — ffmpeg will still try: {video_path}")

    max_frames = max(1, int(max_frames))

    # ── Pass 1: scene-change extraction (emit timestamped jpeg files) ─────────
    scene_dir = out_dir / 'scene'
    scene_dir.mkdir(exist_ok=True)
    scene_pattern = str(scene_dir / 'scene_%04d.jpg')
    scene_vf = (
        f"select='gt(scene,{scene_threshold})',"
        f"showinfo,"
        f"scale='min(1280,iw)':-2"
    )
    # showinfo prints pts_time per picked frame on stderr
    proc = subprocess.run(
        ['ffmpeg', '-hide_banner', '-loglevel', 'info', '-y',
         '-i', video_path,
         '-vf', scene_vf,
         '-vsync', 'vfr',
         '-frames:v', str(max_frames * 4),   # over-extract, we dedupe below
         '-q:v', '3',
         scene_pattern],
        capture_output=True, text=True, timeout=600,
    )
    scene_times: list[float] = []
    for line in (proc.stderr or '').splitlines():
        if 'pts_time:' in line:
            try:
                t = float(line.split('pts_time:', 1)[1].split(' ', 1)[0])
                scene_times.append(t)
            except (IndexError, ValueError):
                pass

    scene_files = sorted(scene_dir.glob('scene_*.jpg'))
    frames: list[VideoFrame] = []
    for idx, f in enumerate(scene_files):
        ts_s = scene_times[idx] if idx < len(scene_times) else (idx * min_fallback_interval_sec)
        final = out_dir / f'frame_scene_{idx:04d}.jpg'
        f.replace(final)
        frames.append(VideoFrame(
            frame_index=len(frames),
            timestamp_ms=int(ts_s * 1000),
            is_keyframe=True,
            path=str(final),
            phash=_compute_phash(str(final)),
        ))
    try: scene_dir.rmdir()
    except OSError: pass

    # ── Pass 2: fallback evenly-spaced sampling if under cap ─────────────────
    if len(frames) < max_frames and info.duration_sec > 0:
        needed = max_frames - len(frames)
        # Spread `needed` samples across the duration, avoiding the first/last 2 %
        span = info.duration_sec * 0.96
        offset = info.duration_sec * 0.02
        step = span / (needed + 1)
        for i in range(needed):
            t = offset + step * (i + 1)
            out_file = out_dir / f'frame_even_{i:04d}.jpg'
            r = subprocess.run(
                ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
                 '-ss', f'{t:.3f}', '-i', video_path,
                 '-frames:v', '1', '-q:v', '3',
                 '-vf', "scale='min(1280,iw)':-2",
                 str(out_file)],
                capture_output=True, timeout=60,
            )
            if r.returncode == 0 and out_file.exists():
                frames.append(VideoFrame(
                    frame_index=len(frames),
                    timestamp_ms=int(t * 1000),
                    is_keyframe=False,
                    path=str(out_file),
                    phash=_compute_phash(str(out_file)),
                ))

    # ── Dedup + clip ─────────────────────────────────────────────────────────
    frames.sort(key=lambda f: f.timestamp_ms)
    frames = _dedupe_by_phash(frames, min_distance=dedup_distance)
    if len(frames) > max_frames:
        # Keep the scene-change picks preferentially, then fill by time-spread
        keyframes = [f for f in frames if f.is_keyframe]
        others    = [f for f in frames if not f.is_keyframe]
        keep = keyframes[:max_frames] + others[: max(0, max_frames - len(keyframes))]
        keep.sort(key=lambda f: f.timestamp_ms)
        # Delete the ones we're dropping
        dropped = set(id(f) for f in frames) - set(id(f) for f in keep)
        for f in frames:
            if id(f) in dropped:
                try: os.unlink(f.path)
                except OSError: pass
        frames = keep
        for i, f in enumerate(frames):
            f.frame_index = i

    info.frames = frames
    logger.info(
        f"Extracted {len(frames)} frames from {video_path} "
        f"(duration={info.duration_sec:.1f}s, cap={max_frames})"
    )
    return info


def midpoint_thumbnail(video_path: str, out_path: str, max_size: int = 600) -> bool:
    """Grab a single frame at the 50 % mark for the video's gallery thumbnail."""
    if shutil.which('ffmpeg') is None:
        return False
    info = probe(video_path)
    t = (info.duration_sec or 1.0) / 2
    r = subprocess.run(
        ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
         '-ss', f'{t:.3f}', '-i', video_path,
         '-frames:v', '1', '-q:v', '3',
         '-vf', f"scale='min({max_size},iw)':-2",
         out_path],
        capture_output=True, timeout=60,
    )
    return r.returncode == 0 and Path(out_path).exists()
