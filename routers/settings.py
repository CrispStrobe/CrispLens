"""
routers/settings.py — Config read/write, re-init engine.
"""
import os
import sqlite3
from pathlib import Path
from typing import Any, Dict, Optional

import yaml
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from routers.deps import require_admin

router = APIRouter()


def _state():
    from fastapi_app import state
    return state


class SettingsPatch(BaseModel):
    language:              Optional[str]   = None
    backend:               Optional[str]   = None
    model:                 Optional[str]   = None
    det_threshold:         Optional[float] = None
    rec_threshold:         Optional[float] = None
    det_size:              Optional[int]   = None
    vlm_provider:          Optional[str]   = None
    vlm_model:             Optional[str]   = None
    vlm_enabled:           Optional[bool]  = None
    # Storage: if set, uploaded images are resized to this max dimension before saving.
    # 0 = keep full resolution (default).
    upload_max_dimension:  Optional[int]   = None


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
def put_settings(body: SettingsPatch, _admin=Depends(require_admin)):
    s = _state()
    config = dict(s.config or {})

    if body.language is not None:
        config.setdefault('ui', {})['language'] = body.language

    if body.backend is not None or body.model is not None or \
       body.det_threshold is not None or body.rec_threshold is not None or \
       body.det_size is not None:
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
       body.det_size is not None:
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
