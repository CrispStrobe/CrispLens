# i18n.py - Comprehensive internationalization support
import json
import logging
from typing import Dict, Optional, List
from pathlib import Path

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ============================================================================
# TRANSLATION DEFINITIONS
# ============================================================================

TRANSLATIONS = {
    'de': {
        # ====================================================================
        # UI LABELS
        # ====================================================================
        'app_title': 'CrispLens',
        'app_subtitle': 'Bild- und Gesichtserkennung mit KI',
        'version': 'Version',
        'welcome': 'Willkommen',
        'logout': 'Abmelden',
        'login': 'Anmelden',

        'training_in_progress': 'Trainiere',
        'details': 'Details',
        
        # ====================================================================
        # TABS
        # ====================================================================
        'tab_recognize': 'Erkennen',
        'tab_train': 'Trainieren',
        'tab_people': 'Personen',
        'tab_tags': 'Tags',
        'tab_search': 'Suchen',
        'tab_browse': 'Durchsuchen',
        'tab_batch': 'Stapelverarbeitung',
        'tab_stats': 'Statistiken',
        'tab_settings': 'Einstellungen',
        'tab_admin': 'Admin',
        'tab_export': 'Export',
        'tab_timeline': 'Zeitleiste',
        'tab_folders': 'Ordner',
        'tab_creators': 'Urheber',
        'tab_albums': 'Alben',
        'tab_events': 'Ereignisse',
        'tab_identify': 'Identifizieren',
        'tab_generate': 'Generieren',
        'tab_faceclusters': 'Gesichtsgruppen',
        'settings_storage_mode':      'Speichermodus',
        'settings_storage_mode_hint': 'Wo sollen Ihre Daten gespeichert werden?',
        'settings_standalone_active': 'Standalone-Modus aktiv: Verwendet lokale WASM-SQLite-Datenbank.',
        'settings_restart_wasm':      'WASM-Engine neu starten',
        'tab_filesystem': 'Dateisystem',
        'tab_watchfolders': 'Überwachte Ordner',
        'tab_duplicates': 'Duplikate',
        'tab_ingest': 'Import',
        'more_details': 'Mehr Details',
        'fields': 'FELDER',
        'copy_to_clipboard': 'In Zwischenablage kopieren',
        'move_to_clipboard': 'In Zwischenablage verschieben',
        'paste': 'Einfügen',
        'sidebar_expand': 'Seitenleiste ausklappen',
        'sidebar_collapse': 'Seitenleiste einklappen',
        
        # ====================================================================
        # RECOGNIZE TAB
        # ====================================================================
        'upload_image': 'Bild hochladen',
        'upload_multiple': 'Mehrere Bilder hochladen',
        'drop_files_here': 'Dateien hier ablegen oder Pfad eingeben',
        'show_rectangles': 'Gesichtsrahmen anzeigen',
        'show_names': 'Namen anzeigen',
        'show_confidence': 'Konfidenz anzeigen',
        'show_thumbnail': 'Miniaturansicht',
        'show_full_image': 'Vollbild',
        'process_image': 'Bild verarbeiten',
        'processing': 'Verarbeite...',
        'detection_results': 'Erkennungsergebnisse',
        'total_faces': 'Gesamt Gesichter',
        'known_people': 'Bekannte Personen',
        'unknown_people': 'Unbekannte Personen',
        'people_detected': 'Erkannte Personen',
        'ai_analysis': 'KI-Analyse',
        'description': 'Beschreibung',
        'filename': 'Dateiname',
        'scene_type': 'Szenentyp',
        'tags': 'Tags',
        'confidence': 'Konfidenz',
        'quality': 'Qualität',
        'date_created': 'Erstellt am',
        'date_modified': 'Geändert am',
        'camera_model': 'Kameramodell',
        
        # ====================================================================
        # TRAIN TAB
        # ====================================================================
        'train_description': 'Neue Personen zum System hinzufügen',
        'person_name': 'Personenname',
        'person_name_placeholder': 'z.B. Max Mustermann',
        'training_images': 'Trainingsbilder hochladen',
        'training_method': 'Trainingsmethode',
        'train_upload': 'Bilder hochladen',
        'train_folder': 'Ordner scannen',
        'folder_path': 'Ordnerpfad',
        'scan_folder': 'Ordner scannen',
        'train_folder_description': 'Ordnerstruktur: PersonName/bilder.jpg',
        'train_system': 'System trainieren',
        'training_in_progress': 'Training läuft...',
        'training_complete': 'Training abgeschlossen!',
        'training_failed': 'Training fehlgeschlagen',
        'training_tips': 'Trainingstipps',
        'tip_1': 'Laden Sie 3-10 Bilder pro Person hoch',
        'tip_2': 'Verwenden Sie verschiedene Winkel und Ausdrücke',
        'tip_3': 'Sorgen Sie für gute Beleuchtung',
        'tip_4': 'Eine Person pro Bild für beste Ergebnisse',
        'tip_5': 'Vermeiden Sie verschwommene oder unscharfe Bilder',
        'tip_6': 'Verschiedene Hintergründe helfen bei der Generalisierung',
        
        # ====================================================================
        # SEARCH TAB
        # ====================================================================
        'search_description': 'Suchen Sie nach Bildern mit bestimmten Personen',
        'search_name': 'Personenname eingeben...',
        'search_by_name': 'Nach Namen suchen',
        'search_by_tag': 'Nach Tag suchen',
        'search_by_date': 'Nach Datum suchen',
        'search_by_location': 'Nach Ort suchen',
        'search_advanced': 'Erweiterte Suche',
        'max_results': 'Max. Ergebnisse',
        'sort_by': 'Sortieren nach',
        'sort_newest': 'Neueste zuerst',
        'sort_oldest': 'Älteste zuerst',
        'sort_date_taken_desc': 'Aufnahmedatum absteigend',
        'sort_date_taken_asc': 'Aufnahmedatum aufsteigend',
        'sort_most_faces': 'Meiste Gesichter',
        'sort_filename_az': 'Dateiname A-Z',
        'search_button': 'Suchen',
        'search_results': 'Suchergebnisse für',
        'found_images': 'Bilder gefunden mit dieser Person',
        'no_results_found': 'Keine Ergebnisse gefunden',
        'refine_search': 'Suche verfeinern',
        'refresh': 'Aktualisieren',
        
        # ====================================================================
        # BROWSE TAB
        # ====================================================================
        'browse_description': 'Alle verarbeiteten Bilder durchsuchen',
        'filter_options': 'Filteroptionen',
        'filter_by_people': 'Nach Personen filtern',
        'filter_by_date_range': 'Nach Datumsbereich',
        'filter_by_scene': 'Nach Szene',
        'sort_newest_short': 'Neueste',
        'sort_oldest_short': 'Älteste',
        'sort_most_faces_short': 'Meiste Gesichter',
        'sort_least_faces_short': 'Wenigste Gesichter',
        'sort_by_quality_short': 'Nach Qualität',
        'browse_button': 'Durchsuchen',
        'showing_images': 'Zeige Bilder',
        'page': 'Seite',
        'of': 'von',
        'items_per_page': 'Bilder pro Seite',
        'merge': 'Zusammenführen',
        'target': 'Ziel',
        'source': 'Quelle',
        'select_all': 'Alle auswählen',
        'deselect_all': 'Alle abwählen',
        'select_none': 'Auswahl aufheben',
        'selection': 'Auswahl',
        
        # ====================================================================
        # BATCH TAB
        # ====================================================================
        'batch_description': 'Ganze Ordner mit Bildern verarbeiten',
        'select_folder': 'Ordner auswählen',
        'file_extensions': 'Dateierweiterungen (kommagetrennt)',
        'recursive_scan': 'Unterordner einbeziehen',
        'process_folder': 'Ordner verarbeiten',
        'batch_progress': 'Fortschritt',
        'batch_status': 'Status',
        'batch_complete': 'Stapelverarbeitung abgeschlossen!',
        'batch_stopped': 'Verarbeitung angehalten',
        'batch_failed': 'Verarbeitung fehlgeschlagen',
        'pv_process_btn': '▶ Verarbeiten',
        'pv_process_direct': 'Direkt',
        'pv_process_direct_hint': 'Bilder sofort in diesem Fenster verarbeiten',
        'pv_process_as_batch': 'Als Stapel',
        'pv_item': 'Element',
        'pv_items': 'Elemente',
        'pv_pending': 'ausstehend',
        'pv_image': 'Bild',
        'pv_images': 'Bilder',
        'pv_local_base_label':       'Lokaler Basisordner (optional):',
        'pv_local_base_placeholder': '/Users/alice/Bilder',
        'pv_local_base_hint':        'Wird Dateinamen vorangestellt, wenn der Browser den vollständigen Pfad nicht anzeigen kann',
        'pv_local_path_notice':      'Lokaler Basisordner wird für Stapelaufträge benötigt',
        'processed': 'Verarbeitet',
        'failed': 'Fehlgeschlagen',
        'skipped': 'Übersprungen',
        'remaining': 'Verbleibend',
        'total_faces_detected': 'Gesamt erkannte Gesichter',
        'avg_faces': 'Durchschn. Gesichter pro Bild',
        'stop_processing': 'Anhalten',
        'resume_processing': 'Fortsetzen',
        'bj_retry': 'Fehlgeschlagene erneut versuchen',
        'bj_persistent_hint': 'Einen dauerhaften serverseitigen Auftrag für diese Dateien erstellen',
        'bj_path_required_hint': 'Lokaler Basisordner erforderlich für Stapelaufträge im Browser',
        'bj_source_selection': 'Manuelle Auswahl',
        
        # ====================================================================
        # STATISTICS TAB
        # ====================================================================
        'stats_overview': 'Übersicht',
        'stats_total_people': 'Gesamt Personen',
        'stats_total_images': 'Gesamt Bilder',
        'stats_processed_images': 'verarbeitet',
        'stats_unprocessed_images': 'unverarbeitet',
        'stats_total_faces': 'Gesamt erkannte Gesichter',
        'stats_identified_faces': 'Identifizierte Gesichter',
        'stats_unknown_faces': 'Unbekannte Gesichter',
        'stats_avg_faces_per_image': 'Durchschn. Gesichter pro Bild',
        'stats_configuration': 'Konfiguration',
        'stats_top_people': 'Top 10 Personen (nach Auftreten)',
        'stats_faiss_index': 'FAISS-Index',
        'stats_vectors': 'Vektoren',
        'stats_dimension': 'Dimension',
        'stats_database': 'Datenbank',
        'stats_db_size': 'Datenbankgröße',
        'stats_images_with_location': 'Bilder mit Standort',
        'stats_images_with_date': 'Bilder mit Datum',
        'refresh_stats': 'Aktualisieren',

        # ====================================================================
        # SETTINGS TAB
        # ====================================================================
        'settings_title': 'System-Konfiguration',
        'recognition_settings': 'Erkennungseinstellungen',
        'backend': 'Backend',
        'model': 'Modell',
        'detection_threshold': 'Erkennungsschwelle',
        'recognition_threshold': 'Wiedererkennungsschwelle',
        'use_gpu': 'GPU verwenden',
        'storage_settings': 'Speichereinstellungen',
        'store_in_db': 'Bilder in Datenbank speichern',
        'store_on_disk': 'Bilder auf Festplatte behalten',
        'generate_thumbnails': 'Miniaturansichten generieren',
        'write_metadata': 'Metadaten in Dateien schreiben',
        'metadata_tool': 'ExifTool verfügbar',
        'ai_enrichment': 'KI-Anreicherung',
        'enable_vlm': 'VLM aktivieren',
        'vlm_provider': 'VLM-Anbieter',
        'vlm_api_key': 'API-Schlüssel',
        'vlm_endpoint': 'API-Endpunkt',
        'vlm_model': 'Modell',
        'vlm_test': 'VLM testen',
        'ui_settings': 'Benutzeroberfläche',
        'language': 'Sprache',
        'theme': 'Design',
        'save_settings': 'Einstellungen speichern',
        'reset_settings': 'Zurücksetzen',
        'export_config': 'Konfiguration exportieren',
        'import_config': 'Konfiguration importieren',

        # ====================================================================
        # ADMIN TAB
        # ====================================================================
        'admin_title': 'Administrator-Panel',
        'system_maintenance': 'Systemwartung',
        'run_cleanup': 'Aufräumen',
        'optimize_database': 'Datenbank optimieren',
        'backup_database': 'Datenbank sichern',
        'restore_database': 'Datenbank wiederherstellen',
        'rebuild_index': 'Index neu aufbauen',
        'mount_drives': 'Laufwerke mounten',
        'mount_type': 'Mount-Typ',
        'server_address': 'Server-Adresse',
        'share_path': 'Freigabepfad',
        'mount_point': 'Mount-Punkt',
        'username': 'Benutzername',
        'password': 'Passwort',
        'domain': 'Domäne (optional)',
        'read_only': 'Nur Lesen',
        'mount_button': 'Mounten',
        'unmount_button': 'Unmounten',
        'list_mounts': 'Mounts auflisten',
        'user_management': 'Benutzerverwaltung',
        'add_user': 'Benutzer hinzufügen',
        'user_name': 'Benutzername',
        'user_password': 'Passwort',
        'user_role': 'Rolle',
        'role_admin': 'Administrator',
        'role_user': 'Benutzer',
        'allowed_folders': 'Erlaubte Ordner (einer pro Zeile)',
        'create_user': 'Benutzer erstellen',
        'list_users': 'Benutzer auflisten',
        'reset_password': 'Passwort zurücksetzen',
        'deactivate_user': 'Deaktivieren',
        'activate_user': 'Aktivieren',
        
        # ====================================================================
        # MESSAGES
        # ====================================================================
        'no_image': 'Bitte laden Sie ein Bild hoch',
        'system_not_initialized': 'System nicht initialisiert. Gehen Sie zur Einstellungen-Tab.',
        'no_faces_detected': 'Keine Gesichter im Bild erkannt',
        'enter_name': 'Bitte geben Sie einen Namen ein',
        'upload_images': 'Bitte laden Sie Trainingsbilder hoch',
        'no_results': 'Keine Bilder gefunden mit',
        'folder_not_found': 'Ordner nicht gefunden',
        'no_images_found': 'Keine Bilder gefunden',
        'settings_saved': 'Einstellungen gespeichert',
        'settings_reset': 'Einstellungen zurückgesetzt',
        'error': 'Fehler',
        'success': 'Erfolg',
        'warning': 'Warnung',
        'info': 'Info',
        'permission_denied': 'Zugriff verweigert',
        'invalid_input': 'Ungültige Eingabe',
        'operation_cancelled': 'Vorgang abgebrochen',
        'please_wait': 'Bitte warten...',
        'loading': 'Lade...',
        'no_key': 'Kein Schlüssel',
        'of': 'von',
        
        # ====================================================================
        # BUTTONS & ACTIONS
        # ====================================================================
        'ok': 'OK',
        'cancel': 'Abbrechen',
        'apply': 'Anwenden',
        'close': 'Schließen',
        'save': 'Speichern',
        'delete': 'Löschen',
        'edit': 'Bearbeiten',
        'view': 'Anzeigen',
        'download': 'Herunterladen',
        'upload': 'Hochladen',
        'refresh': 'Aktualisieren',
        'clear': 'Löschen',
        'reset': 'Zurücksetzen',
        'confirm': 'Bestätigen',
        'back': 'Zurück',
        'next': 'Weiter',
        'previous': 'Vorherige',
        'select_all': 'Alle auswählen',
        'deselect_all': 'Alle abwählen',

        # ====================================================================
        # IDENTIFY VIEW & FACE IDENTIFY MODAL
        # ====================================================================
        'identify_persons':         'Personen identifizieren',
        'images_pending':           'Bilder ausstehend',
        'image_pending':            'Bild ausstehend',
        'sort_most_faces':          'Meiste Gesichter zuerst',
        'all_faces_identified':     'Alle Gesichter identifiziert!',
        'process_more_images':      'Weitere Bilder verarbeiten oder später zurückkehren.',
        'face_identification':      'Gesichtsidentifikation',
        'drag_to_mark_face':        'Auf Bild ziehen, um ein Gesicht manuell zu markieren',
        'clear_all_identifications':'Alle Zuweisungen entfernen',
        'clear_all_detections':     'Alle Erkennungen löschen',
        'downsize_before_detect':   'Verkleinern auf (px)',
        'downsize_original':        'Original',
        'no_faces_in_image':        'Keine Gesichter in diesem Bild erkannt.',
        'lower_threshold_hint':     'Schwellenwert oder Mindestgröße verringern.',
        'detection_threshold':      'Schwellenwert',
        'min_face_size':            'Mindestgröße',
        'recognition_certainty':    'Sicherheit',
        'run_detection':            'Erkennung starten',
        'scanning':                 'Scanne…',
        'face_num':                 'Gesicht',
        'remove_detection':         'Erkennung entfernen',
        'type_name_placeholder':    'Name eingeben…',
        'save_all':                 'Alle speichern',
        'rescan':                   'Neu scannen…',
        'press_esc_to_close':       'Esc zum Schließen',
        'fit_to_screen':            'Einpassen',
        'zoom_in':                  'Vergrößern',
        'zoom_out':                 'Verkleinern',
        'conf_short':               'Konf.',
        # Detection model
        'detection_model':          'Erkennungsmodell',
        'det_model_auto':           'Auto (Standard)',
        'det_model_retinaface':     'RetinaFace',
        'det_model_scrfd':          'SCRFD (nicht-frontal)',
        'det_model_yunet':          'YuNet (CPU)',
        'det_model_mediapipe':      'MediaPipe (CPU)',
        'user_detection_prefs':     'Erkennungsmodell-Einstellungen',
        'det_model_global_hint':    'Systemstandard',
        'also_run_vlm':             'VLM-Beschreibung erneuern',
        'rescan_mode_both':         'Beides',
        'rescan_mode_faces':        'Gesichter',
        'rescan_mode_vlm':          'VLM',

        # ====================================================================
        # FACE CLUSTER VIEW
        # ====================================================================
        'face_clusters':            'Gesichts-Cluster',
        'clustering_faces':         'Gesichter clustern…',
        'no_clusters_found':        'Keine unidentifizierten Gesichts-Cluster gefunden.',
        'no_clusters_detail':       'Alle erkannten Gesichter wurden identifiziert, oder es wurden noch keine Gesichter erkannt.',
        'similarity_threshold':     'Ähnlichkeitsschwellenwert',
        'apply_to_all':             'Auf alle anwenden',
        'apply_to_selected':        'Auf ausgewählte anwenden',
        'enter_person_name':        'Personenname eingeben…',
        'skip':                     'Überspringen',
        'deselect':                 'Abwählen',

        # ====================================================================
        # CLOUD DRIVES VIEW
        # ====================================================================
        'cloud_drives':             'Cloud-Laufwerke',
        'add_drive':                'Laufwerk hinzufügen',
        'drive_name':               'Name',
        'drive_type':               'Typ',
        'drive_server':             'Server',
        'drive_share':              'Freigabe',
        'drive_host':               'Host',
        'drive_port':               'Port',
        'drive_username':           'Benutzername',
        'drive_password':           'Passwort',
        'drive_domain':             'Domäne (optional)',
        'drive_remote_path':        'Remote-Pfad',
        'drive_ssh_key':            'SSH-Schlüssel (Pfad, optional)',
        'drive_email':              'E-Mail',
        'drive_tfa':                '2FA-Code (optional)',
        'drive_mount_point':        'Einhängepunkt',
        'drive_scope':              'Geltungsbereich',
        'drive_scope_system':       'System (für alle)',
        'drive_scope_user':         'Benutzer (nur ich)',
        'drive_auto_mount':         'Auto-Einhängen beim Start',
        'drive_read_only':          'Nur lesen',
        'drive_access':             'Zugriff',
        'drive_allowed_roles':      'Berechtigte Rollen',
        'drive_status_mounted':     'Eingehängt',
        'drive_status_connected':   'Verbunden',
        'drive_status_offline':     'Getrennt',
        'drive_mount':              'Einhängen',
        'drive_unmount':            'Aushängen',
        'drive_connect':            'Verbinden',
        'drive_disconnect':         'Trennen',
        'drive_test':               'Verbindung testen',
        'drive_test_ok':            'Verbindung erfolgreich',
        'drive_test_fail':          'Verbindung fehlgeschlagen',
        'drive_save':               'Speichern',
        'drive_edit':               'Bearbeiten',
        'drive_delete':             'Löschen',
        'drive_delete_confirm':     'Dieses Laufwerk wirklich löschen?',
        'no_cloud_drives':          'Keine Laufwerke konfiguriert.',
        'no_cloud_drives_hint':     'Fügen Sie ein SMB-, SFTP-, Filen- oder Internxt-Laufwerk hinzu.',

        # Placeholders for drive form inputs
        'drive_placeholder_name':        'Mein NAS',
        'drive_placeholder_server':      '192.168.1.100',
        'drive_placeholder_share':       'fotos',
        'drive_placeholder_host':        'server.example.com',
        'drive_placeholder_remote_path': '/',
        'drive_placeholder_mount_smb':   '/mnt/nas',
        'drive_placeholder_mount_sftp':  '/mnt/sftp',
        'drive_placeholder_ssh_key':     '/home/benutzer/.ssh/id_rsa',
        'drive_placeholder_tfa':         '123456',

        # Role display names
        'role_medienverwalter':     'Medienverwalter',

        # ====================================================================
        # VLM PROMPTS
        # ====================================================================
        'vlm_prompt': """Analysiere dieses Bild und gib an:
1. Eine kurze Beschreibung (1-2 Sätze)
2. Szenentyp (innen/außen/porträt/gruppe/landschaft/veranstaltung/natur/urban/andere)
3. 5-10 relevante Tags

Formatieren Sie als JSON:
{
  "description": "...",
  "scene_type": "...",
  "tags": ["tag1", "tag2", ...]
}""",
    },
    
    'en': {
        # ====================================================================
        # UI LABELS
        # ====================================================================
        'app_title': 'CrispLens',
        'app_subtitle': 'AI-Powered Image and Face Recognition',
        'version': 'Version',
        'welcome': 'Welcome',
        'logout': 'Logout',
        'login': 'Login',
        
        'training_in_progress': 'Training',
        'details': 'Details',

        # ====================================================================
        # TABS
        # ====================================================================
        'tab_recognize': 'Recognize',
        'tab_train': 'Train',
        'tab_people': 'People',
        'tab_tags': 'Tags',
        'tab_search': 'Search',
        'tab_browse': 'Browse',
        'tab_batch': 'Batch Process',
        'tab_stats': 'Statistics',
        'tab_settings': 'Settings',
        'tab_admin': 'Admin',
        'tab_export': 'Export',
        'tab_timeline': 'Timeline',
        'tab_folders': 'Folders',
        'tab_creators': 'Creators',
        'tab_albums': 'Albums',
        'tab_events': 'Events',
        'tab_identify': 'Identify',
        'tab_generate': 'Generate',
        'tab_faceclusters': 'Face Clusters',
        'settings_storage_mode':      'Storage Mode',
        'settings_storage_mode_hint': 'Where should your data be stored?',
        'settings_standalone_active': 'Standalone mode active: using on-device WASM SQLite.',
        'settings_restart_wasm':      'Restart WASM Engine',
        'tab_filesystem': 'Filesystem',
        'tab_watchfolders': 'Watch Folders',
        'tab_duplicates': 'Duplicates',
        'tab_ingest': 'Ingest',
        'more_details': 'More details',
        'fields': 'Fields',
        'copy_to_clipboard': 'Copy to clipboard',
        'move_to_clipboard': 'Move to clipboard',
        'paste': 'Paste',
        'sidebar_expand': 'Expand sidebar',
        'sidebar_collapse': 'Collapse sidebar',
        
        # ====================================================================
        # RECOGNIZE TAB
        # ====================================================================
        'upload_image': 'Upload Image',
        'upload_multiple': 'Upload Multiple Images',
        'drop_files_here': 'Drop files here',
        'show_rectangles': 'Show Face Rectangles',
        'show_names': 'Show Names',
        'show_confidence': 'Show Confidence',
        'show_thumbnail': 'Thumbnail View',
        'show_full_image': 'Full Image',
        'process_image': 'Process Image',
        'processing': 'Processing...',
        'detection_results': 'Detection Results',
        'total_faces': 'Total Faces',
        'known_people': 'Known People',
        'unknown_people': 'Unknown People',
        'people_detected': 'People Detected',
        'ai_analysis': 'AI Analysis',
        'description': 'Description',
        'filename': 'Filename',
        'scene_type': 'Scene Type',
        'tags': 'Tags',
        'confidence': 'Confidence',
        'quality': 'Quality',
        'date_created': 'Date Created',
        'date_modified': 'Date Modified',
        'camera_model': 'Camera Model',
        
        # ====================================================================
        # TRAIN TAB
        # ====================================================================
        'train_description': 'Add new people to the system',
        'person_name': 'Person Name',
        'person_name_placeholder': 'e.g. John Doe',
        'training_images': 'Upload Training Images',
        'training_method': 'Training Method',
        'train_upload': 'Upload Images',
        'train_folder': 'Scan Folder',
        'folder_path': 'Folder Path',
        'scan_folder': 'Scan Folder',
        'train_folder_description': 'Folder structure: PersonName/images.jpg',
        'train_system': 'Train System',
        'training_in_progress': 'Training in progress...',
        'training_complete': 'Training Complete!',
        'training_failed': 'Training Failed',
        'training_tips': 'Training Tips',
        'tip_1': 'Upload 3-10 images per person',
        'tip_2': 'Use different angles and expressions',
        'tip_3': 'Ensure good lighting',
        'tip_4': 'One person per image for best results',
        'tip_5': 'Avoid blurry or out-of-focus images',
        'tip_6': 'Different backgrounds help generalization',
        
        # ====================================================================
        # SEARCH TAB
        # ====================================================================
        'search_description': 'Search for images containing specific people',
        'search_name': 'Enter person name...',
        'search_by_name': 'Search by Name',
        'search_by_tag': 'Search by Tag',
        'search_by_date': 'Search by Date',
        'search_by_location': 'Search by Location',
        'search_advanced': 'Advanced Search',
        'max_results': 'Max Results',
        'sort_by': 'Sort By',
        'sort_newest': 'Newest first',
        'sort_oldest': 'Oldest first',
        'sort_date_taken_desc': 'Date taken descending',
        'sort_date_taken_asc': 'Date taken ascending',
        'sort_most_faces': 'Most faces',
        'sort_filename_az': 'Filename A-Z',
        'search_button': 'Search',
        'search_results': 'Search Results for',
        'found_images': 'images found containing this person',
        'no_results_found': 'No results found',
        'refine_search': 'Refine search',
        'refresh': 'Refresh',
        
        # ====================================================================
        # BROWSE TAB
        # ====================================================================
        'browse_description': 'Browse all processed images',
        'filter_options': 'Filter Options',
        'filter_by_people': 'Filter by People',
        'filter_by_date_range': 'By Date Range',
        'filter_by_scene': 'By Scene',
        'sort_newest_short': 'Newest',
        'sort_oldest_short': 'Oldest',
        'sort_most_faces_short': 'Most Faces',
        'sort_least_faces_short': 'Least Faces',
        'sort_by_quality_short': 'By Quality',
        'browse_button': 'Browse',
        'showing_images': 'Showing images',
        'page': 'Page',
        'of': 'of',
        'items_per_page': 'Images per page',
        'merge': 'Merge',
        'target': 'Target',
        'source': 'Source',
        'select_all': 'Select All',
        'deselect_all': 'Deselect All',
        'select_none': 'Select None',
        'selection': 'Selection',
        
        # ====================================================================
        # BATCH TAB
        # ====================================================================
        'batch_description': 'Process entire folders of images',
        'select_folder': 'Select Folder',
        'file_extensions': 'File Extensions (comma-separated)',
        'recursive_scan': 'Include Subfolders',
        'process_folder': 'Process Folder',
        'batch_progress': 'Progress',
        'batch_status': 'Status',
        'batch_complete': 'Batch Processing Complete!',
        'batch_stopped': 'Processing Stopped',
        'batch_failed': 'Processing Failed',
        'pv_process_btn': '▶ Process',
        'pv_process_direct': 'Direct',
        'pv_process_direct_hint': 'Process images immediately in this window',
        'pv_process_as_batch': 'As Batch',
        'pv_item': 'item',
        'pv_items': 'items',
        'pv_pending': 'pending',
        'pv_image': 'image',
        'pv_images': 'images',
        'pv_local_base_label':       'Local base folder (optional):',
        'pv_local_base_placeholder': '/Users/you/Downloads/pics',
        'pv_local_base_hint':        'Prepended to filenames when the browser cannot expose the full path',
        'pv_local_path_notice':      'Local base folder required for persistent jobs',
        'processed': 'Processed',
        'failed': 'Failed',
        'skipped': 'Skipped',
        'remaining': 'Remaining',
        'total_faces_detected': 'Total faces detected',
        'avg_faces': 'Average faces per image',
        'stop_processing': 'Stop',
        'resume_processing': 'Resume',
        'bj_retry': 'Retry failed',
        'bj_persistent_hint': 'Create a persistent server-side job for these files',
        'bj_path_required_hint': 'Local base path required for persistent jobs in browser',
        'bj_source_selection': 'Manual selection',
        
        # ====================================================================
        # STATISTICS TAB
        # ====================================================================
        'stats_overview': 'Overview',
        'stats_total_people': 'Total People',
        'stats_total_images': 'Total Images',
        'stats_processed_images': 'processed',
        'stats_unprocessed_images': 'unprocessed',
        'stats_total_faces': 'Total Faces Detected',
        'stats_identified_faces': 'Identified Faces',
        'stats_unknown_faces': 'Unknown Faces',
        'stats_avg_faces_per_image': 'Average faces per image',
        'stats_configuration': 'Configuration',
        'stats_top_people': 'Top 10 People (by appearances)',
        'stats_faiss_index': 'FAISS Index',
        'stats_vectors': 'Vectors',
        'stats_dimension': 'Dimension',
        'stats_database': 'Database',
        'stats_db_size': 'Database Size',
        'stats_images_with_location': 'Images with Location',
        'stats_images_with_date': 'Images with Date',
        'refresh_stats': 'Refresh',

        # ====================================================================
        # SETTINGS TAB
        # ====================================================================
        'settings_title': 'System Configuration',
        'recognition_settings': 'Recognition Settings',
        'backend': 'Backend',
        'model': 'Model',
        'detection_threshold': 'Detection Threshold',
        'recognition_threshold': 'Recognition Threshold',
        'use_gpu': 'Use GPU',
        'storage_settings': 'Storage Settings',
        'store_in_db': 'Store Images in Database',
        'store_on_disk': 'Keep Images on Disk',
        'generate_thumbnails': 'Generate Thumbnails',
        'write_metadata': 'Write Metadata to Files',
        'metadata_tool': 'ExifTool Available',
        'ai_enrichment': 'AI Enrichment',
        'enable_vlm': 'Enable VLM',
        'vlm_provider': 'VLM Provider',
        'vlm_api_key': 'API Key',
        'vlm_endpoint': 'API Endpoint',
        'vlm_model': 'Model',
        'vlm_test': 'Test VLM',
        'ui_settings': 'User Interface',
        'language': 'Language',
        'theme': 'Theme',
        'save_settings': 'Save Settings',
        'reset_settings': 'Reset',
        'export_config': 'Export Configuration',
        'import_config': 'Import Configuration',

        # ====================================================================
        # ADMIN TAB
        # ====================================================================
        'admin_title': 'Administrator Panel',
        'system_maintenance': 'System Maintenance',
        'run_cleanup': 'Run Cleanup',
        'optimize_database': 'Optimize Database',
        'backup_database': 'Backup Database',
        'restore_database': 'Restore Database',
        'rebuild_index': 'Rebuild Index',
        'mount_drives': 'Mount Drives',
        'mount_type': 'Mount Type',
        'server_address': 'Server Address',
        'share_path': 'Share Path',
        'mount_point': 'Mount Point',
        'username': 'Username',
        'password': 'Password',
        'domain': 'Domain (optional)',
        'read_only': 'Read Only',
        'mount_button': 'Mount',
        'unmount_button': 'Unmount',
        'list_mounts': 'List Mounts',
        'user_management': 'User Management',
        'add_user': 'Add User',
        'user_name': 'Username',
        'user_password': 'Password',
        'user_role': 'Role',
        'role_admin': 'Administrator',
        'role_user': 'User',
        'allowed_folders': 'Allowed Folders (one per line)',
        'create_user': 'Create User',
        'list_users': 'List Users',
        'reset_password': 'Reset Password',
        'deactivate_user': 'Deactivate',
        'activate_user': 'Activate',
        
        # ====================================================================
        # MESSAGES
        # ====================================================================
        'no_image': 'Please upload an image',
        'system_not_initialized': 'System not initialized. Go to Settings tab.',
        'no_faces_detected': 'No faces detected in image',
        'enter_name': 'Please enter a name',
        'upload_images': 'Please upload training images',
        'no_results': 'No images found containing',
        'folder_not_found': 'Folder not found',
        'no_images_found': 'No images found',
        'settings_saved': 'Settings saved',
        'settings_reset': 'Settings reset',
        'error': 'Error',
        'success': 'Success',
        'warning': 'Warning',
        'info': 'Info',
        'permission_denied': 'Permission denied',
        'invalid_input': 'Invalid input',
        'operation_cancelled': 'Operation cancelled',
        'please_wait': 'Please wait...',
        'loading': 'Loading...',
        'no_key': 'No Key',
        'of': 'of',
        
        # ====================================================================
        # BUTTONS & ACTIONS
        # ====================================================================
        'ok': 'OK',
        'cancel': 'Cancel',
        'apply': 'Apply',
        'close': 'Close',
        'save': 'Save',
        'delete': 'Delete',
        'edit': 'Edit',
        'view': 'View',
        'download': 'Download',
        'upload': 'Upload',
        'refresh': 'Refresh',
        'clear': 'Clear',
        'reset': 'Reset',
        'confirm': 'Confirm',
        'back': 'Back',
        'next': 'Next',
        'previous': 'Previous',
        'select_all': 'Select All',
        'deselect_all': 'Deselect All',
        'select_none': 'Select None',
        'selection': 'Selection',

        # ====================================================================
        # IDENTIFY VIEW & FACE IDENTIFY MODAL
        # ====================================================================
        'identify_persons':         'Identify Persons',
        'images_pending':           'images pending',
        'image_pending':            'image pending',
        'sort_most_faces':          'Most faces first',
        'all_faces_identified':     'All faces are identified!',
        'process_more_images':      'Process more images or check back later.',
        'face_identification':      'Face Identification',
        'drag_to_mark_face':        'Drag on image to manually mark a face',
        'clear_all_identifications':'Clear all identifications',
        'clear_all_detections':     'Delete all detections',
        'downsize_before_detect':   'Downsize to (px)',
        'downsize_original':        'Original',
        'no_faces_in_image':        'No faces detected in this image.',
        'lower_threshold_hint':     'Try lowering the threshold or min face size below.',
        'detection_threshold':      'Threshold',
        'min_face_size':            'Min Size',
        'recognition_certainty':    'Certainty',
        'run_detection':            'Run Detection',
        'scanning':                 'Scanning…',
        'face_num':                 'Face',
        'remove_detection':         'Remove detection',
        'type_name_placeholder':    'Type name…',
        'save_all':                 'Save all',
        'rescan':                   'Re-scan…',
        'press_esc_to_close':       'Press Esc to close',
        'fit_to_screen':            'Fit',
        'zoom_in':                  'Zoom in',
        'zoom_out':                 'Zoom out',
        'conf_short':               'conf',
        # Detection model
        'detection_model':          'Detection Model',
        'det_model_auto':           'Auto (Default)',
        'det_model_retinaface':     'RetinaFace',
        'det_model_scrfd':          'SCRFD (non-frontal)',
        'det_model_yunet':          'YuNet (CPU)',
        'det_model_mediapipe':      'MediaPipe (CPU)',
        'user_detection_prefs':     'Detection Model Settings',
        'det_model_global_hint':    'System default',
        'also_run_vlm':             'Also refresh VLM description',
        'rescan_mode_both':         'Both',
        'rescan_mode_faces':        'Faces',
        'rescan_mode_vlm':          'VLM',

        # ====================================================================
        # FACE CLUSTER VIEW
        # ====================================================================
        'face_clusters':            'Face Clusters',
        'clustering_faces':         'Clustering faces…',
        'no_clusters_found':        'No unidentified face clusters found.',
        'no_clusters_detail':       'All detected faces have been identified, or no faces have been detected yet.',
        'similarity_threshold':     'Similarity threshold',
        'apply_to_all':             'Apply to all',
        'apply_to_selected':        'Apply to selected',
        'enter_person_name':        'Enter person name…',
        'skip':                     'Skip',
        'deselect':                 'Deselect',

        # ====================================================================
        # CLOUD DRIVES VIEW
        # ====================================================================
        'cloud_drives':             'Cloud Drives',
        'add_drive':                'Add Drive',
        'drive_name':               'Name',
        'drive_type':               'Type',
        'drive_server':             'Server',
        'drive_share':              'Share',
        'drive_host':               'Host',
        'drive_port':               'Port',
        'drive_username':           'Username',
        'drive_password':           'Password',
        'drive_domain':             'Domain (optional)',
        'drive_remote_path':        'Remote Path',
        'drive_ssh_key':            'SSH Key (path, optional)',
        'drive_email':              'Email',
        'drive_tfa':                '2FA Code (optional)',
        'drive_mount_point':        'Mount Point',
        'drive_scope':              'Scope',
        'drive_scope_system':       'System (all users)',
        'drive_scope_user':         'User (only me)',
        'drive_auto_mount':         'Auto-mount on startup',
        'drive_read_only':          'Read only',
        'drive_access':             'Access',
        'drive_allowed_roles':      'Allowed Roles',
        'drive_status_mounted':     'Mounted',
        'drive_status_connected':   'Connected',
        'drive_status_offline':     'Offline',
        'drive_mount':              'Mount',
        'drive_unmount':            'Unmount',
        'drive_connect':            'Connect',
        'drive_disconnect':         'Disconnect',
        'drive_test':               'Test Connection',
        'drive_test_ok':            'Connection successful',
        'drive_test_fail':          'Connection failed',
        'drive_save':               'Save',
        'drive_edit':               'Edit',
        'drive_delete':             'Delete',
        'drive_delete_confirm':     'Really delete this drive?',
        'no_cloud_drives':          'No drives configured.',
        'no_cloud_drives_hint':     'Add an SMB, SFTP, Filen, or Internxt drive.',

        # Placeholders for drive form inputs
        'drive_placeholder_name':        'My NAS',
        'drive_placeholder_server':      '192.168.1.100',
        'drive_placeholder_share':       'photos',
        'drive_placeholder_host':        'server.example.com',
        'drive_placeholder_remote_path': '/',
        'drive_placeholder_mount_smb':   '/mnt/nas',
        'drive_placeholder_mount_sftp':  '/mnt/sftp',
        'drive_placeholder_ssh_key':     '/home/user/.ssh/id_rsa',
        'drive_placeholder_tfa':         '123456',

        # Role display names
        'role_medienverwalter':     'Media Manager',

        # ====================================================================
        # VLM PROMPTS
        # ====================================================================
        'vlm_prompt': """Analyze this image and provide:
1. A brief description (1-2 sentences)
2. Scene type (indoor/outdoor/portrait/group/landscape/event/nature/urban/other)
3. 5-10 relevant tags

Format as JSON:
{
  "description": "...",
  "scene_type": "...",
  "tags": ["tag1", "tag2", ...]
}""",
    }
}


# ============================================================================
# I18N CLASS
# ============================================================================

class I18n:
    """Internationalization helper with comprehensive features."""
    
    SUPPORTED_LANGUAGES = ['de', 'en']
    DEFAULT_LANGUAGE = 'de'
    
    def __init__(self, language: str = None):
        """
        Initialize i18n.
        
        Args:
            language: Language code (de, en). Defaults to 'de'
        """
        self.language = language or self.DEFAULT_LANGUAGE
        self.translations = {}
        self._load_translations()
    
    def _load_translations(self):
        """Load translations for current language."""
        if self.language not in TRANSLATIONS:
            logger.warning(f"Language '{self.language}' not found, falling back to '{self.DEFAULT_LANGUAGE}'")
            self.language = self.DEFAULT_LANGUAGE
        
        self.translations = TRANSLATIONS[self.language]
        logger.info(f"Loaded translations for language: {self.language}")
    
    def t(self, key: str, default: Optional[str] = None, **kwargs) -> str:
        """
        Get translation for key with optional string formatting.
        
        Args:
            key: Translation key
            default: Default value if key not found
            **kwargs: Format arguments for string formatting
        
        Returns:
            Translated string
        
        Examples:
            >>> i18n.t('welcome')
            'Willkommen'
            >>> i18n.t('greeting', name='Max')
            'Hallo, Max!'
        """
        translation = self.translations.get(key, default or key)
        
        # Apply string formatting if kwargs provided
        if kwargs:
            try:
                translation = translation.format(**kwargs)
            except (KeyError, ValueError) as e:
                logger.warning(f"Translation formatting error for key '{key}': {e}")
        
        return translation
    
    def set_language(self, language: str) -> bool:
        """
        Change language.
        
        Args:
            language: Language code
        
        Returns:
            True if successful, False otherwise
        """
        if language not in self.SUPPORTED_LANGUAGES:
            logger.error(f"Unsupported language: {language}")
            return False
        
        self.language = language
        self._load_translations()
        return True
    
    def get_language(self) -> str:
        """Get current language."""
        return self.language
    
    def get_supported_languages(self) -> List[str]:
        """Get list of supported languages."""
        return self.SUPPORTED_LANGUAGES.copy()
    
    def has_translation(self, key: str) -> bool:
        """Check if translation key exists."""
        return key in self.translations
    
    def get_all_keys(self) -> List[str]:
        """Get all translation keys for current language."""
        return list(self.translations.keys())
    
    def export_translations(self, filepath: str):
        """Export current translations to JSON file."""
        try:
            with open(filepath, 'w', encoding='utf-8') as f:
                json.dump(self.translations, f, ensure_ascii=False, indent=2)
            logger.info(f"Exported translations to: {filepath}")
        except Exception as e:
            logger.error(f"Failed to export translations: {e}")
    
    def import_translations(self, filepath: str) -> bool:
        """
        Import translations from JSON file.
        
        Args:
            filepath: Path to JSON file
        
        Returns:
            True if successful
        """
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                new_translations = json.load(f)
            
            self.translations.update(new_translations)
            logger.info(f"Imported translations from: {filepath}")
            return True
        except Exception as e:
            logger.error(f"Failed to import translations: {e}")
            return False


# ============================================================================
# GLOBAL INSTANCE
# ============================================================================

# Create global instance
i18n = I18n('de')  # Default German


# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

def get_translation(key: str, language: str = None, **kwargs) -> str:
    """
    Convenience function to get translation.
    
    Args:
        key: Translation key
        language: Override language (optional)
        **kwargs: Format arguments
    
    Returns:
        Translated string
    """
    if language and language != i18n.get_language():
        # Create temporary instance for different language
        temp_i18n = I18n(language)
        return temp_i18n.t(key, **kwargs)
    
    return i18n.t(key, **kwargs)


def get_language_name(code: str) -> str:
    """Get full language name from code."""
    names = {
        'de': 'Deutsch',
        'en': 'English'
    }
    return names.get(code, code)


def validate_language_code(code: str) -> bool:
    """Validate language code."""
    return code in I18n.SUPPORTED_LANGUAGES
