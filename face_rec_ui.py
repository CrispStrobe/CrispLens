# face_rec_ui.py - Comprehensive Gradio UI for face recognition system

# ── Logging must be configured FIRST, before any local module imports,
#    because face_recognition_core also calls logging.basicConfig().
import os
import logging

# Support for Electron app wrapper: data directory for config, DB, and logs
_DATA_DIR  = os.environ.get('FACE_REC_DATA_DIR', '')
_THUMB_DIR = os.path.join(_DATA_DIR, 'thumbnails') if _DATA_DIR else 'thumbnails'
_log_file = os.path.join(_DATA_DIR, 'face_recognition.log') if _DATA_DIR else 'face_recognition.log'

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(_log_file),
        logging.StreamHandler()
    ],
    force=True,   # override any basicConfig already set by imported modules
)
logger = logging.getLogger(__name__)

# ── Standard library & third-party imports ───────────────────────────────────
import gradio as gr
import cv2
import numpy as np
from pathlib import Path
from typing import List, Dict, Optional, Tuple, Any
import yaml
import json
from datetime import datetime
import shutil

# Import our modules
from face_recognition_core import (
    FaceRecognitionEngine, FaceRecognitionConfig,
    get_available_backends, BACKEND_EMBEDDING_DIMS,
)
from permissions import PermissionManager, User
from vlm_providers import create_vlm_provider, VLMConfig, fetch_vlm_models
from api_key_manager import ApiKeyManager, PROVIDER_CONFIGS
from folder_training import FolderTrainer
from drive_mount import DriveMount
from i18n import i18n, get_language_name
from image_ops import (
    SCENE_TYPES,
    browse_images_filtered,
    format_exif_as_markdown,
    get_all_person_names,
    get_all_scene_types,
    get_all_tags,
    get_image_record,
    load_thumbnail_pil,
    read_exif,
    rename_image as _rename_image,
    update_image_metadata as _update_image_metadata,
)

# ============================================================================
# GLOBAL STATE
# ============================================================================

class AppState:
    """Global application state."""
    
    def __init__(self):
        self.config = None
        self.engine = None
        self.permissions = None
        self.api_key_manager = None
        self.vlm_provider = None
        self.current_user = None
        self.initialized = False
    
    def initialize(self, config_path: str = None):
        """Initialize application."""
        try:
            # Resolve config path: argument > FACE_REC_DATA_DIR env > cwd
            if config_path is None:
                config_path = os.path.join(_DATA_DIR, 'config.yaml') if _DATA_DIR else 'config.yaml'

            # Load configuration
            if Path(config_path).exists():
                with open(config_path, 'r') as f:
                    config_dict = yaml.safe_load(f)
                logger.info(f"Loaded configuration from {config_path}")
            else:
                config_dict = {}
                logger.warning(f"config.yaml not found at {config_path}, using defaults")
            
            # Set language
            ui_config = config_dict.get('ui', {})
            language = ui_config.get('language', 'de')
            i18n.set_language(language)
            
            # Initialize face recognition engine
            _default_db = os.path.join(_DATA_DIR, 'face_recognition.db') if _DATA_DIR else 'face_recognition.db'
            db_path = config_dict.get('database', {}).get('path', _default_db)
            # If db_path is relative and DATA_DIR is set, anchor it to DATA_DIR
            if _DATA_DIR and not os.path.isabs(db_path):
                db_path = os.path.join(_DATA_DIR, db_path)
            face_config = FaceRecognitionConfig(config_dict.get('face_recognition', {}))
            
            self.engine = FaceRecognitionEngine(db_path, face_config)
            logger.info("Face recognition engine initialized")
            
            # Initialize permissions
            self.permissions = PermissionManager(db_path)
            logger.info("Permission manager initialized")

            # Initialize API key manager (encrypted storage)
            self.api_key_manager = ApiKeyManager(db_path)
            logger.info("API key manager initialized")

            # Auto-activate VLM if configured (use encrypted key from DB)
            vlm_config = config_dict.get('vlm', {})
            if vlm_config.get('enabled', False):
                provider = vlm_config.get('provider', 'anthropic')
                model = vlm_config.get('model') or None
                # Prefer encrypted DB key; fall back to legacy plaintext key in YAML
                api_key = self.api_key_manager.get_effective_key(provider, None)
                key_source = "encrypted DB"
                if not api_key:
                    api_key = vlm_config.get('api', {}).get('key') or None
                    key_source = "config.yaml (legacy)"
                endpoint = vlm_config.get('api', {}).get('endpoint') or None
                if api_key:
                    masked = f"****{api_key[-4:]}" if len(api_key) > 4 else "****"
                    logger.info(f"VLM startup: provider={provider}, model={model or 'default'}, "
                                f"key source={key_source}, key preview={masked}")
                else:
                    logger.warning(f"VLM startup: provider={provider} enabled but NO API key found "
                                   f"(check Settings → API Key Management)")
                self.vlm_provider = create_vlm_provider(
                    provider=provider,
                    api_key=api_key,
                    endpoint=endpoint,
                    model=model,
                    config=VLMConfig(vlm_max_size=vlm_max_size)
                )
                if self.vlm_provider:
                    logger.info(f"VLM provider auto-activated: {provider}")
                else:
                    logger.warning(f"VLM provider NOT activated for {provider} — check key and model")
            
            self.config = config_dict
            self.initialized = True
            
            return True, "✅ System initialized successfully"

        except Exception as e:
            logger.error(f"Failed to initialize application: {e}", exc_info=True)
            return False, f"❌ Initialization failed: {str(e)}"

    def get_db_stats(self) -> dict:
        """Return quick stats about the active database for UI display."""
        if not self.initialized or not self.engine:
            return {}
        try:
            import sqlite3 as _sq
            conn = _sq.connect(self.engine.db_path, timeout=3)
            face_count  = conn.execute("SELECT COUNT(*) FROM people").fetchone()[0]
            embed_count = conn.execute("SELECT COUNT(*) FROM face_embeddings").fetchone()[0]
            img_count   = conn.execute("SELECT COUNT(*) FROM images WHERE processed=1").fetchone()[0]
            conn.close()
            return {
                'path':    self.engine.db_path,
                'persons': face_count,
                'embeddings': embed_count,
                'images':  img_count,
            }
        except Exception as e:
            return {'path': getattr(self.engine, 'db_path', '?'), 'error': str(e)}

    def switch_database(self, new_path: str) -> Tuple[bool, str]:
        """
        Hot-swap the active SQLite database.
        Re-initialises the engine, permissions manager, and API key manager.
        Persists the new path to config.yaml so it survives restarts.
        Admin-only (caller must verify role before calling).
        """
        if not self.initialized:
            return False, "System not initialised"

        new_path = new_path.strip()
        if not new_path:
            return False, "Path cannot be empty"

        db_dir = os.path.dirname(os.path.abspath(new_path))
        if not os.path.isdir(db_dir):
            return False, f"Directory does not exist: {db_dir}"

        if new_path == self.engine.db_path:
            return False, "Already connected to this database"

        try:
            face_config = FaceRecognitionConfig(self.config.get('face_recognition', {}))
            new_engine  = FaceRecognitionEngine(new_path, face_config)
            new_perms   = PermissionManager(new_path)
            new_keys    = ApiKeyManager(new_path)

            self.engine          = new_engine
            self.permissions     = new_perms
            self.api_key_manager = new_keys

            # Persist to config.yaml so the choice survives restarts
            config_path = os.path.join(_DATA_DIR, 'config.yaml') if _DATA_DIR else 'config.yaml'
            try:
                with open(config_path, 'r') as f:
                    cfg = yaml.safe_load(f) or {}
                cfg.setdefault('database', {})['path'] = new_path
                with open(config_path, 'w') as f:
                    yaml.dump(cfg, f, default_flow_style=False, allow_unicode=True)
            except Exception as e:
                logger.warning(f"Could not persist new db path to config.yaml: {e}")

            logger.info(f"Switched active database to: {new_path}")
            return True, f"✅ Connected to: {new_path}"

        except Exception as e:
            logger.error(f"Failed to switch database: {e}", exc_info=True)
            return False, f"❌ Failed: {e}"

# Global state instance
app_state = AppState()


# ============================================================================
# AUTHENTICATION
# ============================================================================

def login(username: str, password: str) -> Tuple[bool, str, Optional[User]]:
    """Authenticate user."""
    if not app_state.initialized:
        return False, i18n.t('system_not_initialized'), None
    
    if not username or not password:
        return False, i18n.t('invalid_input'), None
    
    success, message, user = app_state.permissions.authenticate(username, password)
    
    if success:
        app_state.current_user = user
        logger.info(f"User logged in: {username}")
        return True, f"{i18n.t('welcome')}, {username}!", user
    else:
        logger.warning(f"Failed login attempt: {username}")
        return False, message, None


def logout():
    """Logout current user."""
    if app_state.current_user:
        logger.info(f"User logged out: {app_state.current_user.username}")
    app_state.current_user = None
    return f"✅ {i18n.t('logout')}"


def check_permission(folder_path: str = None) -> bool:
    """Check if current user has permission."""
    if not app_state.current_user:
        return False
    
    if folder_path:
        return app_state.permissions.can_access_folder(app_state.current_user, folder_path)
    
    return True


# ============================================================================
# IMAGE PROCESSING FUNCTIONS
# ============================================================================

def draw_faces_on_image(image: np.ndarray, faces: List[Dict], 
                        show_rectangles: bool = True,
                        show_names: bool = True,
                        show_confidence: bool = False) -> np.ndarray:
    """Draw face rectangles and labels on image."""
    if not show_rectangles and not show_names:
        return image
    
    # Create copy
    img_display = image.copy()
    height, width = img_display.shape[:2]
    
    for face_data in faces:
        bbox = face_data['bbox']
        recognition = face_data.get('recognition')
        
        # Convert to pixels
        top = int(bbox['top'] * height)
        right = int(bbox['right'] * width)
        bottom = int(bbox['bottom'] * height)
        left = int(bbox['left'] * width)
        
        # Determine color and label
        if recognition and recognition.get('verified'):
            color = (0, 255, 0)  # Green for known
            label = recognition['person_name']
        else:
            color = (0, 0, 255)  # Red for unknown
            label = i18n.t('unknown_people')
        
        # Draw rectangle
        if show_rectangles:
            cv2.rectangle(img_display, (left, top), (right, bottom), color, 2)
        
        # Draw label
        if show_names:
            label_text = label
            if show_confidence and recognition:
                conf = recognition.get('confidence', 0)
                label_text += f" ({conf:.2%})"
            
            # Calculate text size and background
            font = cv2.FONT_HERSHEY_SIMPLEX
            font_scale = 0.6
            thickness = 2
            (text_width, text_height), baseline = cv2.getTextSize(
                label_text, font, font_scale, thickness
            )
            
            # Draw background rectangle for text
            cv2.rectangle(
                img_display,
                (left, top - text_height - 10),
                (left + text_width + 10, top),
                color,
                -1
            )
            
            # Draw text
            cv2.putText(
                img_display,
                label_text,
                (left + 5, top - 5),
                font,
                font_scale,
                (255, 255, 255),
                thickness
            )
    
    return img_display


# ============================================================================
# RECOGNIZE TAB
# ============================================================================

def process_single_image(image_path, show_rectangles, show_names, show_confidence):
    """
    Process a single uploaded image.
    image_path is a filepath string (gr.Image type='filepath') — this lets us
    handle WebP, TIFF, and other formats that PIL cannot preprocess, and avoids
    the dedup collision that occurred with the fixed /tmp/gradio_temp_image.jpg path.
    Returns 8 values: img_thumb, img_display, results_text, vlm_text,
                       image_id, description, scene_type, tags_csv
    """
    _empty = None, None, i18n.t('permission_denied'), "", None, "", "", ""
    if not check_permission():
        return _empty

    if image_path is None:
        return None, None, i18n.t('no_image'), "", None, "", "", ""

    try:
        # Process using the actual upload path (avoids dedup collision)
        result = app_state.engine.process_image(image_path, app_state.vlm_provider)

        if not result['success']:
            return None, None, f"{i18n.t('error')}: {result.get('error', 'Unknown')}", "", None, "", "", ""

        # Load image for display — use engine's _load_image for format safety
        img_bgr = app_state.engine._load_image(image_path)
        if img_bgr is None:
            return None, None, f"{i18n.t('error')}: could not decode image for display", "", None, "", "", ""

        # Create annotated version
        img_annotated = draw_faces_on_image(
            img_bgr,
            result['faces'],
            show_rectangles,
            show_names,
            show_confidence
        )

        # Convert to RGB for display
        img_display = cv2.cvtColor(img_annotated, cv2.COLOR_BGR2RGB)

        # Create thumbnail
        img_thumb = cv2.resize(img_display, (300, 300))
        
        # Build results text
        face_count = result['face_count']
        known_count = sum(1 for f in result['faces'] if f['recognition'] and f['recognition']['verified'])
        unknown_count = face_count - known_count
        cached_note = " _(loaded from cache)_" if result.get('skipped') else ""

        results_text = f"### {i18n.t('detection_results')}{cached_note}\n"
        results_text += f"- **{i18n.t('total_faces')}:** {face_count}\n"
        results_text += f"- **{i18n.t('known_people')}:** {known_count}\n"
        results_text += f"- **{i18n.t('unknown_people')}:** {unknown_count}\n\n"
        results_text += f"### {i18n.t('people_detected')}\n"

        for i, face_data in enumerate(result['faces'], 1):
            recognition = face_data.get('recognition')
            if recognition and recognition.get('verified'):
                name = recognition['person_name']
                conf = recognition['confidence']
                results_text += f"{i}. **{name}** ({conf:.2%})\n"
            else:
                results_text += f"{i}. {i18n.t('unknown_people')}\n"

        # VLM results — show prominently including tags
        vlm_text = ""
        vlm_result = result.get('vlm_result')
        if vlm_result and 'error' not in vlm_result:
            tags = vlm_result.get('tags', [])
            tag_str = "  ".join(f"`{t}`" for t in tags) if tags else "_none_"
            vlm_text = (
                f"### {i18n.t('ai_analysis')}\n"
                f"**{i18n.t('description')}:** {vlm_result.get('description', 'N/A')}\n\n"
                f"**{i18n.t('scene_type')}:** {vlm_result.get('scene_type', 'N/A')}\n\n"
                f"**{i18n.t('tags')}:**\n{tag_str}\n"
            )
        elif app_state.vlm_provider:
            vlm_text = "_VLM active — no description available for this image yet._"

        # Pull editable metadata from DB record for the edit accordion
        image_id = result.get('image_id')
        description, scene_type, tags_csv = "", "", ""
        if image_id and app_state.initialized:
            record = get_image_record(_db_path(), image_id)
            if record:
                description = record.get('ai_description') or ''
                scene_type  = record.get('ai_scene_type')  or ''
                ai_tags  = record.get('ai_tags_list', [])
                db_tags  = [t['name'] for t in record.get('db_tags', [])]
                all_tags = list(dict.fromkeys(ai_tags + db_tags))
                tags_csv = ', '.join(all_tags)

        return img_thumb, img_display, results_text, vlm_text, image_id, description, scene_type, tags_csv

    except Exception as e:
        logger.error(f"Image processing failed: {e}", exc_info=True)
        return None, None, f"{i18n.t('error')}: {str(e)}", "", None, "", "", ""


# ============================================================================
# TRAIN TAB
# ============================================================================

def train_from_uploads(person_name: str, training_images):
    """Train from uploaded images."""
    if not check_permission():
        return i18n.t('permission_denied')
    
    if not person_name or not person_name.strip():
        return i18n.t('enter_name')
    
    if not training_images:
        return i18n.t('upload_images')
    
    try:
        # Save uploaded images
        temp_dir = Path("/tmp/gradio_training") / person_name.replace(" ", "_")
        temp_dir.mkdir(parents=True, exist_ok=True)
        
        image_paths = []
        for i, img in enumerate(training_images):
            img_path = temp_dir / f"train_{i}.jpg"
            cv2.imwrite(str(img_path), cv2.cvtColor(img, cv2.COLOR_RGB2BGR))
            image_paths.append(str(img_path))
        
        # Train
        success, message, details = app_state.engine.train_person(person_name, image_paths)
        
        # Cleanup
        shutil.rmtree(temp_dir, ignore_errors=True)
        
        if success:
            result = f"""
{i18n.t('training_complete')}

**{i18n.t('person_name')}:** {details['person_name']}
**{i18n.t('processed')}:** {details['processed_images']} / {len(training_images)}
**{i18n.t('failed')}:** {details['failed_images']}
**{i18n.t('total_faces')}:** {details['total_faces']}

{message}
"""
        else:
            result = f"{i18n.t('training_failed')}\n\n{message}"
        
        return result
    
    except Exception as e:
        logger.error(f"Training failed: {e}", exc_info=True)
        return f"{i18n.t('error')}: {str(e)}"


def train_from_folder(folder_path: str, progress=gr.Progress()):
    """Train from folder structure with streaming updates."""
    if not check_permission(folder_path):
        yield i18n.t('permission_denied')
        return
    
    if not folder_path or not folder_path.strip():
        yield i18n.t('folder_not_found')
        return
    
    try:
        # Validate folder
        yield "⏳ " + i18n.t('scanning')
        progress(0, desc=i18n.t('scanning'))
        
        valid, message, summary = FolderTrainer.validate_folder_structure(folder_path)
        
        if not valid:
            yield message
            return
        
        # Scan folder
        person_to_images = FolderTrainer.scan_training_folder(folder_path)
        
        if not person_to_images:
            yield i18n.t('no_images_found')
            return
        
        # Train each person with progress updates
        total_people = len(person_to_images)
        results = []
        total_embeddings = 0
        total_processed = 0
        total_failed = 0
        
        # Initial status
        yield f"🚀 Starting training for {total_people} people..."
        
        for i, (person_name, image_paths) in enumerate(person_to_images.items(), 1):
            # Update progress bar
            progress_val = (i - 1) / total_people
            progress(progress_val, desc=f"Training: {person_name} ({i}/{total_people})")
            
            # Yield status update
            status = f"Training {person_name} ({i}/{total_people})...\n\n"
            status += f"Processed: {total_processed}, Failed: {total_failed}, Embeddings: {total_embeddings}"
            yield status
            
            # Train this person
            success, msg, details = app_state.engine.train_person(person_name, image_paths)
            
            if success:
                embeddings = details.get('embeddings_count', 0)
                processed = details.get('processed_images', 0)
                failed = details.get('failed_images', 0)
                
                total_embeddings += embeddings
                total_processed += processed
                total_failed += failed
                
                results.append(f"✅ **{person_name}**: {embeddings} embeddings ({processed}/{len(image_paths)} images)")
            else:
                total_failed += len(image_paths)
                results.append(f"❌ **{person_name}**: {msg}")
        
        # Final progress update
        progress(1.0, desc=i18n.t('training_complete'))
        
        # Build final summary
        result_text = f"""
## {i18n.t('training_complete')}

### {i18n.t('stats_overview')}
- **{i18n.t('stats_total_people')}:** {total_people}
- **{i18n.t('total_faces_detected')}:** {total_embeddings}
- **{i18n.t('processed')}:** {total_processed} images
- **{i18n.t('failed')}:** {total_failed} images
- **Success Rate:** {100 * total_processed / (total_processed + total_failed) if (total_processed + total_failed) > 0 else 0:.1f}%

### {i18n.t('details')}
""" + "\n".join(results)
        
        # Final yield - this is what stays on screen
        yield result_text
    
    except Exception as e:
        logger.error(f"Folder training failed: {e}", exc_info=True)
        yield f"{i18n.t('error')}: {str(e)}"


# ============================================================================
# SEARCH TAB
# ============================================================================

def search_by_person(person_name: str, max_results: int):
    """Search images by person name. Returns (status, gallery_items, id_list)."""
    if not check_permission():
        return i18n.t('permission_denied'), [], []

    if not person_name or not person_name.strip():
        return i18n.t('enter_name'), [], []

    try:
        results = app_state.engine.search_images_by_person(person_name.strip(), max_results)

        if not results:
            return f"{i18n.t('no_results')} '{person_name}'", [], []

        td = _thumb_dir()
        gallery_items = []
        id_list = []
        for result in results:
            filepath = result.get('filepath', '')
            image_id = result.get('id')
            if not Path(filepath).exists() or image_id is None:
                continue
            try:
                thumb = load_thumbnail_pil(image_id, filepath, td, size=400)
                if thumb is None:
                    continue
                caption = f"{result['filename']}\n{i18n.t('confidence')}: {result['confidence']:.2%}"
                gallery_items.append((thumb, caption))
                id_list.append(image_id)
            except Exception as e:
                logger.warning(f"Failed to add image to gallery ({filepath}): {e}")

        message = f"{i18n.t('search_results')} '{person_name}': {len(gallery_items)} {i18n.t('found_images')}"
        return message, gallery_items, id_list

    except Exception as e:
        logger.error(f"Search failed: {e}", exc_info=True)
        return f"{i18n.t('error')}: {str(e)}", [], []


# ============================================================================
# BROWSE TAB
# ============================================================================

def browse_images(sort_by: str, max_images: int):
    """Browse all processed images with face rectangles."""
    if not check_permission():
        return i18n.t('permission_denied'), []
    
    if not app_state.engine:
        return "System not initialized", []
    
    try:
        conn = app_state.engine._get_connection()
        
        # Build query based on sort
        sort_mapping = {
            i18n.t('sort_newest'): "created_at DESC",
            i18n.t('sort_oldest'): "created_at ASC",
            i18n.t('sort_most_faces'): "face_count DESC",
            i18n.t('sort_least_faces'): "face_count ASC"
        }
        
        order_by = sort_mapping.get(sort_by, "created_at DESC")
        
        logger.info(f"Browsing images: sort_by={sort_by}, order_by={order_by}, max={max_images}")
        
        cursor = conn.execute(f"""
            SELECT id, filepath, filename, face_count, ai_description
            FROM images
            WHERE processed = 1 AND filepath != '__training__'
            ORDER BY {order_by}
            LIMIT ?
        """, (max_images,))
        
        results = cursor.fetchall()
        logger.info(f"Found {len(results)} images in database")
        conn.close()
        
        # Build gallery with face rectangles
        gallery_items = []
        
        for row in results:
            image_id = row['id']
            filepath = row['filepath']
            
            logger.debug(f"Processing image {image_id}: {filepath}")
            
            # Check file exists
            if not Path(filepath).exists():
                logger.warning(f"  ❌ File does not exist: {filepath}")
                continue
            
            try:
                # Load image
                img = cv2.imread(filepath)
                if img is None:
                    logger.warning(f"  ❌ Failed to load: {filepath}")
                    continue
                
                # Get face data from database
                conn = app_state.engine._get_connection()
                cursor = conn.execute("""
                    SELECT 
                        f.bbox_top, f.bbox_right, f.bbox_bottom, f.bbox_left,
                        f.detection_confidence,
                        p.name as person_name,
                        fe.recognition_confidence
                    FROM faces f
                    LEFT JOIN face_embeddings fe ON f.id = fe.face_id
                    LEFT JOIN people p ON fe.person_id = p.id
                    WHERE f.image_id = ?
                """, (image_id,))
                
                faces = cursor.fetchall()
                conn.close()
                
                # Draw rectangles on image
                height, width = img.shape[:2]
                
                for face in faces:
                    # Convert normalized coords to pixels
                    top = int(face['bbox_top'] * height)
                    right = int(face['bbox_right'] * width)
                    bottom = int(face['bbox_bottom'] * height)
                    left = int(face['bbox_left'] * width)
                    
                    # Determine color and label
                    if face['person_name']:
                        color = (0, 255, 0)  # Green for known
                        label = face['person_name']
                        if face['recognition_confidence']:
                            label += f" ({face['recognition_confidence']:.0%})"
                    else:
                        color = (0, 0, 255)  # Red for unknown
                        label = i18n.t('unknown_people')
                    
                    # Draw rectangle
                    cv2.rectangle(img, (left, top), (right, bottom), color, 2)
                    
                    # Draw label with background
                    font = cv2.FONT_HERSHEY_SIMPLEX
                    font_scale = 0.5
                    thickness = 1
                    (text_width, text_height), baseline = cv2.getTextSize(
                        label, font, font_scale, thickness
                    )
                    
                    # Background rectangle
                    cv2.rectangle(
                        img,
                        (left, top - text_height - 10),
                        (left + text_width + 10, top),
                        color,
                        -1
                    )
                    
                    # Text
                    cv2.putText(
                        img,
                        label,
                        (left + 5, top - 5),
                        font,
                        font_scale,
                        (255, 255, 255),
                        thickness
                    )
                
                # Convert to RGB for display
                img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
                
                caption = f"{row['filename']}\n{i18n.t('total_faces')}: {row['face_count']}"
                gallery_items.append((img_rgb, caption))
                
            except Exception as e:
                logger.error(f"  ❌ Failed to process image {filepath}: {e}")
                continue
        
        message = f"{i18n.t('showing_images')} ({sort_by}): {len(gallery_items)} images"
        logger.info(f"Returning {len(gallery_items)} gallery items")
        
        return message, gallery_items
    
    except Exception as e:
        logger.error(f"Browse failed: {e}", exc_info=True)
        import traceback
        traceback.print_exc()
        return f"{i18n.t('error')}: {str(e)}", []


# ============================================================================
# BATCH PROCESSING TAB
# ============================================================================

def batch_process_folder(folder_path: str, extensions: str, recursive: bool, progress=gr.Progress()):
    """Batch process folder of images — yields live progress updates."""
    if not check_permission(folder_path):
        yield i18n.t('permission_denied')
        return

    if not folder_path or not Path(folder_path).exists():
        yield i18n.t('folder_not_found')
        return

    try:
        ext_list = [e.strip() for e in extensions.split(',') if e.strip()]
        if not ext_list:
            ext_list = ['.jpg', '.jpeg', '.png', '.pgm', '.webp']

        progress(0, desc=i18n.t('scanning'))
        folder = Path(folder_path)

        image_files = []
        glob_fn = folder.rglob if recursive else folder.glob
        for ext in ext_list:
            image_files.extend(glob_fn(f"*{ext}"))
            image_files.extend(glob_fn(f"*{ext.upper()}"))
        image_files = sorted(set(image_files))

        if not image_files:
            yield f"{i18n.t('no_images_found')} ({extensions})"
            return

        total = len(image_files)
        processed = skipped = failed = total_faces = 0
        recent_lines: List[str] = []   # keep a rolling window of last results

        yield f"⏳ Found **{total}** images — starting...\n"

        for i, img_path in enumerate(image_files):
            fname = img_path.name
            progress((i + 1) / total, desc=f"{i18n.t('processing')} {i+1}/{total}: {fname}")

            result = app_state.engine.process_image(str(img_path), app_state.vlm_provider)

            if result['success']:
                fc = result['face_count']
                total_faces += fc
                line_parts = [f"**{fname}**"]

                if result.get('skipped'):
                    skipped += 1
                    line_parts.append("⏭️ cached")
                else:
                    processed += 1
                    line_parts.append(f"✅ {fc} face{'s' if fc != 1 else ''}")

                # People names
                names = [
                    f['recognition']['person_name']
                    for f in result.get('faces', [])
                    if f.get('recognition') and f['recognition'].get('verified')
                ]
                if names:
                    line_parts.append("👤 " + ", ".join(names))

                # VLM tags
                vlm = result.get('vlm_result')
                if vlm and 'error' not in vlm:
                    desc = vlm.get('description', '')
                    tags = vlm.get('tags', [])
                    if desc:
                        line_parts.append(f"🤖 _{desc[:120]}_")
                    if tags:
                        line_parts.append("🏷️ " + " · ".join(tags[:8]))
            else:
                failed += 1
                line_parts = [f"**{fname}**", f"❌ {result.get('error', 'failed')}"]

            recent_lines.append("  \n".join(line_parts))
            if len(recent_lines) > 10:
                recent_lines.pop(0)

            # Yield rolling status
            header = (
                f"### {i18n.t('processing')} {i+1}/{total}\n\n"
                f"✅ {processed}  ⏭️ {skipped}  ❌ {failed}  👤 {total_faces} faces\n\n"
                "---\n\n"
            )
            yield header + "\n\n---\n\n".join(reversed(recent_lines))

        # Final summary
        avg_faces = total_faces / (processed + skipped) if (processed + skipped) > 0 else 0
        yield (
            f"## {i18n.t('batch_complete')}\n\n"
            f"- **{i18n.t('stats_total_images')}:** {total}\n"
            f"- **{i18n.t('processed')}:** {processed} new  |  {skipped} cached\n"
            f"- **{i18n.t('failed')}:** {failed}\n"
            f"- **{i18n.t('total_faces_detected')}:** {total_faces}\n"
            f"- **{i18n.t('avg_faces')}:** {avg_faces:.2f}\n"
        )

    except Exception as e:
        logger.error(f"Batch processing failed: {e}", exc_info=True)
        yield f"{i18n.t('error')}: {str(e)}"


# ============================================================================
# STATISTICS TAB
# ============================================================================

def get_statistics():
    """Get system statistics."""
    if not check_permission():
        return i18n.t('permission_denied')
    
    try:
        stats = app_state.engine.get_statistics()
        
        stats_text = f"""
### {i18n.t('stats_overview')}

**{i18n.t('stats_total_people')}:** {stats.get('total_people', 0)}
**{i18n.t('stats_total_images')}:** {stats.get('total_images', 0)} ({stats.get('processed_images', 0)} {i18n.t('stats_processed_images')})
**{i18n.t('stats_total_faces')}:** {stats.get('total_faces', 0)}
**{i18n.t('stats_identified_faces')}:** {stats.get('identified_faces', 0)}
**{i18n.t('stats_unknown_faces')}:** {stats.get('unknown_faces', 0)}

### {i18n.t('stats_configuration')}

**{i18n.t('backend')}:** {stats.get('backend', 'N/A')}
**{i18n.t('model')}:** {stats.get('model', 'N/A')}
**{i18n.t('detection_threshold')}:** {stats.get('detection_threshold', 0):.2f}
**{i18n.t('recognition_threshold')}:** {stats.get('recognition_threshold', 0):.2f}

### {i18n.t('stats_faiss_index')}

**{i18n.t('stats_vectors')}:** {stats.get('faiss_vectors', 0)}
**{i18n.t('stats_dimension')}:** {stats.get('faiss_dimension', 0)}

### {i18n.t('stats_top_people')}

"""
        
        for person in stats.get('top_people', []):
            stats_text += f"- **{person['name']}**: {person['count']}\n"
        
        return stats_text
    
    except Exception as e:
        logger.error(f"Failed to get statistics: {e}", exc_info=True)
        return f"{i18n.t('error')}: {str(e)}"


# ============================================================================
# SETTINGS TAB
# ============================================================================

def save_settings(language: str, backend: str, model: str,
                  det_threshold: float, rec_threshold: float):
    """Save general settings to config.yaml (VLM keys are managed separately)."""
    if not check_permission():
        return i18n.t('permission_denied')

    try:
        # ── Backend-change guard ──────────────────────────────────────────────
        # Backends produce incompatible embedding vectors.
        # Warn if the user is switching away from the current backend and
        # existing embeddings are stored in the DB.
        current_backend = getattr(
            getattr(app_state, 'engine', None),
            'config', None
        )
        current_backend = getattr(current_backend, 'backend', None) if current_backend else None

        if current_backend and backend != current_backend and app_state.engine:
            try:
                conn = app_state.engine._get_connection()
                embed_count = conn.execute(
                    "SELECT COUNT(*) FROM face_embeddings"
                ).fetchone()[0]
                conn.close()
            except Exception:
                embed_count = 0

            if embed_count > 0:
                old_dim = BACKEND_EMBEDDING_DIMS.get(current_backend, '?')
                new_dim = BACKEND_EMBEDDING_DIMS.get(backend, '?')
                return (
                    f"⚠️ **Backend switch blocked — embedding incompatibility**\n\n"
                    f"The current backend (**{current_backend}**, {old_dim}-dim) has "
                    f"**{embed_count} face embeddings** in the database.\n\n"
                    f"The new backend (**{backend}**, {new_dim}-dim) produces vectors in a "
                    f"**different space** — existing embeddings cannot be used and FAISS "
                    f"searches will return wrong results.\n\n"
                    f"**To switch backends:**\n"
                    f"1. Click **Clear all embeddings** (below) — this deletes all stored face vectors\n"
                    f"2. Then save settings and re-train all persons from scratch\n\n"
                    f"_Other settings (language, thresholds) were not saved — please save again after clearing._"
                )

        config = app_state.config or {}

        if 'ui' not in config:
            config['ui'] = {}
        config['ui']['language'] = language

        if 'face_recognition' not in config:
            config['face_recognition'] = {}
        config['face_recognition']['backend'] = backend

        if 'insightface' not in config['face_recognition']:
            config['face_recognition']['insightface'] = {}
        config['face_recognition']['insightface']['model'] = model
        config['face_recognition']['insightface']['detection_threshold'] = det_threshold
        config['face_recognition']['insightface']['recognition_threshold'] = rec_threshold

        # Remove any legacy plaintext VLM key that may be in the YAML
        config.get('vlm', {}).get('api', {}).pop('key', None)

        config_path = os.path.join(_DATA_DIR, 'config.yaml') if _DATA_DIR else 'config.yaml'
        with open(config_path, 'w') as f:
            yaml.dump(config, f, default_flow_style=False, allow_unicode=True)

        i18n.set_language(language)
        logger.info(f"Settings saved (backend={backend})")
        return f"{i18n.t('settings_saved')}\n\n⚠️  {i18n.t('please_wait')}"

    except Exception as e:
        logger.error(f"Failed to save settings: {e}", exc_info=True)
        return f"{i18n.t('error')}: {str(e)}"


def clear_all_embeddings():
    """
    Delete ALL face embeddings from the database and rebuild an empty FAISS index.
    Required when switching recognition backends (incompatible vector spaces).
    Admin only.
    """
    if not app_state.current_user or app_state.current_user.role != 'admin':
        return "❌ Admin access required"
    if not app_state.initialized or not app_state.engine:
        return "❌ System not initialised"
    try:
        conn = app_state.engine._get_connection()
        count = conn.execute("SELECT COUNT(*) FROM face_embeddings").fetchone()[0]
        conn.execute("DELETE FROM face_embeddings")
        conn.commit()
        conn.close()
        app_state.engine._load_faiss_index()   # rebuilds empty index
        logger.info(f"Admin cleared all face embeddings ({count} rows deleted)")
        return (
            f"✅ Cleared **{count}** face embeddings and rebuilt FAISS index.\n\n"
            "You can now switch to the new backend and re-train all persons."
        )
    except Exception as e:
        logger.error(f"Failed to clear embeddings: {e}", exc_info=True)
        return f"❌ Error: {e}"


# ============================================================================
# ADMIN TAB
# ============================================================================

def mount_network_drive(mount_type: str, server: str, share: str, 
                        mount_point: str, username: str, password: str, 
                        domain: str, read_only: bool):
    """Mount network drive."""
    if not app_state.current_user or app_state.current_user.role != 'admin':
        return i18n.t('permission_denied')
    
    try:
        if mount_type == "SMB/CIFS":
            success, message = DriveMount.mount_smb(
                server, share, mount_point, username, password, domain, read_only
            )
            return message
        else:
            return f"{i18n.t('error')}: Unsupported mount type"
    
    except Exception as e:
        logger.error(f"Mount failed: {e}", exc_info=True)
        return f"{i18n.t('error')}: {str(e)}"


def create_new_user(username: str, password: str, role: str, allowed_folders: str):
    """Create new user."""
    if not app_state.current_user or app_state.current_user.role != 'admin':
        return i18n.t('permission_denied')
    
    try:
        # Parse folders
        folders = [f.strip() for f in allowed_folders.split('\n') if f.strip()]
        
        success, message, user_id = app_state.permissions.create_user(
            username, password, role.lower(), folders
        )
        
        return message
    
    except Exception as e:
        logger.error(f"User creation failed: {e}", exc_info=True)
        return f"{i18n.t('error')}: {str(e)}"


def list_all_users():
    """List all users."""
    if not app_state.current_user or app_state.current_user.role != 'admin':
        return i18n.t('permission_denied')
    
    try:
        users = app_state.permissions.list_users()
        
        if not users:
            return "No users found"
        
        result = f"### {i18n.t('user_management')}\n\n"
        
        for user in users:
            result += f"**{user.username}** ({user.role})\n"
            result += f"  - Created: {user.created_at}\n"
            result += f"  - Active: {'✅' if user.is_active else '❌'}\n"
            if user.allowed_folders:
                result += f"  - Folders: {len(user.allowed_folders)}\n"
            result += "\n"
        
        return result
    
    except Exception as e:
        logger.error(f"List users failed: {e}", exc_info=True)
        return f"{i18n.t('error')}: {str(e)}"


# ============================================================================
# VLM / API KEY MANAGEMENT FUNCTIONS
# ============================================================================

def _current_username() -> Optional[str]:
    """Return the currently logged-in username, or None."""
    return app_state.current_user.username if app_state.current_user else None


def _is_admin() -> bool:
    return bool(app_state.current_user and app_state.current_user.role == 'admin')


def _validate_api_key(provider: str, api_key: str) -> Tuple[bool, str]:
    """
    Test an API key by calling the provider's models endpoint.
    Returns (valid, message).  Skips validation for providers that don't need keys.
    """
    requires_key = PROVIDER_CONFIGS.get(provider, {}).get('requires_key', True)
    if not requires_key:
        return True, "No key required for this provider"
    models, error = fetch_vlm_models(provider, api_key)
    if error:
        return False, error
    display = PROVIDER_CONFIGS.get(provider, {}).get('display_name', provider)
    return True, f"Key accepted by {display} — {len(models)} model(s) available"


def save_system_api_key(provider: str, api_key: str) -> str:
    """Validate then save a system-wide API key (admin only)."""
    if not _is_admin():
        return "❌ Admin access required"
    if not api_key or not api_key.strip():
        return "❌ API key cannot be empty"
    api_key = api_key.strip()
    valid, val_msg = _validate_api_key(provider, api_key)
    if not valid:
        return f"❌ Key NOT saved — validation failed:\n\n{val_msg}"
    success, message = app_state.api_key_manager.set_system_key(provider, api_key)
    return f"✅ {val_msg}\n\n✅ System key saved." if success else f"❌ {message}"


def delete_system_api_key(provider: str) -> str:
    """Delete a system-wide API key (admin only)."""
    if not _is_admin():
        return "❌ Admin access required"
    success, message = app_state.api_key_manager.delete_system_key(provider)
    return f"✅ {message}" if success else f"❌ {message}"


def save_user_api_key(provider: str, api_key: str) -> str:
    """Validate then save a personal API key for the current user."""
    if not check_permission():
        return "❌ " + i18n.t('permission_denied')
    username = _current_username()
    if not username:
        return "❌ Not logged in"
    if not api_key or not api_key.strip():
        return "❌ API key cannot be empty"
    api_key = api_key.strip()
    valid, val_msg = _validate_api_key(provider, api_key)
    if not valid:
        return f"❌ Key NOT saved — validation failed:\n\n{val_msg}"
    success, message = app_state.api_key_manager.set_user_key(provider, api_key, username)
    return f"✅ {val_msg}\n\n✅ Personal key saved." if success else f"❌ {message}"


def delete_user_api_key(provider: str) -> str:
    """Delete the current user's personal API key for a provider."""
    if not check_permission():
        return "❌ " + i18n.t('permission_denied')
    username = _current_username()
    if not username:
        return "❌ Not logged in"
    success, message = app_state.api_key_manager.delete_user_key(provider, username)
    return f"✅ {message}" if success else f"❌ {message}"


def get_provider_key_status(provider: str) -> str:
    """Return a human-readable masked key status for UI display."""
    if not check_permission():
        return i18n.t('permission_denied')
    username = _current_username()
    status = app_state.api_key_manager.get_key_status(provider, username)

    sys_info = status['system']
    usr_info = status['user']

    lines = [f"**Key status for {PROVIDER_CONFIGS.get(provider, {}).get('display_name', provider)}**\n"]
    if sys_info['exists']:
        lines.append(f"- System key: `{sys_info['preview']}` (set)")
    else:
        lines.append("- System key: not set")

    if usr_info['exists']:
        lines.append(f"- Personal key: `{usr_info['preview']}` (active — overrides system key)")
    else:
        lines.append("- Personal key: not set")

    effective = "personal key" if usr_info['exists'] else ("system key" if sys_info['exists'] else "**none**")
    lines.append(f"\nActive key: {effective}")
    return "\n".join(lines)


def fetch_models_for_provider(provider: str) -> Tuple[List[str], str]:
    """
    Call the provider's /models endpoint and return the list.
    Returns (choices_list, status_message).
    """
    if not check_permission():
        return [], i18n.t('permission_denied')

    username = _current_username()
    api_key = app_state.api_key_manager.get_effective_key(provider, username)

    models, error = fetch_vlm_models(provider, api_key)
    if error:
        return [], f"❌ {error}"

    default = PROVIDER_CONFIGS.get(provider, {}).get('default_model', '')
    return models, f"✅ {len(models)} models fetched" + (f" (default: {default})" if default in models else "")


def activate_vlm_provider(enable_vlm: bool, provider: str, model: str, vlm_max_size: int = 0) -> str:
    """
    Create and activate a VLM provider instance using the stored key.
    Called when the user clicks 'Activate VLM'.
    """
    if not check_permission():
        return "❌ " + i18n.t('permission_denied')

    if not enable_vlm:
        app_state.vlm_provider = None
        return "VLM disabled"

    username = _current_username()
    api_key = app_state.api_key_manager.get_effective_key(provider, username)

    requires_key = PROVIDER_CONFIGS.get(provider, {}).get('requires_key', True)
    if not api_key and requires_key:
        return (
            f"❌ No API key available for {provider}.\n"
            "Please save a system or personal key first, then try again."
        )

    provider_obj = create_vlm_provider(
        provider=provider,
        api_key=api_key,
        model=model or None,
        config=VLMConfig(vlm_max_size=vlm_max_size)
    )
    if provider_obj:
        app_state.vlm_provider = provider_obj
        used_model = model or PROVIDER_CONFIGS.get(provider, {}).get('default_model', 'default')
        return f"✅ VLM activated: **{PROVIDER_CONFIGS[provider]['display_name']}** / `{used_model}`"
    return "❌ Failed to activate VLM provider — check logs for details"


# ============================================================================
# IMAGE OPERATIONS — thin wrappers around image_ops that use app_state
# (Keep these wrappers lean; all real logic lives in image_ops.py so it can
#  be called directly from FastAPI endpoints in Phase B.)
# ============================================================================

def _db_path() -> str:
    """Return the active database path from app_state."""
    return app_state.engine.db_path


def _thumb_dir() -> str:
    """Return the thumbnail cache directory (anchored to the active DB location)."""
    return os.path.join(os.path.dirname(_db_path()), 'thumbnails')


def ui_get_image_detail(image_id: Optional[int]):
    """
    Load full image + EXIF + tags for the detail panel.
    Returns (pil_image, exif_md, description, scene_type, tags_csv, filepath).
    """
    if image_id is None or not app_state.initialized:
        return None, "_Select an image to inspect it._", "", "", "", None

    record = get_image_record(_db_path(), image_id)
    if not record:
        return None, "_Image not found._", "", "", "", None

    filepath = record.get('filepath', '')

    # Load full-size image for display
    pil_img = None
    try:
        from PIL import Image as _PIL
        if Path(filepath).exists():
            pil_img = _PIL.open(filepath).convert('RGB')
    except Exception:
        pass

    # EXIF
    exif = read_exif(filepath) if Path(filepath).exists() else {}
    exif_md = format_exif_as_markdown(exif)

    # Augment EXIF display with DB record info
    people = record.get('detected_people', [])
    if people:
        names = ', '.join(p['name'] for p in people)
        exif_md += f"\n\n**People detected:** {names}"

    file_size = record.get('file_size')
    if file_size:
        size_kb = file_size // 1024
        exif_md += f"\n\n**File size:** {size_kb:,} KB"

    # Filesystem modification time
    if filepath and Path(filepath).exists():
        try:
            mtime = datetime.fromtimestamp(Path(filepath).stat().st_mtime)
            exif_md += f"\n\n**File modified:** {mtime.strftime('%Y-%m-%d %H:%M:%S')}"
        except Exception:
            pass

    # DB timestamps
    created_at = record.get('created_at')
    if created_at:
        exif_md += f"\n\n**Added to DB:** {str(created_at)[:19]}"
    updated_at = record.get('updated_at')
    if updated_at and updated_at != created_at:
        exif_md += f"\n\n**Last updated:** {str(updated_at)[:19]}"

    # Current tags — merge AI tags and manual image_tags, dedup
    ai_tags = record.get('ai_tags_list', [])
    db_tags = [t['name'] for t in record.get('db_tags', [])]
    all_tags = list(dict.fromkeys(ai_tags + db_tags))   # preserve order, dedup
    tags_csv = ', '.join(all_tags)

    description = record.get('ai_description') or ''
    scene_type  = record.get('ai_scene_type')  or ''

    return pil_img, exif_md, description, scene_type, tags_csv, filepath


def ui_browse(person, tag, scene, date_from, date_to, sort_by, limit, n_cols=5):
    """
    Run a filtered browse query and return (status_md, gallery_update, id_list).
    gallery_update is gr.update(columns=n_cols, value=...) so the column count
    updates live when the slider changes.
    id_list is a parallel list of image_ids for selection tracking.
    """
    if not app_state.initialized:
        return "System not initialised", gr.update(value=[]), []

    rows = browse_images_filtered(
        db_path    = _db_path(),
        person     = person or '',
        tag        = tag or '',
        scene_type = scene or '',
        date_from  = date_from or '',
        date_to    = date_to or '',
        sort_by    = sort_by or 'newest',
        limit      = int(limit),
    )

    n_cols = max(1, int(n_cols or 5))

    if not rows:
        return "No images found matching these filters.", gr.update(columns=n_cols, value=[]), []

    gallery_items = []
    id_list       = []
    td = _thumb_dir()

    for r in rows:
        if not Path(r['filepath']).exists():
            continue

        thumb = load_thumbnail_pil(r['id'], r['filepath'], td, size=400)
        if thumb is None:
            continue

        # Build caption
        parts = [r['filename']]
        if r.get('taken_at'):
            parts.append(r['taken_at'][:10])
        if r.get('face_count'):
            parts.append(f"👤 {r['face_count']}")
        if r.get('people_names'):
            parts.append(r['people_names'])
        tags_preview = ', '.join(r.get('ai_tags_list', [])[:4])
        if tags_preview:
            parts.append(tags_preview)

        gallery_items.append((thumb, '\n'.join(parts)))
        id_list.append(r['id'])

    active_filters = ', '.join(filter(None, [
        f"person '{person}'" if person else '',
        f"tag '{tag}'" if tag else '',
        f"scene '{scene}'" if scene and scene.lower() != 'all' else '',
        f"from {date_from}" if date_from else '',
        f"to {date_to}" if date_to else '',
    ]))
    status = f"**{len(gallery_items)}** image(s) found"
    if active_filters:
        status += f" — filtered by: {active_filters}"
    return status, gr.update(columns=n_cols, value=gallery_items), id_list


def ui_save_metadata(image_id, description, scene_type, tags_csv):
    if not check_permission():
        return i18n.t('permission_denied')
    if not image_id:
        return "❌ No image selected"
    ok, msg = _update_image_metadata(_db_path(), image_id, description, scene_type, tags_csv)
    return msg


def ui_rename_image(image_id, new_filename):
    if not check_permission():
        return i18n.t('permission_denied')
    if not image_id:
        return "❌ No image selected"
    ok, msg = _rename_image(_db_path(), image_id, new_filename)
    return msg


def ui_download_image(image_id):
    """Return the filepath for gr.File download, or None."""
    if not image_id or not app_state.initialized:
        return None
    record = get_image_record(_db_path(), image_id)
    if not record:
        return None
    fp = record.get('filepath', '')
    return fp if Path(fp).exists() else None


def ui_open_in_os(image_id) -> str:
    """Open image in the default OS viewer. Returns status string."""
    # Phase-B API: POST /api/images/{id}/open  (local-only, Electron mode)
    import subprocess, sys
    if not image_id or not app_state.initialized:
        return "❌ No image selected"
    record = get_image_record(_db_path(), image_id)
    if not record:
        return "❌ Image not found"
    fp = record.get('filepath', '')
    if not Path(fp).exists():
        return f"❌ File not found: {fp}"
    try:
        if sys.platform == 'darwin':
            subprocess.Popen(['open', fp])
        elif sys.platform == 'win32':
            import os as _os
            _os.startfile(fp)
        else:
            subprocess.Popen(['xdg-open', fp])
        return f"✅ Opened: {Path(fp).name}"
    except Exception as e:
        return f"❌ Could not open file: {e}"


# ============================================================================
# BUILD UI
# ============================================================================

def build_ui():
    """Build Gradio UI - Gradio 6.0 compatible."""
    
    # Custom CSS
    css = """
    .main-container {
        max-width: 1400px;
        margin: auto;
    }
    .gradio-container {
        font-family: 'Inter', sans-serif;
    }
    """
    
    # Note: In Gradio 6.0, theme and css are passed to launch(), not Blocks()
    with gr.Blocks() as app:
        
        # Header
        gr.Markdown(f"""
        # {i18n.t('app_title')}
        ### {i18n.t('app_subtitle')}
        """)
        
        # Session state
        user_state = gr.State(None)
        
        # Login section
        with gr.Column(visible=True) as login_section:
            with gr.Row():
                with gr.Column(scale=1):
                    login_username = gr.Textbox(label=i18n.t('username'), placeholder="admin")
                    login_password = gr.Textbox(label=i18n.t('password'), type="password", placeholder="admin")
                    login_btn = gr.Button(i18n.t('login'), variant="primary")
                    login_status = gr.Textbox(label=i18n.t('batch_status'), interactive=False)
        
        def handle_login(username, password):
            success, message, user = login(username, password)
            if success:
                is_admin_user = (user is not None and user.role == 'admin')
                return (
                    message,
                    gr.update(visible=False),       # login_section
                    gr.update(visible=True),        # main_content
                    user,
                    gr.update(visible=is_admin_user)  # system_key_group
                )
            else:
                return (
                    message,
                    gr.update(visible=True),
                    gr.update(visible=False),
                    None,
                    gr.update(visible=False)
                )
        
        # Main content (hidden until login)
        with gr.Column(visible=False) as main_content:
            
            # Tabs
            with gr.Tabs():
                
                # ============================================================
                # RECOGNIZE TAB
                # ============================================================
                with gr.Tab(i18n.t('tab_recognize')):
                    with gr.Row():
                        with gr.Column():
                            input_image = gr.Image(
                                label=i18n.t('upload_image'),
                                type="filepath"  # bypass PIL preprocessing; handles WebP/TIFF natively
                            )

                            with gr.Row():
                                show_rect = gr.Checkbox(label=i18n.t('show_rectangles'), value=True)
                                show_names = gr.Checkbox(label=i18n.t('show_names'), value=True)
                                show_conf = gr.Checkbox(label=i18n.t('show_confidence'), value=False)

                            process_btn = gr.Button(i18n.t('process_image'), variant="primary")

                        with gr.Column():
                            output_thumb = gr.Image(label=i18n.t('show_thumbnail'))
                            output_full = gr.Image(label=i18n.t('show_full_image'))

                    with gr.Row():
                        results_text = gr.Markdown(label=i18n.t('detection_results'))
                        vlm_text = gr.Markdown(label=i18n.t('ai_analysis'))

                    # ── Edit metadata after processing ───────────────────────
                    recog_edit_id = gr.State(None)
                    with gr.Accordion("✏️ Edit metadata", open=False) as recog_edit_acc:
                        recog_edit_desc = gr.Textbox(
                            label="Description",
                            lines=3,
                            placeholder="A brief description of this image…",
                        )
                        with gr.Row():
                            recog_edit_scene = gr.Dropdown(
                                label="Scene type",
                                choices=[''] + SCENE_TYPES,
                                allow_custom_value=True,
                                scale=1,
                            )
                            recog_edit_tags = gr.Textbox(
                                label="Tags (comma-separated)",
                                placeholder="portrait, indoor, family…",
                                scale=2,
                            )
                        recog_edit_save_btn = gr.Button("💾 Save metadata", variant="primary")
                        recog_edit_result   = gr.Markdown()

                    process_btn.click(
                        fn=process_single_image,
                        inputs=[input_image, show_rect, show_names, show_conf],
                        outputs=[output_thumb, output_full, results_text, vlm_text,
                                 recog_edit_id, recog_edit_desc, recog_edit_scene, recog_edit_tags],
                    )
                    recog_edit_save_btn.click(
                        fn=ui_save_metadata,
                        inputs=[recog_edit_id, recog_edit_desc, recog_edit_scene, recog_edit_tags],
                        outputs=recog_edit_result,
                    )
                
                # ============================================================
                # TRAIN TAB
                # ============================================================
                with gr.Tab(i18n.t('tab_train')):
                    gr.Markdown(f"### {i18n.t('train_description')}")
                    
                    with gr.Tab(i18n.t('train_upload')):
                        train_name = gr.Textbox(
                            label=i18n.t('person_name'),
                            placeholder=i18n.t('person_name_placeholder')
                        )
                        train_images = gr.Gallery(
                            label=i18n.t('training_images'),
                            type="numpy",
                            columns=5
                        )
                        train_upload_btn = gr.Button(i18n.t('train_system'), variant="primary")
                        train_upload_result = gr.Markdown()
                        
                        train_upload_btn.click(
                            fn=train_from_uploads,
                            inputs=[train_name, train_images],
                            outputs=train_upload_result
                        )
                    
                    # Find this section in the TRAIN TAB:
                    with gr.Tab(i18n.t('train_folder')):
                        gr.Markdown(i18n.t('train_folder_description'))
                        train_folder_path = gr.Textbox(
                            label=i18n.t('folder_path'),
                            placeholder="/path/to/training/folder"
                        )
                        train_folder_btn = gr.Button(i18n.t('train_system'), variant="primary")
                        train_folder_result = gr.Markdown()
                        
                        # FIX: Change this line
                        train_folder_btn.click(
                            fn=train_from_folder,
                            inputs=[train_folder_path],
                            outputs=train_folder_result,
                            show_progress="full"  # ← Add this for visual progress bar!
                        )
                    
                    # Tips
                    with gr.Accordion(i18n.t('training_tips'), open=False):
                        gr.Markdown(f"""
                        - {i18n.t('tip_1')}
                        - {i18n.t('tip_2')}
                        - {i18n.t('tip_3')}
                        - {i18n.t('tip_4')}
                        - {i18n.t('tip_5')}
                        - {i18n.t('tip_6')}
                        """)
                
                # ============================================================
                # SEARCH TAB
                # ============================================================
                with gr.Tab(i18n.t('tab_search')):
                    gr.Markdown(f"### {i18n.t('search_description')}")

                    with gr.Row():
                        search_name = gr.Textbox(
                            label=i18n.t('person_name'),
                            placeholder=i18n.t('search_name')
                        )
                        search_max = gr.Slider(
                            label=i18n.t('max_results'),
                            minimum=1,
                            maximum=100,
                            value=20,
                            step=1
                        )

                    search_btn = gr.Button(i18n.t('search_button'), variant="primary")
                    search_results_text = gr.Markdown()
                    search_gallery = gr.Gallery(label=i18n.t('search_results'), columns=4)

                    # ── Detail / edit panel for search results ──────────────
                    search_ids_state = gr.State([])

                    with gr.Accordion("📋 Image Details", open=False) as search_detail_acc:
                        with gr.Row():
                            with gr.Column(scale=1):
                                search_detail_img  = gr.Image(label="Selected image", interactive=False)
                                with gr.Row():
                                    search_dl_btn      = gr.Button("⬇️ Download", variant="secondary", scale=1)
                                    search_open_btn    = gr.Button("🖼️ Open in viewer", variant="secondary", scale=1)
                                search_dl_file     = gr.File(label="Download", visible=True)
                                search_open_result = gr.Markdown()
                            with gr.Column(scale=2):
                                with gr.Tabs():
                                    with gr.Tab("📋 Info & EXIF"):
                                        search_detail_info = gr.Markdown("_Select an image above._")
                                    with gr.Tab("✏️ Edit"):
                                        search_detail_desc  = gr.Textbox(label="Description", lines=3)
                                        search_detail_scene = gr.Dropdown(
                                            label="Scene type",
                                            choices=[''] + SCENE_TYPES,
                                            allow_custom_value=True,
                                        )
                                        search_detail_tags  = gr.Textbox(
                                            label="Tags (comma-separated)",
                                            placeholder="outdoor, family, summer…",
                                        )
                                        search_detail_save_btn = gr.Button("💾 Save metadata", variant="primary")
                                        gr.Markdown("---")
                                        search_detail_rename       = gr.Textbox(label="Rename to", placeholder="new_name.jpg")
                                        search_detail_rename_btn   = gr.Button("✏️ Rename file")
                                        search_detail_result       = gr.Markdown()
                        search_detail_id = gr.State(None)

                    def _search_load_detail(evt: gr.SelectData, ids):
                        iid = ids[evt.index] if ids and evt.index < len(ids) else None
                        img, exif_md, desc, scene, tags, _ = ui_get_image_detail(iid)
                        return img, exif_md, desc, scene, tags, iid

                    def _search_results_with_ids(name, max_r):
                        """Wrapper — search_by_person now returns IDs in the same order as gallery."""
                        status, items, id_list = search_by_person(name, max_r)
                        return status, items, id_list

                    search_btn.click(
                        fn=_search_results_with_ids,
                        inputs=[search_name, search_max],
                        outputs=[search_results_text, search_gallery, search_ids_state],
                    )
                    search_gallery.select(
                        fn=_search_load_detail,
                        inputs=[search_ids_state],
                        outputs=[search_detail_img, search_detail_info,
                                 search_detail_desc, search_detail_scene,
                                 search_detail_tags, search_detail_id],
                    )
                    search_detail_save_btn.click(
                        fn=ui_save_metadata,
                        inputs=[search_detail_id, search_detail_desc,
                                search_detail_scene, search_detail_tags],
                        outputs=search_detail_result,
                    )
                    search_detail_rename_btn.click(
                        fn=ui_rename_image,
                        inputs=[search_detail_id, search_detail_rename],
                        outputs=search_detail_result,
                    )
                    search_dl_btn.click(
                        fn=ui_download_image,
                        inputs=[search_detail_id],
                        outputs=search_dl_file,
                    )
                    search_open_btn.click(
                        fn=ui_open_in_os,
                        inputs=[search_detail_id],
                        outputs=search_open_result,
                    )

                # ============================================================
                # BROWSE TAB  (thumbnails · filters · inline edit)
                # ============================================================
                with gr.Tab(i18n.t('tab_browse')):
                    gr.Markdown(f"### {i18n.t('browse_description')}")

                    # ── Filters ─────────────────────────────────────────────
                    with gr.Accordion("🔍 Filters", open=True):
                        with gr.Row():
                            browse_person = gr.Textbox(
                                label="Person",
                                placeholder="Name contains…",
                                scale=2,
                            )
                            browse_tag = gr.Textbox(
                                label="Tag",
                                placeholder="Tag contains…",
                                scale=2,
                            )
                            browse_scene = gr.Dropdown(
                                label="Scene type",
                                choices=['All'] + SCENE_TYPES,
                                value='All',
                                scale=1,
                            )
                        with gr.Row():
                            browse_date_from = gr.Textbox(
                                label="Date from (YYYY-MM-DD)",
                                placeholder="2020-01-01",
                                scale=1,
                            )
                            browse_date_to = gr.Textbox(
                                label="Date to (YYYY-MM-DD)",
                                placeholder="2024-12-31",
                                scale=1,
                            )
                            browse_sort = gr.Dropdown(
                                label=i18n.t('sort_by'),
                                choices=[
                                    ("Newest added",     "newest"),
                                    ("Oldest added",     "oldest"),
                                    ("Date taken ↓",     "date_taken_desc"),
                                    ("Date taken ↑",     "date_taken_asc"),
                                    ("Most faces",       "most_faces"),
                                    ("Fewest faces",     "fewest_faces"),
                                    ("Filename A→Z",     "filename_az"),
                                    ("Filename Z→A",     "filename_za"),
                                ],
                                value="newest",
                                scale=2,
                            )
                            browse_max = gr.Slider(
                                label=i18n.t('max_results'),
                                minimum=10,
                                maximum=500,
                                value=100,
                                step=10,
                                scale=2,
                            )
                            browse_cols = gr.Slider(
                                label="Thumbnail columns",
                                minimum=1,
                                maximum=10,
                                value=5,
                                step=1,
                                scale=1,
                            )

                    browse_btn          = gr.Button("📚 Browse", variant="primary")
                    browse_results_text = gr.Markdown()
                    browse_gallery      = gr.Gallery(
                        label="",
                        columns=5,
                        height=520,
                        object_fit="cover",
                    )
                    browse_ids_state    = gr.State([])   # parallel list of image_ids

                    # ── Detail / edit panel ─────────────────────────────────
                    gr.Markdown("---")
                    gr.Markdown("### 📋 Image Details  _(click a thumbnail above)_")

                    with gr.Row():
                        with gr.Column(scale=1):
                            browse_detail_img = gr.Image(
                                label="Selected image",
                                interactive=False,
                                height=400,
                            )
                            with gr.Row():
                                browse_dl_btn   = gr.Button("⬇️ Download", variant="secondary", scale=1)
                                browse_open_btn = gr.Button("🖼️ Open in viewer", variant="secondary", scale=1)
                            browse_dl_file   = gr.File(label="Download", visible=True)
                            browse_open_result = gr.Markdown()

                        with gr.Column(scale=2):
                            with gr.Tabs():
                                with gr.Tab("📋 Info & EXIF"):
                                    browse_detail_info = gr.Markdown(
                                        "_Click a thumbnail to see image details here._"
                                    )
                                with gr.Tab("✏️ Edit metadata"):
                                    browse_detail_desc  = gr.Textbox(
                                        label="Description",
                                        lines=3,
                                        placeholder="A brief description of this image…",
                                    )
                                    browse_detail_scene = gr.Dropdown(
                                        label="Scene type",
                                        choices=[''] + SCENE_TYPES,
                                        allow_custom_value=True,
                                    )
                                    browse_detail_tags  = gr.Textbox(
                                        label="Tags (comma-separated)",
                                        placeholder="outdoor, family, birthday…",
                                    )
                                    browse_detail_save_btn = gr.Button(
                                        "💾 Save metadata", variant="primary"
                                    )
                                    gr.Markdown("---")
                                    with gr.Row():
                                        browse_detail_rename     = gr.Textbox(
                                            label="Rename file to",
                                            placeholder="new_filename.jpg",
                                            scale=3,
                                        )
                                        browse_detail_rename_btn = gr.Button(
                                            "✏️ Rename", scale=1
                                        )
                                    browse_detail_result = gr.Markdown()

                    browse_detail_id = gr.State(None)   # currently selected image_id

                    # ── Wire up browse ──────────────────────────────────────
                    def _do_browse(person, tag, scene, date_from, date_to, sort_by, limit, n_cols):
                        status, gallery_upd, ids = ui_browse(
                            person, tag, scene, date_from, date_to, sort_by, limit, n_cols
                        )
                        return status, gallery_upd, ids

                    def _browse_load_detail(evt: gr.SelectData, ids):
                        iid = ids[evt.index] if ids and evt.index < len(ids) else None
                        img, exif_md, desc, scene, tags, _ = ui_get_image_detail(iid)
                        return img, exif_md, desc, scene, tags, iid

                    browse_btn.click(
                        fn=_do_browse,
                        inputs=[browse_person, browse_tag, browse_scene,
                                browse_date_from, browse_date_to,
                                browse_sort, browse_max, browse_cols],
                        outputs=[browse_results_text, browse_gallery, browse_ids_state],
                    )
                    browse_gallery.select(
                        fn=_browse_load_detail,
                        inputs=[browse_ids_state],
                        outputs=[browse_detail_img, browse_detail_info,
                                 browse_detail_desc, browse_detail_scene,
                                 browse_detail_tags, browse_detail_id],
                    )
                    browse_detail_save_btn.click(
                        fn=ui_save_metadata,
                        inputs=[browse_detail_id, browse_detail_desc,
                                browse_detail_scene, browse_detail_tags],
                        outputs=browse_detail_result,
                    )
                    browse_detail_rename_btn.click(
                        fn=ui_rename_image,
                        inputs=[browse_detail_id, browse_detail_rename],
                        outputs=browse_detail_result,
                    )
                    browse_dl_btn.click(
                        fn=ui_download_image,
                        inputs=[browse_detail_id],
                        outputs=browse_dl_file,
                    )
                    browse_open_btn.click(
                        fn=ui_open_in_os,
                        inputs=[browse_detail_id],
                        outputs=browse_open_result,
                    )

                # ============================================================
                # BATCH TAB
                # ============================================================
                with gr.Tab(i18n.t('tab_batch')):
                    gr.Markdown(f"### {i18n.t('batch_description')}")
                    
                    batch_folder = gr.Textbox(
                        label=i18n.t('folder_path'),
                        placeholder="/path/to/images"
                    )
                    batch_extensions = gr.Textbox(
                        label=i18n.t('file_extensions'),
                        value=".jpg, .jpeg, .png, .pgm"  # ← Added .pgm here!
                    )
                    batch_recursive = gr.Checkbox(
                        label=i18n.t('recursive_scan'),
                        value=False
                    )
                    batch_btn = gr.Button(i18n.t('process_folder'), variant="primary")
                    batch_result = gr.Markdown()
                    
                    batch_btn.click(
                        fn=batch_process_folder,
                        inputs=[batch_folder, batch_extensions, batch_recursive],
                        outputs=batch_result,
                        show_progress="full"  # ← Also add this for visual progress bar!
                    )
                
                # ============================================================
                # STATISTICS TAB
                # ============================================================
                with gr.Tab(i18n.t('tab_stats')):
                    stats_refresh_btn = gr.Button(i18n.t('refresh_stats'), variant="secondary")
                    stats_display = gr.Markdown()
                    
                    stats_refresh_btn.click(
                        fn=get_statistics,
                        outputs=stats_display
                    )
                    
                    # Load stats on tab open
                    app.load(fn=get_statistics, outputs=stats_display)
                
                # ============================================================
                # SETTINGS TAB
                # ============================================================
                with gr.Tab(i18n.t('tab_settings')):
                    gr.Markdown(f"### {i18n.t('settings_title')}")
                    
                    with gr.Accordion(i18n.t('ui_settings'), open=True):
                        settings_language = gr.Dropdown(
                            label=i18n.t('language'),
                            choices=['de', 'en'],
                            value=i18n.get_language()
                        )
                    
                    with gr.Accordion(i18n.t('recognition_settings'), open=True):
                        # Build backend choices dynamically from what's installed
                        _avail = get_available_backends()
                        _backend_choices = [
                            (f"InsightFace — ArcFace 512-dim {'✓' if _avail['insightface'] else '✗ (not installed)'}",
                             'insightface'),
                            (f"dlib HOG — ResNet 128-dim {'✓' if _avail['dlib_hog'] else '✗ (not installed)'}",
                             'dlib_hog'),
                            (f"dlib CNN — ResNet 128-dim {'✓' if _avail['dlib_cnn'] else '✗ (not installed)'}",
                             'dlib_cnn'),
                        ]
                        _current_backend = (
                            app_state.engine.config.backend
                            if app_state.initialized and app_state.engine
                            else 'insightface'
                        )

                        settings_backend = gr.Dropdown(
                            label=i18n.t('backend'),
                            choices=_backend_choices,
                            value=_current_backend,
                        )
                        gr.Markdown(
                            "_Note: YuNet (OpenCV) is face **detection** only — it produces no embedding "
                            "vectors and cannot be used as a standalone recognition backend._",
                            visible=True,
                        )
                        settings_model = gr.Dropdown(
                            label=i18n.t('model'),
                            choices=['buffalo_l', 'buffalo_m', 'buffalo_s'],
                            value='buffalo_l'
                        )
                        settings_det_threshold = gr.Slider(
                            label=i18n.t('detection_threshold'),
                            minimum=0.1, maximum=1.0, value=0.6, step=0.05
                        )
                        settings_rec_threshold = gr.Slider(
                            label=i18n.t('recognition_threshold'),
                            minimum=0.1, maximum=1.0, value=0.4, step=0.05
                        )

                    settings_save_btn = gr.Button(i18n.t('save_settings'), variant="primary")
                    settings_result = gr.Markdown()

                    settings_save_btn.click(
                        fn=save_settings,
                        inputs=[
                            settings_language, settings_backend, settings_model,
                            settings_det_threshold, settings_rec_threshold,
                        ],
                        outputs=settings_result
                    )

                    # --------------------------------------------------------
                    # BACKEND SWITCH — clear embeddings
                    # --------------------------------------------------------
                    with gr.Accordion("⚠️ Backend switch — Clear embeddings", open=False):
                        gr.Markdown(
                            "Each backend stores face vectors in a **different dimensional space** "
                            "(InsightFace = 512-dim ArcFace, dlib = 128-dim ResNet).\n\n"
                            "**Switching backends requires clearing all stored embeddings and "
                            "re-training every person from scratch.**\n\n"
                            "The settings save button will block you if embeddings already exist "
                            "and you try to switch — use the button below first.\n\n"
                            "_Admin only._"
                        )
                        embed_stats_md = gr.Markdown()
                        with gr.Row():
                            embed_refresh_btn = gr.Button("🔄 Show current embedding stats")
                            embed_clear_btn   = gr.Button("🗑️ Clear ALL embeddings", variant="stop")
                        embed_result_md = gr.Markdown()

                        def _embed_stats():
                            if not app_state.initialized or not app_state.engine:
                                return "_(not initialised)_"
                            try:
                                conn = app_state.engine._get_connection()
                                rows = conn.execute(
                                    "SELECT embedding_dimension, COUNT(*) FROM face_embeddings "
                                    "GROUP BY embedding_dimension ORDER BY embedding_dimension"
                                ).fetchall()
                                total = conn.execute("SELECT COUNT(*) FROM face_embeddings").fetchone()[0]
                                conn.close()
                                if not rows:
                                    return "No embeddings stored — safe to switch backends."
                                lines = [f"**Total:** {total} embeddings\n"]
                                for dim, cnt in rows:
                                    backend_hint = "InsightFace" if dim == 512 else "dlib" if dim == 128 else "unknown"
                                    lines.append(f"- {cnt} × {dim}-dim ({backend_hint})")
                                return "\n".join(lines)
                            except Exception as e:
                                return f"❌ {e}"

                        embed_refresh_btn.click(fn=_embed_stats, outputs=embed_stats_md)
                        embed_clear_btn.click(fn=clear_all_embeddings, outputs=embed_result_md)

                    # --------------------------------------------------------
                    # DATABASE CONNECTION
                    # --------------------------------------------------------
                    with gr.Accordion("🗄️ Database Connection", open=False):
                        gr.Markdown(
                            "Switch the active SQLite database at runtime — useful for pointing "
                            "multiple instances at a **shared network drive** (SMB/NFS).  "
                            "The new path is saved to `config.yaml` and survives restarts. "
                            "_Admin only._"
                        )
                        db_info_md   = gr.Markdown()
                        db_path_input = gr.Textbox(
                            label="Database path (local or network)",
                            placeholder="/mnt/nas/facerec/face_recognition.db",
                            interactive=True,
                        )
                        with gr.Row():
                            db_refresh_btn = gr.Button("🔄 Refresh info")
                            db_connect_btn = gr.Button("🔌 Connect", variant="primary")
                        db_result_md = gr.Markdown()

                        faiss_interval = gr.Slider(
                            label="FAISS reload interval (seconds) — how often to check for remote changes",
                            minimum=5, maximum=300, value=30, step=5,
                            info="Increase for busy networks; decrease for faster cross-instance sync."
                        )
                        faiss_interval_btn = gr.Button("Apply interval")
                        faiss_result_md = gr.Markdown()

                        def _db_info():
                            s = app_state.get_db_stats()
                            if not s:
                                return "_(not initialised)_"
                            if 'error' in s:
                                return f"❌ {s['error']}\n\n`{s.get('path','?')}`"
                            return (
                                f"**Active DB:** `{s['path']}`\n\n"
                                f"| Persons | Embeddings | Images processed |\n"
                                f"|---|---|---|\n"
                                f"| {s['persons']} | {s['embeddings']} | {s['images']} |"
                            )

                        def _connect_db(new_path):
                            if not app_state.current_user or app_state.current_user.role != 'admin':
                                return "❌ Admin access required", _db_info()
                            ok, msg = app_state.switch_database(new_path)
                            return msg, _db_info()

                        def _set_faiss_interval(val):
                            if app_state.engine:
                                app_state.engine.config.faiss_sync_interval = float(val)
                                return f"✅ FAISS sync interval set to {val:.0f} s"
                            return "❌ Engine not initialised"

                        db_refresh_btn.click(fn=_db_info, outputs=db_info_md)
                        db_connect_btn.click(
                            fn=_connect_db,
                            inputs=db_path_input,
                            outputs=[db_result_md, db_info_md],
                        )
                        faiss_interval_btn.click(
                            fn=_set_faiss_interval,
                            inputs=faiss_interval,
                            outputs=faiss_result_md,
                        )

                    # --------------------------------------------------------
                    # API KEY MANAGEMENT
                    # --------------------------------------------------------
                    with gr.Accordion("🔑 API Key Management", open=False):
                        gr.Markdown(
                            "_Keys are stored encrypted. Stored keys are never shown in plaintext._"
                        )
                        apikey_provider = gr.Dropdown(
                            label="Provider",
                            choices=list(PROVIDER_CONFIGS.keys()),
                            value='anthropic'
                        )
                        apikey_status = gr.Markdown("Select a provider to see key status")

                        # Admin-only: system key section (visibility set after login)
                        with gr.Group() as system_key_group:
                            gr.Markdown("**System Key** — applies to all users (admin only)")
                            system_key_input = gr.Textbox(
                                label="New system key", type="password", placeholder="sk-..."
                            )
                            with gr.Row():
                                save_system_key_btn = gr.Button("✅ Test & Save system key", variant="primary", scale=2)
                                delete_system_key_btn = gr.Button("Delete system key", variant="stop", scale=1)
                            system_key_result = gr.Markdown()

                        gr.Markdown("---")
                        gr.Markdown("**Personal Key** — overrides the system key for your account")
                        user_key_input = gr.Textbox(
                            label="New personal key", type="password", placeholder="sk-..."
                        )
                        with gr.Row():
                            save_user_key_btn = gr.Button("✅ Test & Save personal key", variant="primary", scale=2)
                            delete_user_key_btn = gr.Button("Delete personal key", variant="secondary", scale=1)
                        user_key_result = gr.Markdown()

                        apikey_refresh_btn = gr.Button("Refresh key status", variant="secondary")

                        # Wire up key management buttons
                        def _refresh_status(provider):
                            return get_provider_key_status(provider)

                        apikey_provider.change(
                            fn=_refresh_status,
                            inputs=apikey_provider,
                            outputs=apikey_status
                        )
                        apikey_refresh_btn.click(
                            fn=_refresh_status,
                            inputs=apikey_provider,
                            outputs=apikey_status
                        )
                        save_system_key_btn.click(
                            fn=save_system_api_key,
                            inputs=[apikey_provider, system_key_input],
                            outputs=system_key_result
                        ).then(fn=_refresh_status, inputs=apikey_provider, outputs=apikey_status)

                        delete_system_key_btn.click(
                            fn=delete_system_api_key,
                            inputs=apikey_provider,
                            outputs=system_key_result
                        ).then(fn=_refresh_status, inputs=apikey_provider, outputs=apikey_status)

                        save_user_key_btn.click(
                            fn=save_user_api_key,
                            inputs=[apikey_provider, user_key_input],
                            outputs=user_key_result
                        ).then(fn=_refresh_status, inputs=apikey_provider, outputs=apikey_status)

                        delete_user_key_btn.click(
                            fn=delete_user_api_key,
                            inputs=apikey_provider,
                            outputs=user_key_result
                        ).then(fn=_refresh_status, inputs=apikey_provider, outputs=apikey_status)

                    # --------------------------------------------------------
                    # VLM ACTIVATION
                    # --------------------------------------------------------
                    with gr.Accordion("🤖 VLM Activation", open=False):
                        gr.Markdown(
                            "Select a provider and model, then click **Activate**. "
                            "The key stored above will be used automatically."
                        )
                        vlm_enable_chk = gr.Checkbox(label="Enable VLM image enrichment", value=False)
                        vlm_act_provider = gr.Dropdown(
                            label="Provider",
                            choices=list(PROVIDER_CONFIGS.keys()),
                            value='anthropic'
                        )
                        with gr.Row():
                            fetch_models_btn = gr.Button("Fetch models", variant="secondary")
                            vlm_act_model = gr.Dropdown(
                                label="Model",
                                choices=[],
                                value=None,
                                allow_custom_value=True,
                                interactive=True
                            )
                        fetch_models_status = gr.Markdown()
                        vlm_max_size = gr.Slider(
                            minimum=0, maximum=2048, value=0, step=16,
                            label="VLM Downsizing (Max Dimension)",
                            info="0 = disabled. Recommended for Mistral: 900px, Groq: 1024px."
                        )
                        
                        def _update_vlm_max_size(provider):
                            default = PROVIDER_CONFIGS.get(provider, {}).get('default_vlm_max_size', 0)
                            return gr.update(value=default)

                        activate_vlm_btn = gr.Button("Activate VLM", variant="primary")
                        vlm_activation_result = gr.Markdown()

                        def _fetch_models(provider):
                            models, msg = fetch_models_for_provider(provider)
                            default = PROVIDER_CONFIGS.get(provider, {}).get('default_model')
                            chosen = default if default in models else (models[0] if models else None)
                            return gr.update(choices=models, value=chosen), msg

                        fetch_models_btn.click(
                            fn=_fetch_models,
                            inputs=vlm_act_provider,
                            outputs=[vlm_act_model, fetch_models_status]
                        )
                        activate_vlm_btn.click(
                            fn=activate_vlm_provider,
                            inputs=[vlm_enable_chk, vlm_act_provider, vlm_act_model, vlm_max_size],
                            outputs=vlm_activation_result
                        )
                
                # ============================================================
                # ADMIN TAB
                # ============================================================
                with gr.Tab(i18n.t('tab_admin')):
                    gr.Markdown(f"### {i18n.t('admin_title')}")
                    
                    with gr.Accordion(i18n.t('mount_drives'), open=False):
                        mount_type = gr.Dropdown(
                            label=i18n.t('mount_type'),
                            choices=['SMB/CIFS'],
                            value='SMB/CIFS'
                        )
                        mount_server = gr.Textbox(label=i18n.t('server_address'))
                        mount_share = gr.Textbox(label=i18n.t('share_path'))
                        mount_point = gr.Textbox(label=i18n.t('mount_point'))
                        mount_user = gr.Textbox(label=i18n.t('username'))
                        mount_pass = gr.Textbox(label=i18n.t('password'), type="password")
                        mount_domain = gr.Textbox(label=i18n.t('domain'))
                        mount_readonly = gr.Checkbox(label=i18n.t('read_only'), value=False)
                        mount_btn = gr.Button(i18n.t('mount_button'), variant="primary")
                        mount_result = gr.Markdown()
                        
                        mount_btn.click(
                            fn=mount_network_drive,
                            inputs=[
                                mount_type, mount_server, mount_share, mount_point,
                                mount_user, mount_pass, mount_domain, mount_readonly
                            ],
                            outputs=mount_result
                        )
                    
                    with gr.Accordion(i18n.t('user_management'), open=True):
                        user_username = gr.Textbox(label=i18n.t('user_name'))
                        user_password = gr.Textbox(label=i18n.t('user_password'), type="password")
                        user_role = gr.Dropdown(
                            label=i18n.t('user_role'),
                            choices=[i18n.t('role_admin'), i18n.t('role_user')],
                            value=i18n.t('role_user')
                        )
                        user_folders = gr.Textbox(
                            label=i18n.t('allowed_folders'),
                            lines=5,
                            placeholder="/home/user/photos\n/mnt/nas"
                        )
                        user_create_btn = gr.Button(i18n.t('create_user'), variant="primary")
                        user_result = gr.Markdown()
                        
                        user_create_btn.click(
                            fn=create_new_user,
                            inputs=[user_username, user_password, user_role, user_folders],
                            outputs=user_result
                        )
                        
                        user_list_btn = gr.Button(i18n.t('list_users'), variant="secondary")
                        user_list_result = gr.Markdown()
                        
                        user_list_btn.click(
                            fn=list_all_users,
                            outputs=user_list_result
                        )
        
        # Login handler
        login_btn.click(
            fn=handle_login,
            inputs=[login_username, login_password],
            outputs=[login_status, login_section, main_content, user_state, system_key_group]
        )
    
    return app

def fix_broken_confidence_data(db_path: str = "face_recognition.db"):
    """Fix existing records with invalid recognition_confidence."""
    import sqlite3
    
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # Fix NULL values
    cursor.execute("""
        UPDATE face_embeddings 
        SET recognition_confidence = 0.0 
        WHERE recognition_confidence IS NULL
    """)
    
    # Fix values outside range
    cursor.execute("""
        UPDATE face_embeddings 
        SET recognition_confidence = 0.0 
        WHERE recognition_confidence < 0.0
    """)
    
    cursor.execute("""
        UPDATE face_embeddings 
        SET recognition_confidence = 1.0 
        WHERE recognition_confidence > 1.0
    """)
    
    rows_fixed = cursor.rowcount
    conn.commit()
    conn.close()
    
    print(f"✅ Fixed {rows_fixed} records with broken confidence data")


# ============================================================================
# MAIN
# ============================================================================

if __name__ == "__main__":
    # Initialize application
    logger.info("Starting Face Recognition System...")
    
    success, message = app_state.initialize()
    if not success:
        logger.error(f"Failed to initialize: {message}")
        print(f"\n{message}\n")
        print("Please ensure:")
        print("1. Database schema is initialized (run schema_complete.sql)")
        print("2. Required packages are installed (run setup.sh)")
        print("3. config.yaml exists with valid configuration")
        exit(1)
    
    logger.info(message)

    fix_broken_confidence_data()
    
    # Build UI
    app = build_ui()
    
    # Get server config
    server_config = app_state.config.get('ui', {}).get('server', {})

    # Electron wrapper: FACE_REC_PORT overrides config; bind to localhost only
    _env_port = os.environ.get('FACE_REC_PORT')
    _host = '127.0.0.1' if _DATA_DIR else server_config.get('host', '0.0.0.0')
    _port = int(_env_port) if _env_port else server_config.get('port', 7860)

    # Custom CSS for Gradio 6.0
    custom_css = """
    .main-container {
        max-width: 1400px;
        margin: auto;
    }
    .gradio-container {
        font-family: 'Inter', sans-serif;
    }
    """
    
    # Launch - Gradio 6.0 style (theme and css passed here)
    # Allow Gradio to serve thumbnail files and the directory containing the DB
    # (the user's actual photo directories are not known at startup — add them
    #  here if you have a fixed photos root, or leave blank; Gradio falls back
    #  to returning numpy arrays for images outside allowed paths).
    _db_dir    = os.path.dirname(os.path.abspath(
        app_state.engine.db_path if app_state.initialized else 'face_recognition.db'
    ))
    _allowed   = [_THUMB_DIR, _db_dir]

    app.launch(
        server_name=_host,
        server_port=_port,
        share=False if _DATA_DIR else server_config.get('share', False),
        show_error=True,
        quiet=False,
        allowed_paths=_allowed,
        css=custom_css,
    )