"""
routers/settings.py — Config read/write, re-init engine.
"""
import logging
import os
import sqlite3
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

import yaml
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from routers.deps import require_admin, get_current_user

router = APIRouter()


def _state():
    from fastapi_app import state
    return state


class SettingsPatch(BaseModel):
    language:              Optional[str]        = None
    backend:               Optional[str]        = None
    model:                 Optional[str]        = None
    det_threshold:         Optional[float]      = None
    rec_threshold:         Optional[float]      = None
    det_size:              Optional[int]        = None
    det_model:             Optional[str]        = None   # 'auto'|'retinaface'|'scrfd'|'yunet'|'mediapipe'
    vlm_provider:          Optional[str]        = None
    vlm_model:             Optional[str]        = None
    vlm_enabled:           Optional[bool]       = None
    # Storage: if set, uploaded images are resized to this max dimension before saving.
    # 0 = keep full resolution (default).
    upload_max_dimension:  Optional[int]        = None
    # Admin: paths that are already on the server — uploaded files from these locations
    # are recorded in-place (no copy to uploads/).  Default: ['/mnt']
    copy_exempt_paths:     Optional[list]       = None
    # Admin: path to fix_db.sh for the one-click server update feature.
    fix_db_path:           Optional[str]        = None


_DE: dict = {
    'app_title': 'CrispLens', 'app_subtitle': 'KI-gestützte Bild- und Gesichtserkennung',
    'version': 'Version', 'welcome': 'Willkommen', 'logout': 'Abmelden', 'login': 'Anmelden',
    'details': 'Details', 'training_in_progress': 'Training',
    'tab_recognize': 'Erkennen', 'tab_train': 'Trainieren', 'tab_people': 'Personen',
    'tab_tags': 'Tags', 'tab_search': 'Suchen', 'tab_browse': 'Durchsuchen',
    'tab_batch': 'Stapelverarbeitung', 'tab_stats': 'Statistiken', 'tab_settings': 'Einstellungen',
    'tab_admin': 'Admin', 'tab_export': 'Export', 'tab_timeline': 'Zeitleiste', 'tab_folders': 'Ordner',
    'upload_image': 'Bild hochladen', 'upload_multiple': 'Mehrere Bilder hochladen',
    'process_image': 'Bild verarbeiten', 'processing': 'Verarbeitung...', 'detection_results': 'Erkennungsergebnisse',
    'total_faces': 'Gesichter gesamt', 'known_people': 'Bekannte Personen', 'unknown_people': 'Unbekannte Personen',
    'ai_analysis': 'KI-Analyse', 'description': 'Beschreibung', 'filename': 'Dateiname',
    'scene_type': 'Szenentyp', 'tags': 'Tags', 'confidence': 'Konfidenz', 'quality': 'Qualität',
    'date_created': 'Erstellungsdatum', 'date_modified': 'Änderungsdatum', 'camera_model': 'Kameramodell',
    'person_name': 'Personenname', 'training_images': 'Trainingsbilder hochladen',
    'training_method': 'Trainingsmethode', 'train_upload': 'Bilder hochladen', 'train_folder': 'Ordner scannen',
    'folder_path': 'Ordnerpfad', 'scan_folder': 'Ordner scannen', 'train_system': 'System trainieren',
    'training_complete': 'Training abgeschlossen!', 'training_failed': 'Training fehlgeschlagen',
    'training_tips': 'Trainingshinweise',
    'search_description': 'Bilder mit bestimmten Personen suchen',
    'search_button': 'Suchen', 'search_results': 'Suchergebnisse für',
    'no_results_found': 'Keine Ergebnisse gefunden', 'refresh': 'Aktualisieren',
    'browse_description': 'Alle verarbeiteten Bilder durchsuchen', 'filter_options': 'Filteroptionen',
    'filter_by_people': 'Nach Personen filtern', 'sort_by': 'Sortieren nach',
    'sort_newest': 'Neueste zuerst', 'sort_oldest': 'Älteste zuerst',
    'merge': 'Zusammenführen', 'select_all': 'Alle auswählen', 'deselect_all': 'Auswahl aufheben',
    'batch_description': 'Gesamte Ordner verarbeiten', 'select_folder': 'Ordner wählen',
    'recursive_scan': 'Unterordner einschließen', 'process_folder': 'Ordner verarbeiten',
    'batch_progress': 'Fortschritt', 'batch_complete': 'Stapelverarbeitung abgeschlossen!',
    'processed': 'Verarbeitet', 'failed': 'Fehlgeschlagen', 'skipped': 'Übersprungen', 'remaining': 'Verbleibend',
    'stop_processing': 'Stopp', 'resume_processing': 'Fortsetzen',
    'stats_overview': 'Übersicht', 'stats_total_people': 'Personen gesamt', 'stats_total_images': 'Bilder gesamt',
    'stats_total_faces': 'Erkannte Gesichter', 'stats_database': 'Datenbank',
    'refresh_stats': 'Aktualisieren',
    'settings_title': 'Systemkonfiguration', 'recognition_settings': 'Erkennungseinstellungen',
    'backend': 'Backend', 'model': 'Modell', 'detection_threshold': 'Erkennungsschwelle',
    'recognition_threshold': 'Erkennungsschwellwert', 'use_gpu': 'GPU verwenden',
    'ai_enrichment': 'KI-Anreicherung', 'enable_vlm': 'VLM aktivieren',
    'vlm_provider': 'VLM-Anbieter', 'vlm_api_key': 'API-Schlüssel', 'vlm_model': 'Modell',
    'ui_settings': 'Benutzeroberfläche', 'language': 'Sprache',
    'save_settings': 'Einstellungen speichern', 'reset_settings': 'Zurücksetzen',
    'user_management': 'Benutzerverwaltung', 'username': 'Benutzername', 'password': 'Passwort',
    'role_admin': 'Administrator', 'role_user': 'Benutzer',
    'no_image': 'Bitte ein Bild hochladen', 'no_faces_detected': 'Keine Gesichter erkannt',
    'settings_saved': 'Einstellungen gespeichert', 'error': 'Fehler', 'success': 'Erfolg',
    'please_wait': 'Bitte warten...', 'loading': 'Lädt...', 'no_key': 'Kein Schlüssel', 'of': 'von',
    'ok': 'OK', 'cancel': 'Abbrechen', 'save': 'Speichern', 'delete': 'Löschen', 'edit': 'Bearbeiten',
    'view': 'Ansehen', 'download': 'Herunterladen', 'upload': 'Hochladen', 'clear': 'Leeren', 'reset': 'Zurücksetzen',
    'confirm': 'Bestätigen', 'back': 'Zurück', 'next': 'Weiter', 'previous': 'Zurück',
    'search_by_date': 'Datum',
    'change_password': 'Passwort ändern',
    'current_password': 'Aktuelles Passwort',
    'new_password': 'Neues Passwort',
    'confirm_password': 'Passwort bestätigen',
    'password_changed': 'Passwort erfolgreich geändert',
    'set_password': 'Passwort setzen',
    'test_key': 'Testen',
    'key_valid': 'Schlüssel gültig',
    'key_invalid': 'Ungültiger Schlüssel',
    # Cloud drives
    'cloud_drives': 'Cloud-Laufwerke',
    'add_drive': 'Laufwerk hinzufügen',
    'no_cloud_drives': 'Keine Cloud-Laufwerke konfiguriert',
    'no_cloud_drives_hint': 'Netzwerkfreigabe oder Cloud-Konto hinzufügen',
    'drive_name': 'Laufwerkname', 'drive_type': 'Typ', 'drive_host': 'Host', 'drive_server': 'Server',
    'drive_share': 'Freigabe', 'drive_username': 'Benutzername', 'drive_password': 'Passwort',
    'drive_domain': 'Domäne', 'drive_port': 'Port', 'drive_remote_path': 'Entfernter Pfad',
    'drive_ssh_key': 'SSH-Schlüssel', 'drive_email': 'E-Mail', 'drive_tfa': '2FA-Code',
    'drive_mount_point': 'Einhängepunkt', 'drive_read_only': 'Nur lesen',
    'drive_scope': 'Bereich', 'drive_scope_system': 'System', 'drive_scope_user': 'Persönlich',
    'drive_allowed_roles': 'Erlaubte Rollen', 'drive_auto_mount': 'Automatisch einbinden',
    'drive_edit': 'Bearbeiten', 'drive_save': 'Laufwerk speichern', 'drive_delete': 'Laufwerk löschen',
    'drive_delete_confirm': 'Laufwerk löschen?',
    'drive_connect': 'Verbinden', 'drive_disconnect': 'Trennen',
    'drive_mount': 'Einbinden', 'drive_unmount': 'Trennen', 'drive_test': 'Testen',
    'drive_status_connected': 'Verbunden', 'drive_status_mounted': 'Eingebunden', 'drive_status_offline': 'Offline',
    'drive_placeholder_name': 'Mein Laufwerk', 'drive_placeholder_host': 'z.B. 192.168.1.1',
    'drive_placeholder_server': '//server/freigabe', 'drive_placeholder_share': 'freigabe',
    'drive_placeholder_remote_path': '/entfernter/pfad', 'drive_placeholder_ssh_key': '/pfad/zum/schlüssel',
    'drive_placeholder_tfa': '2FA-Code', 'drive_placeholder_mount_smb': '/mnt/smb',
    'drive_placeholder_mount_sftp': '/mnt/sftp',
    # Face identification / clusters
    'face_identification': 'Gesichtserkennung', 'face_clusters': 'Gesichtsgruppen',
    'face_num': 'Gesicht #', 'identify_persons': 'Identifizieren',
    'person_name_placeholder': 'Name eingeben…', 'type_name_placeholder': 'Name eingeben…',
    'enter_person_name': 'Personenname eingeben',
    'all_faces_identified': 'Alle Gesichter identifiziert', 'no_faces_in_image': 'Keine Gesichter in diesem Bild',
    'no_clusters_found': 'Keine Gesichtsgruppen gefunden',
    'no_clusters_detail': 'Weitere Bilder verarbeiten um Gesichtsgruppen zu erstellen',
    'clustering_faces': 'Gesichter werden gruppiert…', 'similarity_threshold': 'Ähnlichkeitsschwelle',
    'lower_threshold_hint': 'Niedrigerer Schwellwert = mehr Ergebnisse',
    'recognition_certainty': 'Gewissheit', 'conf_short': 'Konf',
    'clear_all_identifications': 'Alle Identifikationen löschen',
    'clear_all_detections': 'Alle Erkennungen löschen',
    'downsize_before_detect': 'Verkleinern auf (px)',
    'downsize_original': 'Original',
    'drag_to_mark_face': 'Ziehen um Gesicht zu markieren',
    # Train
    'browse_button': 'Durchsuchen',
    'train_folder_description': 'Ordner mit benannten Unterordnern (je eine Person)',
    # Sort options
    'sort_date_taken_asc': 'Aufnahmedatum (älteste)', 'sort_date_taken_desc': 'Aufnahmedatum (neueste)',
    'sort_filename_az': 'Dateiname A–Z', 'sort_most_faces': 'Meiste Gesichter',
    # Stats
    'stats_images_with_date': 'Bilder mit Datum',
    # Lightbox / image ops
    'zoom_in': 'Vergrößern', 'zoom_out': 'Verkleinern', 'fit_to_screen': 'Bildschirm füllen',
    'press_esc_to_close': 'Esc zum Schließen', 'close': 'Schließen',
    'run_detection': 'Erkennung starten', 'remove_detection': 'Erkennung entfernen',
    'min_face_size': 'Min. Gesichtsgröße',
    # Misc
    'apply': 'Anwenden', 'apply_to_all': 'Auf alle anwenden', 'apply_to_selected': 'Auf Auswahl anwenden',
    'skip': 'Überspringen', 'rescan': 'Neu scannen', 'scanning': 'Scannt…', 'save_all': 'Alle speichern',
    'deselect': 'Auswahl aufheben', 'selection': 'Auswahl', 'source': 'Quelle', 'target': 'Ziel',
    'search_name': 'Nach Name suchen…', 'operation_cancelled': 'Abgebrochen',
    'people_detected': 'Erkannte Personen', 'process_more_images': 'Weitere Bilder verarbeiten',
    'image_pending': '1 Bild ausstehend', 'images_pending': '{n} Bilder ausstehend',
    # Detection model
    'detection_model': 'Erkennungsmodell',
    'det_model_auto': 'Auto (Standard)',
    'det_model_retinaface': 'RetinaFace',
    'det_model_scrfd': 'SCRFD (nicht-frontal)',
    'det_model_yunet': 'YuNet (CPU)',
    'det_model_mediapipe': 'MediaPipe (CPU)',
    'user_detection_prefs': 'Erkennungsmodell-Einstellungen',
    'det_model_global_hint': 'Systemstandard',
    # Re-identify modal strings (previously hardcoded English)
    'also_run_vlm': 'VLM-Beschreibung erneuern',
    # Rescan mode
    'rescan_mode_both': 'Beides',
    'rescan_mode_faces': 'Gesichter',
    'rescan_mode_vlm': 'VLM',
    # Settings sections (added 2026-02-27 — were missing from server dict,
    # causing fallback to English even when DE was selected)
    'settings_server_section':    'FastAPI Server',
    'settings_mode_run_local':    'Lokal auf diesem Rechner ausführen',
    'settings_mode_run_local_hint':'App verwaltet eigenen Python/FastAPI-Prozess',
    'settings_mode_remote':       'Mit Remote-Server verbinden (VPS)',
    'settings_mode_remote_hint':  'Verbindung zu vorhandener FastAPI-Instanz',
    'settings_server_restart_hint':'Änderungen am Server-Modus erfordern einen Neustart.',
    'settings_local_port':        'Lokaler Port',
    'settings_server_url':        'Server-URL',
    'settings_db_section':        'Datenbank',
    'settings_db_switch_hint':    'Zwischen lokalen SQLite-Datenbankdateien wechseln. Erfordert Neustart.',
    'settings_db_current':        'Aktuelle DB',
    'settings_db_switch_to':      'Wechseln zu',
    'settings_db_switch_btn':     'Datenbank wechseln & Neustart',
    'settings_db_remote_info':    'Datenbank wird vom Remote-Server verwaltet.',
    'settings_img_proc_section':  'Bildverarbeitung',
    'settings_python_path':       'Python-Pfad',
    'settings_upload_mode':       'Bilder auf Server hochladen',
    'settings_upload_mode_hint':  'Lokale Bilder an VPS senden — Server führt InsightFace + VLM aus',
    'settings_local_proc_mode':   'Lokaler Verarbeitungsmodus',
    'settings_local_proc_mode_hint':'InsightFace lokal ausführen → nur Embeddings + Thumbnail hochladen (kein VLM)',
    'settings_local_model':       'Lokales Modell',
    'settings_det_size':          'Erkennungsgröße',
    'settings_det_size_hint':     'Größere Werte erkennen kleinere Gesichter, sind aber langsamer.',
    'settings_storage_section':   'Speicher',
    'settings_storage_hint':      'Maximale Bildgröße nach dem Hochladen begrenzen. Spart Speicherplatz, wenn Originale lokal bleiben.',
    'settings_upload_max_dim':    'Max. Auflösung beim Hochladen (px)',
    'settings_no_resize':         'Volle Auflösung (keine Größenänderung)',
    'settings_resize_hint':       'Bilder werden vor dem Speichern skaliert',
    'settings_db_health':         'Datenbank-Diagnose',
    'settings_engine_section':    'Gesichtserkennungs-Engine',
    'settings_engine_ready':      '✓ Bereit',
    'settings_engine_not_ready':  '✗ Nicht bereit',
    'settings_reload_engine':     'Engine neu laden',
    'add_user':                   'Benutzer hinzufügen',
    'add':                        'Hinzufügen',
    # Admin / server management
    'admin_server_mgmt':   'Server-Verwaltung',
    'admin_update_server': 'Server aktualisieren',
    'admin_view_logs':     'Logs anzeigen',
    'admin_run_update':    'Update starten',
    'update_modal_hint':   'Führt fix_db.sh als root aus (git pull + DB-Migrationen + Neustart). Die Verbindung wird beim Neustart unterbrochen.',
    'root_password':       'Root-Passwort',
    'running':             'Läuft…',
    'admin_logs_title':    'Server-Logs',
    'logs_refresh':        'Aktualisieren',
    'logs_follow':         'Folgen',
    'exempt_paths_label':  'Kopier-Ausnahmepfade',
    'exempt_paths_hint':   'Dateien von diesen Server-Pfaden werden direkt in der DB registriert (keine Kopie nach uploads/).',
    'fix_db_path_label':   'fix_db.sh Pfad',
    'fix_db_path_hint':    'Vollständiger Pfad zu fix_db.sh auf dem Server.',
}

_TRANSLATIONS: dict[str, dict] = {'de': _DE}


@router.get("/i18n")
def get_i18n():
    """Return the UI translation strings for the configured language."""
    s = _state()
    language = (s.config or {}).get('ui', {}).get('language', 'en')
    tr = _TRANSLATIONS.get(language, {})
    return {"lang": language, "translations": tr}


@router.get("")
def get_settings():
    s = _state()
    return s.config or {}


@router.put("")
def put_settings(body: SettingsPatch, user=Depends(get_current_user)):
    s = _state()
    config = dict(s.config or {})

    # Face-recognition system settings + global VLM defaults are admin-only
    _admin_fields = (body.backend, body.model, body.det_threshold,
                     body.rec_threshold, body.det_size, body.det_model,
                     body.vlm_provider, body.vlm_model, body.vlm_enabled)
    if any(f is not None for f in _admin_fields) and user.role != 'admin':
        raise HTTPException(
            status_code=403,
            detail="Recognition settings and global VLM defaults require admin access. "
                   "Use PUT /api/settings/user-vlm to set your personal VLM preferences.",
        )

    if body.language is not None:
        config.setdefault('ui', {})['language'] = body.language

    if body.backend is not None or body.model is not None or \
       body.det_threshold is not None or body.rec_threshold is not None or \
       body.det_size is not None or body.det_model is not None:
        fr = config.setdefault('face_recognition', {})
        if body.backend is not None:
            fr['backend'] = body.backend
        isf = fr.setdefault('insightface', {})
        if body.model is not None:
            isf['model'] = body.model
        if body.det_threshold is not None:
            isf['detection_threshold'] = body.det_threshold
        if body.rec_threshold is not None:
            isf['recognition_threshold'] = body.rec_threshold
        if body.det_size is not None:
            isf['det_size'] = [body.det_size, body.det_size]
        if body.det_model is not None:
            isf['det_model'] = body.det_model

    if body.vlm_provider is not None or body.vlm_model is not None or body.vlm_enabled is not None:
        vlm = config.setdefault('vlm', {})
        if body.vlm_enabled is not None:
            vlm['enabled'] = body.vlm_enabled
        if body.vlm_provider is not None:
            vlm['provider'] = body.vlm_provider
        if body.vlm_model is not None:
            vlm['model'] = body.vlm_model

    if body.upload_max_dimension is not None:
        config.setdefault('storage', {})['upload_max_dimension'] = body.upload_max_dimension

    # Admin-only storage + admin config keys
    if body.copy_exempt_paths is not None or body.fix_db_path is not None:
        if user.role != 'admin':
            raise HTTPException(status_code=403, detail="Admin access required")
        if body.copy_exempt_paths is not None:
            config.setdefault('storage', {})['copy_exempt_paths'] = body.copy_exempt_paths
        if body.fix_db_path is not None:
            config.setdefault('admin', {})['fix_db_path'] = body.fix_db_path

    # Strip legacy plaintext keys
    config.get('vlm', {}).get('api', {}).pop('key', None)

    # Write back
    _DATA_DIR = os.environ.get('FACE_REC_DATA_DIR', '')
    config_path = os.path.join(_DATA_DIR, 'config.yaml') if _DATA_DIR else 'config.yaml'
    try:
        with open(config_path, 'w') as f:
            yaml.safe_dump(config, f, default_flow_style=False, allow_unicode=True)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write config: {e}")

    s.config = config

    # Update engine config if face recognition settings changed
    if body.backend is not None or body.model is not None or \
       body.det_threshold is not None or body.rec_threshold is not None or \
       body.det_size is not None or body.det_model is not None:
        from face_recognition_core import FaceRecognitionConfig
        new_face_cfg = FaceRecognitionConfig(config.get('face_recognition', {}))
        # If backend or model changed, we must re-init. 
        # If only thresholds/size changed, we could just update attributes, 
        # but re-creating the engine instance is safer and ensure lazy-init handles it.
        if body.backend is not None or body.model is not None:
            from face_recognition_core import FaceRecognitionEngine
            s.engine = FaceRecognitionEngine(s.db_path, new_face_cfg)
        else:
            s.engine.config = new_face_cfg

    # Re-init VLM provider if vlm settings changed
    if body.vlm_provider is not None or body.vlm_model is not None or body.vlm_enabled is not None:
        from vlm_providers import create_vlm_provider, VLMConfig
        vlm_cfg = config.get('vlm', {})
        if vlm_cfg.get('enabled', False):
            provider = vlm_cfg.get('provider', 'anthropic')
            model = vlm_cfg.get('model') or None
            api_key = s.api_key_manager.get_effective_key(provider, None)
            endpoint = vlm_cfg.get('api', {}).get('endpoint') or None
            s.vlm_provider = create_vlm_provider(
                provider=provider, api_key=api_key,
                endpoint=endpoint, model=model, config=VLMConfig(),
            )
        else:
            s.vlm_provider = None

    return {"ok": True}


# ── Per-user VLM preferences ──────────────────────────────────────────────────

def get_effective_vlm_provider(user, state):
    """
    Resolve the VLM provider for a given user.

    Priority: user personal override → global config.yaml default.
    Returns a VLM provider instance or None if VLM is disabled/unconfigured.
    """
    from vlm_providers import create_vlm_provider, VLMConfig

    global_vlm = (state.config or {}).get('vlm', {})

    # Enabled: user override wins over global
    user_enabled = user.vlm_enabled   # None = no override
    if user_enabled is not None:
        enabled = bool(user_enabled)
    else:
        enabled = global_vlm.get('enabled', False)

    logger.info(
        'get_effective_vlm_provider: user=%s | user.vlm_enabled=%s user.vlm_provider=%s user.vlm_model=%s'
        ' | global_enabled=%s global_provider=%s global_model=%s | resolved_enabled=%s',
        user.username,
        user.vlm_enabled, user.vlm_provider, user.vlm_model,
        global_vlm.get('enabled'), global_vlm.get('provider'), global_vlm.get('model'),
        enabled,
    )

    if not enabled:
        return None

    provider = user.vlm_provider or global_vlm.get('provider', 'anthropic')
    model    = user.vlm_model    or global_vlm.get('model') or None

    api_key  = state.api_key_manager.get_effective_key(provider, user.username)
    has_key  = bool(api_key)
    endpoint = global_vlm.get('api', {}).get('endpoint') or None

    logger.info(
        'get_effective_vlm_provider: resolved provider=%s model=%s has_key=%s endpoint=%s',
        provider, model, has_key, endpoint,
    )

    return create_vlm_provider(
        provider=provider, api_key=api_key,
        endpoint=endpoint, model=model, config=VLMConfig(),
    )


class UserVlmPrefs(BaseModel):
    vlm_enabled:  Optional[bool] = None   # None = reset to global default
    vlm_provider: Optional[str]  = None   # None = reset to global default
    vlm_model:    Optional[str]  = None   # None = reset to global default


@router.get("/user-vlm")
def get_user_vlm(user=Depends(get_current_user)):
    """Return the current user's personal VLM preferences + global defaults."""
    s = _state()
    global_vlm = (s.config or {}).get('vlm', {})
    logger.info(
        'get_user_vlm: user=%s | vlm_enabled=%s vlm_provider=%s vlm_model=%s',
        user.username, user.vlm_enabled, user.vlm_provider, user.vlm_model,
    )
    return {
        'user': {
            'vlm_enabled':  user.vlm_enabled,
            'vlm_provider': user.vlm_provider,
            'vlm_model':    user.vlm_model,
        },
        'global': {
            'vlm_enabled':  global_vlm.get('enabled', False),
            'vlm_provider': global_vlm.get('provider', 'anthropic'),
            'vlm_model':    global_vlm.get('model'),
        },
        'effective': {
            'vlm_enabled':  bool(user.vlm_enabled) if user.vlm_enabled is not None
                            else global_vlm.get('enabled', False),
            'vlm_provider': user.vlm_provider or global_vlm.get('provider', 'anthropic'),
            'vlm_model':    user.vlm_model or global_vlm.get('model'),
        },
    }


@router.put("/user-vlm")
def put_user_vlm(body: UserVlmPrefs, user=Depends(get_current_user)):
    """Save current user's personal VLM preferences (any authenticated user)."""
    s = _state()
    import sqlite3 as _sqlite3
    # Encode: True→1, False→0, None→NULL (reset to global)
    enabled_val = (1 if body.vlm_enabled else 0) if body.vlm_enabled is not None else None
    logger.info(
        'put_user_vlm: user=%s id=%s | vlm_enabled=%s→%s vlm_provider=%s vlm_model=%s',
        user.username, user.id, body.vlm_enabled, enabled_val, body.vlm_provider, body.vlm_model,
    )
    conn = None
    try:
        conn = _sqlite3.connect(s.db_path)
        try:
            conn.execute(
                'UPDATE users SET vlm_enabled = ?, vlm_provider = ?, vlm_model = ? WHERE id = ?',
                (enabled_val, body.vlm_provider, body.vlm_model, user.id),
            )
        except _sqlite3.OperationalError as col_err:
            if 'no such column' in str(col_err) or 'no column named' in str(col_err):
                # Columns added in a later migration — add them and retry
                for col, typ in [('vlm_enabled', 'INTEGER'), ('vlm_provider', 'TEXT'), ('vlm_model', 'TEXT')]:
                    try:
                        conn.execute(f'ALTER TABLE users ADD COLUMN {col} {typ}')
                    except _sqlite3.OperationalError:
                        pass  # already exists
                conn.execute(
                    'UPDATE users SET vlm_enabled = ?, vlm_provider = ?, vlm_model = ? WHERE id = ?',
                    (enabled_val, body.vlm_provider, body.vlm_model, user.id),
                )
            else:
                raise
        conn.commit()
        logger.info('put_user_vlm: DB commit OK for user_id=%s', user.id)
    except Exception as e:
        logger.error('put_user_vlm: DB write failed for user_id=%s: %s', user.id, e)
        raise HTTPException(status_code=500, detail=f"Failed to save VLM preferences: {e}")
    finally:
        if conn:
            conn.close()
    return {'ok': True}


# ── Per-user detection model preferences ─────────────────────────────────────

_VALID_DET_MODELS = {'auto', 'retinaface', 'scrfd', 'yunet', 'mediapipe'}


def get_effective_det_model(user, state) -> str:
    """
    Resolve the detection model for a given user.

    Priority: user personal override → global config.yaml default → 'auto'.
    Returns a model key string ('auto'|'retinaface'|'scrfd'|'yunet'|'mediapipe').
    """
    global_isf = (state.config or {}).get('face_recognition', {}).get('insightface', {})
    return user.det_model or global_isf.get('det_model', 'auto') or 'auto'


class UserDetPrefs(BaseModel):
    det_model: Optional[str] = None   # None = reset to global default


@router.get("/user-detection")
def get_user_detection(user=Depends(get_current_user)):
    """Return current user's personal detection model preference + global default."""
    s = _state()
    global_isf = (s.config or {}).get('face_recognition', {}).get('insightface', {})
    global_det = global_isf.get('det_model', 'auto') or 'auto'
    return {
        'user': {'det_model': user.det_model},
        'global': {'det_model': global_det},
        'effective': {'det_model': user.det_model or global_det},
    }


@router.put("/user-detection")
def put_user_detection(body: UserDetPrefs, user=Depends(get_current_user)):
    """Save current user's personal detection model preference."""
    if body.det_model is not None and body.det_model not in _VALID_DET_MODELS:
        raise HTTPException(status_code=422, detail=f"Invalid det_model: {body.det_model!r}")
    s = _state()
    import sqlite3 as _sqlite3
    conn = None
    try:
        conn = _sqlite3.connect(s.db_path)
        try:
            conn.execute('UPDATE users SET det_model = ? WHERE id = ?', (body.det_model, user.id))
        except _sqlite3.OperationalError as col_err:
            if 'no column named det_model' in str(col_err) or 'no such column' in str(col_err):
                conn.execute('ALTER TABLE users ADD COLUMN det_model TEXT')
                conn.execute('UPDATE users SET det_model = ? WHERE id = ?', (body.det_model, user.id))
            else:
                raise
        conn.commit()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save detection preferences: {e}")
    finally:
        if conn:
            conn.close()
    return {'ok': True}


class CheckCredentialsRequest(BaseModel):
    username: str
    password: str


@router.post("/check-credentials")
def check_credentials(body: CheckCredentialsRequest, _admin=Depends(require_admin)):
    """
    Verify a username/password pair against the permissions DB.
    Admin-only — used for the Settings DB health check UI.
    """
    s = _state()
    ok = s.permissions.verify_credentials(body.username, body.password)
    return {"ok": ok, "message": "Credentials valid" if ok else "Invalid credentials"}


@router.get("/db-status")
def db_status(_admin=Depends(require_admin)):
    """Return basic DB health information (admin only)."""
    s = _state()
    db_path = s.db_path
    info: Dict[str, Any] = {"db_path": db_path}
    try:
        stat = Path(db_path).stat()
        info["file_size_mb"] = round(stat.st_size / (1024 * 1024), 2)
        info["permissions_ok"] = os.access(db_path, os.R_OK | os.W_OK)
    except OSError:
        info["file_size_mb"] = None
        info["permissions_ok"] = False

    try:
        conn = sqlite3.connect(db_path, timeout=5.0)
        conn.row_factory = sqlite3.Row
        info["user_count"]  = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        info["image_count"] = conn.execute("SELECT COUNT(*) FROM images").fetchone()[0]
        conn.close()
    except Exception as e:
        info["db_error"] = str(e)

    return info


@router.get("/engine-status")
def engine_status(user=Depends(get_current_user)):
    """Return face-recognition engine + individual detector readiness."""
    from face_recognition_core import INSIGHTFACE_AVAILABLE, YUNET_AVAILABLE, MEDIAPIPE_AVAILABLE
    s = _state()
    eng = s.engine

    # ── Per-detector availability / model-file presence ───────────────────────
    db_dir = Path(s.db_path).parent

    yunet_model  = db_dir / 'face_detection_yunet_2023mar.onnx'
    mp_model     = db_dir / 'blaze_face_short_range.tflite'
    MP_MIN_BYTES = 800_000   # ~2.8 MB; <800 KB = corrupt / incomplete

    detectors = {
        "retinaface": {
            "available": INSIGHTFACE_AVAILABLE,
            "ready":     bool(eng._backend_ready),
            "note":      "Uses buffalo_l det_model (built-in)",
        },
        "scrfd": {
            "available": INSIGHTFACE_AVAILABLE,
            "ready":     bool(eng._backend_ready),
            "note":      "SCRFD-10G-KPS via InsightFace (built-in)",
        },
        "yunet": {
            "available": YUNET_AVAILABLE,
            "model_exists": yunet_model.exists(),
            "model_size_kb": round(yunet_model.stat().st_size / 1024) if yunet_model.exists() else None,
            "note":      "OpenCV FaceDetectorYN — model auto-downloaded on first use",
        },
        "mediapipe": {
            "available":    MEDIAPIPE_AVAILABLE,
            "model_exists": mp_model.exists(),
            "model_ok":     mp_model.exists() and mp_model.stat().st_size >= MP_MIN_BYTES,
            "model_size_kb": round(mp_model.stat().st_size / 1024) if mp_model.exists() else None,
            "note":      "BlazeFace short-range — model auto-downloaded on first use",
        },
    }

    return {
        "ready":     bool(eng._backend_ready),
        "error":     eng._init_error or None,
        "backend":   s.config.get('face_recognition', {}).get('backend', 'insightface'),
        "model":     s.config.get('face_recognition', {}).get('insightface', {}).get('model', 'buffalo_l'),
        "detectors": detectors,
    }


@router.post("/reload-engine")
def reload_engine(_admin=Depends(require_admin)):
    """Reset and re-initialize the face-recognition backend (admin only).

    Resets the backend synchronously then kicks off the heavy model load in a
    background thread (same pattern as the startup warm-up).  Returns
    immediately with {queued: true}.
    """
    s = _state()
    s.engine.reset_backend()

    import threading
    def _warm():
        try:
            logger.info("reload-engine: reloading backend…")
            s.engine._ensure_backend()
            logger.info("reload-engine: backend reloaded successfully")
        except Exception as exc:
            logger.error("reload-engine: reload failed: %s", exc)

    threading.Thread(target=_warm, daemon=True, name="engine-reload").start()
    return {"queued": True, "message": "Engine reload started in background"}
