import { writable, derived } from 'svelte/store';

// ── Gallery state ──────────────────────────────────────────────────────────
export const galleryImages  = writable([]);    // current browse results
export const galleryMode    = writable('grid'); // grid | table
export const selectedId     = writable(null);  // lightbox target image id (single click/open)
export const selectedItems  = writable(new Set()); // Set of selected image IDs
export const lastClickedId  = writable(null);  // for shift-click selection
export const galleryLoading = writable(false);
export const backendReady   = writable(false);

// ── Filters & sort ──────────────────────────────────────────────────────────
export const filters = writable({
  person:   '',
  tag:      '',
  scene:    '',
  folder:   '',
  path:     '',
  dateFrom: '',
  dateTo:   '',
});
export const sortBy   = writable('newest');  // newest | oldest | date_taken_desc | ...
export const thumbSize = writable(200);       // px; drives CSS var + API size param

// ── Sidebar view ─────────────────────────────────────────────────────────────
// 'all' | 'people' | 'tags' | 'dates' | 'process' | 'train' | 'settings'
export const sidebarView = writable('all');

// ── Auth ──────────────────────────────────────────────────────────────────────
export const currentUser = writable(null);   // { username, role } | null

// ── Processing ────────────────────────────────────────────────────────────────
export const processingJobs = writable([]);  // SSE batch jobs

// ── People ────────────────────────────────────────────────────────────────────
export const allPeople    = writable([]);
export const selectedPerson = writable(null);  // person object for detail view

// ── Stats ─────────────────────────────────────────────────────────────────────
export const stats = writable({});

// ── Model warm-up state ───────────────────────────────────────────────────────
export const modelReady = writable(false);

// ── Tags & scenes ─────────────────────────────────────────────────────────────
export const allTags   = writable([]);
export const allScenes = writable([]);

// ── i18n ──────────────────────────────────────────────────────────────────────
// English defaults so the UI is readable before the backend responds
const EN = {
  app_title: 'CrispLens', app_subtitle: 'AI-Powered Image and Face Recognition',
  version: 'Version', welcome: 'Welcome', logout: 'Logout', login: 'Login',
  details: 'Details', training_in_progress: 'Training',
  tab_recognize: 'Recognize', tab_train: 'Train', tab_people: 'People',
  tab_tags: 'Tags', tab_search: 'Search', tab_browse: 'Browse',
  tab_batch: 'Batch Process', tab_stats: 'Statistics', tab_settings: 'Settings',
  tab_admin: 'Admin', tab_export: 'Export', tab_timeline: 'Timeline', tab_folders: 'Folders',
  upload_image: 'Upload Image', upload_multiple: 'Upload Multiple Images',
  process_image: 'Process Image', processing: 'Processing...', detection_results: 'Detection Results',
  total_faces: 'Total Faces', known_people: 'Known People', unknown_people: 'Unknown People',
  ai_analysis: 'AI Analysis', description: 'Description', filename: 'Filename',
  scene_type: 'Scene Type', tags: 'Tags', confidence: 'Confidence', quality: 'Quality',
  date_created: 'Date Created', date_modified: 'Date Modified', camera_model: 'Camera Model',
  person_name: 'Person Name', training_images: 'Upload Training Images',
  training_method: 'Training Method', train_upload: 'Upload Images', train_folder: 'Scan Folder',
  folder_path: 'Folder Path', scan_folder: 'Scan Folder', train_system: 'Train System',
  training_complete: 'Training Complete!', training_failed: 'Training Failed',
  training_tips: 'Training Tips',
  search_description: 'Search for images containing specific people',
  search_button: 'Search', search_results: 'Search Results for',
  no_results_found: 'No results found', refresh: 'Refresh',
  browse_description: 'Browse all processed images', filter_options: 'Filter Options',
  filter_by_people: 'Filter by People', sort_by: 'Sort By',
  sort_newest: 'Newest first', sort_oldest: 'Oldest first',
  merge: 'Merge', select_all: 'Select All', deselect_all: 'Deselect All',
  batch_description: 'Process entire folders of images', select_folder: 'Select Folder',
  recursive_scan: 'Include Subfolders', process_folder: 'Process Folder',
  batch_progress: 'Progress', batch_complete: 'Batch Processing Complete!',
  processed: 'Processed', failed: 'Failed', skipped: 'Skipped', remaining: 'Remaining',
  stop_processing: 'Stop', resume_processing: 'Resume',
  stats_overview: 'Overview', stats_total_people: 'Total People', stats_total_images: 'Total Images',
  stats_total_faces: 'Total Faces Detected', stats_database: 'Database',
  refresh_stats: 'Refresh',
  settings_title: 'System Configuration', recognition_settings: 'Recognition Settings',
  backend: 'Backend', model: 'Model', detection_threshold: 'Detection Threshold',
  recognition_threshold: 'Recognition Threshold', use_gpu: 'Use GPU',
  ai_enrichment: 'AI Enrichment', enable_vlm: 'Enable VLM',
  vlm_provider: 'VLM Provider', vlm_api_key: 'API Key', vlm_model: 'Model',
  ui_settings: 'User Interface', language: 'Language',
  save_settings: 'Save Settings', reset_settings: 'Reset',
  user_management: 'User Management', username: 'Username', password: 'Password',
  role_admin: 'Administrator', role_user: 'User',
  no_image: 'Please upload an image', no_faces_detected: 'No faces detected',
  settings_saved: 'Settings saved', error: 'Error', success: 'Success',
  please_wait: 'Please wait...', loading: 'Loading...', no_key: 'No key set', of: 'of',
  ok: 'OK', cancel: 'Cancel', save: 'Save', delete: 'Delete', edit: 'Edit',
  view: 'View', download: 'Download', upload: 'Upload', clear: 'Clear', reset: 'Reset',
  confirm: 'Confirm', back: 'Back', next: 'Next', previous: 'Previous',
  search_by_date: 'Date',
  change_password: 'Change Password',
  current_password: 'Current Password',
  new_password: 'New Password',
  confirm_password: 'Confirm Password',
  password_changed: 'Password changed successfully',
  set_password: 'Set Password',
  test_key: 'Test',
  key_valid: 'Key valid',
  key_invalid: 'Invalid key',
  // Cloud drives
  cloud_drives: 'Cloud Drives',
  add_drive: 'Add Drive',
  no_cloud_drives: 'No cloud drives configured',
  no_cloud_drives_hint: 'Add a network share or cloud storage account',
  drive_name: 'Drive Name', drive_type: 'Type', drive_host: 'Host', drive_server: 'Server',
  drive_share: 'Share', drive_username: 'Username', drive_password: 'Password',
  drive_domain: 'Domain', drive_port: 'Port', drive_remote_path: 'Remote Path',
  drive_ssh_key: 'SSH Key', drive_email: 'Email', drive_tfa: '2FA Code',
  drive_mount_point: 'Mount Point', drive_read_only: 'Read Only',
  drive_scope: 'Scope', drive_scope_system: 'System', drive_scope_user: 'Personal',
  drive_allowed_roles: 'Allowed Roles', drive_auto_mount: 'Auto-mount',
  drive_edit: 'Edit', drive_save: 'Save Drive', drive_delete: 'Delete Drive',
  drive_delete_confirm: 'Delete this drive?',
  drive_connect: 'Connect', drive_disconnect: 'Disconnect',
  drive_mount: 'Mount', drive_unmount: 'Unmount', drive_test: 'Test',
  drive_status_connected: 'Connected', drive_status_mounted: 'Mounted', drive_status_offline: 'Offline',
  drive_placeholder_name: 'My Drive', drive_placeholder_host: 'e.g. 192.168.1.1',
  drive_placeholder_server: '//server/share', drive_placeholder_share: 'share',
  drive_placeholder_remote_path: '/remote/path', drive_placeholder_ssh_key: '/path/to/key',
  drive_placeholder_tfa: '2FA code', drive_placeholder_mount_smb: '/mnt/smb',
  drive_placeholder_mount_sftp: '/mnt/sftp',
  // Face identification / clusters
  face_identification: 'Face Identification', face_clusters: 'Face Clusters',
  face_num: 'Face #', identify_persons: 'Identify',
  person_name_placeholder: 'Enter name…', type_name_placeholder: 'Type a name…',
  enter_person_name: 'Enter person name',
  all_faces_identified: 'All faces identified', no_faces_in_image: 'No faces in this image',
  no_clusters_found: 'No face clusters found', no_clusters_detail: 'Process more images to generate face clusters',
  clustering_faces: 'Clustering faces…', similarity_threshold: 'Similarity threshold',
  lower_threshold_hint: 'Lower threshold = more results',
  recognition_certainty: 'Certainty', conf_short: 'Conf',
  clear_all_identifications: 'Clear all identifications',
  drag_to_mark_face: 'Drag to mark a face',
  // Train
  browse_button: 'Browse', train_folder_description: 'Scan folder for named sub-folders (one per person)',
  // Sort options
  sort_date_taken_asc: 'Date taken (oldest)', sort_date_taken_desc: 'Date taken (newest)',
  sort_filename_az: 'Filename A–Z', sort_most_faces: 'Most faces',
  // Stats
  stats_images_with_date: 'Images with date',
  // Lightbox / image ops
  zoom_in: 'Zoom in', zoom_out: 'Zoom out', fit_to_screen: 'Fit to screen',
  press_esc_to_close: 'Press Esc to close', close: 'Close',
  run_detection: 'Run detection', remove_detection: 'Remove detection',
  min_face_size: 'Min Face Size',
  // Misc
  apply: 'Apply', apply_to_all: 'Apply to all', apply_to_selected: 'Apply to selected',
  skip: 'Skip', rescan: 'Rescan', scanning: 'Scanning…', save_all: 'Save all',
  deselect: 'Deselect', selection: 'Selection', source: 'Source', target: 'Target',
  search_name: 'Search by name…', operation_cancelled: 'Cancelled',
  people_detected: 'People detected', process_more_images: 'Process more images',
  image_pending: '1 image pending', images_pending: '{n} images pending',
};

export const TRANSLATIONS = {
  en: EN,
  de: {
    app_title: 'CrispLens', app_subtitle: 'KI-gestützte Bild- und Gesichtserkennung',
    version: 'Version', welcome: 'Willkommen', logout: 'Abmelden', login: 'Anmelden',
    details: 'Details', training_in_progress: 'Training',
    tab_recognize: 'Erkennen', tab_train: 'Trainieren', tab_people: 'Personen',
    tab_tags: 'Tags', tab_search: 'Suchen', tab_browse: 'Durchsuchen',
    tab_batch: 'Stapelverarbeitung', tab_stats: 'Statistiken', tab_settings: 'Einstellungen',
    tab_admin: 'Admin', tab_export: 'Export', tab_timeline: 'Zeitleiste', tab_folders: 'Ordner',
    upload_image: 'Bild hochladen', upload_multiple: 'Mehrere Bilder hochladen',
    process_image: 'Bild verarbeiten', processing: 'Verarbeitung...', detection_results: 'Erkennungsergebnisse',
    total_faces: 'Gesichter gesamt', known_people: 'Bekannte Personen', unknown_people: 'Unbekannte Personen',
    ai_analysis: 'KI-Analyse', description: 'Beschreibung', filename: 'Dateiname',
    scene_type: 'Szenentyp', tags: 'Tags', confidence: 'Konfidenz', quality: 'Qualität',
    date_created: 'Erstellungsdatum', date_modified: 'Änderungsdatum', camera_model: 'Kameramodell',
    person_name: 'Personenname', training_images: 'Trainingsbilder hochladen',
    training_method: 'Trainingsmethode', train_upload: 'Bilder hochladen', train_folder: 'Ordner scannen',
    folder_path: 'Ordnerpfad', scan_folder: 'Ordner scannen', train_system: 'System trainieren',
    training_complete: 'Training abgeschlossen!', training_failed: 'Training fehlgeschlagen',
    training_tips: 'Trainingshinweise',
    search_description: 'Bilder mit bestimmten Personen suchen',
    search_button: 'Suchen', search_results: 'Suchergebnisse für',
    no_results_found: 'Keine Ergebnisse gefunden', refresh: 'Aktualisieren',
    browse_description: 'Alle verarbeiteten Bilder durchsuchen', filter_options: 'Filteroptionen',
    filter_by_people: 'Nach Personen filtern', sort_by: 'Sortieren nach',
    sort_newest: 'Neueste zuerst', sort_oldest: 'Älteste zuerst',
    merge: 'Zusammenführen', select_all: 'Alle auswählen', deselect_all: 'Auswahl aufheben',
    batch_description: 'Gesamte Ordner verarbeiten', select_folder: 'Ordner wählen',
    recursive_scan: 'Unterordner einschließen', process_folder: 'Ordner verarbeiten',
    batch_progress: 'Fortschritt', batch_complete: 'Stapelverarbeitung abgeschlossen!',
    processed: 'Verarbeitet', failed: 'Fehlgeschlagen', skipped: 'Übersprungen', remaining: 'Verbleibend',
    stop_processing: 'Stopp', resume_processing: 'Fortsetzen',
    stats_overview: 'Übersicht', stats_total_people: 'Personen gesamt', stats_total_images: 'Bilder gesamt',
    stats_total_faces: 'Erkannte Gesichter', stats_database: 'Datenbank',
    refresh_stats: 'Aktualisieren',
    settings_title: 'Systemkonfiguration', recognition_settings: 'Erkennungseinstellungen',
    backend: 'Backend', model: 'Modell', detection_threshold: 'Erkennungsschwelle',
    recognition_threshold: 'Erkennungsschwellwert', use_gpu: 'GPU verwenden',
    ai_enrichment: 'KI-Anreicherung', enable_vlm: 'VLM aktivieren',
    vlm_provider: 'VLM-Anbieter', vlm_api_key: 'API-Schlüssel', vlm_model: 'Modell',
    ui_settings: 'Benutzeroberfläche', language: 'Sprache',
    save_settings: 'Einstellungen speichern', reset_settings: 'Zurücksetzen',
    user_management: 'Benutzerverwaltung', username: 'Benutzername', password: 'Passwort',
    role_admin: 'Administrator', role_user: 'Benutzer',
    no_image: 'Bitte ein Bild hochladen', no_faces_detected: 'Keine Gesichter erkannt',
    settings_saved: 'Einstellungen gespeichert', error: 'Fehler', success: 'Erfolg',
    please_wait: 'Bitte warten...', loading: 'Lädt...', no_key: 'Kein Schlüssel', of: 'von',
    ok: 'OK', cancel: 'Abbrechen', save: 'Speichern', delete: 'Löschen', edit: 'Bearbeiten',
    view: 'Ansehen', download: 'Herunterladen', upload: 'Hochladen', clear: 'Leeren', reset: 'Zurücksetzen',
    confirm: 'Bestätigen', back: 'Zurück', next: 'Weiter', previous: 'Zurück',
    search_by_date: 'Datum',
    change_password: 'Passwort ändern',
    current_password: 'Aktuelles Passwort',
    new_password: 'Neues Passwort',
    confirm_password: 'Passwort bestätigen',
    password_changed: 'Passwort erfolgreich geändert',
    set_password: 'Passwort setzen',
    test_key: 'Testen',
    key_valid: 'Schlüssel gültig',
    key_invalid: 'Ungültiger Schlüssel',
    // Cloud drives
    cloud_drives: 'Cloud-Laufwerke',
    add_drive: 'Laufwerk hinzufügen',
    no_cloud_drives: 'Keine Cloud-Laufwerke konfiguriert',
    no_cloud_drives_hint: 'Netzwerkfreigabe oder Cloud-Konto hinzufügen',
    drive_name: 'Laufwerkname', drive_type: 'Typ', drive_host: 'Host', drive_server: 'Server',
    drive_share: 'Freigabe', drive_username: 'Benutzername', drive_password: 'Passwort',
    drive_domain: 'Domäne', drive_port: 'Port', drive_remote_path: 'Entfernter Pfad',
    drive_ssh_key: 'SSH-Schlüssel', drive_email: 'E-Mail', drive_tfa: '2FA-Code',
    drive_mount_point: 'Einhängepunkt', drive_read_only: 'Nur lesen',
    drive_scope: 'Bereich', drive_scope_system: 'System', drive_scope_user: 'Persönlich',
    drive_allowed_roles: 'Erlaubte Rollen', drive_auto_mount: 'Automatisch einbinden',
    drive_edit: 'Bearbeiten', drive_save: 'Laufwerk speichern', drive_delete: 'Laufwerk löschen',
    drive_delete_confirm: 'Laufwerk löschen?',
    drive_connect: 'Verbinden', drive_disconnect: 'Trennen',
    drive_mount: 'Einbinden', drive_unmount: 'Trennen', drive_test: 'Testen',
    drive_status_connected: 'Verbunden', drive_status_mounted: 'Eingebunden', drive_status_offline: 'Offline',
    drive_placeholder_name: 'Mein Laufwerk', drive_placeholder_host: 'z.B. 192.168.1.1',
    drive_placeholder_server: '//server/freigabe', drive_placeholder_share: 'freigabe',
    drive_placeholder_remote_path: '/entfernter/pfad', drive_placeholder_ssh_key: '/pfad/zum/schlüssel',
    drive_placeholder_tfa: '2FA-Code', drive_placeholder_mount_smb: '/mnt/smb',
    drive_placeholder_mount_sftp: '/mnt/sftp',
    // Face identification / clusters
    face_identification: 'Gesichtserkennung', face_clusters: 'Gesichtsgruppen',
    face_num: 'Gesicht #', identify_persons: 'Identifizieren',
    person_name_placeholder: 'Name eingeben…', type_name_placeholder: 'Name eingeben…',
    enter_person_name: 'Personenname eingeben',
    all_faces_identified: 'Alle Gesichter identifiziert', no_faces_in_image: 'Keine Gesichter in diesem Bild',
    no_clusters_found: 'Keine Gesichtsgruppen gefunden', no_clusters_detail: 'Weitere Bilder verarbeiten um Gesichtsgruppen zu erstellen',
    clustering_faces: 'Gesichter werden gruppiert…', similarity_threshold: 'Ähnlichkeitsschwelle',
    lower_threshold_hint: 'Niedrigerer Schwellwert = mehr Ergebnisse',
    recognition_certainty: 'Gewissheit', conf_short: 'Konf',
    clear_all_identifications: 'Alle Identifikationen löschen',
    drag_to_mark_face: 'Ziehen um Gesicht zu markieren',
    // Train
    browse_button: 'Durchsuchen', train_folder_description: 'Ordner mit benannten Unterordnern (je eine Person)',
    // Sort options
    sort_date_taken_asc: 'Aufnahmedatum (älteste)', sort_date_taken_desc: 'Aufnahmedatum (neueste)',
    sort_filename_az: 'Dateiname A–Z', sort_most_faces: 'Meiste Gesichter',
    // Stats
    stats_images_with_date: 'Bilder mit Datum',
    // Lightbox / image ops
    zoom_in: 'Vergrößern', zoom_out: 'Verkleinern', fit_to_screen: 'Bildschirm füllen',
    press_esc_to_close: 'Esc zum Schließen', close: 'Schließen',
    run_detection: 'Erkennung starten', remove_detection: 'Erkennung entfernen',
    min_face_size: 'Min. Gesichtsgröße',
    // Misc
    apply: 'Anwenden', apply_to_all: 'Auf alle anwenden', apply_to_selected: 'Auf Auswahl anwenden',
    skip: 'Überspringen', rescan: 'Neu scannen', scanning: 'Scannt…', save_all: 'Alle speichern',
    deselect: 'Auswahl aufheben', selection: 'Auswahl', source: 'Quelle', target: 'Ziel',
    search_name: 'Nach Name suchen…', operation_cancelled: 'Abgebrochen',
    people_detected: 'Erkannte Personen', process_more_images: 'Weitere Bilder verarbeiten',
    image_pending: '1 Bild ausstehend', images_pending: '{n} Bilder ausstehend',
  },
};

export const translations = writable(EN);
export const lang = writable('en');

export const t = derived(translations, $t => (key) => $t[key] || key);

// ── Watch folders ──────────────────────────────────────────────────────────────
export const watchFolders = writable([]);

// ── Filesystem browser ──────────────────────────────────────────────────────
export const fsCurrentPath = writable('');

// ── Albums ───────────────────────────────────────────────────────────────────
export const allAlbums = writable([]);

// ── Ratings & flags ──────────────────────────────────────────────────────────
// Local cache of user-assigned ratings/flags; key = image_id (number)
export const starRatings = writable({});   // { [id]: 0-5 }
export const colorFlags  = writable({});   // { [id]: 'pick'|'delete'|null }

// ── Lightbox refresh ─────────────────────────────────────────────────────────
// Increment to force the lightbox to reload its image (e.g., after rotate)
export const lightboxKey = writable(0);

// ── Gallery refresh tick ──────────────────────────────────────────────────────
// Increment to trigger a gallery reload (e.g., after upload completion)
export const galleryRefreshTick = writable(0);

// ── Background task (e.g., "Add to DB" SSE) ──────────────────────────────────
// { label: string, done: number, total: number } | null
export const backgroundTask = writable(null);

// ── Hybrid ingest mode (when Electron is connected to a remote VPS) ───────────
// 'upload_full'    — Electron uploads full images → VPS processes (default)
// 'local_process'  — Electron runs InsightFace → uploads embeddings only
export const processingMode   = writable('upload_full');
export const localModel       = writable('buffalo_l');
export const localModelStatus = writable({});   // { buffalo_l: bool, ... }

// ── Derived ───────────────────────────────────────────────────────────────────
export const activeFilterCount = derived(filters, $f =>
  Object.values($f).filter(v => v && v.trim()).length
);
