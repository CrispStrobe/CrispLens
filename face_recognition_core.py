# face_recognition_core.py - Core face recognition engine with comprehensive features
import sqlite3
import time
import numpy as np
import cv2
from pathlib import Path
from typing import List, Dict, Optional, Tuple, Any
import logging
import hashlib
import json
from dataclasses import dataclass, asdict
from datetime import datetime
import io
from PIL import Image
import base64
import os
import platform
import threading

# Optional imports with fallbacks
try:
    import faiss
    FAISS_AVAILABLE = True
except ImportError:
    FAISS_AVAILABLE = False
    logging.warning("FAISS not available - vector search will be limited")

try:
    import insightface
    from insightface.app import FaceAnalysis
    INSIGHTFACE_AVAILABLE = True
except ImportError:
    INSIGHTFACE_AVAILABLE = False
    logging.warning("InsightFace not available")

try:
    import face_recognition as fr
    FACE_RECOGNITION_AVAILABLE = True
except (ImportError, SystemExit, Exception):
    FACE_RECOGNITION_AVAILABLE = False
    logging.warning("face_recognition (dlib) not available")

try:
    import mediapipe as _mp_module
    MEDIAPIPE_AVAILABLE = True
except ImportError:
    MEDIAPIPE_AVAILABLE = False

# YuNet is part of OpenCV ≥ 4.5.4 — detected lazily at first use.
YUNET_AVAILABLE = hasattr(cv2, 'FaceDetectorYN')

# Embedding dimensionality per backend.
# FAISS indices are NOT cross-compatible between backends —
# switching backend requires clearing all embeddings and re-training.
BACKEND_EMBEDDING_DIMS = {
    'insightface': 512,   # ArcFace (buffalo_l / buffalo_m / buffalo_s)
    'dlib_hog':    128,   # ResNet dlib
    'dlib_cnn':    128,   # ResNet dlib (CNN detector variant)
}


def get_available_backends() -> dict:
    """
    Return installation status for each supported backend.
    Used by the Settings UI to show ✓/✗ per option.
    """
    return {
        'insightface': INSIGHTFACE_AVAILABLE,
        'dlib_hog':    FACE_RECOGNITION_AVAILABLE,
        'dlib_cnn':    FACE_RECOGNITION_AVAILABLE,
    }

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

def get_sqlite_path():
    """Get path to SQLite binary with FTS5 support."""
    if platform.system() == "Darwin":  # macOS
        # Try Homebrew locations
        homebrew_paths = [
            "/opt/homebrew/opt/sqlite/bin/sqlite3",  # Apple Silicon
            "/usr/local/opt/sqlite/bin/sqlite3"      # Intel
        ]
        for path in homebrew_paths:
            if os.path.exists(path):
                return path
    return "sqlite3"  # Fallback to system

# For use in subprocess calls
SQLITE_BIN = get_sqlite_path()

# ============================================================================
# DATA CLASSES
# ============================================================================

@dataclass
class BoundingBox:
    """Normalized bounding box (0-1 coordinates)."""
    top: float
    right: float
    bottom: float
    left: float
    
    def to_pixels(self, width: int, height: int) -> Tuple[int, int, int, int]:
        """Convert to pixel coordinates."""
        return (
            int(self.top * height),
            int(self.right * width),
            int(self.bottom * height),
            int(self.left * width)
        )
    
    def area(self) -> float:
        """Calculate area (normalized)."""
        return (self.bottom - self.top) * (self.right - self.left)
    
    def is_valid(self) -> bool:
        """Check if bounding box is valid."""
        return (
            0 <= self.top < self.bottom <= 1 and
            0 <= self.left < self.right <= 1
        )


@dataclass
class Face:
    """Detected face with metadata."""
    bbox: BoundingBox
    detection_confidence: float
    embedding: Optional[np.ndarray] = None
    quality: float = 1.0
    landmarks: Optional[np.ndarray] = None
    age: Optional[int] = None
    gender: Optional[str] = None
    pose: Optional[Dict[str, float]] = None


@dataclass
class Recognition:
    """Face recognition result."""
    person_id: Optional[int]
    person_name: Optional[str]
    confidence: float
    distance: float
    verified: bool = False


@dataclass
class ImageMetadata:
    """Image metadata."""
    width: int
    height: int
    format: str
    file_size: int
    file_hash: str
    taken_at: Optional[datetime] = None
    location: Optional[Tuple[float, float]] = None
    camera_make: Optional[str] = None
    camera_model: Optional[str] = None
    iso: Optional[int] = None
    aperture: Optional[float] = None
    shutter_speed: Optional[str] = None
    focal_length: Optional[float] = None


# ============================================================================
# CONFIGURATION
# ============================================================================

class FaceRecognitionConfig:
    """Configuration for face recognition system."""
    
    # Backend options
    BACKEND_INSIGHTFACE = "insightface"
    BACKEND_DLIB_HOG = "dlib_hog"
    BACKEND_DLIB_CNN = "dlib_cnn"
    
    # InsightFace models
    MODEL_BUFFALO_L = "buffalo_l"  # Best quality, 512D
    MODEL_BUFFALO_M = "buffalo_m"  # Balanced, 512D
    MODEL_BUFFALO_S = "buffalo_s"  # Fast, 512D
    MODEL_BUFFALO_SC = "buffalo_sc"  # Compact, 128D
    
    def __init__(self, config_dict: Optional[Dict] = None):
        """Initialize configuration."""
        config = config_dict or {}
        
        # Backend settings
        self.backend = config.get('backend', self.BACKEND_INSIGHTFACE)
        
        # InsightFace settings
        insightface_config = config.get('insightface', {})
        self.model = insightface_config.get('model', self.MODEL_BUFFALO_L)
        self.detection_threshold = insightface_config.get('detection_threshold', 0.5)
        self.recognition_threshold = insightface_config.get('recognition_threshold', 0.4)
        
        # Load det_size (can be int or list of 2 ints)
        ds = insightface_config.get('det_size', [640, 640])
        if isinstance(ds, int):
            self.det_size = (ds, ds)
        elif isinstance(ds, (list, tuple)) and len(ds) >= 2:
            self.det_size = (int(ds[0]), int(ds[1]))
        else:
            self.det_size = (640, 640)

        self.ctx_id = insightface_config.get('ctx_id', 0)  # -1=CPU, 0+=GPU
        self.use_coreml = insightface_config.get('use_coreml', True)  # macOS CoreML acceleration
        self.lazy_init = config.get('lazy_init', True)  # Defer backend load to first use
        
        # Dlib settings
        dlib_config = config.get('dlib', {})
        self.dlib_model = dlib_config.get('model', 'hog')
        self.dlib_num_jitters = dlib_config.get('num_jitters', 1)
        
        # Processing settings
        processing = config.get('processing', {})
        self.min_face_size = processing.get('min_face_size', 40)  # px; below this = likely false positive
        self.max_face_size = processing.get('max_face_size', 0)
        self.min_face_quality = processing.get('min_face_quality', 0.3)
        self.max_faces_per_image = processing.get('max_faces_per_image', 50)
        
        # Storage settings
        storage = config.get('storage', {})
        self.store_in_db = storage.get('store_in_db', False)
        self.store_on_disk = storage.get('store_on_disk', True)
        self.generate_thumbnails = storage.get('generate_thumbnails', True)
        self.thumbnail_size = tuple(storage.get('thumbnail_size', [200, 200]))
        self.calculate_file_hash = storage.get('calculate_file_hash', True)

        # Shared-DB FAISS sync: how often (seconds) to check for remote writes
        self.faiss_sync_interval = config.get('faiss_sync_interval', 30.0)

        # Shared-DB FAISS sync: reload FAISS when another process writes embeddings
        self.faiss_sync_interval = config.get('faiss_sync_interval', 30.0)


# ============================================================================
# FACE RECOGNITION ENGINE
# ============================================================================

class FaceRecognitionEngine:
    """
    Core face recognition engine with multiple backends.
    
    Features:
    - Multiple backend support (InsightFace, Dlib)
    - FAISS vector indexing for fast search
    - Face quality assessment
    - Comprehensive error handling
    - Database integration
    """
    
    def __init__(self, db_path: str, config: Optional[FaceRecognitionConfig] = None):
        """
        Initialize face recognition engine.
        
        Args:
            db_path: Path to SQLite database
            config: Configuration object
        """
        self.db_path = db_path
        self.config = config or FaceRecognitionConfig()
        
        # Initialize components
        self.face_analyzer = None
        self.faiss_index = None
        self.person_id_map = {}  # faiss_index -> person_id
        self._backend_ready = False
        self._init_error: str = ''           # last initialization error message (empty = no error)
        self._init_lock = threading.Lock()   # prevents concurrent _initialize_backend calls

        # Shared-DB FAISS sync state
        self._faiss_db_mtime = 0.0    # DB mtime when FAISS was last built
        self._faiss_last_check = 0.0  # wall-clock time of last staleness check

        # FAISS staleness tracking (for shared-DB multi-instance setups)
        self._faiss_db_mtime = 0.0    # db file mtime when FAISS was last built
        self._faiss_last_check = 0.0  # wall-clock of last staleness poll

        # Statistics
        self.stats = {
            'images_processed': 0,
            'faces_detected': 0,
            'faces_recognized': 0,
            'errors': 0
        }

        # Initialize database (fast)
        self._initialize_database()

        # Load FAISS index (fast — reads from SQLite)
        self._load_faiss_index()

        if self.config.lazy_init:
            logger.info(
                f"FaceRecognitionEngine ready (backend={self.config.backend}, "
                "lazy_init=True — model will load on first use)"
            )
        else:
            # Eager load (default)
            self._initialize_backend()
            logger.info(f"FaceRecognitionEngine initialized with backend: {self.config.backend}")
    
    def _execute_with_retry(self, func, max_retries=3):
        """Execute database operation with retry on lock."""
        import time
        
        for attempt in range(max_retries):
            try:
                return func()
            except sqlite3.OperationalError as e:
                if "database is locked" in str(e) and attempt < max_retries - 1:
                    wait_time = (2 ** attempt) * 0.1  # Exponential backoff: 0.1s, 0.2s, 0.4s
                    logger.warning(f"Database locked, retrying in {wait_time:.1f}s... (attempt {attempt + 1}/{max_retries})")
                    time.sleep(wait_time)
                else:
                    raise
    
    def _get_connection(self) -> sqlite3.Connection:
        """Get database connection with proper settings."""
        conn = sqlite3.connect(self.db_path, timeout=60.0)  # Increased from 10.0 to 60.0
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        conn.row_factory = sqlite3.Row
        return conn
    
    def _ensure_backend(self):
        """Lazy-initialize the backend on first use (thread-safe)."""
        if not self._backend_ready:
            with self._init_lock:
                if not self._backend_ready:   # double-checked locking
                    self._initialize_backend()

    @staticmethod
    def _build_onnx_providers(ctx_id: int, use_coreml: bool) -> List[str]:
        """
        Build the ONNX Runtime execution provider list.

        Priority order on macOS:
          CoreMLExecutionProvider  → uses Apple Neural Engine / Metal GPU,
                                     compiles model on first run, then caches it
                                     (subsequent startups are dramatically faster)
          CPUExecutionProvider     → always-available fallback

        On Linux/Windows with GPU:
          CUDAExecutionProvider → CPUExecutionProvider
        """
        if platform.system() == 'Darwin' and use_coreml:
            # CoreML is available; it will cache the compiled model in
            # ~/Library/Caches/com.apple.dt.Xcode (or ONNX Runtime's cache dir)
            # so only the very first run is slow.
            return ['CoreMLExecutionProvider', 'CPUExecutionProvider']
        elif ctx_id >= 0:
            return ['CUDAExecutionProvider', 'CPUExecutionProvider']
        else:
            return ['CPUExecutionProvider']

    def _initialize_backend(self):
        """Initialize face recognition backend."""
        try:
            if self.config.backend == FaceRecognitionConfig.BACKEND_INSIGHTFACE:
                if not INSIGHTFACE_AVAILABLE:
                    raise ImportError("InsightFace not installed")

                providers = self._build_onnx_providers(
                    self.config.ctx_id, self.config.use_coreml
                )
                logger.info(f"Loading InsightFace model '{self.config.model}' with providers: {providers}")

                self.face_analyzer = FaceAnalysis(
                    name=self.config.model,
                    allowed_modules=['detection', 'recognition'],
                    providers=providers
                )
                self.face_analyzer.prepare(
                    ctx_id=-1 if platform.system() == 'Darwin' else self.config.ctx_id,
                    det_size=self.config.det_size
                )
                self._backend_ready = True
                logger.info(f"InsightFace initialized with model: {self.config.model}")

            elif self.config.backend in [FaceRecognitionConfig.BACKEND_DLIB_HOG, FaceRecognitionConfig.BACKEND_DLIB_CNN]:
                if not FACE_RECOGNITION_AVAILABLE:
                    raise ImportError("face_recognition (dlib) not installed")
                self._backend_ready = True
                logger.info(f"Dlib backend initialized: {self.config.backend}")

            else:
                raise ValueError(f"Unknown backend: {self.config.backend}")

        except Exception as e:
            self._init_error = str(e)
            logger.error(f"Failed to initialize backend: {e}")
            raise

        self._init_error = ''   # clear any previous error on success

    def reset_backend(self) -> None:
        """Clear the backend so the next _ensure_backend() call reinitializes it.

        Use this when model files change, after manually downloading a missing
        model, or after any config change that requires a fresh model load.
        Thread-safe: acquires the init lock.
        """
        with self._init_lock:
            logger.info("reset_backend: clearing face_analyzer and resetting _backend_ready")
            self.face_analyzer = None
            self._backend_ready = False
            self._init_error = ''

    def _initialize_database(self):
        """Initialize database tables if needed and run column migrations."""
        try:
            conn = self._get_connection()

            # Check if schema exists
            cursor = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='images'"
            )

            if not cursor.fetchone():
                # Schema missing — run schema_complete.sql automatically.
                # Look for it next to face_recognition_core.py (works both locally and on VPS).
                import os as _os
                schema_path = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), 'schema_complete.sql')
                if _os.path.exists(schema_path):
                    logger.info(f"Initialising database schema from {schema_path}")
                    schema_sql = open(schema_path, 'r').read()
                    conn.executescript(schema_sql)
                    conn.commit()
                    logger.info("Database schema created successfully.")
                else:
                    logger.error(
                        "schema_complete.sql not found — cannot initialise DB. "
                        "Place schema_complete.sql next to face_recognition_core.py and restart."
                    )
                    conn.close()
                    return

            # Migration: add EXIF columns that may be missing from older schemas
            existing_cols = {
                row[1]
                for row in conn.execute("PRAGMA table_info(images)").fetchall()
            }
            migrations = [
                ("iso",          "INTEGER"),
                ("aperture",     "REAL"),
                ("shutter_speed","TEXT"),
                ("focal_length", "REAL"),
                ("favorite",     "BOOLEAN DEFAULT 0"),
            ]
            for col, col_type in migrations:
                if col not in existing_cols:
                    conn.execute(f"ALTER TABLE images ADD COLUMN {col} {col_type}")
                    logger.info(f"DB migration: added column images.{col}")
            conn.commit()
            conn.close()

        except Exception as e:
            logger.error(f"Database initialization check failed: {e}")
    
    def _load_faiss_index(self):
        """Load FAISS index from database."""
        if not FAISS_AVAILABLE:
            logger.warning("FAISS not available - using linear search")
            return
        
        try:
            conn = self._get_connection()
            rows = conn.execute("""
                SELECT fe.id, fe.person_id, fe.embedding_vector, fe.embedding_dimension,
                       fe.verified, fe.verification_method, fe.recognition_confidence
                FROM face_embeddings fe
                WHERE fe.person_id IS NOT NULL
                  AND fe.embedding_vector IS NOT NULL
                ORDER BY fe.id
            """).fetchall()
            conn.close()

            embeddings = []
            person_ids = []
            # Diagnostic counters
            count_verified = 0
            count_unverified = 0
            count_by_method: dict = {}
            count_by_person: dict = {}

            for row in rows:
                embedding = np.frombuffer(row['embedding_vector'], dtype=np.float32)
                embeddings.append(embedding)
                pid = row['person_id']
                person_ids.append(pid)

                if row['verified']:
                    count_verified += 1
                else:
                    count_unverified += 1
                method = row['verification_method'] or 'auto'
                count_by_method[method] = count_by_method.get(method, 0) + 1
                count_by_person[pid] = count_by_person.get(pid, 0) + 1

            if embeddings:
                # Build per-person name map for logging
                conn2 = self._get_connection()
                person_names = {
                    r['id']: r['name']
                    for r in conn2.execute("SELECT id, name FROM people").fetchall()
                }
                conn2.close()

                dimension = len(embeddings[0])
                embeddings_array = np.array(embeddings).astype('float32')
                faiss.normalize_L2(embeddings_array)
                self.faiss_index = faiss.IndexFlatIP(dimension)
                self.faiss_index.add(embeddings_array)
                self.person_id_map = {i: pid for i, pid in enumerate(person_ids)}

                logger.info(
                    f"Loaded FAISS index: {len(embeddings)} embeddings, dim={dimension} "
                    f"[verified={count_verified}, unverified={count_unverified}] "
                    f"methods={count_by_method}"
                )
                for pid, cnt in sorted(count_by_person.items(), key=lambda x: -x[1]):
                    pname = person_names.get(pid, f"id={pid}")
                    logger.info(f"  → {pname}: {cnt} embedding(s)")
            else:
                logger.info("No embeddings in database — FAISS index is empty")
        
        except Exception as e:
            logger.error(f"Failed to load FAISS index: {e}")
            self.faiss_index = None
        finally:
            try:
                self._faiss_db_mtime = os.path.getmtime(self.db_path)
            except Exception:
                pass

    def _check_faiss_staleness(self):
        """
        Reload FAISS index if another process has written new embeddings to the
        shared SQLite database since our last build.  Checks are throttled by
        config.faiss_sync_interval (default 30 s) to avoid stat() on every call.
        """
        now = time.monotonic()
        if now - self._faiss_last_check < self.config.faiss_sync_interval:
            return
        self._faiss_last_check = now
        try:
            mtime = os.path.getmtime(self.db_path)
            if mtime > self._faiss_db_mtime:
                logger.info("Shared DB modified by another instance — reloading FAISS index")
                self._load_faiss_index()
        except Exception:
            pass

    def _calculate_file_hash(self, image_path: str) -> str:
        """Calculate SHA256 hash of file."""
        sha256 = hashlib.sha256()
        try:
            with open(image_path, 'rb') as f:
                while chunk := f.read(8192):
                    sha256.update(chunk)
            return sha256.hexdigest()
        except Exception as e:
            logger.error(f"Failed to calculate file hash: {e}")
            return ""
    
    def _extract_metadata(self, image_path: str) -> ImageMetadata:
        """Extract image metadata."""
        logger.info(f"  🔍 Extracting metadata from: {image_path}")
        try:
            path = Path(image_path)
            
            # Get file info
            file_size = path.stat().st_size
            
            # Load image to get dimensions
            img = cv2.imread(str(path))
            if img is None:
                raise ValueError("Failed to load image")
            
            height, width = img.shape[:2]
            logger.info(f"    Size: {width}x{height}, Bytes: {file_size}")

            # Determine format
            img_format = path.suffix.upper()[1:] if path.suffix else "UNKNOWN"
            
            # Calculate hash if enabled
            file_hash = ""
            if self.config.calculate_file_hash:
                file_hash = self._calculate_file_hash(image_path)
            
            # Try to extract EXIF data
            taken_at = None
            location = None
            camera_make = None
            camera_model = None
            iso = None
            aperture = None
            shutter_speed = None
            focal_length = None

            try:
                from PIL import Image
                from PIL.ExifTags import TAGS, GPSTAGS

                pil_img = Image.open(image_path)
                exif_data = pil_img.getexif()

                if exif_data:
                    # Extract datetime
                    if 306 in exif_data:  # DateTime
                        datetime_str = exif_data[306]
                        try:
                            taken_at = datetime.strptime(datetime_str, "%Y:%m:%d %H:%M:%S")
                        except:
                            pass

                    # Extract camera info
                    camera_make = exif_data.get(271)  # Make
                    camera_model = exif_data.get(272)  # Model
                    if camera_make or camera_model:
                        logger.info(f"    Camera: {camera_make} {camera_model}")

                    # ISO speed
                    raw_iso = exif_data.get(34855)  # ISOSpeedRatings
                    if raw_iso is not None:
                        try:
                            iso = int(raw_iso)
                        except (TypeError, ValueError):
                            pass

                    # Aperture (FNumber = rational)
                    raw_fn = exif_data.get(33437)  # FNumber
                    if raw_fn is not None:
                        try:
                            aperture = float(raw_fn)
                        except (TypeError, ValueError):
                            pass

                    # Shutter speed (ExposureTime = rational, store as human-readable)
                    raw_et = exif_data.get(33434)  # ExposureTime
                    if raw_et is not None:
                        try:
                            et = float(raw_et)
                            if et > 0:
                                if et >= 1:
                                    shutter_speed = f"{et:.0f}s"
                                else:
                                    shutter_speed = f"1/{round(1/et)}s"
                        except (TypeError, ValueError, ZeroDivisionError):
                            pass

                    # Focal length (mm)
                    raw_fl = exif_data.get(37386)  # FocalLength
                    if raw_fl is not None:
                        try:
                            focal_length = float(raw_fl)
                        except (TypeError, ValueError):
                            pass

                    # Extract GPS
                    if 34853 in exif_data:  # GPSInfo
                        gps_info = exif_data[34853]
                        if gps_info:
                            # This is simplified - full GPS parsing is complex
                            lat = gps_info.get(2)
                            lon = gps_info.get(4)
                            if lat and lon:
                                location = (float(lat[0]), float(lon[0]))

            except Exception as e:
                logger.debug(f"EXIF extraction failed: {e}")

            return ImageMetadata(
                width=width,
                height=height,
                format=img_format,
                file_size=file_size,
                file_hash=file_hash,
                taken_at=taken_at,
                location=location,
                camera_make=camera_make,
                camera_model=camera_model,
                iso=iso,
                aperture=aperture,
                shutter_speed=shutter_speed,
                focal_length=focal_length,
            )
        
        except Exception as e:
            logger.error(f"Failed to extract metadata: {e}")
            raise
    
    def _create_thumbnail(self, image: np.ndarray) -> Optional[bytes]:
        """Create thumbnail of image."""
        if not self.config.generate_thumbnails:
            return None
        
        try:
            # Convert BGR to RGB
            img_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            pil_img = Image.fromarray(img_rgb)
            
            # Create thumbnail
            pil_img.thumbnail(self.config.thumbnail_size, Image.Resampling.LANCZOS)
            
            # Convert to bytes
            buffer = io.BytesIO()
            pil_img.save(buffer, format='JPEG', quality=85)
            return buffer.getvalue()
        
        except Exception as e:
            logger.error(f"Failed to create thumbnail: {e}")
            return None
    
    def _detect_faces_insightface(self, image: np.ndarray, det_thresh: Optional[float] = None) -> List[Face]:
        """Detect faces using InsightFace with adaptive detection size."""
        self._ensure_backend()
        try:
            h, w = image.shape[:2]
            
            # Ensure BGR format
            if len(image.shape) == 2:
                image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
            
            # ================================================================
            # KEY FIX: Adaptive detection size based on image dimensions
            # Increased for high-res images to find small faces.
            # ================================================================
            if self.config.det_size != (640, 640):
                # User has manually overridden det_size in config
                det_size = self.config.det_size
            else:
                max_dim = max(h, w)
                if max_dim < 200:
                    det_size = (128, 128)
                elif max_dim < 400:
                    det_size = (320, 320)
                elif max_dim < 1200:
                    det_size = (640, 640)
                elif max_dim < 2400:
                    det_size = (1280, 1280)
                else:
                    det_size = (1920, 1920)
            
            self.face_analyzer.det_model.input_size = det_size

            # Use provided threshold or global config
            threshold = det_thresh if det_thresh is not None else self.config.detection_threshold

            # Set NMS floor low so InsightFace returns ALL candidates above noise;
            # the post-filter loop below applies the effective threshold.
            # Previously we pushed `threshold` here, which silently dropped faces
            # scoring 0.625–0.637 when threshold=0.70 — the main cause of missed detections.
            if hasattr(self.face_analyzer.det_model, 'det_thresh'):
                self.face_analyzer.det_model.det_thresh = 0.05

            logger.info(f"  🎯 Detection: image={w}x{h}px  det_size={det_size}  det_thresh={threshold:.2f}  min_face={self.config.min_face_size}px")

            # Detect faces
            faces = self.face_analyzer.get(image)
            logger.info(f"  🔎 InsightFace found {len(faces)} raw candidate(s)")

            # Convert to Face objects
            detected_faces = []

            for i, face in enumerate(faces):
                # InsightFace bbox = [x1, y1, x2, y2]  (left, top, right, bottom)
                bp = face.bbox.astype(int)
                x1, y1, x2, y2 = bp[0], bp[1], bp[2], bp[3]
                conf = float(face.det_score)
                face_w_px = x2 - x1
                face_h_px = y2 - y1

                logger.info(
                    f"    Candidate {i}: x=[{x1}–{x2}] y=[{y1}–{y2}]  "
                    f"size={face_w_px}x{face_h_px}px  det_score={conf:.4f}"
                )

                # Normalize to 0-1
                bbox = BoundingBox(
                    top=max(0, y1 / h),
                    right=min(1, x2 / w),
                    bottom=min(1, y2 / h),
                    left=max(0, x1 / w)
                )

                if not bbox.is_valid():
                    logger.warning(f"    ✗ Candidate {i}: invalid bbox (x1={x1},y1={y1},x2={x2},y2={y2}) — skipped")
                    continue

                if conf < threshold:
                    logger.info(f"    ✗ Candidate {i}: det_score {conf:.4f} < threshold {threshold:.2f} — rejected")
                    continue

                # Get embedding
                embedding = face.normed_embedding
                
                # Optional attributes - handle None values
                landmarks = face.kps if hasattr(face, 'kps') else None
                
                age = None
                if hasattr(face, 'age') and face.age is not None:
                    try:
                        age = int(face.age)
                    except (ValueError, TypeError):
                        pass
                
                gender = None
                if hasattr(face, 'sex') and face.sex is not None:
                    gender = str(face.sex)
                
                pose = None
                if hasattr(face, 'pose') and face.pose is not None:
                    try:
                        pose = {
                            'roll': float(face.pose[0]),
                            'yaw': float(face.pose[1]),
                            'pitch': float(face.pose[2])
                        }
                    except (IndexError, TypeError, ValueError):
                        pass
                
                face_obj = Face(
                    bbox=bbox,
                    detection_confidence=conf,
                    embedding=embedding,
                    quality=conf,
                    landmarks=landmarks,
                    age=age,
                    gender=gender,
                    pose=pose
                )
                
                detected_faces.append(face_obj)
            
            return detected_faces
        
        except Exception as e:
            logger.error(f"Face detection failed (InsightFace): {e}", exc_info=True)
            return []
    
    def _detect_faces_dlib(self, image: np.ndarray) -> List[Face]:
        """Detect faces using Dlib (face_recognition library)."""
        self._ensure_backend()
        try:
            # Convert BGR to RGB
            rgb_image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            
            # Detect faces
            if self.config.dlib_model == 'cnn':
                face_locations = fr.face_locations(rgb_image, model='cnn')
            else:
                face_locations = fr.face_locations(rgb_image, model='hog')
            
            # Get encodings
            face_encodings = fr.face_encodings(
                rgb_image,
                face_locations,
                num_jitters=self.config.dlib_num_jitters
            )
            
            # Convert to Face objects
            detected_faces = []
            height, width = image.shape[:2]
            
            for location, encoding in zip(face_locations, face_encodings):
                # face_locations returns (top, right, bottom, left) in pixels
                top, right, bottom, left = location
                
                # Normalize to 0-1
                bbox = BoundingBox(
                    top=max(0, top / height),
                    right=min(1, right / width),
                    bottom=min(1, bottom / height),
                    left=max(0, left / width)
                )
                
                if not bbox.is_valid():
                    continue
                
                face_obj = Face(
                    bbox=bbox,
                    detection_confidence=1.0,  # Dlib doesn't provide confidence
                    embedding=encoding,
                    quality=1.0
                )
                
                detected_faces.append(face_obj)
            
            return detected_faces
        
        except Exception as e:
            logger.error(f"Face detection failed (Dlib): {e}")
            return []
    
    def detect_faces(self, image: np.ndarray, det_thresh: Optional[float] = None,
                     min_face_size: Optional[int] = None, det_model: str = 'auto') -> List[Face]:
        """
        Detect faces in image.

        Args:
            image: Image array (BGR format)
            det_thresh: Optional detection threshold override
            min_face_size: Optional minimum face size override
            det_model: Detection model override — 'auto'|'retinaface'|'scrfd'|'yunet'|'mediapipe'.
                       'auto' and 'retinaface' use the standard InsightFace pipeline with
                       threshold-sweep retries.  Other values jump directly to that detector.

        Returns:
            List of detected faces
        """
        if image is None or image.size == 0:
            return []
        
        try:
            height, width = image.shape[:2]
            mfs = min_face_size if min_face_size is not None else self.config.min_face_size

            def _apply_filters(raw_faces: List) -> List:
                """Apply quality and size filters. Bbox is normalised 0-1 so original
                image dimensions are correct even for faces found in a downscaled copy."""
                result = []
                for face in raw_faces:
                    if face.quality < self.config.min_face_quality:
                        continue
                    bp = face.bbox.to_pixels(width, height)
                    fw = bp[1] - bp[3]   # right - left
                    fh = bp[2] - bp[0]   # bottom - top
                    if fw < mfs or fh < mfs:
                        logger.info(f"  Face rejected: too small ({fw}x{fh}px < {mfs}px min)")
                        continue
                    if self.config.max_face_size > 0:
                        if fw > self.config.max_face_size or fh > self.config.max_face_size:
                            continue
                    result.append(face)
                return result

            # ── Initial detection ──────────────────────────────────────────────────
            # When a specific model is requested, jump straight to it (no retry sweep).
            if det_model == 'scrfd':
                logger.info("  🔬 Using SCRFD detector (explicit override)")
                faces = self._detect_faces_scrfd(image, det_thresh=det_thresh)
                return _apply_filters(faces)
            elif det_model == 'yunet':
                logger.info("  🔬 Using YuNet detector (explicit override)")
                faces = self._detect_faces_yunet(image, det_thresh=det_thresh)
                return _apply_filters(faces)
            elif det_model == 'mediapipe':
                logger.info("  🔬 Using MediaPipe detector (explicit override)")
                faces = self._detect_faces_mediapipe(image, det_thresh=det_thresh)
                return _apply_filters(faces)

            # 'auto' and 'retinaface' → standard InsightFace pipeline
            if self.config.backend == FaceRecognitionConfig.BACKEND_INSIGHTFACE:
                faces = self._detect_faces_insightface(image, det_thresh=det_thresh)
            else:
                faces = self._detect_faces_dlib(image)

            filtered_faces = _apply_filters(faces)

            # ── Auto-retry: lower threshold sweep when nothing found ───────────────
            # Only kick in when the caller did not supply an explicit threshold, so we
            # don't override intentional manual re-detects.
            if (not filtered_faces
                    and det_thresh is None
                    and self.config.backend == FaceRecognitionConfig.BACKEND_INSIGHTFACE):

                # Descend to progressively lower thresholds
                for retry_thresh in [0.30, 0.20, 0.10]:
                    logger.info(f"  🔄 No faces at default threshold — retrying at {retry_thresh:.2f}")
                    raw = self._detect_faces_insightface(image, det_thresh=retry_thresh)
                    filtered_faces = _apply_filters(raw)
                    if filtered_faces:
                        break

                # ── Scale-retry: downsample when all threshold attempts failed ──
                # Thresholds must go DOWN (not up) from the last attempt: the whole
                # point is to find faces the model rates as low-confidence.
                if not filtered_faces:
                    for scale in [0.75, 0.50]:
                        sh, sw = int(height * scale), int(width * scale)
                        scaled = cv2.resize(image, (sw, sh), interpolation=cv2.INTER_AREA)
                        logger.info(f"  🔍 Scale-retry at {int(scale * 100)}% ({sw}×{sh}px)")
                        for retry_thresh in [0.20, 0.10]:
                            raw = self._detect_faces_insightface(scaled, det_thresh=retry_thresh)
                            filtered_faces = _apply_filters(raw)
                            if filtered_faces:
                                logger.info(f"  ✓ Found {len(filtered_faces)} face(s) at scale {int(scale*100)}%, thresh {retry_thresh:.2f}")
                                break
                        if filtered_faces:
                            break

            # ── Last-resort: accept best large-area candidate at near-noise level ─
            # This catches faces that InsightFace's detector rates very low (e.g.
            # extreme pose, unusual lighting) but that are clearly face-sized regions.
            # Applied regardless of whether det_thresh was explicitly supplied so
            # manual re-detects at low thresholds also benefit.
            # We require ≥ 150 px in each dimension (much larger than min_face_size)
            # and take only the single highest-scoring candidate to limit false positives.
            if not filtered_faces and self.config.backend == FaceRecognitionConfig.BACKEND_INSIGHTFACE:
                raw_lr = self._detect_faces_insightface(image, det_thresh=0.04)
                large = [
                    f for f in raw_lr
                    if (f.bbox.right - f.bbox.left) * width  >= 150
                    and (f.bbox.bottom - f.bbox.top) * height >= 150
                ]
                if large:
                    best_lr = max(large, key=lambda f: f.detection_confidence)
                    logger.warning(
                        f"  ⚠️  Last-resort: accepting best large candidate "
                        f"({int((best_lr.bbox.right - best_lr.bbox.left)*width)}×"
                        f"{int((best_lr.bbox.bottom - best_lr.bbox.top)*height)}px, "
                        f"score={best_lr.detection_confidence:.4f})"
                    )
                    filtered_faces = [best_lr]

            # ── Alternative detector fallbacks ────────────────────────────────
            # Last-resort failed OR was not applicable (dlib backend).
            # Try YuNet then MediaPipe — both return Face objects with ArcFace
            # embeddings so they're immediately usable by recognize_face().
            if not filtered_faces and self.config.backend == FaceRecognitionConfig.BACKEND_INSIGHTFACE:
                for label, fallback_fn in [
                    ('YuNet',      self._detect_faces_yunet),
                    ('MediaPipe',  self._detect_faces_mediapipe),
                ]:
                    raw_fb = fallback_fn(image)
                    filtered_fb = _apply_filters(raw_fb)
                    if filtered_fb:
                        logger.info(f"  ✓ {label} fallback accepted {len(filtered_fb)} face(s)")
                        filtered_faces = filtered_fb
                        break

            # Limit number of faces
            if self.config.max_faces_per_image > 0:
                filtered_faces = filtered_faces[:self.config.max_faces_per_image]

            return filtered_faces

        except Exception as e:
            logger.error(f"Face detection failed: {e}")
            return []
    
    def recognize_face(self, face: Face, top_k: int = 1, rec_thresh: Optional[float] = None) -> List[Recognition]:
        """
        Recognize a face using FAISS index.
        
        Args:
            face: Face object with embedding
            top_k: Number of top matches to return
            rec_thresh: Optional recognition threshold override
        
        Returns:
            List of Recognition objects
        """
        if face.embedding is None:
            logger.warning("  ⚠️ Cannot recognize face: No embedding found")
            return []

        self._check_faiss_staleness()

        if self.faiss_index is None or self.faiss_index.ntotal == 0:
            logger.info("  ℹ️ FAISS index empty, skipping recognition")
            return []
        
        try:
            # Prepare query
            query_embedding = face.embedding.reshape(1, -1).astype('float32')
            faiss.normalize_L2(query_embedding)
            
            # Search
            distances, indices = self.faiss_index.search(query_embedding, min(top_k, self.faiss_index.ntotal))
            
            # Convert to Recognition objects
            recognitions = []
            
            # Use provided threshold or global config
            threshold = rec_thresh if rec_thresh is not None else self.config.recognition_threshold

            for dist, idx in zip(distances[0], indices[0]):
                if idx == -1:  # No match
                    continue
                
                # Get person_id
                person_id = self.person_id_map.get(int(idx))
                if person_id is None:
                    continue
                
                # Convert distance to confidence (cosine similarity -> confidence)
                # Distance is cosine similarity (0-1), higher is better
                confidence = float(dist)
                
                # Get person name
                person_name = self._get_person_name(person_id)
                
                # Check if above threshold
                verified = confidence >= threshold
                
                logger.info(f"  👤 Recognized '{person_name}' (id={person_id}) with confidence {confidence:.4f} (thresh={threshold}, verified={verified})")

                recognition = Recognition(
                    person_id=person_id,
                    person_name=person_name,
                    confidence=confidence,
                    distance=1.0 - confidence,  # Convert to distance metric
                    verified=verified
                )
                
                recognitions.append(recognition)
            
            return recognitions
        
        except Exception as e:
            logger.error(f"Face recognition failed: {e}")
            return []
    
    def _get_person_name(self, person_id: int) -> Optional[str]:
        """Get person name from database."""
        try:
            conn = self._get_connection()
            cursor = conn.execute("SELECT name FROM people WHERE id = ?", (person_id,))
            row = cursor.fetchone()
            conn.close()
            
            return row['name'] if row else None
        except Exception as e:
            logger.error(f"Failed to get person name: {e}")
            return None
    
    def process_image(self, image_path: str, vlm_provider=None, force: bool = False,
                     det_thresh: Optional[float] = None, min_face_size: Optional[int] = None,
                     rec_thresh: Optional[float] = None,
                     skip_faces: bool = False, skip_vlm: bool = False,
                     det_model: str = 'auto', max_size: int = 0) -> Dict[str, Any]:
        """
        Process image: detect faces, recognize, store in database.

        Args:
            image_path:  Path to image file
            vlm_provider: Optional VLM provider for enrichment
            force:       If True, re-process even if already in DB
            det_thresh:  Optional detection threshold override
            min_face_size: Optional minimum face size override
            rec_thresh:  Optional recognition threshold override
            skip_faces:  If True, skip face detection/recognition/storage
                         (existing face rows are left untouched)
            skip_vlm:    If True, skip VLM enrichment step

        Returns:
            Processing results dictionary
        """
        logger.info(f"=== Processing image: {image_path} (force={force}) ===")
        try:
            # ================================================================
            # CHECK FOR DUPLICATES - Skip if already processed
            # ================================================================
            conn = self._get_connection()
            cursor = conn.execute(
                "SELECT id, face_count, ai_description FROM images WHERE filepath = ? AND processed = 1",
                (image_path,)
            )
            existing = cursor.fetchone()
            conn.close()
            
            if existing and not force:
                image_id = existing['id']
                logger.info(f"⏭️  Image already processed (id={image_id}, faces={existing['face_count']})")
                
                # Run VLM if active and no description stored yet
                if vlm_provider and (not existing['ai_description']):
                    try:
                        from i18n import i18n as _i18n
                        vlm_r = vlm_provider.enrich_image(image_path, _i18n.t('vlm_prompt'))
                        if vlm_r and 'error' not in vlm_r:
                            self._update_image_vlm(image_id, vlm_r)
                    except Exception as e:
                        logger.warning(f"VLM enrichment failed for cached image: {e}")
                
                return self._build_cached_result(image_id, image_path)
            # ================================================================
            
            # Load image (handles grayscale, RGBA → BGR automatically)
            image = self._load_image(image_path)
            if image is None:
                raise ValueError(f"Failed to load image: {image_path}")
            
            # Extract metadata
            metadata = self._extract_metadata(image_path)
            
            # Create thumbnail
            thumbnail = self._create_thumbnail(image)
            
            # Store image in database
            image_id = self._store_image(image_path, metadata, image if self.config.store_in_db else None, thumbnail)
            if image_id is None:
                # Last resort: direct SELECT in case _store_image's recovery also failed
                _lr_conn = None
                try:
                    _lr_conn = self._get_connection()
                    _lr_row = _lr_conn.execute(
                        "SELECT id FROM images WHERE filepath = ?", (image_path,)
                    ).fetchone()
                    if _lr_row:
                        image_id = _lr_row['id']
                    elif metadata.file_hash:
                        _lr_row = _lr_conn.execute(
                            "SELECT id FROM images WHERE file_hash = ?", (metadata.file_hash,)
                        ).fetchone()
                        if _lr_row:
                            image_id = _lr_row['id']
                finally:
                    if _lr_conn:
                        _lr_conn.close()
            if image_id is None:
                raise ValueError(f"Failed to store image record (no retrievable row): {image_path}")
            logger.info(f"  💾 Stored/Reused image record (id={image_id})")

            # If the stored row's filepath differs from image_path, the insert hit a filepath
            # UNIQUE violation and we recovered an existing row (same file processed twice).
            # If that row is already fully processed, return the cached result to avoid
            # inserting duplicate faces.
            if not force:
                _conn_chk = self._get_connection()
                try:
                    _chk_row = _conn_chk.execute(
                        "SELECT processed, filepath FROM images WHERE id = ?", (image_id,)
                    ).fetchone()
                finally:
                    _conn_chk.close()
                if _chk_row and _chk_row['processed'] and _chk_row['filepath'] != image_path:
                    logger.info(f"  ⏭️  Duplicate content detected (id={image_id}), returning cached result")
                    return self._build_cached_result(image_id, image_path)

            # ── Optional in-memory downsize before detection ───────────────────
            # max_size > 0 means: resize the image to max dimension max_size before
            # detection (for speed on very high-res inputs).  Bboxes are normalised
            # 0-1 so they map back to the original image automatically.  The stored
            # file and DB record are not affected.
            det_image = image
            if max_size and max_size > 0:
                dh, dw = image.shape[:2]
                if max(dh, dw) > max_size:
                    _scale = max_size / max(dh, dw)
                    det_image = cv2.resize(
                        image,
                        (int(dw * _scale), int(dh * _scale)),
                        interpolation=cv2.INTER_AREA,
                    )
                    logger.info(f"  🔽 Downsized for detection: {dw}×{dh} → {det_image.shape[1]}×{det_image.shape[0]}")

            # ── Face detection & recognition ───────────────────────────────────
            faces: List = []
            recognitions_by_face: List = []
            if not skip_faces:
                faces = self.detect_faces(det_image, det_thresh=det_thresh, min_face_size=min_face_size, det_model=det_model)
                logger.info(f"  👤 Detected {len(faces)} faces")
                h_img, w_img = image.shape[:2]
                for i, face in enumerate(faces):
                    y1_px, x2_px, y2_px, x1_px = face.bbox.to_pixels(w_img, h_img)
                    fw = x2_px - x1_px
                    fh = y2_px - y1_px
                    logger.info(
                        f"    Recognizing face {i+1}/{len(faces)}: "
                        f"x=[{x1_px}–{x2_px}] y=[{y1_px}–{y2_px}] size={fw}x{fh}px  det={face.detection_confidence:.3f}"
                    )
                    recognitions = self.recognize_face(face, top_k=1, rec_thresh=rec_thresh)
                    recognitions_by_face.append(recognitions[0] if recognitions else None)
                logger.info("  📥 Storing faces in database...")
                self._store_faces(image_id, faces, recognitions_by_face)
            else:
                logger.info("  ⏭️  skip_faces=True — face detection skipped")

            # ── VLM enrichment ─────────────────────────────────────────────────
            vlm_result = None
            if vlm_provider and not skip_vlm:
                logger.info(f"Calling VLM provider for: {image_path}")
                try:
                    from i18n import i18n
                    vlm_result = vlm_provider.enrich_image(image_path, i18n.t('vlm_prompt'))
                    logger.debug(f"VLM response: {vlm_result}")
                    if vlm_result and 'error' not in vlm_result:
                        self._update_image_vlm(image_id, vlm_result)
                except Exception as e:
                    logger.warning(f"VLM enrichment failed: {e}")
            elif skip_vlm:
                logger.debug("  ⏭️  skip_vlm=True — VLM enrichment skipped")
            else:
                logger.debug("VLM provider not enabled, skipping enrichment")
            
            # Update processing status
            conn = self._get_connection()
            conn.execute("UPDATE images SET processed = 1 WHERE id = ?", (image_id,))
            conn.commit()
            conn.close()
            logger.debug(f"Marked image {image_id} as processed")

            # Update statistics
            self.stats['images_processed'] += 1
            self.stats['faces_detected'] += len(faces)
            self.stats['faces_recognized'] += sum(1 for r in recognitions_by_face if r and r.verified)
            
            # Build result
            result = {
                'success': True,
                'image_id': image_id,
                'filepath': image_path,
                'metadata': asdict(metadata),
                'face_count': len(faces),
                'faces': [],
                'vlm_result': vlm_result
            }
            
            for face, recognition in zip(faces, recognitions_by_face):
                face_result = {
                    'bbox': asdict(face.bbox),
                    'confidence': face.detection_confidence,
                    'quality': face.quality,
                    'age': face.age,
                    'gender': face.gender,
                    'recognition': asdict(recognition) if recognition else None
                }
                result['faces'].append(face_result)
            
            return result
        
        except Exception as e:
            logger.error(f"Failed to process image {image_path}: {e}", exc_info=True)
            self.stats['errors'] += 1
            return {
                'success': False,
                'error': str(e),
                'filepath': image_path
            }
    
    def _store_image(self, filepath: str, metadata: ImageMetadata, 
                    image_blob: Optional[np.ndarray], thumbnail_blob: Optional[bytes]) -> int:
        """Store image in database with retry on lock."""
        
        def store_operation():
            conn = None
            try:
                conn = self._get_connection()
                cursor = conn.cursor()

                # Convert image to blob if needed
                image_data = None
                if image_blob is not None:
                    _, buffer = cv2.imencode('.jpg', image_blob, [cv2.IMWRITE_JPEG_QUALITY, 85])
                    image_data = buffer.tobytes()

                cursor.execute("""
                    INSERT INTO images (
                        filepath, filename, file_hash, file_size,
                        width, height, format,
                        image_blob, thumbnail_blob,
                        taken_at, location_lat, location_lng,
                        camera_make, camera_model,
                        iso, aperture, shutter_speed, focal_length,
                        processed, face_count, processed_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, CURRENT_TIMESTAMP)
                """, (
                    filepath,
                    Path(filepath).name,
                    metadata.file_hash,
                    metadata.file_size,
                    metadata.width,
                    metadata.height,
                    metadata.format,
                    image_data,
                    thumbnail_blob,
                    metadata.taken_at,
                    metadata.location[0] if metadata.location else None,
                    metadata.location[1] if metadata.location else None,
                    metadata.camera_make,
                    metadata.camera_model,
                    metadata.iso,
                    metadata.aperture,
                    metadata.shutter_speed,
                    metadata.focal_length,
                ))

                image_id = cursor.lastrowid
                conn.commit()
                return image_id

            except sqlite3.IntegrityError as _ie:
                # Constraint violation — could be UNIQUE on filepath OR on file_hash
                # (if the schema migration to a composite index hasn't run yet on this server).
                # Use a fresh connection for the recovery SELECT to avoid stale tx state.
                logger.warning(f"_store_image IntegrityError for {filepath}: {_ie}")
                _rc = None
                try:
                    _rc = sqlite3.connect(self.db_path, timeout=10.0)
                    # Try filepath first (the most common case)
                    _row = _rc.execute(
                        "SELECT id FROM images WHERE filepath = ?", (filepath,)
                    ).fetchone()
                    if _row:
                        return _row[0]
                    # Fall back to file_hash match (old schema: file_hash TEXT UNIQUE)
                    if metadata.file_hash:
                        _row = _rc.execute(
                            "SELECT id FROM images WHERE file_hash = ?", (metadata.file_hash,)
                        ).fetchone()
                        if _row:
                            return _row[0]
                    return None
                except Exception as _re:
                    logger.error(f"Recovery SELECT failed: {_re}")
                    return None
                finally:
                    if _rc:
                        _rc.close()

            except Exception as e:
                logger.error(f"Failed to store image: {e}")
                raise

            finally:
                if conn:
                    conn.close()
        
        # Use retry wrapper for database locks
        return self._execute_with_retry(store_operation)


    def _store_faces(self, image_id: int, faces: List[Face], recognitions: List[Optional[Recognition]]):
        """Store faces and embeddings in database with retry on lock."""
        
        def store_operation():
            conn = None
            try:
                conn = self._get_connection()
                cursor = conn.cursor()

                # Use BEGIN IMMEDIATE to get write lock upfront
                cursor.execute("BEGIN IMMEDIATE")

                for face, recognition in zip(faces, recognitions):
                    # Insert face
                    cursor.execute("""
                        INSERT INTO faces (
                            image_id, bbox_top, bbox_right, bbox_bottom, bbox_left,
                            detection_confidence, face_quality,
                            estimated_age, estimated_gender
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, (
                        image_id,
                        face.bbox.top, face.bbox.right, face.bbox.bottom, face.bbox.left,
                        face.detection_confidence,
                        face.quality,
                        face.age,
                        face.gender
                    ))

                    face_id = cursor.lastrowid

                    # Insert embedding
                    if face.embedding is not None:
                        embedding_blob = face.embedding.tobytes()

                        # CRITICAL FIX: Handle None values properly
                        if recognition and recognition.confidence is not None:
                            rec_confidence = float(recognition.confidence)
                            rec_verified = bool(recognition.verified)
                            # Only assign person_id when confidence meets threshold (verified=True)
                            person_id = recognition.person_id if recognition.verified else None
                        else:
                            rec_confidence = 0.0
                            rec_verified = False
                            person_id = None

                        # Ensure confidence is in valid range [0, 1]
                        rec_confidence = max(0.0, min(1.0, rec_confidence))

                        cursor.execute("""
                            INSERT INTO face_embeddings (
                                face_id, person_id, embedding_vector, embedding_dimension,
                                recognition_confidence, verified,
                                embedding_model
                            ) VALUES (?, ?, ?, ?, ?, ?, ?)
                        """, (
                            face_id,
                            person_id,
                            embedding_blob,
                            len(face.embedding),
                            rec_confidence,
                            rec_verified,
                            self.config.model
                        ))

                # Mark as fully processed — atomic with the face data.
                # processed=1 is only set here; a crash before this point leaves
                # processed=0 so the image is retried on the next run.
                cursor.execute("""
                    UPDATE images SET face_count = ?, processed = 1 WHERE id = ?
                """, (len(faces), image_id))

                conn.commit()
                return True

            except Exception as e:
                logger.error(f"Failed to store faces: {e}")
                if conn:
                    conn.rollback()
                raise

            finally:
                if conn:
                    conn.close()
        
        # Use retry wrapper for database locks
        self._execute_with_retry(store_operation)
    
    def _build_cached_result(self, image_id: int, image_path: str) -> Dict[str, Any]:
        """
        Build a full result dict from already-stored DB data.
        Used when process_image detects a duplicate so callers still get
        face bboxes, recognition names, and any saved VLM data.
        """
        conn = self._get_connection()
        try:
            img_row = conn.execute(
                "SELECT face_count, ai_description, ai_scene_type, ai_tags FROM images WHERE id = ?",
                (image_id,)
            ).fetchone()

            face_rows = conn.execute("""
                SELECT
                    f.bbox_top, f.bbox_right, f.bbox_bottom, f.bbox_left,
                    f.detection_confidence, f.face_quality,
                    f.estimated_age, f.estimated_gender,
                    fe.person_id, fe.recognition_confidence, fe.verified,
                    p.name as person_name
                FROM faces f
                LEFT JOIN face_embeddings fe ON f.id = fe.face_id
                LEFT JOIN people p ON fe.person_id = p.id
                WHERE f.image_id = ?
            """, (image_id,)).fetchall()
        finally:
            conn.close()

        faces = []
        for row in face_rows:
            faces.append({
                'bbox': {
                    'top': row['bbox_top'], 'right': row['bbox_right'],
                    'bottom': row['bbox_bottom'], 'left': row['bbox_left'],
                },
                'confidence': row['detection_confidence'],
                'quality': row['face_quality'],
                'age': row['estimated_age'],
                'gender': row['estimated_gender'],
                'recognition': {
                    'person_id': row['person_id'],
                    'person_name': row['person_name'],
                    'confidence': row['recognition_confidence'] or 0.0,
                    'distance': 0.0,
                    'verified': bool(row['verified']),
                } if row['person_id'] else None,
            })

        vlm_result = None
        if img_row and img_row['ai_description']:
            vlm_result = {
                'description': img_row['ai_description'],
                'scene_type': img_row['ai_scene_type'] or 'unknown',
                'tags': json.loads(img_row['ai_tags'] or '[]'),
            }

        return {
            'success': True,
            'image_id': image_id,
            'filepath': image_path,
            'face_count': img_row['face_count'] if img_row else len(faces),
            'faces': faces,
            'vlm_result': vlm_result,
            'skipped': True,
        }

    def _update_image_vlm(self, image_id: int, vlm_result: Dict):
        """Update image with VLM enrichment data."""
        try:
            conn = self._get_connection()
            
            tags_json = json.dumps(vlm_result.get('tags', []))
            
            conn.execute("""
                UPDATE images
                SET ai_description = ?,
                    ai_scene_type = ?,
                    ai_tags = ?,
                    ai_confidence = 1.0
                WHERE id = ?
            """, (
                vlm_result.get('description'),
                vlm_result.get('scene_type'),
                tags_json,
                image_id
            ))
            
            conn.commit()
            conn.close()
        
        except Exception as e:
            logger.error(f"Failed to update VLM data: {e}")
    
    def _load_image(self, image_path: str) -> Optional[np.ndarray]:
        """
        Load image in BGR format with correct EXIF orientation applied.

        cv2.imread ignores the EXIF orientation tag, so smartphone photos
        (Samsung, Apple, etc.) appear rotated/flipped.  We always load via
        PIL and call ImageOps.exif_transpose() which bakes the rotation into
        the pixel data before we hand it to InsightFace.
        """
        try:
            ext = Path(image_path).suffix.lower()

            # Reject video files early
            if ext in {'.webm', '.mp4', '.avi', '.mov', '.mkv'}:
                logger.error(f"Cannot process video file as image: {image_path}")
                return None

            # ── Primary path: PIL + EXIF transpose ──────────────────────────
            # PIL reads EXIF orientation and ImageOps.exif_transpose() rotates
            # the pixel buffer so the image is always right-side-up.
            try:
                from PIL import Image as PILImage, ImageOps
                with PILImage.open(image_path) as pil_img:
                    pil_img = ImageOps.exif_transpose(pil_img)  # apply EXIF rotation
                    pil_img = pil_img.convert('RGB')
                    img = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
                return img
            except Exception as pil_err:
                logger.warning(f"PIL load failed for {image_path}: {pil_err} — falling back to cv2")

            # ── Fallback: cv2 (no EXIF correction) ──────────────────────────
            img = cv2.imread(image_path, cv2.IMREAD_UNCHANGED)
            if img is None:
                logger.error(f"Both PIL and cv2 failed to load: {image_path}")
                return None

            # Normalise channels
            if len(img.shape) == 2:
                img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
            elif img.shape[2] == 4:
                img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)

            logger.warning(f"Loaded without EXIF correction (cv2 fallback): {image_path}")
            return img

        except Exception as e:
            logger.error(f"Error loading image {image_path}: {e}")
            return None

    def train_person(self, person_name: str, image_paths: List[str]) -> Tuple[bool, str, Dict]:
        """
        Train system to recognize a person.
        
        Args:
            person_name: Name of the person
            image_paths: List of training image paths
        
        Returns:
            (success, message, details)
        """
        try:
            if not person_name or not person_name.strip():
                return False, "Person name cannot be empty", {}
            
            if not image_paths:
                return False, "No training images provided", {}
            
            person_name = person_name.strip()
            
            logger.info(f"=== Training '{person_name}' with {len(image_paths)} images ===")
            
            # Check if person exists
            conn = self._get_connection()
            try:
                cursor = conn.execute("SELECT id FROM people WHERE name = ?", (person_name,))
                row = cursor.fetchone()

                if row:
                    person_id = row['id']
                    logger.info(f"Person '{person_name}' already exists (ID: {person_id})")
                else:
                    # Create person
                    cursor = conn.execute("INSERT INTO people (name) VALUES (?)", (person_name,))
                    person_id = cursor.lastrowid
                    conn.commit()
                    logger.info(f"Created person '{person_name}' (ID: {person_id})")
            finally:
                conn.close()
            
            # Process training images
            embeddings = []
            processed_images = 0
            failed_images = 0
            total_faces = 0
            
            for idx, image_path in enumerate(image_paths, 1):
                try:
                    # Get filename for logging
                    filename = Path(image_path).name
                    logger.info(f"[{idx}/{len(image_paths)}] Processing: {filename}")
                    
                    # Load image with proper format handling
                    image = self._load_image(image_path)
                    
                    if image is None:
                        logger.warning(f"  ❌ Failed to load image: {filename}")
                        failed_images += 1
                        continue
                    
                    # Log image dimensions
                    h, w = image.shape[:2]
                    channels = image.shape[2] if len(image.shape) == 3 else 1
                    logger.info(f"  📐 Dimensions: {w}x{h} pixels, {channels} channels")
                    
                    # Check if image is too small
                    min_dim = min(h, w)
                    if min_dim < 480:
                        logger.info(f"  ⚠️  Small image detected (min dim: {min_dim}px) - upscaling recommended")
                    
                    # Detect faces
                    faces = self.detect_faces(image)
                    total_faces += len(faces)
                    
                    logger.info(f"  👤 Detected {len(faces)} face(s)")
                    
                    if not faces:
                        logger.warning(f"  ❌ No faces detected in: {filename}")
                        failed_images += 1
                        continue
                    
                    # Log face details
                    for i, face in enumerate(faces, 1):
                        logger.debug(f"    Face {i}: confidence={face.detection_confidence:.3f}, quality={face.quality:.3f}")
                    
                    # Use first face (assume single person per training image)
                    face = faces[0]
                    
                    if face.embedding is not None:
                        logger.info(f"  ✅ Embedding extracted: {len(face.embedding)}D vector")
                        embeddings.append(face.embedding)
                        processed_images += 1
                    else:
                        logger.warning(f"  ❌ No embedding extracted from: {filename}")
                        failed_images += 1
                
                except Exception as e:
                    logger.error(f"  ❌ Failed to process training image {Path(image_path).name}: {e}")
                    failed_images += 1
            
            # Summary of processing
            logger.info(f"=== Processing Summary ===")
            logger.info(f"  Processed: {processed_images}/{len(image_paths)} images")
            logger.info(f"  Failed: {failed_images}/{len(image_paths)} images")
            logger.info(f"  Total faces: {total_faces}")
            logger.info(f"  Valid embeddings: {len(embeddings)}")
            
            if not embeddings:
                error_msg = f"No valid embeddings extracted from training images (processed: {processed_images}, failed: {failed_images})"
                logger.error(f"  ❌ {error_msg}")
                return False, error_msg, {
                    'processed_images': processed_images,
                    'failed_images': failed_images,
                    'total_faces': total_faces
                }
            
            # Store embeddings in database with retry
            logger.info(f"=== Storing {len(embeddings)} embeddings in database ===")

            def store_embeddings():
                conn = self._get_connection()
                try:
                    cursor = conn.cursor()
                    cursor.execute("BEGIN IMMEDIATE")
                    
                    # CRITICAL FIX: Create dummy training image if it doesn't exist
                    cursor.execute("SELECT id FROM images WHERE id = -1")
                    if not cursor.fetchone():
                        cursor.execute("""
                            INSERT INTO images (id, filepath, filename, processed, face_count, created_at)
                            VALUES (-1, '__training__', '__training__', 1, 0, CURRENT_TIMESTAMP)
                        """)
                        logger.debug("  Created dummy training image (id=-1)")
                    
                    for i, embedding in enumerate(embeddings, 1):
                        embedding_blob = embedding.tobytes()
                        
                        # Use dummy image_id = -1 for training faces
                        cursor.execute("""
                            INSERT INTO faces (
                                image_id, bbox_top, bbox_right, bbox_bottom, bbox_left,
                                detection_confidence, face_quality
                            ) VALUES (-1, 0, 1, 1, 0, 1.0, 1.0)
                        """)
                        
                        face_id = cursor.lastrowid
                        
                        cursor.execute("""
                            INSERT INTO face_embeddings (
                                face_id, person_id, embedding_vector, embedding_dimension,
                                verified, verification_method, embedding_model
                            ) VALUES (?, ?, ?, ?, 1, 'training', ?)
                        """, (
                            face_id,
                            person_id,
                            embedding_blob,
                            len(embedding),
                            self.config.model
                        ))
                        
                        logger.debug(f"  Stored embedding {i}/{len(embeddings)}")
                    
                    conn.commit()
                    return True
                except Exception:
                    conn.rollback()
                    raise
                finally:
                    conn.close()

            # Execute with retry
            self._execute_with_retry(store_embeddings)
            logger.info(f"✅ Database updated with {len(embeddings)} embeddings")
            
            # Reload FAISS index
            logger.info("=== Reloading FAISS index ===")
            self._load_faiss_index()
            logger.info(f"✅ FAISS index reloaded: {self.faiss_index.ntotal if self.faiss_index else 0} total vectors")
            
            message = f"Successfully trained '{person_name}' with {len(embeddings)} embeddings"
            details = {
                'person_id': person_id,
                'person_name': person_name,
                'embeddings_count': len(embeddings),
                'processed_images': processed_images,
                'failed_images': failed_images,
                'total_faces': total_faces
            }
            
            logger.info(f"=== Training Complete ===")
            logger.info(f"  {message}")
            logger.info(f"  Person ID: {person_id}")
            logger.info(f"  Success rate: {processed_images}/{len(image_paths)} ({100*processed_images/len(image_paths):.1f}%)")
            
            return True, message, details
        
        except Exception as e:
            logger.error(f"❌ Training failed for '{person_name}': {e}", exc_info=True)
            return False, f"Training failed: {str(e)}", {}
    
    def search_images_by_person(self, person_name: str, max_results: int = 50) -> List[Dict]:
        """
        Search for images containing a specific person.
        Supports partial name matching (substring search).

        Args:
            person_name: Name (or partial name) of person to search for
            max_results: Maximum number of results

        Returns:
            List of image results
        """
        try:
            conn = self._get_connection()

            cursor = conn.execute("""
                SELECT DISTINCT
                    i.id, i.filepath, i.filename, i.taken_at,
                    i.face_count, i.ai_description, i.ai_tags,
                    fe.recognition_confidence
                FROM images i
                JOIN faces f ON i.id = f.image_id
                JOIN face_embeddings fe ON f.id = fe.face_id
                JOIN people p ON fe.person_id = p.id
                WHERE p.name LIKE ? AND fe.verified = 1
                ORDER BY i.taken_at DESC, fe.recognition_confidence DESC
                LIMIT ?
            """, (f'%{person_name}%', max_results))
            
            results = []
            for row in cursor.fetchall():
                results.append({
                    'id': row['id'],
                    'filepath': row['filepath'],
                    'filename': row['filename'],
                    'taken_at': row['taken_at'],
                    'face_count': row['face_count'],
                    'description': row['ai_description'],
                    'tags': json.loads(row['ai_tags']) if row['ai_tags'] else [],
                    'confidence': row['recognition_confidence']
                })
            
            conn.close()
            return results
        
        except Exception as e:
            logger.error(f"Image search failed: {e}")
            return []
    
    def get_statistics(self) -> Dict[str, Any]:
        """Get system statistics."""
        try:
            conn = self._get_connection()
            
            stats = {}
            
            # People count
            cursor = conn.execute("SELECT COUNT(*) as count FROM people")
            stats['total_people'] = cursor.fetchone()['count']
            
            # Images count
            cursor = conn.execute("SELECT COUNT(*) as count, SUM(processed) as processed FROM images")
            row = cursor.fetchone()
            stats['total_images'] = row['count']
            stats['processed_images'] = row['processed'] or 0
            
            # Faces count
            cursor = conn.execute("SELECT COUNT(*) as count FROM faces")
            stats['total_faces'] = cursor.fetchone()['count']
            
            # Identified vs unknown
            cursor = conn.execute("""
                SELECT 
                    SUM(CASE WHEN person_id IS NOT NULL AND verified = 1 THEN 1 ELSE 0 END) as identified,
                    SUM(CASE WHEN person_id IS NULL OR verified = 0 THEN 1 ELSE 0 END) as unknown
                FROM face_embeddings
            """)
            row = cursor.fetchone()
            stats['identified_faces'] = row['identified'] or 0
            stats['unknown_faces'] = row['unknown'] or 0
            
            # Top people
            cursor = conn.execute("""
                SELECT p.name, COUNT(*) as count
                FROM people p
                JOIN face_embeddings fe ON p.id = fe.person_id
                WHERE fe.verified = 1
                GROUP BY p.id
                ORDER BY count DESC
                LIMIT 10
            """)
            stats['top_people'] = [{'name': row['name'], 'count': row['count']} for row in cursor.fetchall()]
            
            # FAISS index info
            if self.faiss_index:
                stats['faiss_vectors'] = self.faiss_index.ntotal
                stats['faiss_dimension'] = self.faiss_index.d
            else:
                stats['faiss_vectors'] = 0
                stats['faiss_dimension'] = 0
            
            # Configuration
            stats['backend'] = self.config.backend
            stats['model'] = self.config.model
            stats['detection_threshold'] = self.config.detection_threshold
            stats['recognition_threshold'] = self.config.recognition_threshold
            
            # Processing stats
            stats.update(self.stats)
            
            conn.close()
            return stats
        
        except Exception as e:
            logger.error(f"Failed to get statistics: {e}")
            return {}

    def get_all_people(self) -> List[Dict[str, Any]]:
        """Get list of all people in database."""
        try:
            conn = self._get_connection()
            cursor = conn.execute("""
                SELECT id, name, total_appearances, first_seen, last_seen, created_at
                FROM people
                ORDER BY name
            """)
            
            people = []
            for row in cursor.fetchall():
                people.append({
                    'id': row['id'],
                    'name': row['name'],
                    'appearances': row['total_appearances'],
                    'first_seen': row['first_seen'],
                    'last_seen': row['last_seen'],
                    'created_at': row['created_at']
                })
            
            conn.close()
            return people
        
        except Exception as e:
            logger.error(f"Failed to get people list: {e}")
            return []

    # ── Manual face helpers ───────────────────────────────────────────────────

    def _bbox_iou(self, a: 'BoundingBox', b: 'BoundingBox') -> float:
        """IoU between two normalized BoundingBox objects."""
        inter_top    = max(a.top,    b.top)
        inter_left   = max(a.left,   b.left)
        inter_bottom = min(a.bottom, b.bottom)
        inter_right  = min(a.right,  b.right)
        if inter_bottom <= inter_top or inter_right <= inter_left:
            return 0.0
        inter_area = (inter_bottom - inter_top) * (inter_right - inter_left)
        a_area = (a.bottom - a.top) * (a.right - a.left)
        b_area = (b.bottom - b.top) * (b.right - b.left)
        union_area = a_area + b_area - inter_area
        return inter_area / union_area if union_area > 0 else 0.0

    def _detect_face_near_bbox(self, image: np.ndarray, target_bbox: 'BoundingBox',
                               det_thresh: float = 0.05) -> Optional['Face']:
        """
        Run detection on the full image at a very low threshold and return the
        detected face whose bbox overlaps most with *target_bbox* (IoU > 0.1).
        Returns None if nothing suitable is found.
        """
        try:
            all_faces = self.detect_faces(image, det_thresh=det_thresh, min_face_size=10)
            if not all_faces:
                return None
            best_face, best_iou = None, 0.0
            for f in all_faces:
                iou = self._bbox_iou(f.bbox, target_bbox)
                if iou > best_iou:
                    best_iou = iou
                    best_face = f
            if best_face and best_iou > 0.1:
                logger.info(f"Full-image fallback found face with IoU={best_iou:.3f} at det_thresh={det_thresh}")
                return best_face
        except Exception as e:
            logger.warning(f"Full-image face fallback failed: {e}")
        return None

    def _extract_embedding_from_crop(self, crop: np.ndarray) -> Optional[np.ndarray]:
        """
        Extract a face embedding directly from a BGR crop by feeding it to
        InsightFace's ArcFace recognition model, bypassing the detector.
        The crop is resized to 112×112 (standard ArcFace input); no landmark
        alignment is performed, so the embedding quality is lower than normal
        but still usable for basic identity assignment.
        """
        try:
            if self.config.backend != FaceRecognitionConfig.BACKEND_INSIGHTFACE:
                return None
            if self.face_analyzer is None:
                return None
            rec_model = getattr(self.face_analyzer, 'models', {}).get('recognition')
            if rec_model is None:
                logger.warning("No 'recognition' model found in face_analyzer.models — cannot extract direct embedding")
                return None
            aligned = cv2.resize(crop, (112, 112))
            feat = rec_model.get_feat([aligned])   # returns ndarray (1, dim)
            if feat is None or len(feat) == 0:
                return None
            embedding = feat[0].astype(np.float32)
            norm = np.linalg.norm(embedding)
            if norm > 0:
                embedding /= norm  # L2-normalise to match normed_embedding
            logger.info(f"Direct crop embedding: shape={embedding.shape}, ||e||={np.linalg.norm(embedding):.4f}")
            return embedding
        except Exception as e:
            logger.warning(f"Direct crop embedding extraction failed: {e}")
        return None

    # ── Fallback face detectors ────────────────────────────────────────────────
    # Used when InsightFace RetinaFace returns 0 confident detections.
    # Both extract embeddings via the existing ArcFace model so the vectors
    # are directly comparable with FAISS index entries.

    def _embed_crop(self, image: np.ndarray, bbox: 'BoundingBox',
                    landmarks: Optional[np.ndarray] = None) -> Optional[np.ndarray]:
        """
        Return an ArcFace embedding for the given bbox region.
        If ``landmarks`` is a (5, 2) array compatible with InsightFace's
        face_align.norm_crop, use it for proper 112×112 alignment (best
        quality).  Otherwise fall back to a simple resize.
        """
        h, w = image.shape[:2]
        if landmarks is not None:
            try:
                from insightface.utils import face_align
                aligned = face_align.norm_crop(image, landmark=landmarks, image_size=112)
                rec_model = getattr(self.face_analyzer, 'models', {}).get('recognition')
                if rec_model is not None:
                    feat = rec_model.get_feat([aligned])
                    if feat is not None and len(feat):
                        emb = feat[0].astype(np.float32)
                        norm = np.linalg.norm(emb)
                        if norm > 0:
                            emb /= norm
                        return emb
            except Exception as e:
                logger.debug(f"norm_crop alignment failed, falling back to simple crop: {e}")
        # Simple crop resize fallback
        y1, x2, y2, x1 = bbox.to_pixels(w, h)
        crop = image[y1:y2, x1:x2]
        if crop.size == 0:
            return None
        return self._extract_embedding_from_crop(crop)

    def _detect_faces_scrfd(self, image: np.ndarray, det_thresh: Optional[float] = None) -> List['Face']:
        """
        SCRFD detection via face_analyzer.get() — the full InsightFace pipeline.
        buffalo_l's det_model IS SCRFD-10G-KPS; it was trained at 640×640.
        Forcing det_size=(1920,1920) degrades confidence to near-zero because the
        anchor grid is calibrated for 640×640 input.  We therefore always start at
        640×640 and implement the same retry/scale-sweep as AUTO mode.
        """
        if not INSIGHTFACE_AVAILABLE:
            logger.warning("SCRFD: InsightFace not available")
            return []
        try:
            self._ensure_backend()
            det_model = getattr(self.face_analyzer, 'det_model', None)
            if det_model is None:
                logger.warning("SCRFD: face_analyzer.det_model not available")
                return []
            logger.info(f"  SCRFD: det_model class={type(det_model).__name__}")

            threshold = det_thresh if det_thresh is not None else self.config.detection_threshold
            orig_h, orig_w = image.shape[:2]
            NMS_FLOOR = 0.05

            def _run_at(det_size: tuple, thresh: float, img: np.ndarray) -> List['Face']:
                """Run one SCRFD pass at the given det_size and confidence floor."""
                det_model.input_size = det_size
                if hasattr(det_model, 'det_thresh'):
                    det_model.det_thresh = NMS_FLOOR
                raw = self.face_analyzer.get(img)
                img_h, img_w = img.shape[:2]
                logger.info(
                    f"  SCRFD det_size={det_size} img={img_w}×{img_h}: "
                    f"{len(raw)} raw candidates, filtering at thresh={thresh:.2f}"
                )
                results = []
                for i, face in enumerate(raw):
                    bp = face.bbox.astype(int)
                    x1, y1, x2, y2 = bp[0], bp[1], bp[2], bp[3]
                    conf = float(face.det_score)
                    if conf < thresh:
                        logger.info(f"    candidate {i}: score={conf:.4f} < {thresh:.2f} — skipped")
                        continue
                    norm_bbox = BoundingBox(
                        top=max(0.0, y1 / img_h), right=min(1.0, x2 / img_w),
                        bottom=min(1.0, y2 / img_h), left=max(0.0, x1 / img_w),
                    )
                    if not norm_bbox.is_valid():
                        continue
                    embedding = None
                    if face.embedding is not None:
                        _e = face.embedding / (np.linalg.norm(face.embedding) + 1e-8)
                        if np.any(_e):
                            embedding = _e
                    # For downscaled passes prefer a crop from the full-res original
                    if img is not image:
                        embedding = self._embed_crop(image, norm_bbox) or embedding
                    if embedding is None:
                        embedding = self._embed_crop(img, norm_bbox)
                    if embedding is None:
                        continue
                    kps = getattr(face, 'kps', None)
                    lm = np.array(kps, dtype=np.float32) if kps is not None else None
                    logger.info(f"    candidate {i}: score={conf:.4f}  bbox=[{x1},{y1},{x2},{y2}]  ✓")
                    results.append(Face(
                        bbox=norm_bbox,
                        detection_confidence=conf,
                        embedding=embedding,
                        quality=conf,
                        landmarks=lm,
                    ))
                return results

            # ── Pass 1: native 640×640 at user threshold ──────────────────────
            faces = _run_at((640, 640), threshold, image)
            if faces:
                return faces

            # ── Pass 2: lower thresholds at 640×640 ───────────────────────────
            for retry_thresh in [0.30, 0.20, 0.10]:
                if retry_thresh >= threshold:
                    continue
                faces = _run_at((640, 640), retry_thresh, image)
                if faces:
                    logger.info(f"  SCRFD: found {len(faces)} face(s) at thresh={retry_thresh:.2f}")
                    return faces

            # ── Pass 3: scale-retry (downsample image) ─────────────────────────
            for scale in [0.75, 0.50]:
                sh, sw = int(orig_h * scale), int(orig_w * scale)
                scaled = cv2.resize(image, (sw, sh), interpolation=cv2.INTER_AREA)
                logger.info(f"  SCRFD scale-retry at {int(scale*100)}% ({sw}×{sh}px)")
                for retry_thresh in [0.20, 0.10]:
                    faces = _run_at((640, 640), retry_thresh, scaled)
                    if faces:
                        logger.info(
                            f"  SCRFD: found {len(faces)} face(s) at scale={int(scale*100)}%"
                            f", thresh={retry_thresh:.2f}"
                        )
                        return faces

            return []
        except Exception as e:
            logger.warning(f"SCRFD detection failed: {e}")
            return []

    def _detect_faces_yunet(self, image: np.ndarray, det_thresh: Optional[float] = None) -> List['Face']:
        """
        Face detector using OpenCV YuNet (FaceDetectorYN).
        Requires OpenCV ≥ 4.5.4.  Downloads the model file on first use.
        Returns Face objects with ArcFace embeddings (5-point landmark aligned).
        """
        if not YUNET_AVAILABLE:
            return []
        try:
            import urllib.request
            YUNET_URL = (
                'https://github.com/opencv/opencv_zoo/raw/main/'
                'models/face_detection_yunet/face_detection_yunet_2023mar.onnx'
            )
            model_path = Path(self.db_path).parent / 'face_detection_yunet_2023mar.onnx'
            if not model_path.exists():
                logger.info(f"Downloading YuNet model → {model_path}")
                urllib.request.urlretrieve(YUNET_URL, str(model_path))

            threshold = det_thresh if det_thresh is not None else self.config.detection_threshold

            h, w = image.shape[:2]

            # YuNet works best at ≤1920px on the long edge.
            # Full-res images (e.g. 7334×4892) produce many false positives because
            # the model scans too wide a scale range.  Downsample for detection,
            # then scale pixel bboxes back to original coords for embedding.
            MAX_YN_DIM = 1920
            scale = 1.0
            det_image = image
            if max(h, w) > MAX_YN_DIM:
                scale = MAX_YN_DIM / max(h, w)
                new_w, new_h = int(w * scale), int(h * scale)
                det_image = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_AREA)
                logger.info(f"  YuNet: downsampled {w}×{h} → {new_w}×{new_h} for detection")

            dh, dw = det_image.shape[:2]
            detector = cv2.FaceDetectorYN.create(
                str(model_path), '', (dw, dh),
                score_threshold=threshold, nms_threshold=0.3, top_k=100,
            )
            _, results = detector.detect(det_image)
            if results is None or len(results) == 0:
                return []

            faces = []
            for det in results:
                # det layout: [x, y, bw, bh, re_x, re_y, le_x, le_y,
                #              nose_x, nose_y, rm_x, rm_y, lm_x, lm_y, score]
                x, y, bw, bh = float(det[0]), float(det[1]), float(det[2]), float(det[3])
                score = float(det[14])
                # Scale coords back to original image resolution
                inv = 1.0 / scale
                bbox = BoundingBox(
                    top=max(0.0, (y * inv) / h),
                    right=min(1.0, ((x + bw) * inv) / w),
                    bottom=min(1.0, ((y + bh) * inv) / h),
                    left=max(0.0, (x * inv) / w),
                )
                if not bbox.is_valid():
                    continue
                # Scale landmarks back too
                lm = det[4:14].reshape(5, 2).astype(np.float32) * inv
                embedding = self._embed_crop(image, bbox, landmarks=lm)
                if embedding is None:
                    continue
                faces.append(Face(
                    bbox=bbox,
                    detection_confidence=score,
                    embedding=embedding,
                    quality=score,
                ))
            logger.info(f"  YuNet: {len(faces)} face(s) found (score_threshold={threshold:.2f})")
            return faces
        except Exception as e:
            logger.warning(f"YuNet detection failed: {e}")
            return []

    def _detect_faces_mediapipe(self, image: np.ndarray, det_thresh: Optional[float] = None) -> List['Face']:
        """
        Face detector using the MediaPipe Tasks API (mediapipe ≥ 0.10).
        Uses the blaze_face_short_range.tflite model downloaded on first use.
        Bounding boxes from the Tasks API are in pixel coords of the input image.
        """
        if not MEDIAPIPE_AVAILABLE:
            return []
        try:
            import mediapipe as mp
            import tempfile, os
            h, w = image.shape[:2]
            threshold = det_thresh if det_thresh is not None else self.config.detection_threshold
            # Use a very low floor so we can see EVERYTHING the model finds;
            # we apply the real threshold ourselves in detect_faces().
            min_conf = max(0.05, min(0.9, float(threshold)))

            # BlazeFace works best at ≤1920px — downsample large images.
            MAX_MP_DIM = 1920
            det_image = image
            if max(h, w) > MAX_MP_DIM:
                scale = MAX_MP_DIM / max(h, w)
                new_w, new_h = int(w * scale), int(h * scale)
                det_image = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_AREA)
                logger.info(f"  MediaPipe: downsampled {w}×{h} → {new_w}×{new_h}")
            dh, dw = det_image.shape[:2]

            # Download/re-download tflite model (re-download if file is too small = truncated)
            model_path = Path(self.db_path).parent / 'blaze_face_short_range.tflite'
            EXPECTED_MIN_BYTES = 800_000   # real file is ~2.8 MB; <800 KB means corrupt
            needs_download = (
                not model_path.exists()
                or model_path.stat().st_size < EXPECTED_MIN_BYTES
            )
            if needs_download:
                import urllib.request
                url = ('https://storage.googleapis.com/mediapipe-models/'
                       'face_detector/blaze_face_short_range/float16/1/'
                       'blaze_face_short_range.tflite')
                logger.info(f"  MediaPipe: downloading model → {model_path}")
                urllib.request.urlretrieve(url, str(model_path))

            model_bytes = model_path.stat().st_size
            logger.info(
                f"  MediaPipe: model={model_path.name} ({model_bytes:,} B), "
                f"img={dw}×{dh}, min_conf={min_conf:.2f}"
            )

            # Tasks API (mediapipe ≥ 0.10)
            from mediapipe.tasks import python as _mp_py
            from mediapipe.tasks.python import vision as _mp_vis

            # Write detection image to a temp file and use create_from_file() —
            # this matches the official example exactly and avoids any numpy-array
            # format/contiguity issues with the mp.Image() constructor.
            # Keep the temp file alive until after detector.detect() returns.
            tmp_path = None
            result = None
            try:
                with tempfile.NamedTemporaryFile(suffix='.jpg', delete=False) as tmp:
                    tmp_path = tmp.name
                from PIL import Image as _PILImage
                rgb = cv2.cvtColor(det_image, cv2.COLOR_BGR2RGB)
                _PILImage.fromarray(rgb).save(tmp_path, 'JPEG', quality=95)

                mp_image = mp.Image.create_from_file(tmp_path)

                base_opts = _mp_py.BaseOptions(model_asset_path=str(model_path))
                opts = _mp_vis.FaceDetectorOptions(
                    base_options=base_opts,
                    min_detection_confidence=min_conf,
                )
                detector = _mp_vis.FaceDetector.create_from_options(opts)
                try:
                    result = detector.detect(mp_image)
                finally:
                    detector.close()
            finally:
                if tmp_path:
                    try:
                        os.unlink(tmp_path)
                    except OSError:
                        pass

            n_raw = len(result.detections) if result and result.detections else 0
            logger.info(f"  MediaPipe: {n_raw} raw detection(s) (min_conf={min_conf:.2f})")
            if not n_raw:
                return []

            faces = []
            for det in result.detections:
                bb = det.bounding_box          # pixel coords in det_image space
                x1 = max(0.0, bb.origin_x / dw)
                y1 = max(0.0, bb.origin_y / dh)
                x2 = min(1.0, (bb.origin_x + bb.width) / dw)
                y2 = min(1.0, (bb.origin_y + bb.height) / dh)
                face_bbox = BoundingBox(top=y1, right=x2, bottom=y2, left=x1)
                if not face_bbox.is_valid():
                    continue
                score = float(det.categories[0].score) if det.categories else 0.5
                # Embed from the original full-res image for best quality
                embedding = self._embed_crop(image, face_bbox)
                if embedding is None:
                    continue
                faces.append(Face(
                    bbox=face_bbox,
                    detection_confidence=score,
                    embedding=embedding,
                    quality=score,
                ))
            logger.info(f"  MediaPipe: {len(faces)} face(s) accepted")
            return faces
        except Exception as e:
            logger.warning(f"MediaPipe detection failed: {e}", exc_info=True)
            return []

    def add_manual_face(self, image_id: int, bbox_dict: Dict[str, float], rec_thresh: Optional[float] = None) -> Dict[str, Any]:
        """
        Manually add a face detection for an image.
        bbox_dict: {top, right, bottom, left} (0-1)
        """
        try:
            conn = self._get_connection()
            row = conn.execute("SELECT filepath FROM images WHERE id = ?", (image_id,)).fetchone()
            if not row:
                conn.close()
                return {'success': False, 'error': 'Image not found'}
            filepath = row['filepath']
            conn.close()

            image = self._load_image(filepath)
            if image is None:
                return {'success': False, 'error': 'Failed to load image'}

            bbox = BoundingBox(**bbox_dict)
            h, w = image.shape[:2]
            y1, x2, y2, x1 = bbox.to_pixels(w, h)

            # Crop image to the bbox (with some padding for the analyzer)
            pad_h = int((y2 - y1) * 0.2)
            pad_w = int((x2 - x1) * 0.2)
            cy1, cy2 = max(0, y1 - pad_h), min(h, y2 + pad_h)
            cx1, cx2 = max(0, x1 - pad_w), min(w, x2 + pad_w)
            crop = image[cy1:cy2, cx1:cx2]

            # Strategy 1: detect in the padded crop at a very low threshold
            faces = self.detect_faces(crop, det_thresh=0.1, min_face_size=5)

            if not faces:
                logger.warning(f"Crop detection failed for image {image_id} — trying full-image fallback")
                # Strategy 2: run on the full image at an even lower threshold and
                # pick the face that best overlaps the user-drawn bbox
                face = self._detect_face_near_bbox(image, bbox, det_thresh=0.3)
                if face is None:
                    # Strategy 3: feed the crop directly to the ArcFace model (no alignment)
                    logger.warning(f"Full-image fallback also failed — extracting embedding from crop directly")
                    embedding = self._extract_embedding_from_crop(crop)
                    if embedding is not None:
                        logger.info(f"Direct crop embedding succeeded for image {image_id}")
                    else:
                        logger.warning(f"All embedding strategies failed for image {image_id} — "
                                       f"face stored without embedding and won't be used for recognition")
                    face = Face(bbox=bbox, detection_confidence=1.0, quality=0.5, embedding=embedding)
            else:
                # Use the best face in the crop, but adjust its bbox back to original image coordinates
                face = faces[0]
                ch, cw = crop.shape[:2]
                f_y1, f_x2, f_y2, f_x1 = face.bbox.to_pixels(cw, ch)
                # Map back
                face.bbox = BoundingBox(
                    top=(cy1 + f_y1) / h,
                    right=(cx1 + f_x2) / w,
                    bottom=(cy1 + f_y2) / h,
                    left=(cx1 + f_x1) / w
                )

            # Recognize
            recognitions = self.recognize_face(face, top_k=1, rec_thresh=rec_thresh)
            recognition = recognitions[0] if recognitions else None

            # Store
            self._store_faces(image_id, [face], [recognition])
            
            # Get the newly created face_id
            conn = self._get_connection()
            new_face = conn.execute("""
                SELECT f.id as face_id, p.name as person_name, fe.recognition_confidence
                FROM faces f
                LEFT JOIN face_embeddings fe ON f.id = fe.face_id
                LEFT JOIN people p ON fe.person_id = p.id
                WHERE f.image_id = ? 
                ORDER BY f.id DESC LIMIT 1
            """, (image_id,)).fetchone()
            conn.close()

            return {
                'success': True, 
                'face': {
                    'face_id': new_face['face_id'],
                    'bbox': bbox_dict,
                    'person_name': new_face['person_name'],
                    'recognition_confidence': new_face['recognition_confidence']
                }
            }
        except Exception as e:
            logger.error(f"add_manual_face failed: {e}", exc_info=True)
            return {'success': False, 'error': str(e)}
    