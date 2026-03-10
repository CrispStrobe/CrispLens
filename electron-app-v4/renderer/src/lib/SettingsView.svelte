<script>
  import { onMount } from 'svelte';
  import {
    fetchSettings, saveSettings,
    fetchUserVlmPrefs, saveUserVlmPrefs,
    fetchUserDetPrefs, saveUserDetPrefs,
    fetchProviders, fetchKeyStatus, saveApiKey, deleteApiKey, testApiKey,
    login, logout, fetchMe, fetchVlmModels,
    listUsers, createUser, updateUser, deleteUser, resetUserLock,
    checkCredentials, fetchDbStatus, fetchEngineStatus, reloadEngine,
    changePassword, fetchTranslations,
    isLocalMode, setLocalMode, exportDB, importDB, clearDB, hardResetApp
  } from '../api.js';
  import { currentUser, t, processingMode, localModel, backendReady, stats, allPeople, allTags, allAlbums, translations, lang, TRANSLATIONS, processingBackend } from '../stores.js';
  import syncManager, { loadSyncSettings, saveSyncSettings } from './SyncManager.js';
  import { fetchStats, fetchPeople, fetchTags, fetchAlbums, fetchServerLogs,
           testAdminJson } from '../api.js';
  import ServerUpdateModal from './ServerUpdateModal.svelte';
  import ServerLogsModal   from './ServerLogsModal.svelte';
  import { VLM_MODELS } from './VlmData.js';

  // ── Config state ──────────────────────────────────────────────────────────
  let cfg = null;
  let saving = false;
  let saveMsg = '';

  // Convenience shorthand
  $: isAdmin = $currentUser?.role === 'admin';

  // Editable fields
  let language     = 'de';
  let backend      = 'insightface';
  let model        = 'buffalo_l';
  let detThreshold = 0.6;
  let recThreshold = 0.4;
  let detSize      = 640;
  let detRetries   = 1;
  let vlmEnabled   = false;
  let vlmProvider  = '';
  let vlmModel     = '';
  let vlmMaxSize   = 0;
  let uploadMaxDim = 0; // 0 = keep full resolution
  // Admin — server management
  let showUpdateModal = false;
  let showLogsModal   = false;
  // Debug test state: label + lines + running flag per button
  let testLabel   = '';
  let testLines   = [];
  let testRunning = false;
  let exemptPaths     = ['/mnt'];
  let benchmarkRunning = false;
  let browserBenchResults = null;
  let serverBenchResults = null;
  let benchProgress = '';
  let benchImageId = null;
  $: isAppleSiliconClient = typeof navigator !== 'undefined' && /Macintosh|Mac OS X/i.test(navigator.userAgent);
  $: isWindowsClient = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
  $: isLinuxClient = typeof navigator !== 'undefined' && /Linux/i.test(navigator.userAgent);

  let fixDbPath       = '';
  let detModel     = 'auto';   // detection model (system default or user override)
  let globalDetModelHint = null; // for non-admin hint

  const BACKENDS   = ['insightface', 'dlib_hog', 'dlib_cnn'];
  const IF_MODELS  = ['buffalo_l', 'buffalo_m', 'buffalo_s', 'buffalo_sc'];
  const LANGUAGES  = [{ code: 'en', label: 'English' }, { code: 'de', label: 'Deutsch' }];

  // ── Remote processing backend ─────────────────────────────────────────────
  let procBackend    = 'local';         // 'local' | 'remote_v2' | 'remote_v4'
  let remoteV2Url    = '';
  let remoteV2User   = '';
  let remoteV2Pass   = '';
  let remoteV2Mode   = 'upload_bytes';  // 'upload_bytes' | 'local_infer'
  let remoteV2TestMsg = '';
  let remoteV2Testing = false;

  // Detection model options vary by backend
  const ALL_DET_MODELS = [
    { value: 'auto',       label: 'det_model_auto',       backends: ['local', 'remote_v2', 'remote_v4', 'standalone'] },
    { value: 'retinaface', label: 'det_model_retinaface',  backends: ['remote_v2'] },
    { value: 'scrfd',      label: 'det_model_scrfd',       backends: ['remote_v2'] },
    { value: 'yunet',      label: 'det_model_yunet',       backends: ['local', 'remote_v2', 'remote_v4', 'standalone'] },
    { value: 'mediapipe',  label: 'det_model_mediapipe',   backends: ['remote_v2', 'standalone'] },
    { value: 'none',       label: 'det_model_none',        backends: ['local', 'remote_v2', 'remote_v4', 'standalone'] },
  ];
  $: _effectiveBackend = dbMode === 'local' ? 'standalone' : procBackend;
  $: DET_MODELS = ALL_DET_MODELS.filter(m => m.backends.includes(_effectiveBackend));
  $: if (DET_MODELS.length && !DET_MODELS.find(m => m.value === detModel)) detModel = 'auto';

  // ── Browser ONNX provider prefs (localStorage, standalone/browser only) ────
  const _ls = typeof localStorage !== 'undefined' ? localStorage : null;
  let ortUseSIMD   = _ls?.getItem('pref_ort_use_simd')   === 'true';
  let ortUseWebGL  = _ls?.getItem('pref_ort_use_webgl')  !== 'false'; // default true
  let ortUseWebGPU = _ls?.getItem('pref_ort_use_webgpu') === 'true';

  function saveOrtPrefs() {
    if (!_ls) return;
    _ls.setItem('pref_ort_use_simd',   String(ortUseSIMD));
    _ls.setItem('pref_ort_use_webgl',  String(ortUseWebGL));
    _ls.setItem('pref_ort_use_webgpu', String(ortUseWebGPU));
  }

  // ── Server ONNX provider prefs (from server settings) ─────────────────────
  let ortUseCoreML   = false;
  let ortUseCUDA     = false;
  let ortUseDirectML = false;

  // ── Auto-load server settings when backend becomes ready ──────────────────
  $: if ($backendReady && !cfg) {
    console.log('[SettingsView] Backend ready, starting initial fetch...');
    fetchSettings().then(c => {
      console.log('[SettingsView] fetchSettings complete');
      cfg = c;
      language     = c?.ui?.language ?? 'de';
      backend      = c?.face_recognition?.backend ?? 'insightface';
      model        = c?.face_recognition?.insightface?.model ?? 'buffalo_l';
      detThreshold = c?.face_recognition?.insightface?.detection_threshold ?? 0.6;
      recThreshold = c?.face_recognition?.insightface?.recognition_threshold ?? 0.4;
      detRetries   = c?.face_recognition?.insightface?.det_retries ?? 1;
      const ds     = c?.face_recognition?.insightface?.det_size ?? [640, 640];
      detSize      = Array.isArray(ds) ? ds[0] : ds;
      uploadMaxDim = c?.storage?.upload_max_dimension ?? 0;
      exemptPaths  = c?.storage?.copy_exempt_paths ?? ['/mnt'];
      fixDbPath    = c?.admin?.fix_db_path ?? '';
      if ($currentUser?.role === 'admin') {
        // Admin edits global VLM defaults directly
        vlmEnabled  = c?.vlm?.enabled ?? false;
        vlmProvider = c?.vlm?.provider ?? 'anthropic';
        vlmModel    = c?.vlm?.model ?? '';
        detModel    = c?.face_recognition?.insightface?.det_model ?? 'auto';
        // Remote backend settings
        procBackend    = c?.processing?.backend         ?? 'local';
        remoteV2Url    = c?.processing?.remote_v2?.url  ?? '';
        remoteV2User   = c?.processing?.remote_v2?.user ?? '';
        remoteV2Mode   = c?.processing?.remote_v2?.mode ?? 'upload_bytes';
        ortUseCoreML   = c?.inference?.ort_use_coreml   ?? false;
        ortUseCUDA     = c?.inference?.ort_use_cuda     ?? false;
        ortUseDirectML = c?.inference?.ort_use_directml ?? false;
        processingBackend.set(procBackend);
      }
    }).catch(e => console.error('[SettingsView] fetchSettings failed:', e));
    // Non-admin: load personal VLM prefs (shows effective = override || global fallback)
    if ($currentUser?.role !== 'admin') {
      fetchUserVlmPrefs().then(p => {
        console.log('[SettingsView] fetchUserVlmPrefs complete');
        vlmEnabled  = p.effective.vlm_enabled  ?? false;
        vlmProvider = p.effective.vlm_provider ?? 'anthropic';
        vlmModel    = p.effective.vlm_model    ?? '';
        vlmMaxSize  = p.effective.vlm_max_size  ?? 0;
        globalVlmHint = p.global;
      }).catch(e => console.warn('[SettingsView] fetchUserVlmPrefs failed:', e));
      // Load personal detection model pref
      fetchUserDetPrefs().then(p => {
        console.log('[SettingsView] fetchUserDetPrefs complete');
        detModel = p.effective?.det_model ?? 'auto';
        globalDetModelHint = p.global?.det_model ?? 'auto';
      }).catch(e => console.warn('[SettingsView] fetchUserDetPrefs failed:', e));
    }
    fetchProviders().then(p => { console.log('[SettingsView] fetchProviders complete'); providers = p; }).catch(() => {});
    fetchKeyStatus().then(k => { console.log('[SettingsView] fetchKeyStatus complete'); keyStatus = k; }).catch(() => {});
    fetchEngineStatus().then(s => { console.log('[SettingsView] fetchEngineStatus complete'); engineStatus = s; }).catch(() => {});
    if ($currentUser?.role === 'admin') {
      console.log('[SettingsView] User is admin, loading users and db status...');
      loadUsers();
      fetchDbStatus().then(s => { console.log('[SettingsView] fetchDbStatus complete'); dbStatus = s; }).catch(() => {});
    }
  }

  $: if ($currentUser?.role === 'admin' && $backendReady && !usersLoaded && !usersLoading) {
    console.log('[SettingsView] Reactive trigger: loading users...');
    loadUsers();
  }

  // ── VLM Models ─────────────────────────────────────────────────────────────
  let vlmModels = [];
  let fetchingModels = false;
  let globalVlmHint = null;  // { vlm_enabled, vlm_provider, vlm_model } — for non-admin hint

  $: if (vlmProvider) {
    console.log('[SettingsView] VLM provider changed:', vlmProvider);
    doFetchModels();
  }


  // Reactive default for VLM max size
  $: if (vlmProvider && vlmMaxSize === 0) {
    if (vlmProvider === 'mistral') vlmMaxSize = 900;
    else if (vlmProvider === 'groq') vlmMaxSize = 1024;
  }

  let vlmFetchMsg = '';
  async function doFetchModels() {
    if (!vlmProvider || fetchingModels) return;
    fetchingModels = true;
    vlmFetchMsg = 'Fetching…';
    const currentProvider = vlmProvider;
    const currentModel = vlmModel;
    console.log('[SettingsView] doFetchModels for:', currentProvider);
    
    // Safety timeout to prevent permanent hang
    const safetyTimer = setTimeout(() => {
      if (fetchingModels) {
        console.warn('[SettingsView] doFetchModels safety timeout triggered');
        fetchingModels = false;
        vlmFetchMsg = '✗ Request timed out';
      }
    }, 15000);

    try {
      const models = await fetchVlmModels(currentProvider);
      vlmModels = models;
      vlmFetchMsg = vlmModels.length > 0 ? `✓ ${vlmModels.length} models found` : '✓ Using local defaults';
      console.log(`[SettingsView] Found ${vlmModels.length} models for ${currentProvider}`);
      
      // If the previously selected model is in the new list, keep it
      if (currentModel && vlmModels.includes(currentModel)) {
        vlmModel = currentModel;
      }
    } catch (e) {
      console.error('[SettingsView] fetchVlmModels failed:', e);
      vlmFetchMsg = '✗ Live fetch failed — using defaults';
      // Fallback: at least show the hardcoded models if we know them
      vlmModels = VLM_MODELS[currentProvider] || [];
      if (currentModel && vlmModels.includes(currentModel)) {
        vlmModel = currentModel;
      }
    } finally {
      clearTimeout(safetyTimer);
      fetchingModels = false;
      setTimeout(() => { if (vlmFetchMsg.startsWith('✓') || vlmFetchMsg.includes('failed') || vlmFetchMsg.includes('timeout')) vlmFetchMsg = ''; }, 3000);
    }
  }

  // Get the display name for the default model of current provider
  function getDefaultModelName(provider) {
    return VLM_MODELS[provider]?.[0] || 'Default';
  }
  let defaultModelLabel = 'Default';
  $: if (vlmProvider) {
    defaultModelLabel = `Default (${getDefaultModelName(vlmProvider)})`;
  }

  // ── API keys state ─────────────────────────────────────────────────────────
  let providers = {};
  let keyStatus = {};
  let keyInputs = {};   // provider → { value, scope }
  let keyMsg = {};      // provider → message string

  // ── Change-password state (own account) ──────────────────────────────────
  let pwCurrent = '';
  let pwNew     = '';
  let pwConfirm = '';
  let pwMsg     = '';
  let pwChanging = false;

  // ── Admin: set another user's password ────────────────────────────────────
  let setPassUserId   = null;   // which user row has the form open
  let setPassValue    = '';
  let setPassMsg      = '';
  let setPassWorking  = false;

  // ── API key test results ──────────────────────────────────────────────────
  let keyTestMsg = {};  // provider → message string

  // ── Auth state ────────────────────────────────────────────────────────────
  let loginUsername = '';
  let loginPassword = '';
  let loginError = '';

  // ── Connection state ──────────────────────────────────────────────────────
  let connectionMode = 'local';
  let remoteUrl = '';
  let localPort = 7865;
  let isStandaloneBroken = false;
  let standaloneError = '';
  let syncRemoteUrl = ''; // Target server for syncing from standalone mode
  let testDiagMsg = '';
  let testingDiag = false;
  let restartingEngine = false;

  async function doRestartEngine() {
    restartingEngine = true;
    testDiagMsg = 'Restarting WASM engine...';
    try {
      const { restartEngine } = await import('./LocalDB.js');
      await restartEngine();
      testDiagMsg = '✓ Engine restarted successfully';
      isStandaloneBroken = false;
      standaloneError = '';
    } catch (e) {
      testDiagMsg = `✗ Restart failed: ${e.message}`;
    } finally {
      restartingEngine = false;
    }
  }

  async function runDbDiag() {
    testingDiag = true;
    testDiagMsg = 'Running diagnostics...';
    try {
      const { testStandaloneDB } = await import('./LocalDB.js');
      const res = await testStandaloneDB();
      testDiagMsg = res.ok ? `✓ ${res.message}` : `✗ ${res.error}`;
    } catch (e) {
      testDiagMsg = `✗ ${e.message}`;
    } finally {
      testingDiag = false;
    }
  }

  // ── Storage mode: 'server' (HTTP) vs 'local' (on-device SQLite) ─────────
  let dbMode = typeof window !== 'undefined'
    ? (localStorage.getItem('db_mode') || 'server')
    : 'server';

  async function switchDbMode(mode) {
    setLocalMode(mode === 'local');
    dbMode = mode;
    // Reload so the new mode takes effect immediately.
    // App.svelte handles robust initialization on the fresh load.
    setTimeout(() => { window.location.reload(); }, 500);
  }

  // Check standalone availability
  onMount(async () => {
    if (dbMode === 'local') {
      try {
        const { isAvailable } = await import('./LocalDB.js');
        const ok = await isAvailable();
        if (!ok) {
          isStandaloneBroken = true;
          standaloneError = 'SQLite engine failed to initialize (WASM error).';
        }
      } catch (e) {
        isStandaloneBroken = true;
        standaloneError = e.message;
      }

      // Load sync/offline settings from SQLite (authoritative in local mode)
      try {
        const s = await fetchSettings();
        if (s?.sync) {
          console.log('[SettingsView] Loaded sync settings from SQLite:', s.sync);
          syncThumbSize  = s.sync.thumb_size  ?? syncThumbSize;
          syncMaxItems   = s.sync.max_items   ?? syncMaxItems;
          syncMaxSizeMb  = s.sync.max_size_mb ?? syncMaxSizeMb;
          // Mirror to localStorage so SyncManager and reDetectFaces can read without async
          saveSyncSettings({ thumbSize: syncThumbSize, maxItems: syncMaxItems, maxSizeMb: syncMaxSizeMb });
          console.log(`[SettingsView] Sync settings applied: thumb_size=${syncThumbSize} max_items=${syncMaxItems} max_size_mb=${syncMaxSizeMb}`);
        } else {
          console.warn('[SettingsView] fetchSettings() returned no sync section — using localStorage values');
        }
      } catch (e) {
        console.warn('[SettingsView] Could not load sync settings from SQLite:', e.message);
      }
    }
    // Allow reactive auto-save now that initial values are set
    _syncSettingsReady = true;
  });

  // ── ONNX model download (for standalone/local mode) ─────────────────────
  let modelStatus = { det_10g: false, w600k_r50: false };
  let modelDownloading = false;
  let modelDownloadMsg = '';

  async function checkModelStatus() {
    try {
      const { faceEngineWeb } = await import('./FaceEngineWeb.js');
      // Always use /ort-wasm for local models
      faceEngineWeb.setModelBaseUrl('/ort-wasm');
      modelStatus = await faceEngineWeb.getModelCacheStatus();
    } catch { /* ignore */ }
  }

  async function downloadModels() {
    if (modelDownloading) return;
    modelDownloading = true;
    modelDownloadMsg = '';
    try {
      const { faceEngineWeb } = await import('./FaceEngineWeb.js');
      faceEngineWeb.setModelBaseUrl('/ort-wasm');
      const results = await faceEngineWeb.downloadModels(
        (msg) => { modelDownloadMsg = msg; }
      );
      const failed = Object.entries(results).filter(([, v]) => v !== 'ok');
      modelDownloadMsg = failed.length
        ? '✗ Failed: ' + failed.map(([k, v]) => `${k}: ${v}`).join(', ')
        : '✓ Models cached — ready for offline use';
      await checkModelStatus();
    } catch (e) {
      modelDownloadMsg = '✗ ' + (e.message || String(e));
    } finally {
      modelDownloading = false;
    }
  }

  // Check model status when settings view mounts (if in local mode)
  $: if (dbMode === 'local' && typeof window !== 'undefined') checkModelStatus();

  // ── PWA / Browser API server ──────────────────────────────────────────────
  // App.svelte reads 'remote_url' from localStorage — we must use the same key.
  const _PRESETS_KEY = 'crisp_server_presets';
  let pwaServerUrl  = typeof window !== 'undefined'
    ? (localStorage.getItem('remote_url') || window.location.origin)
    : '';
  let pwaConnectMsg = '';
  let serverPresets = typeof window !== 'undefined'
    ? JSON.parse(localStorage.getItem(_PRESETS_KEY) || '[]')
    : [];
  let newPresetName = '';
  let presetMsg = '';

  function doPwaConnect(urlOverride) {
    const url = (urlOverride ?? pwaServerUrl).trim().replace(/\/$/, '');
    if (!url) { pwaConnectMsg = '✗ Enter a server URL'; return; }
    if (!url.startsWith('http')) { pwaConnectMsg = '✗ URL must start with https:// or http://'; return; }
    pwaServerUrl = url;
    // Same key App.svelte reads on startup
    if (url === window.location.origin) {
      localStorage.removeItem('remote_url');  // same-origin = no stored URL
    } else {
      localStorage.setItem('remote_url', url);
    }
    pwaConnectMsg = '✓ Saved — reloading…';
    setTimeout(() => { window.location.reload(); }, 800);
  }

  function saveCurrentAsPreset() {
    const url = pwaServerUrl.trim().replace(/\/$/, '');
    if (!url || !url.startsWith('http')) { presetMsg = '✗ Set a valid URL first'; return; }
    const name = newPresetName.trim() || url;
    serverPresets = serverPresets.filter(p => p.url !== url);
    serverPresets = [...serverPresets, { name, url }];
    localStorage.setItem(_PRESETS_KEY, JSON.stringify(serverPresets));
    newPresetName = '';
    presetMsg = '✓ Saved';
    setTimeout(() => { presetMsg = ''; }, 2000);
  }

  function deletePreset(i) {
    serverPresets = serverPresets.filter((_, idx) => idx !== i);
    localStorage.setItem(_PRESETS_KEY, JSON.stringify(serverPresets));
  }

  // ── Offline cache / sync ──────────────────────────────────────────────────
  // Initial values from localStorage (fast, sync) — will be overwritten from
  // SQLite on mount when in local mode (the authoritative store).
  const _syncCfg        = typeof window !== 'undefined' ? loadSyncSettings() : {};
  let syncMaxItems      = _syncCfg.maxItems  ?? 500;
  let syncMaxSizeMb     = _syncCfg.maxSizeMb ?? 500;
  let syncThumbSize     = _syncCfg.thumbSize ?? 600;  // default 600 matches SQLite default
  let _syncSettingsReady = false;  // true after mount-time SQLite load
  let pendingPushCount  = 0;
  let pushing           = false;
  let pushMsg           = '';
  let syncing           = false;
  let syncProgress      = '';
  let syncMsg           = '';
  let syncStats         = null;

  // Auto-save sync settings when sliders change — but only after initial load
  // to avoid overwriting SQLite values with stale localStorage defaults.
  $: if (typeof window !== 'undefined' && _syncSettingsReady) {
    const cfg = { maxItems: syncMaxItems, maxSizeMb: syncMaxSizeMb, thumbSize: syncThumbSize };
    console.log('[SettingsView] sync settings changed — saving to localStorage + SQLite (local mode):', cfg);
    saveSyncSettings(cfg);
    if (dbMode === 'local') {
      // Also persist to SQLite so values survive hard reset
      saveSettings({ thumb_size: syncThumbSize, max_items: syncMaxItems, max_size_mb: syncMaxSizeMb })
        .then(() => console.log('[SettingsView] sync settings saved to SQLite ✓'))
        .catch(e => console.warn('[SettingsView] SQLite save for sync settings failed:', e.message));
    }
  }

  async function loadSyncStats() {
    syncStats = await syncManager.getStats().catch(() => null);
    pendingPushCount = syncStats?.pendingPush ?? 0;
  }

  async function doPush() {
    if (pushing) return;
    pushing = true; pushMsg = '';
    const apiBase = typeof window !== 'undefined'
      ? (localStorage.getItem('remote_url') || window.location.origin)
      : '';
    try {
      const { pushed, failed } = await syncManager.pushPending(apiBase,
        ({ done, total }) => { syncProgress = `${$t('offline_pushing')} ${done}/${total}…`; }
      );
      pushMsg = `✓ Pushed ${pushed}${failed ? `, ${failed} failed` : ''}`;
      await loadSyncStats();
    } catch (e) {
      pushMsg = '✗ ' + (e.message || String(e));
    } finally {
      pushing = false; syncProgress = '';
    }
  }

  async function doSync() {
    if (syncing) return;
    syncing = true; syncMsg = ''; syncProgress = '';
    saveSyncSettings({ maxItems: syncMaxItems, maxSizeMb: syncMaxSizeMb, thumbSize: syncThumbSize });
    const apiBase = typeof window !== 'undefined'
      ? (localStorage.getItem('remote_url') || window.location.origin)
      : '';
    try {
      await syncManager.sync({
        apiBase,
        maxItems: syncMaxItems,
        maxSizeMb: syncMaxSizeMb,
        thumbSize: syncThumbSize,
        onProgress({ phase, done, total, cancelled }) {
          if (cancelled) { syncProgress = ''; return; }
          if (phase === 'metadata')   syncProgress = `${$t('offline_phase_metadata')} (${total})`;
          else if (phase === 'thumbnails') syncProgress = `${$t('offline_phase_thumbnails')} ${done}/${total}`;
          else if (phase === 'done')  syncProgress = $t('offline_phase_done');
        },
      });
      syncMsg = '✓ ' + $t('offline_phase_done');
      await loadSyncStats();
    } catch (e) {
      syncMsg = '✗ ' + (e.message || String(e));
    } finally {
      syncing = false;
      syncProgress = '';
    }
  }

  async function doClearCache() {
    await syncManager.clear();
    syncMsg = '✓ ' + $t('offline_cleared');
    syncStats = null;
  }

  // ── Electron / ingest mode state ──────────────────────────────────────────
  let isElectron = false;
  let processingModeLocal = 'upload_full';   // 'upload_full' | 'local_process'
  let localModelLocal     = 'buffalo_l';
  let pythonPath          = '';
  let localModelStatus    = {};              // { buffalo_l: bool, ... }
  let testingPython       = false;
  let testResult          = '';
  let downloadingModel    = '';              // name of model currently downloading
  let downloadMsg         = {};             // { modelName: lastMsg }

  // ── Database state (Electron only) ───────────────────────────────────────
  let activeDbInfo  = null;     // { activePath, size, writable, defaultPath, isDefault }
  let currentDbPath = '';       // display value (= activeDbInfo.activePath once loaded)
  let newDbPath     = '';       // editable target for "open existing"
  let switchingDb   = false;
  let switchDbMsg   = '';

  // ── User management state (admin only) ───────────────────────────────────
  let users          = [];
  let usersLoading   = false;
  let usersLoaded    = false;
  let usersMsg       = '';
  let newUserName    = '';
  let newUserPass    = '';
  let newUserRole    = 'user';

  // ── DB health check state ─────────────────────────────────────────────────
  let credCheckUser  = '';
  let credCheckPass  = '';
  let credCheckMsg   = '';
  let credChecking   = false;
  let dbStatus       = null;
  let engineStatus   = null;   // {ready, error, backend, model}
  let engineReloading = false;
  let engineReloadMsg = '';
  let mpDownloading   = false;
  let mpDownloadMsg   = '';

  onMount(async () => {
    isElectron = typeof window.electronAPI !== 'undefined';
    if (isElectron) {
      try {
        const s = await window.electronAPI.getSettings();
        if (s) {
          connectionMode = s.remoteUrl ? 'remote' : 'local';
          remoteUrl      = s.remoteUrl || '';
          localPort      = s.port || 7861;
          console.log('[SettingsView] Electron settings.json loaded:', { connectionMode, remoteUrl, localPort });
        }
      } catch (e) { console.error('[SettingsView] getSettings error:', e); }

      // Load the ACTUAL active database info from main process
      try {
        activeDbInfo  = await window.electronAPI.getActiveDb();
        currentDbPath = activeDbInfo.activePath || '';
        newDbPath     = currentDbPath;
        console.log('[SettingsView] Active DB:', activeDbInfo);
      } catch (e) { console.error('[SettingsView] getActiveDb error:', e); }
    }

    if (isElectron) {
      try { localModelStatus = await window.electronAPI.checkLocalModels(); } catch { /* ignore */ }
    }

    // Load offline cache stats (works regardless of backend state)
    if (typeof window !== 'undefined') {
      loadSyncStats();
      syncRemoteUrl = localStorage.getItem('remote_url') || '';
    }

    if ($backendReady) {
      try {
        console.log('[SettingsView] onMount: fetching initial settings...');
        cfg = await fetchSettings();
        console.log('[SettingsView] onMount: cfg loaded:', cfg);
        language     = cfg?.ui?.language ?? 'de';
        backend      = cfg?.face_recognition?.backend ?? 'insightface';
        model        = cfg?.face_recognition?.insightface?.model ?? 'buffalo_l';
        detThreshold = cfg?.face_recognition?.insightface?.detection_threshold ?? 0.6;
        recThreshold = cfg?.face_recognition?.insightface?.recognition_threshold ?? 0.4;
        detRetries   = cfg?.face_recognition?.insightface?.det_retries ?? 1;
        const ds = cfg?.face_recognition?.insightface?.det_size ?? [640, 640];
        detSize = Array.isArray(ds) ? ds[0] : ds;
          if ($currentUser?.role === 'admin') {
          console.log('[SettingsView] onMount: user is admin, setting VLM fields');
          vlmEnabled  = cfg?.vlm?.enabled ?? false;
          vlmProvider = cfg?.vlm?.provider ?? 'anthropic';
          vlmModel    = cfg?.vlm?.model ?? '';
          vlmMaxSize  = cfg?.vlm?.max_size ?? 0;
          detModel    = cfg?.face_recognition?.insightface?.det_model ?? 'auto';
          console.log(`[SettingsView] onMount: VLM initialized: enabled=${vlmEnabled}, provider=${vlmProvider}, model=${vlmModel}`);
          procBackend    = cfg?.processing?.backend         ?? 'local';
          remoteV2Url    = cfg?.processing?.remote_v2?.url  ?? '';
          remoteV2User   = cfg?.processing?.remote_v2?.user ?? '';
          remoteV2Mode   = cfg?.processing?.remote_v2?.mode ?? 'upload_bytes';
          ortUseCoreML   = cfg?.inference?.ort_use_coreml   ?? false;
          ortUseCUDA     = cfg?.inference?.ort_use_cuda     ?? false;
          ortUseDirectML = cfg?.inference?.ort_use_directml ?? false;
          processingBackend.set(procBackend);
        }
      } catch (e) { 
        console.error('[SettingsView] onMount: settings fetch error:', e);
        saveMsg = '⚠ Could not load server settings: ' + e.message; 
      }
      if ($currentUser?.role !== 'admin') {
        try {
          const p = await fetchUserVlmPrefs();
          console.log('[SettingsView] fetchUserVlmPrefs result:', p);
          vlmEnabled  = p.effective.vlm_enabled  ?? false;
          if (p.effective.vlm_provider) vlmProvider = p.effective.vlm_provider;
          if (p.effective.vlm_model) vlmModel = p.effective.vlm_model;
          globalVlmHint = p.global;
        } catch (err) { console.warn('[SettingsView] fetchUserVlmPrefs failed:', err); }
        try {
          const dp = await fetchUserDetPrefs();
          detModel = dp.effective?.det_model ?? 'auto';
          globalDetModelHint = dp.global?.det_model ?? 'auto';
        } catch { /* ignore */ }
      }
      try { providers = await fetchProviders(); } catch { /* ignore */ }
      try { keyStatus = await fetchKeyStatus(); } catch { /* ignore */ }
      
      // Ensure models are loaded for the current provider
      if (vlmProvider) doFetchModels();
    }
  });


  import { faceEngineWeb } from './FaceEngineWeb.js';
  import { fetchImages, fetchImageAsUrl, fetchThumbnail } from '../api.js';

              /** Extremely robust way to get base64 from any URL (blob, data, or remote) */
  async function _getBase64ViaImage(url) {
    console.log('[Benchmark] _getBase64ViaImage START for:', url.slice(0, 50));
    
    // Firefox FIX: Blobs must be fetched and read as data URLs to bypass Security Error
    if (url.startsWith('blob:')) {
      try {
        console.log('[Benchmark] URL is a blob, using fetch + FileReader');
        const res = await fetch(url);
        const blob = await res.blob();
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      } catch (e) {
        console.warn('[Benchmark] Fetching blob URL failed, falling back to Image parser:', e.message);
      }
    }

    return new Promise((resolve, reject) => {
      const img = new Image();
      if (!url.startsWith('blob:') && !url.startsWith('data:') && !url.startsWith('filesystem:')) {
        img.crossOrigin = 'anonymous';
      }
      const timeout = setTimeout(() => { img.src = ''; reject(new Error('Image load timeout (10s)')); }, 10000);
      img.onload = () => {
        clearTimeout(timeout);
        try {
          const canvas = document.createElement('canvas');
          const maxDim = 1024;
          let w = img.width, h = img.height;
          if (w > maxDim || h > maxDim) {
            const scale = maxDim / Math.max(w, h);
            w = Math.round(w * scale); h = Math.round(h * scale);
          }
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        } catch (e) { reject(new Error('Canvas conversion failed: ' + e.message)); }
      };
      img.onerror = () => { clearTimeout(timeout); reject(new Error('Browser failed to load image resource (Security or Network error)')); };
      img.src = url;
    });
  }

  async function doBrowserBenchmark() {
    benchmarkRunning = true;
    browserBenchResults = null;
    try {
      console.log('%c[Benchmark] BROWSER benchmark starting...', 'color: #4090d0; font-weight: bold');
      benchProgress = 'Preparing benchmark image...';
      let img;
      if (benchImageId) {
        const { fetchImage } = await import('../api.js');
        img = await fetchImage(benchImageId);
        if (!img) throw new Error(`Image ID ${benchImageId} not found`);
      } else {
        const imgs = await fetchImages({ unidentified: false, sort: 'most_faces', limit: 1 });
        if (!imgs || imgs.length === 0) throw new Error('No images in database to test with');
        img = imgs[0];
      }
      
      let b64 = null;
      // Step A: Try direct thumbnail from DB (safest)
      try {
        console.log('[Benchmark] Attempting to fetch thumbnail directly for ID:', img.id);
        const thumb = await fetchThumbnail(img.id);
        if (thumb) {
          b64 = thumb.startsWith('data:') ? thumb : `data:image/jpeg;base64,${thumb}`;
          console.log('[Benchmark] Using direct base64 from DB');
        }
      } catch (e) { console.warn('[Benchmark] DB fetch failed'); }

      // Step B: Fallback to URL conversion
      if (!b64) {
        const imgUrl = await fetchImageAsUrl(img.filepath);
        benchProgress = 'Converting image URL...';
        b64 = await _getBase64ViaImage(imgUrl);
      }
      
      if (!b64) throw new Error('Failed to obtain image data');
      
      browserBenchResults = await faceEngineWeb.runInferenceBenchmark(b64, (msg) => {
        benchProgress = msg;
      });
      benchProgress = '✓ Browser benchmark complete';
    } catch (err) {
      console.error('BROWSER benchmark failed:', err);
      benchProgress = '✗ Failed: ' + err.message;
    } finally {
      benchmarkRunning = false;
    }
  }

  async function doServerBenchmark() {
    benchmarkRunning = true;
    serverBenchResults = null;
    try {
      benchProgress = 'Starting server-side benchmark...';
      const resp = await fetch('/api/benchmark/server', { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ image_id: benchImageId })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Server error');
      serverBenchResults = data;
      benchProgress = '✓ Server benchmark complete';
    } catch (err) {
      console.error('Server benchmark failed:', err);
      benchProgress = '✗ Failed: ' + err.message;
    } finally {
      benchmarkRunning = false;
    }
  }

  async function doSaveSettings() {
    console.log('[SettingsView] doSaveSettings() start');
    saving = true;
    saveMsg = '';
    try {
      if (isElectron) {
        console.log('[SettingsView] Saving Electron settings via IPC...');
        const existing = await window.electronAPI?.getSettings() || {};
        // Use flat format matching resolveDbPath() + switch-db IPC expectations.
        // Only write remoteUrl when explicitly switching to remote mode.
        const newSettings = {
          ...existing,
          port:      localPort || 7861,
          remoteUrl: connectionMode === 'remote' ? remoteUrl : '',
          // dbPath is managed exclusively by switchDb/resetDbToDefault IPC — don't overwrite here
        };
        // Remove stale nested keys from old format to avoid confusion
        delete newSettings.server;
        delete newSettings.client;
        await window.electronAPI?.saveSettings(newSettings);
        console.log('[SettingsView] Saved Electron settings:', newSettings);
        // Sync stores so ProcessView picks up changes immediately
        processingMode.set(processingModeLocal);
        localModel.set(localModelLocal);
        console.log('[SettingsView] IPC save settings complete');
      } else {
        // Browser/PWA: persist language preference locally
        localStorage.setItem('pwa_language', language);
      }

      if (dbMode === 'local') {
        localStorage.setItem('remote_url', syncRemoteUrl.trim());
      }

      // Only try to save server settings when backend is reachable
      if ($backendReady) {
        console.log('[SettingsView] Saving server settings via API...');
        if (isAdmin) {
          // Admin saves language + face-rec + global VLM defaults + upload settings
          await saveSettings({
            language,
            backend, model,
            det_threshold: detThreshold,
            rec_threshold: recThreshold,
            det_retries: detRetries,
            det_size: detSize,
            det_model: detModel || 'auto',
            vlm_enabled: vlmEnabled,
            vlm_provider: vlmProvider,
            vlm_model: vlmModel || null,
            vlm_max_size: vlmMaxSize,
            upload_max_dimension: uploadMaxDim,
            copy_exempt_paths:    exemptPaths.filter(p => p.trim()),
            fix_db_path:          fixDbPath.trim(),
            processing_backend: procBackend,
            remote_v2_url:      remoteV2Url.trim(),
            remote_v2_user:     remoteV2User.trim(),
            remote_v2_mode:     remoteV2Mode,
            ...(remoteV2Pass ? { remote_v2_pass: remoteV2Pass } : {}),
            ort_use_coreml:     ortUseCoreML,
            ort_use_cuda:       ortUseCUDA,
            ort_use_directml:   ortUseDirectML,
          });
          processingBackend.set(procBackend);
        } else {
          // Non-admin saves language + upload settings to global config
          await saveSettings({ language, upload_max_dimension: uploadMaxDim });
          // Personal VLM preferences go to the user-vlm endpoint
          await saveUserVlmPrefs({
            vlm_enabled:  vlmEnabled,
            vlm_provider: vlmProvider,
            vlm_model:    vlmModel || null,
            vlm_max_size: vlmMaxSize,
          });
          // Personal detection model preference
          await saveUserDetPrefs({ det_model: detModel || null });
        }
        console.log('[SettingsView] API save settings complete');
        saveMsg = '✓ All settings saved';
      } else {
        saveMsg = isElectron
          ? '✓ Connection settings saved  (server settings require backend)'
          : '✓ Preferences saved  (server settings require backend)';
      }
    } catch (e) {
      console.error('[SettingsView] doSaveSettings error:', e);
      saveMsg = '✗ ' + e.message;
    } finally {
      saving = false;
      console.log('[SettingsView] doSaveSettings() finished');
    }
  }

  async function doSaveKey(provider) {
    const canSystemKey = $currentUser?.role === 'admin' || $currentUser?.role === 'mediamanager';
    const defaultScope = canSystemKey ? 'system' : 'user';
    const input = keyInputs[provider] ?? { value: '', scope: defaultScope };
    if (!input.value?.trim()) return;
    try {
      await saveApiKey(provider, input.value.trim(), input.scope ?? 'system');
      keyMsg = { ...keyMsg, [provider]: '✓ Key saved' };
      keyStatus = await fetchKeyStatus();
      keyInputs = { ...keyInputs, [provider]: { ...input, value: '' } };
    } catch (e) {
      keyMsg = { ...keyMsg, [provider]: '✗ ' + e.message };
    }
  }

  async function doDeleteKey(provider, scope = 'system') {
    if (!confirm(`Delete ${scope} key for ${provider}?`)) return;
    try {
      await deleteApiKey(provider, scope);
      keyMsg = { ...keyMsg, [provider]: '✓ Key deleted' };
      keyStatus = await fetchKeyStatus();
    } catch (e) {
      keyMsg = { ...keyMsg, [provider]: '✗ ' + e.message };
    }
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  async function doLogin() {
    loginError = '';
    try {
      const r = await login(loginUsername, loginPassword);
      currentUser.set({ username: r.username, role: r.role });
      loginPassword = '';
      // Refresh all data stores now that we have a valid session
      if ($backendReady) {
        try { stats.set(await fetchStats()); } catch {}
        try { allTags.set(await fetchTags()); } catch {}
        try { allPeople.set(await fetchPeople()); } catch {}
        try { allAlbums.set(await fetchAlbums()); } catch {}
        fetchProviders().then(p => { providers = p; }).catch(() => {});
        fetchKeyStatus().then(k => { keyStatus = k; }).catch(() => {});
        fetchEngineStatus().then(s => { engineStatus = s; }).catch(() => {});
        if (r.role === 'admin') {
          loadUsers();
          fetchDbStatus().then(s => { dbStatus = s; }).catch(() => {});
        }
      }
    } catch (e) {
      loginError = e.message;
    }
  }

  async function doLogout() {
    try { await logout(); } catch { /* ignore */ }
    currentUser.set(null);
    // Clear data that required auth
    stats.set({});
    allTags.set([]);
    allPeople.set([]);
    allAlbums.set([]);
    users = [];
    dbStatus = null;
    engineStatus = null;
    providers = {};
    keyStatus = {};
  }

  // ── Database operations (Electron only) ──────────────────────────────────

  async function browseDb() {
    const paths = await window.electronAPI.openFileDialog({
      title: 'Open existing SQLite database',
      filters: [{ name: 'SQLite database', extensions: ['db', 'sqlite', 'sqlite3'] }],
      properties: ['openFile'],
    });
    if (paths?.length) newDbPath = paths[0];
  }

  async function doSwitchDb() {
    const p = newDbPath?.trim();
    if (!p || p === currentDbPath) return;
    switchingDb = true; switchDbMsg = '';
    try {
      await window.electronAPI.switchDb(p);
      switchDbMsg = 'Restarting…';
    } catch (e) { switchDbMsg = '✗ ' + e.message; switchingDb = false; }
  }

  async function doCreateNewDb() {
    const p = await window.electronAPI.saveFileDialog({
      title: 'Create new CrispLens database',
      defaultPath: 'face_recognition.db',
      filters: [{ name: 'SQLite database', extensions: ['db'] }],
    });
    if (!p) return;
    switchingDb = true; switchDbMsg = '';
    try {
      const r = await window.electronAPI.createNewDb(p);
      if (r.ok) { switchDbMsg = 'Restarting with new database…'; }
      else { switchDbMsg = '✗ ' + r.error; switchingDb = false; }
    } catch (e) { switchDbMsg = '✗ ' + e.message; switchingDb = false; }
  }

  async function doResetDbToDefault() {
    if (!confirm('Reset to default database location? The app will restart.')) return;
    switchingDb = true; switchDbMsg = '';
    try {
      await window.electronAPI.resetDbToDefault();
      switchDbMsg = 'Restarting with default database…';
    } catch (e) { switchDbMsg = '✗ ' + e.message; switchingDb = false; }
  }

  // ── User management ───────────────────────────────────────────────────────
  async function loadUsers() {
    console.log('[SettingsView] loadUsers() start');
    usersLoading = true;
    
    // 10s safety timeout
    const safety = setTimeout(() => {
      if (usersLoading) {
        console.warn('[SettingsView] loadUsers() safety timeout');
        usersLoading = false;
        usersMsg = '✗ Request timed out (SQLite error?)';
      }
    }, 10000);

    try {
      users = await listUsers();
      console.log(`[SettingsView] loadUsers() success: ${Array.isArray(users) ? users.length : 'non-array'} users found`);
    } catch (e) {
      console.error('[SettingsView] loadUsers() failed:', e);
      usersMsg = '✗ ' + e.message;
    } finally {
      clearTimeout(safety);
      usersLoading = false;
      usersLoaded = true;
      console.log('[SettingsView] loadUsers() finished');
    }
  }

  async function doCreateUser() {
    if (!newUserName.trim() || !newUserPass.trim()) return;
    try {
      await createUser(newUserName.trim(), newUserPass.trim(), newUserRole);
      usersMsg = `✓ User '${newUserName.trim()}' created`;
      newUserName = '';
      newUserPass = '';
      newUserRole = 'user';
      await loadUsers();
    } catch (e) {
      usersMsg = '✗ ' + e.message;
    }
  }

  async function doUpdateUserRole(userId, role) {
    try {
      await updateUser(userId, { role });
      await loadUsers();
    } catch (e) {
      usersMsg = '✗ ' + e.message;
    }
  }

  async function doToggleUserActive(userId, is_active) {
    try {
      await updateUser(userId, { is_active });
      await loadUsers();
    } catch (e) {
      usersMsg = '✗ ' + e.message;
    }
  }

  async function doDeleteUser(userId, username) {
    if (!confirm(`Delete user '${username}'?`)) return;
    try {
      await deleteUser(userId);
      usersMsg = `✓ User deleted`;
      await loadUsers();
    } catch (e) {
      usersMsg = '✗ ' + e.message;
    }
  }

  async function doResetLock(userId, username) {
    try {
      await resetUserLock(userId);
      usersMsg = `✓ Lock reset for '${username}'`;
      await loadUsers();
    } catch (e) {
      usersMsg = '✗ ' + e.message;
    }
  }

  async function doAdminSetPassword(userId) {
    if (!setPassValue.trim()) return;
    setPassWorking = true;
    setPassMsg = '';
    try {
      await updateUser(userId, { password: setPassValue.trim() });
      setPassMsg = '✓ Password updated';
      setPassValue = '';
      setPassUserId = null;
    } catch (e) {
      setPassMsg = '✗ ' + e.message;
    } finally {
      setPassWorking = false;
    }
  }

  // ── Change own password ───────────────────────────────────────────────────
  async function doChangePassword() {
    if (!pwCurrent || !pwNew) return;
    if (pwNew !== pwConfirm) { pwMsg = '✗ Passwords do not match'; return; }
    if (pwNew.length < 4) { pwMsg = '✗ Password must be at least 4 characters'; return; }
    pwChanging = true;
    pwMsg = '';
    try {
      await changePassword(pwCurrent, pwNew);
      pwMsg = '✓ ' + $t('password_changed');
      pwCurrent = ''; pwNew = ''; pwConfirm = '';
    } catch (e) {
      pwMsg = '✗ ' + e.message;
    } finally {
      pwChanging = false;
    }
  }

  // ── Test API key ──────────────────────────────────────────────────────────
  async function doTestKey(provider) {
    keyTestMsg = { ...keyTestMsg, [provider]: '…' };
    try {
      const r = await testApiKey(provider);
      if (r?.ok) {
        keyTestMsg = { ...keyTestMsg, [provider]: '✓ ' + (r.message || 'OK') };
      } else {
        keyTestMsg = { ...keyTestMsg, [provider]: '✗ ' + (r?.error || r?.detail || 'Key not found') };
      }
    } catch (e) {
      keyTestMsg = { ...keyTestMsg, [provider]: '✗ ' + e.message.replace(/^.*→ \d+: /, '') };
    }
  }

  // ── Test remote v2 connection ─────────────────────────────────────────────
  async function doTestRemoteV2() {
    remoteV2Testing = true;
    remoteV2TestMsg = '';
    try {
      // POST current form values directly — works before saving
      const r = await fetch('/api/settings/test-remote-v2', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ url: remoteV2Url, user: remoteV2User, pass: remoteV2Pass }),
      }).then(r => r.json());
      remoteV2TestMsg = r.ok
        ? '✓ ' + $t('remote_v2_connected')
        : '✗ ' + $t('remote_v2_unreachable') + (r.error ? `: ${r.error}` : '');
    } catch (e) {
      remoteV2TestMsg = '✗ ' + e.message;
    } finally {
      remoteV2Testing = false;
    }
  }

  // ── Language change — reload translations ─────────────────────────────────
  async function applyLanguage(newLang) {
    language = newLang;
    // Apply from local dict immediately for instant feedback.
    // Always merge on top of EN so keys missing from DE fall back to English.
    const local = TRANSLATIONS[newLang];
    const base  = TRANSLATIONS.en;
    if (local) {
      lang.set(newLang);
      translations.set({ ...base, ...local });
      sessionStorage.removeItem('i18n_cache');
    }

    if (isLocalMode()) {
      localStorage.setItem('pwa_language', newLang);
      // Also save to SQLite via LocalAdapter
      try {
        await saveSettings({ language: newLang });
      } catch (e) { console.warn('[SettingsView] Failed to save language to SQLite:', e); }
    }

    // Then sync with server (also persists config.yaml on save)
    if ($backendReady && !isLocalMode()) {
      try {
        const data = await fetchTranslations();
        lang.set(data.lang);
        if (data.translations && Object.keys(data.translations).length > 0) {
          translations.set({ ...base, ...data.translations });
        }
        sessionStorage.setItem('i18n_cache', JSON.stringify(data));
      } catch { /* ignore */ }
    }
  }

  // ── MediaPipe model download (server-side) ────────────────────────────────
  async function doDownloadMediaPipe() {
    mpDownloading = true;
    mpDownloadMsg = '';
    try {
      const r = await fetch('/api/settings/download-mediapipe', { method: 'POST' }).then(r => r.json());
      mpDownloadMsg = r.ok ? '✓ face_landmarker.task downloaded' : '✗ ' + r.error;
      if (r.ok) engineStatus = await fetchEngineStatus();
    } catch (e) {
      mpDownloadMsg = '✗ ' + e.message;
    } finally {
      mpDownloading = false;
    }
  }

  // ── Engine reload ─────────────────────────────────────────────────────────
  async function doReloadEngine() {
    engineReloading = true;
    engineReloadMsg = '';
    try {
      if (isLocalMode()) {
        // In standalone mode, release ONNX sessions so they'll be reloaded fresh on next inference
        const { faceEngineWeb } = await import('./FaceEngineWeb.js');
        await faceEngineWeb.releaseModels();
        engineReloadMsg = '✓ Engine sessions released — will reload on next use';
        engineReloading = false;
      } else {
        await reloadEngine();
        engineReloadMsg = 'Reload queued — refreshing status in 5 s…';
        // Poll once after a short delay to show the updated state
        setTimeout(async () => {
          try { engineStatus = await fetchEngineStatus(); } catch {}
          engineReloadMsg = engineStatus?.ready
            ? '✓ Engine ready'
            : (engineStatus?.error ? '✗ ' + engineStatus.error : 'Still loading…');
          engineReloading = false;
        }, 5000);
      }
    } catch (e) {
      engineReloadMsg = '✗ ' + e.message;
      engineReloading = false;
    }
  }

  // ── Standalone DB Export/Import ──────────────────────────────────────────
  let exporting = false;
  let importing = false;
  let dbMsg = '';

  async function doExportDB() {
    exporting = true;
    dbMsg = 'Exporting...';
    try {
      const json = await exportDB();
      const blob = new Blob([JSON.stringify(json)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `face_rec_backup_${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      dbMsg = '✓ ' + $t('success');
    } catch (e) {
      dbMsg = '✗ ' + e.message;
    } finally {
      exporting = false;
    }
  }

  async function handleImportChange(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (!confirm($t('settings_db_import_confirm'))) return;
    
    importing = true;
    dbMsg = $t('please_wait');
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      await importDB(json);
      dbMsg = '✓ ' + $t('success') + '. Reloading...';
      setTimeout(() => window.location.reload(), 1500);
    } catch (e) {
      dbMsg = '✗ ' + e.message;
    } finally {
      importing = false;
      event.target.value = ''; // Reset input
    }
  }

  async function doClearDB() {
    if (!confirm($t('settings_db_clear_confirm'))) return;
    try {
      await clearDB();
      dbMsg = '✓ ' + $t('success') + '. Reloading...';
      setTimeout(() => window.location.reload(), 1500);
    } catch (e) {
      dbMsg = '✗ ' + e.message;
    }
  }

  async function doHardReset() {
    if (!confirm('This will purge EVERYTHING: database, settings, and all locally cached data. The app will reload. Continue?')) return;
    try {
      await hardResetApp();
    } catch (e) {
      dbMsg = '✗ ' + e.message;
    }
  }

  // ── Debug test stream helpers ─────────────────────────────────────────────
  async function _runSseTest(label, fetchFn) {
    testLabel   = label;
    testLines   = [`[${label}] started at ${new Date().toLocaleTimeString()}`];
    testRunning = true;
    try {
      const resp = await fetchFn();
      if (!resp.ok) { testLines = [...testLines, `✗ HTTP ${resp.status}`]; return; }
      const reader = resp.body.getReader();
      const dec    = new TextDecoder();
      let   buf    = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const p of parts) {
          if (p.startsWith('data: ')) testLines = [...testLines, p.slice(6)];
        }
      }
      testLines = [...testLines, `[${label}] stream ended`];
    } catch (e) {
      testLines = [...testLines, `✗ ${e.message}`];
    } finally {
      testRunning = false;
    }
  }

  async function _runJsonTest() {
    testLabel   = 'GET JSON';
    testLines   = [`[GET JSON] started at ${new Date().toLocaleTimeString()}`];
    testRunning = true;
    try {
      const resp = await testAdminJson();
      testLines = [...testLines, `HTTP ${resp.status} ${resp.statusText}`];
      if (resp.ok) {
        const data = await resp.json();
        testLines = [...testLines, JSON.stringify(data, null, 2)];
      } else {
        testLines = [...testLines, '✗ not ok'];
      }
    } catch (e) {
      testLines = [...testLines, `✗ ${e.message}`];
    } finally {
      testRunning = false;
    }
  }

  const doTestLogs       = () => _runSseTest('Logs SSE (20)',  () => fetchServerLogs(20));
  const doTestLogsFull   = () => _runSseTest('Logs SSE (100)', () => fetchServerLogs(100));

  // ── DB credential health check ────────────────────────────────────────────
  async function doCheckCredentials() {
    if (!credCheckUser.trim() || !credCheckPass.trim()) return;
    credChecking = true;
    credCheckMsg = '';
    try {
      const r = await checkCredentials(credCheckUser.trim(), credCheckPass.trim());
      credCheckMsg = r.ok ? '✓ ' + r.message : '✗ ' + r.message;
    } catch (e) {
      credCheckMsg = '✗ ' + e.message;
    } finally {
      credChecking = false;
    }
  }

  // ── Local model helpers ───────────────────────────────────────────────────
  async function doTestPython() {
    testingPython = true;
    testResult = '';
    try {
      if (typeof window.electronAPI?.testPython !== 'function') {
        testResult = '✗ Python test not available (Node.js ONNX mode — no Python needed)';
        return;
      }
      const r = await window.electronAPI.testPython(pythonPath || null);
      testResult = r.ok ? '✓ Python OK — InsightFace found' : '✗ ' + r.error;
    } catch (e) {
      testResult = '✗ ' + e.message;
    } finally {
      testingPython = false;
    }
  }

  async function doDownloadModel(name) {
    if (downloadingModel) return;
    downloadingModel = name;
    downloadMsg = { ...downloadMsg, [name]: 'Starting…' };
    window.electronAPI.onDownloadProgress(d => {
      if (d.model === name) downloadMsg = { ...downloadMsg, [name]: d.msg };
    });
    try {
      await window.electronAPI.downloadModel(name, pythonPath || null);
      downloadMsg = { ...downloadMsg, [name]: '✓ Done' };
      localModelStatus = await window.electronAPI.checkLocalModels();
    } catch (e) {
      downloadMsg = { ...downloadMsg, [name]: '✗ ' + e.message };
    } finally {
      downloadingModel = '';
    }
  }
</script>

<div class="settings-view">
  <h2>⚙ {$t('settings_title')}</h2>

  <!-- Node.js Server (Electron only) -->
  {#if isElectron}
  <section class="card">
    <h3>{$t('settings_server_section')}</h3>
    <div class="mode-radios" style="margin-bottom: 8px;">
      <label class="radio-row">
        <input type="radio" bind:group={connectionMode} value="local" />
        <div>
          <span class="radio-label">{$t('settings_mode_run_local')}</span>
          <span class="radio-hint">{$t('settings_mode_run_local_hint')}</span>
        </div>
      </label>
      <label class="radio-row">
        <input type="radio" bind:group={connectionMode} value="remote" />
        <div>
          <span class="radio-label">{$t('settings_mode_remote')}</span>
          <span class="radio-hint">{$t('settings_mode_remote_hint')}</span>
        </div>
      </label>
    </div>
    <div class="form-grid">
      {#if connectionMode === 'local'}
        <label>{$t('settings_local_port')}</label>
        <div class="field-row">
          <input type="number" bind:value={localPort} min="1024" max="65535" style="width:90px;" />
          <span class="hint" style="margin:0;">default 7861 — app finds next free port if taken</span>
        </div>
      {:else}
        <label>{$t('settings_server_url')}</label>
        <div style="display:flex; flex-direction:column; gap:4px; flex:1;">
          <input type="text" bind:value={remoteUrl} placeholder="https://faces.example.com" />
          {#if remoteUrl && remoteUrl.startsWith('http://') && !remoteUrl.startsWith('http://127') && !remoteUrl.startsWith('http://localhost')}
            <span class="url-warning">⚠ URL uses HTTP — most servers redirect to HTTPS. Use <code>https://</code> to avoid redirect issues.</span>
          {/if}
          {#if remoteUrl && !remoteUrl.startsWith('http')}
            <span class="url-warning">⚠ URL must start with https:// or http://</span>
          {/if}
        </div>
      {/if}
    </div>
    <p class="hint" style="margin-top: 8px;">{$t('settings_server_restart_hint')}</p>
  </section>

  <!-- Database (Electron only) -->
  <section class="card">
    <h3>{$t('settings_db_section')}</h3>
    {#if connectionMode === 'local'}
      <!-- Active DB status -->
      {#if activeDbInfo}
        <div class="form-grid" style="margin-bottom:12px;">
          <label>Active database</label>
          <div style="display:flex;flex-direction:column;gap:3px;">
            <code class="db-path-display" style="word-break:break-all;">{activeDbInfo.activePath}</code>
            <span class="hint" style="margin:0;">
              {(activeDbInfo.size / 1024 / 1024).toFixed(1)} MB
              · {activeDbInfo.writable ? '✓ writable' : '⚠ read-only'}
              {#if activeDbInfo.isDefault}<span style="color:#50a878;"> · default location</span>{/if}
            </span>
          </div>
        </div>
      {/if}

      <p class="hint" style="margin-bottom:10px;">
        CrispLens uses a standard SQLite <code>.db</code> file on your disk.
        You can switch to any existing database or create a new empty one — the app will restart.
      </p>

      <!-- Open existing DB -->
      <div style="margin-bottom:8px;">
        <div style="font-weight:500;margin-bottom:6px;">Open existing database</div>
        <div class="field-row">
          <input type="text" bind:value={newDbPath} placeholder="/path/to/face_recognition.db" style="flex:1;" />
          <button on:click={browseDb} style="flex-shrink:0;">Browse…</button>
        </div>
        <button
          class="primary"
          style="margin-top:8px;align-self:flex-start;"
          on:click={doSwitchDb}
          disabled={switchingDb || !newDbPath?.trim() || newDbPath.trim() === currentDbPath}
        >
          {switchingDb ? '…' : '🔄 Switch & Restart'}
        </button>
      </div>

      <div class="field-row" style="gap:8px;margin-top:12px;flex-wrap:wrap;">
        <!-- Create new empty DB -->
        <button on:click={doCreateNewDb} disabled={switchingDb}>
          ✨ Create new empty database…
        </button>
        <!-- Reset to default -->
        {#if activeDbInfo && !activeDbInfo.isDefault}
          <button on:click={doResetDbToDefault} disabled={switchingDb} style="color:#e08050;">
            ↩ Reset to default location
          </button>
        {/if}
      </div>

      {#if switchDbMsg}<div class="save-msg" style="margin-top:8px;">{switchDbMsg}</div>{/if}
    {:else}
      <p class="hint">{$t('settings_db_remote_info')} <code>{remoteUrl || '(server URL not set)'}</code>.</p>
      <p class="hint" style="margin-top:4px;">The database is managed on the remote server — set <code>DB_PATH</code> env var there.</p>
    {/if}
  </section>
  {:else}
  <!-- Storage Mode selector (browser/PWA/Capacitor) -->
  <section class="card">
    <h3>{$t('settings_storage_mode')}</h3>
    <p class="hint" style="margin-bottom:12px;">
      {$t('settings_storage_mode_hint')}
    </p>
    <div class="mode-selector">
      <button class="mode-btn" class:active={dbMode === 'server'} on:click={() => dbMode !== 'server' && switchDbMode('server')}>
        <span class="mode-icon">☁</span>
        <span class="mode-label">Server</span>
        <span class="mode-desc">v4 Node.js or v2 FastAPI</span>
      </button>
      <button class="mode-btn" class:active={dbMode === 'local'} on:click={() => dbMode !== 'local' && switchDbMode('local')}>
        <span class="mode-icon">📱</span>
        <span class="mode-label">Standalone (Local)</span>
        <span class="mode-desc">On-device SQLite, no server needed</span>
      </button>
    </div>
    {#if dbMode === 'local'}
      {#if isStandaloneBroken}
        <div class="card error-notice" style="margin-top:10px; background:#2a1a1a; border-color:#5a2a2a;">
          <p style="color:#e08080; font-weight:600; font-size:12px;">⚠ Standalone Mode Error</p>
          <p style="color:#c08080; font-size:11px; margin-top:4px;">{standaloneError}</p>
          <div style="display:flex; gap:8px; margin-top:10px; flex-wrap: wrap;">
            <button class="small" on:click={() => switchDbMode('server')}>
              Switch back to Server Mode
            </button>
            <button class="small" on:click={runDbDiag} disabled={testingDiag}>
              {testingDiag ? '...' : $t('settings_db_diag')}
            </button>
            <button class="small primary" on:click={doRestartEngine} disabled={restartingEngine}>
              {restartingEngine ? '...' : '🔄 Restart WASM Engine'}
            </button>
          </div>
          {#if testDiagMsg}
            <p style="font-size:11px; margin-top:8px; color: {testDiagMsg.startsWith('✓') ? '#80c080' : '#e08080'}">{testDiagMsg}</p>
          {/if}
        </div>
      {/if}
      <p class="hint" style="margin-top:10px;color:#a0a060;">
        {$t('settings_standalone_active')}
      </p>
            {#if !isStandaloneBroken}
              <div style="display:flex; gap:8px; margin-top:6px; flex-wrap: wrap;">
                <button class="small" on:click={runDbDiag} disabled={testingDiag}>
                  {testingDiag ? '...' : 'Test Standalone DB Connection'}
                </button>
                <button class="small" on:click={doRestartEngine} disabled={restartingEngine}>
                  {restartingEngine ? '...' : '🔄 Restart SQLite Engine'}
                </button>
              </div>
              {#if testDiagMsg}
                <p style="font-size:11px; margin-top:6px; color: {testDiagMsg.startsWith('✓') ? '#80c080' : '#e08080'}">{testDiagMsg}</p>
              {/if}
            {/if}      <!-- ONNX model cache status + download -->
      <div class="model-cache-section">
        <div class="model-status-row">
          <span class="model-status-label">SCRFD detector</span>
          <span class="model-badge" class:ok={modelStatus.det_10g} class:missing={!modelStatus.det_10g}>
            {modelStatus.det_10g ? '✓ ' + $t('settings_model_cached') : '✗ ' + $t('settings_model_not_found')}
          </span>
        </div>
        <div class="model-status-row">
          <span class="model-status-label">ArcFace recognizer</span>
          <span class="model-badge" class:ok={modelStatus.w600k_r50} class:missing={!modelStatus.w600k_r50}>
            {modelStatus.w600k_r50 ? '✓ ' + $t('settings_model_cached') : '✗ ' + $t('settings_model_not_found')}
          </span>
        </div>
        {#if modelDownloadMsg}
          <div class="save-msg" class:error-msg={modelDownloadMsg.startsWith('✗')} style="margin-top:8px;">
            {modelDownloadMsg}
          </div>
        {/if}
        <p class="hint" style="margin-top:6px;">
          {$t('settings_models_download_hint')}
        </p>
        <button class="primary" style="margin-top:8px;" on:click={downloadModels}
                disabled={modelDownloading || (modelStatus.det_10g && modelStatus.w600k_r50)}>
          {#if modelDownloading}
            ⏳ {modelDownloadMsg || 'Downloading…'}
          {:else if modelStatus.det_10g && modelStatus.w600k_r50}
            ✓ Models ready
          {:else}
            ⬇ Download ONNX models
          {/if}
        </button>
      </div>

      <!-- Sync Target (for standalone mode only) -->
      <div style="margin-top:16px; padding-top:12px; border-top:1px solid #2a2a42;">
        <div style="font-size:12px; font-weight:600; color:#8090b0; margin-bottom:8px;">{$t('settings_sync_target')}</div>
        <p class="hint" style="margin-bottom:8px;">{$t('settings_sync_target_hint')}</p>
        <div class="form-grid">
          <label>{$t('api_server_url_label')}</label>
          <input type="text" bind:value={syncRemoteUrl} placeholder="https://faces.example.com" />
        </div>
      </div>
    {/if}
  </section>

  <!-- Browser/PWA: editable API server URL (only shown in server mode) -->
  {#if dbMode === 'server'}
  <section class="card">
    <h3>{$t('api_server_section')}</h3>
    <p class="hint" style="margin-bottom:10px;">{$t('api_server_hint')}</p>

    <!-- Saved presets -->
    {#if serverPresets.length > 0}
    <div style="margin-bottom:12px;">
      <div style="font-size:0.82rem;font-weight:600;color:var(--text-muted,#888);margin-bottom:6px;">{$t('api_server_saved')}</div>
      {#each serverPresets as preset, i}
      <div class="preset-row">
        <div class="preset-info" title={preset.url}>
          <span class="preset-name">{preset.name}</span>
          <span class="preset-url">{preset.url}</span>
        </div>
        <button class="preset-connect" on:click={() => doPwaConnect(preset.url)}
          class:active-preset={pwaServerUrl === preset.url}
        >{pwaServerUrl === preset.url ? '✓ ' : ''}{$t('api_server_connect')}</button>
        <button class="icon-btn danger" on:click={() => deletePreset(i)} title="Remove preset">×</button>
      </div>
      {/each}
    </div>
    {/if}

    <!-- URL input + connect -->
    <div class="form-grid">
      <label>{$t('api_server_url_label')}</label>
      <div class="field-row">
        <input type="text" bind:value={pwaServerUrl} placeholder="https://faces.example.com" style="flex:1;" />
        <button class="primary" on:click={() => doPwaConnect()} style="flex-shrink:0;">{$t('api_server_connect')}</button>
      </div>
    </div>
    {#if pwaConnectMsg}
      <div class="save-msg" class:error-msg={pwaConnectMsg.startsWith('✗')}>{pwaConnectMsg}</div>
    {/if}

    <!-- Save as preset -->
    <div class="form-grid" style="margin-top:10px;">
      <label>{$t('api_server_save_as')}</label>
      <div class="field-row">
        <input type="text" bind:value={newPresetName} placeholder={pwaServerUrl || $t('api_server_preset_ph')} style="flex:1;" />
        <button on:click={saveCurrentAsPreset} style="flex-shrink:0;">{$t('api_server_save_preset')}</button>
      </div>
    </div>
    {#if presetMsg}
      <div class="save-msg" class:error-msg={presetMsg.startsWith('✗')}>{presetMsg}</div>
    {/if}
  </section>
  {/if}

  <!-- Offline / Local Cache (browser/PWA only, server mode) -->
  <section class="card">
    <h3>{$t('offline_cache_section')}</h3>
    <p class="hint" style="margin-bottom:12px;">{$t('offline_cache_hint')}</p>

    <div class="form-grid">
      <label>{$t('offline_max_images')}</label>
      <div class="field-row" style="gap:10px;">
        <input type="range" min="50" max="2000" step="50" bind:value={syncMaxItems} style="flex:1;" />
        <span style="width:50px;text-align:right;font-variant-numeric:tabular-nums;">{syncMaxItems}</span>
      </div>

      <label>{$t('offline_max_size_mb')}</label>
      <div class="field-row" style="gap:10px;">
        <input type="range" min="50" max="2000" step="50" bind:value={syncMaxSizeMb} style="flex:1;" />
        <span style="width:55px;text-align:right;font-variant-numeric:tabular-nums;">{syncMaxSizeMb} MB</span>
      </div>

      <label>{$t('offline_thumb_size')}</label>
      <div class="field-row" style="gap:10px;">
        <input type="range" min="150" max="1200" step="50" bind:value={syncThumbSize} style="flex:1;" />
        <span style="width:55px;text-align:right;font-variant-numeric:tabular-nums;">{syncThumbSize}px</span>
      </div>
      <p class="hint" style="margin-top:4px;">{$t('offline_thumb_size_hint')}</p>
    </div>

    {#if syncStats}
    <div class="sync-stats">
      <span>{syncStats.count} {$t('offline_stats_images')}</span>
      <span>{syncStats.sizeMb} {$t('offline_stats_size')}</span>
      {#if syncStats.embCount > 0}<span>{syncStats.embCount} embeddings</span>{/if}
      {#if syncStats.lastSync}
        <span>{$t('offline_last_sync')} {new Date(syncStats.lastSync).toLocaleString()}</span>
      {:else}
        <span class="muted">{$t('offline_never_synced')}</span>
      {/if}
    </div>
    {/if}

    {#if syncProgress}
      <div class="sync-progress">{syncProgress}</div>
    {/if}

    {#if pendingPushCount > 0}
      <div class="pending-badge">⬆ {pendingPushCount} {$t('offline_pending_push')}</div>
    {/if}

    <div class="field-row" style="margin-top:12px;gap:8px;">
      <button class="primary" on:click={doSync} disabled={syncing||pushing}>
        {syncing ? $t('offline_syncing') : '↕ ' + $t('offline_sync_btn')}
      </button>
      <button on:click={doPush} disabled={syncing||pushing||pendingPushCount===0}
              title={$t('offline_push_hint')}>
        {pushing ? $t('offline_pushing') : '⬆ ' + $t('offline_push_btn')}
      </button>
      <button on:click={doClearCache} disabled={syncing||pushing}>{$t('offline_clear')}</button>
    </div>

    {#if syncMsg}
      <div class="save-msg" style="margin-top:8px;" class:error-msg={syncMsg.startsWith('✗')}>{syncMsg}</div>
    {/if}
    {#if pushMsg}
      <div class="save-msg" style="margin-top:8px;" class:error-msg={pushMsg.startsWith('✗')}>{pushMsg}</div>
    {/if}
  </section>
  {/if}

  <!-- Image Processing / Ingest mode -->
  {#if isElectron}
  <section class="card">
    <h3>{$t('settings_img_proc_section')}</h3>
    {#if connectionMode === 'local'}
      <p class="hint">Images are processed by the internal Node.js server using ONNX Runtime.</p>
    {:else}
      <div class="mode-radios">
        <label class="radio-row">
          <input type="radio" bind:group={processingModeLocal} value="upload_full" />
          <div>
            <span class="radio-label">{$t('settings_upload_mode')}</span>
            <span class="radio-hint">{$t('settings_upload_mode_hint')}</span>
          </div>
        </label>
        <label class="radio-row">
          <input type="radio" bind:group={processingModeLocal} value="local_process" />
          <div>
            <span class="radio-label">{$t('settings_local_proc_mode')}</span>
            <span class="radio-hint">{$t('settings_local_proc_mode_hint')}</span>
          </div>
        </label>
      </div>

      {#if processingModeLocal === 'local_process'}
        <div class="form-grid" style="margin-top: 12px;">
          <label>{$t('settings_python_path')}</label>
          <div class="field-row">
            <input type="text" bind:value={pythonPath} placeholder="(auto-detect python3)" style="flex:1;" />
            <button on:click={doTestPython} disabled={testingPython} style="flex-shrink:0;">
              {testingPython ? '…' : 'Test'}
            </button>
          </div>
          {#if testResult}
            <div></div>
            <div class="test-result" class:ok={testResult.startsWith('✓')}>{testResult}</div>
          {/if}

          <label>{$t('settings_local_model')}</label>
          <select bind:value={localModelLocal}>
            {#each IF_MODELS as m}
              <option value={m}>{m}</option>
            {/each}
          </select>
        </div>

        <div class="model-table">
          <div class="model-table-head">
            <span>Model</span><span>Status</span><span></span>
          </div>
          {#each IF_MODELS as m}
            <div class="model-row-item" class:active-model={m === localModelLocal}>
              <span class="model-name">{m}</span>
              <span class="model-status-badge" class:downloaded={localModelStatus[m]}>
                {localModelStatus[m] ? '✓' : '✗'}
              </span>
              <span class="model-action-cell">
                {#if localModelStatus[m] && m === localModelLocal}
                  <span class="badge-active">active</span>
                {:else if !localModelStatus[m]}
                  <button class="small primary" on:click={() => doDownloadModel(m)} disabled={!!downloadingModel}>
                    {downloadingModel === m ? '…' : 'Download'}
                  </button>
                {/if}
              </span>
            </div>
            {#if downloadMsg[m]}
              <div class="download-msg">{downloadMsg[m]}</div>
            {/if}
          {/each}
        </div>
      {/if}
    {/if}
  </section>
  {/if}

  <!-- Processing backend (admin only) -->
  {#if isAdmin && $backendReady}
  <section class="card">
    <h3>{$t('processing_backend_section')}</h3>
    <p class="hint" style="margin-bottom:10px;">{$t('processing_backend_hint')}</p>
    <div class="form-grid">
      <label>{$t('processing_backend_section')}</label>
      <select bind:value={procBackend}>
        <option value="local">{$t('backend_local')}</option>
        <option value="remote_v2">{$t('backend_remote_v2')}</option>
        <option value="remote_v4">{$t('backend_remote_v4')}</option>
      </select>
    </div>
    {#if procBackend === 'remote_v2' || procBackend === 'remote_v4'}
    <div class="form-grid" style="margin-top:10px;">
      <label>{$t('remote_v2_url')}</label>
      <input type="text" bind:value={remoteV2Url} placeholder="https://img.example.com" />
      <label>{$t('remote_v2_user')}</label>
      <input type="text" bind:value={remoteV2User} placeholder="admin" />
      <label>{$t('remote_v2_pass')}</label>
      <input type="password" bind:value={remoteV2Pass} placeholder="••••••••" autocomplete="new-password" />
      <label>{$t('remote_v2_mode')}</label>
      <select bind:value={remoteV2Mode}>
        <option value="upload_bytes">{$t('remote_v2_upload_bytes')}</option>
        <option value="local_infer">{$t('remote_v2_local_infer')}</option>
      </select>
    </div>
    <div style="margin-top:8px;display:flex;gap:8px;align-items:center;">
      <button on:click={doTestRemoteV2} disabled={remoteV2Testing || !remoteV2Url}>
        {remoteV2Testing ? '…' : $t('remote_v2_test')}
      </button>
      {#if remoteV2TestMsg}
        <span class:ok={remoteV2TestMsg.startsWith('✓')} class:error-msg={remoteV2TestMsg.startsWith('✗')}>{remoteV2TestMsg}</span>
      {/if}
    </div>
    {/if}

    <!-- Server ONNX providers (GPU acceleration for Node.js engine) -->
    <div style="margin-top:14px; padding-top:12px; border-top:1px solid #2a2a42;">
      <div style="font-size:12px; font-weight:600; color:#8090b0; margin-bottom:4px;">{$t('ort_server_section')}</div>
      <p class="hint" style="margin-bottom:10px;">{$t('ort_server_hint')}</p>
      <div class="form-grid">
        {#if isAppleSiliconClient}
        <!-- CoreML: macOS only -->
        <label title={$t('ort_use_coreml_hint')}>{$t('ort_use_coreml')}</label>
        <div class="field-row">
          <input type="checkbox" bind:checked={ortUseCoreML} />
          <span class="hint">{$t('ort_use_coreml_hint')}</span>
          <span style="color:#50c878; font-size:10px; margin-left:8px;">★ {$t('ort_recommended')}</span>
        </div>
        {/if}
        {#if isWindowsClient || isLinuxClient}
        <!-- CUDA: Windows / Linux only -->
        <label title={$t('ort_use_cuda_hint')}>{$t('ort_use_cuda')}</label>
        <div class="field-row">
          <input type="checkbox" bind:checked={ortUseCUDA} />
          <span class="hint">{$t('ort_use_cuda_hint')}</span>
        </div>
        {/if}
        {#if isWindowsClient}
        <!-- DirectML: Windows only -->
        <label title={$t('ort_use_directml_hint')}>{$t('ort_use_directml')}</label>
        <div class="field-row">
          <input type="checkbox" bind:checked={ortUseDirectML} />
          <span class="hint">{$t('ort_use_directml_hint')}</span>
        </div>
        {/if}
        {#if !isAppleSiliconClient && !isWindowsClient && !isLinuxClient}
        <span class="hint" style="grid-column:1/-1;">{$t('ort_no_accel_available')}</span>
        {/if}
      </div>
    </div>
  </section>
  {/if}


  <!-- Benchmarking -->
  <section class="card">
    <h3>{$t('tab_benchmark')}</h3>
    <p class="hint">Test performance of different inference backends on this device.</p>
    
    <div class="flex-row" style="margin-top:10px; gap:15px; align-items:center;">
      <div style="display:flex; align-items:center; gap:5px;">
        <label for="bench-img-id" style="font-size:11px; color:#8090b0; margin:0;">Image ID (opt):</label>
        <input id="bench-img-id" type="number" bind:value={benchImageId} placeholder="auto" 
               class="num-input" style="width:60px; margin:0;" />
      </div>
      <button class="btn-primary" on:click={doBrowserBenchmark} disabled={benchmarkRunning}>
        {benchmarkRunning ? 'Running...' : 'Run Browser Benchmark'}
      </button>
      {#if isAdmin}
      <button class="btn-primary" on:click={doServerBenchmark} disabled={benchmarkRunning}>
        {benchmarkRunning ? 'Running...' : 'Run Server Benchmark'}
      </button>
      {/if}
    </div>

    {#if benchProgress}
      <div class="save-msg" style="margin-top:10px;">{benchProgress}</div>
    {/if}

    {#if browserBenchResults}
      <div class="benchmark-results" style="margin-top:15px;">
        <div style="font-size:12px; font-weight:600; margin-bottom:5px;">Browser Benchmark Results</div>
        <table style="width:100%; font-size:11px; border-collapse:collapse;">
          <thead>
            <tr style="text-align:left; border-bottom:1px solid #333;">
              <th style="padding:4px;">Backend</th>
              <th style="padding:4px;">Warmup</th><th style="padding:4px;">Inference</th>
              <th style="padding:4px;">Faces</th>
              <th style="padding:4px;">Memory</th>
              <th style="padding:4px;">Status</th>
            </tr>
          </thead>
          <tbody>
            {#each browserBenchResults as r}
              <tr style="border-bottom:1px solid #222;">
                <td style="padding:4px;">{r.backend}</td>
                <td style="padding:4px;">{r.success ? r.warmup_ms + 'ms' : '-'}</td><td style="padding:4px;">{r.success ? r.duration_ms + 'ms' : '-'}</td>
                <td style="padding:4px;">{r.success ? r.faces : '-'}</td>
                <td style="padding:4px;">{r.memory_mb && r.memory_mb !== 'N/A' ? r.memory_mb + ' MB' : 'N/A'}</td>
                <td style="padding:4px;">{r.status || (r.success ? '✓' : '✗')}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    {#if serverBenchResults}
      <div class="benchmark-results" style="margin-top:15px;">
        <div style="font-size:12px; font-weight:600; margin-bottom:5px;">Server Benchmark Results (Image: {serverBenchResults.sample_image})</div>
        <table style="width:100%; font-size:11px; border-collapse:collapse;">
          <thead>
            <tr style="text-align:left; border-bottom:1px solid #333;">
              <th style="padding:4px;">Provider</th>
              <th style="padding:4px;">Warmup</th><th style="padding:4px;">Inference</th>
              <th style="padding:4px;">Faces</th>
              <th style="padding:4px;">Memory</th>
              <th style="padding:4px;">Status</th>
            </tr>
          </thead>
          <tbody>
            {#each serverBenchResults.results as r}
              <tr style="border-bottom:1px solid #222;">
                <td style="padding:4px;">{r.provider}</td>
                <td style="padding:4px;">{r.success ? r.warmup_ms + 'ms' : '-'}</td><td style="padding:4px;">{r.success ? r.duration_ms + 'ms' : '-'}</td>
                <td style="padding:4px;">{r.success ? r.faces : '-'}</td>
                <td style="padding:4px;">{r.success ? '✓' : '✗ ' + r.error}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  <!-- Browser ONNX backend settings (browser/PWA only) -->
  {#if !isElectron}
  <section class="card">
    <h3>{$t('ort_browser_section')}</h3>
    <p class="hint" style="margin-bottom:10px;">{$t('ort_browser_hint')}</p>
    <div class="form-grid">
      <label title={$t('ort_use_webgl_hint')}>{$t('ort_use_webgl')}</label>
      <div class="field-row">
        <input type="checkbox" bind:checked={ortUseWebGL} on:change={saveOrtPrefs} />
        <span class="hint">{$t('ort_use_webgl_hint')}</span>
      </div>
      <label title={$t('ort_use_simd_hint')}>{$t('ort_use_simd')} ⚠</label>
      <div class="field-row">
        <input type="checkbox" bind:checked={ortUseSIMD} on:change={saveOrtPrefs} />
        <span class="hint" style="color:#c09030;">{$t('ort_use_simd_hint')}</span>
      </div>
      <label title={$t('ort_use_webgpu_hint')}>{$t('ort_use_webgpu')} ⚠</label>
      <div class="field-row">
        <input type="checkbox" bind:checked={ortUseWebGPU} on:change={saveOrtPrefs} />
        <span class="hint" style="color:#c09030;">{$t('ort_use_webgpu_hint')}</span>
      </div>
    </div>
    <p class="hint" style="margin-top:8px;">{$t('reload_after_settings')}</p>
  </section>
  {/if}

  {#if !$backendReady}
  <section class="card offline-notice">
    <p>⚡ Backend not connected — connection settings above are saved locally and take effect on restart.
    Server-specific settings (thresholds, VLM, API keys, user auth) are shown below for reference but
    require a live backend to load or save.</p>
  </section>
  {/if}

  <!-- Auth section -->
  <section class="card">
    <h3>{$t('user_management')}</h3>
    {#if $currentUser}
      <div class="auth-row">
        <span>{$t('welcome')}, <strong>{$currentUser.username}</strong> ({$currentUser.role})</span>
        <button on:click={doLogout}>{$t('logout')}</button>
      </div>
    {:else}
      <div class="field-row">
        <input type="text"     bind:value={loginUsername} placeholder="{$t('username')}" />
        <input type="password" bind:value={loginPassword} placeholder="{$t('password')}"
               on:keydown={e => e.key === 'Enter' && doLogin()} />
        <button class="primary" on:click={doLogin}>{$t('login')}</button>
      </div>
      {#if loginError}<div class="error-msg">{loginError}</div>{/if}
    {/if}
  </section>

  <!-- Change own password (any logged-in user) -->
  {#if $currentUser && $backendReady}
  <section class="card">
    <h3>{$t('change_password')}</h3>
    <div class="form-grid">
      <label>{$t('current_password')}</label>
      <input type="password" bind:value={pwCurrent} placeholder="••••••••"
             on:keydown={e => e.key === 'Enter' && doChangePassword()} />
      <label>{$t('new_password')}</label>
      <input type="password" bind:value={pwNew} placeholder="••••••••"
             on:keydown={e => e.key === 'Enter' && doChangePassword()} />
      <label>{$t('confirm_password')}</label>
      <input type="password" bind:value={pwConfirm} placeholder="••••••••"
             on:keydown={e => e.key === 'Enter' && doChangePassword()} />
    </div>
    <button class="primary" style="margin-top:8px;align-self:flex-start;"
      on:click={doChangePassword}
      disabled={pwChanging || !pwCurrent || !pwNew || !pwConfirm}>
      {pwChanging ? $t('please_wait') : $t('change_password')}
    </button>
    {#if pwMsg}
      <div class="save-msg" class:error-msg={pwMsg.startsWith('✗')}>{pwMsg}</div>
    {/if}
  </section>
  {/if}

  <!-- Users Management (admin only) -->
  {#if $currentUser?.role === 'admin' && $backendReady}
  <section class="card">
    <h3>{$t('user_management')}</h3>
    {#if usersLoading}
      <p class="hint">Loading…</p>
    {:else}
      <div class="users-table">
        <div class="users-head">
          <span>{$t('username')}</span><span>{$t('role')}</span><span>{$t('active')}</span><span>{$t('last_login')}</span><span>{$t('actions')}</span>
        </div>
        {#each users as u (u.id)}
          <div class="user-row" class:inactive={!u.is_active}>
            <span class="user-name">{u.username}</span>
            <select
              value={u.role}
              on:change={e => doUpdateUserRole(u.id, e.target.value)}
              disabled={u.id === $currentUser?.id}
            >
              <option value="user">user</option>
              <option value="mediamanager">mediamanager</option>
              <option value="admin">admin</option>
            </select>
            <input type="checkbox" checked={u.is_active}
              on:change={e => doToggleUserActive(u.id, e.target.checked)}
              disabled={u.id === $currentUser?.id}
            />
            <span class="user-login">{u.last_login ? u.last_login.slice(0,16) : '—'}</span>
            <span class="user-actions">
              {#if u.failed_login_attempts > 0}
                <button class="small" on:click={() => doResetLock(u.id, u.username)}
                  title="Failed attempts: {u.failed_login_attempts}">
                  🔓 {u.failed_login_attempts}
                </button>
              {/if}
              <button class="small" title="{$t('set_password')}"
                on:click={() => { setPassUserId = setPassUserId === u.id ? null : u.id; setPassMsg = ''; setPassValue = ''; }}>
                🔑
              </button>
              {#if u.id !== $currentUser?.id}
                <button class="small danger" on:click={() => doDeleteUser(u.id, u.username)}>✕</button>
              {/if}
            </span>
          </div>
          {#if setPassUserId === u.id}
            <div class="set-pass-row">
              <input type="password" bind:value={setPassValue}
                placeholder="{$t('new_password')}"
                on:keydown={e => e.key === 'Enter' && doAdminSetPassword(u.id)} />
              <button class="primary small" on:click={() => doAdminSetPassword(u.id)}
                disabled={setPassWorking || !setPassValue.trim()}>
                {setPassWorking ? '…' : $t('save')}
              </button>
              <button class="small" on:click={() => { setPassUserId = null; setPassValue = ''; setPassMsg = ''; }}>
                {$t('cancel')}
              </button>
              {#if setPassMsg}
                <span class="set-pass-msg" class:error-msg={setPassMsg.startsWith('✗')}>{setPassMsg}</span>
              {/if}
            </div>
          {/if}
        {/each}
      </div>

      <!-- Add new user -->
      <div class="add-user-form">
        <input type="text"     bind:value={newUserName} placeholder="{$t('username')}" />
        <input type="password" bind:value={newUserPass} placeholder="{$t('password')}" />
        <select bind:value={newUserRole}>
          <option value="user">user</option>
          <option value="mediamanager">mediamanager</option>
          <option value="admin">admin</option>
        </select>
        <button class="primary small" on:click={doCreateUser}
          disabled={!newUserName.trim() || !newUserPass.trim()}>
          + {$t('add_user')}
        </button>
      </div>
      {#if usersMsg}<div class="save-msg" class:error-msg={usersMsg.startsWith('✗')}>{usersMsg}</div>{/if}
    {/if}
  </section>

  <!-- DB Health (admin only) -->
  <section class="card">
    <h3>{$t('settings_db_health')}</h3>
    {#if dbStatus}
      <div class="db-status-grid">
        <span class="hint">{$t('db_path_label')}</span>     <span class="db-path-display">{dbStatus.db_path}</span>
        <span class="hint">{$t('db_size_label')}</span>     <span class="hint">{dbStatus.file_size_mb ?? '?'} MB</span>
        <span class="hint">{$t('db_writable_label')}</span> <span class="hint" class:ok={dbStatus.permissions_ok}>{dbStatus.permissions_ok ? '✓' : '✗'}</span>
        <span class="hint">{$t('db_users_label')}</span>    <span class="hint">{dbStatus.user_count ?? '?'}</span>
        <span class="hint">{$t('db_images_label')}</span>   <span class="hint">{dbStatus.image_count ?? '?'}</span>
      </div>
    {/if}
    <div class="field-row" style="margin-top: 8px;">
      <input type="text"     bind:value={credCheckUser} placeholder="Username to test" />
      <input type="password" bind:value={credCheckPass} placeholder="Password" />
      <button class="small" on:click={doCheckCredentials} disabled={credChecking}>
        {credChecking ? '…' : 'Test'}
      </button>
    </div>
    {#if credCheckMsg}
      <div class="save-msg" class:error-msg={credCheckMsg.startsWith('✗')}>{credCheckMsg}</div>
    {/if}

    {#if isLocalMode() || (isElectron && connectionMode === 'local')}
      <div class="field-row" style="margin-top: 15px; border-top: 1px solid var(--border); padding-top: 15px;">
        <div class="hint" style="margin-bottom: 8px; width: 100%;">
          <strong>{$t('settings_db_backup_title')}</strong><br/>
          {$t('settings_db_backup_hint')}
        </div>
        <button class="small primary" on:click={doExportDB} disabled={exporting}>
          {exporting ? '…' : '📥 ' + $t('settings_db_export')}
        </button>
        <div style="position: relative; display: inline-block;">
          <button class="small" disabled={importing}>
            {importing ? '…' : '📤 ' + $t('settings_db_import')}
          </button>
          <input type="file" accept=".json" on:change={handleImportChange} 
            style="position: absolute; left: 0; top: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer;"
            disabled={importing} />
        </div>
        <button class="small danger" style="margin-left: auto;" on:click={doClearDB}>
          🗑 {$t('settings_db_clear')}
        </button>
        <button class="small danger" on:click={doHardReset} title="Clear database, settings, and cache">
          🔥 {$t('hard_reset_app')}
        </button>
      </div>
      {#if dbMsg}
        <div class="save-msg" class:error-msg={dbMsg.startsWith('✗')}>{dbMsg}</div>
      {/if}
    {/if}
  </section>
  {/if}

  <!-- Engine status — visible to all users so they can see why uploads fail -->
  {#if engineStatus}
  <section class="card">
    <h3>{$t('settings_engine_section')}</h3>
    <div class="db-status-grid">
      <span class="hint">Status</span>
      <span class:ok={engineStatus.ready} class:error-badge={!engineStatus.ready}>
        {engineStatus.ready ? $t('settings_engine_ready') : $t('settings_engine_not_ready')}
      </span>
      <span class="hint">Backend</span>  <span class="hint">{engineStatus.backend}</span>
      <span class="hint">Model</span>    <span class="hint">{engineStatus.model}</span>
      {#if engineStatus.error}
        <span class="hint">Error</span>
        <span class="hint" style="color:var(--error,#c0392b);word-break:break-all">{engineStatus.error}</span>
      {/if}
    </div>

    {#if engineStatus.detectors}
    <div style="margin-top:10px;">
      <div class="hint" style="margin-bottom:4px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;">{$t('settings_detectors') || 'Detectors'}</div>
      <div class="detector-grid">
        {#each Object.entries(engineStatus.detectors) as [name, d]}
          {@const ok = d.available && (d.ready ?? (d.model_ok ?? d.model_exists ?? true))}
          <div class="detector-row">
            <span class="det-name">{name}</span>
            <span class:ok={ok} class:error-badge={!ok}>
              {#if !d.available}
                ✗ {$t('det_lib_missing')}
              {:else if d.ready !== undefined && !d.ready}
                ✗ {$t('det_not_loaded')}
              {:else if d.model_ok === false}
                ✗ {$t('det_model_corrupt')}
              {:else if d.model_exists === false}
                ⚠ {$t('det_model_not_downloaded')}
              {:else}
                ✓
              {/if}
            </span>
            {#if d.model_size_kb}
              <span class="hint det-size">{d.model_size_kb} KB</span>
            {/if}
          </div>
        {/each}
      </div>
    </div>
    {/if}

    {#if isAdmin}
    <div class="field-row" style="margin-top:8px;flex-wrap:wrap;gap:6px;">
      <button class="small" on:click={doReloadEngine} disabled={engineReloading}>
        {engineReloading ? '…' : $t('settings_reload_engine')}
      </button>
      <button class="small" on:click={() => fetchEngineStatus().then(s => { engineStatus = s; engineReloadMsg = ''; })}>
        {$t('logs_refresh')}
      </button>
      {#if engineStatus?.detectors?.mediapipe_local && !engineStatus.detectors.mediapipe_local.model_exists}
        <button class="small primary" on:click={doDownloadMediaPipe} disabled={mpDownloading}>
          {mpDownloading ? '⏳ Downloading…' : '⬇ Download face_landmarker.task'}
        </button>
      {/if}
    </div>
    {#if mpDownloadMsg}
      <div class="save-msg" class:error-msg={mpDownloadMsg.startsWith('✗')} style="margin-top:4px;">{mpDownloadMsg}</div>
    {/if}
    {#if engineReloadMsg}
      <div class="save-msg" class:error-msg={engineReloadMsg.startsWith('✗')}>{engineReloadMsg}</div>
    {/if}
    {/if}
  </section>
  {/if}

  <!-- Server management (admin only) -->
  {#if isAdmin}
  <section class="card">
    <h3>{$t('admin_server_mgmt')}</h3>
    <div class="field-row" style="gap:8px;flex-wrap:wrap;">
      <button class="primary small" on:click={() => showUpdateModal = true}>
        🔄 {$t('admin_update_server')}
      </button>
      <button class="small" on:click={() => showLogsModal = true}>
        📋 {$t('admin_view_logs')}
      </button>
    </div>

    <!-- Debug transport tests ── run all 4, compare results in journalctl -f -->
    <div style="margin-top:10px;">
      <div style="font-size:10px;color:#505070;margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em;">
        SSE / transport diagnostics
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button class="small" on:click={doTestLogs}       disabled={testRunning}
                title="Fetch 20 log lines via SSE — should work exactly like the others">
          📋 Logs (20)
        </button>
        <button class="small" on:click={doTestLogsFull}   disabled={testRunning}
                title="Fetch 100 log lines via SSE — proves large SSE works in-page">
          📋 Logs (100)
        </button>
        <button class="small" on:click={_runJsonTest}     disabled={testRunning}
                title="GET plain JSON — hangs? → Apache buffers all non-SSE responses">
          🔵 GET JSON
        </button>
      </div>

      {#if testLines.length || testRunning}
        <div style="margin-top:6px;background:#0e0e18;border:1px solid #2a2a3a;border-radius:5px;
                    padding:8px 10px;font-family:monospace;font-size:10.5px;line-height:1.65;color:#90b890;
                    max-height:160px;overflow-y:auto;">
          <div style="color:#505570;margin-bottom:4px;">{testLabel}</div>
          {#each testLines as l}<div>{l}</div>{/each}
          {#if testRunning}<div style="opacity:0.4;">▌</div>{/if}
        </div>
      {/if}
    </div>

    <div class="form-grid" style="margin-top:14px;">
      {#if dbMode !== 'local'}
      <label>{$t('fix_db_path_label')}</label>
      <div>
        <input type="text" bind:value={fixDbPath} placeholder="/root/CrispLense/fix_db.sh" style="width:100%;box-sizing:border-box;" />
        <div class="hint">{$t('fix_db_path_hint')}</div>
      </div>
      {/if}

      <label>{$t('exempt_paths_label')}</label>
      <div>
        <div class="hint" style="margin-bottom:6px;">{$t('exempt_paths_hint')}</div>
        {#each exemptPaths as _, i}
          <div class="path-row">
            <input type="text" bind:value={exemptPaths[i]} placeholder="/mnt" />
            <button class="small" on:click={() => exemptPaths = exemptPaths.filter((__, j) => j !== i)}>✕</button>
          </div>
        {/each}
        <button class="small" style="margin-top:4px;" on:click={() => exemptPaths = [...exemptPaths, '']}>
          + {$t('add')}
        </button>
      </div>
    </div>
  </section>
  {/if}

  <!-- General settings -->
  <section class="card">
    <h3>{$t('ui_settings')}</h3>
    <div class="form-grid">
      <label for="setting-lang">{$t('language')}</label>
      <select id="setting-lang" value={language}
        on:change={e => applyLanguage(e.target.value)}>
        {#each LANGUAGES as l}
          <option value={l.code}>{l.label}</option>
        {/each}
      </select>

      {#if isAdmin && procBackend === 'remote_v2'}
      <label for="setting-backend">{$t('backend')}</label>
      <select id="setting-backend" bind:value={backend}>
        {#each BACKENDS as b}
          <option value={b}>{b}</option>
        {/each}
      </select>

      {#if backend === 'insightface'}
        <label for="setting-model">{$t('model')}</label>
        <select id="setting-model" bind:value={model}>
          {#each IF_MODELS as m}
            <option value={m}>{m}</option>
          {/each}
        </select>
      {/if}
      {/if}

      {#if isAdmin}
      <label for="setting-det-thresh">{$t('detection_threshold')}</label>
      <div class="slider-row">
        <input id="setting-det-thresh" type="range" min="0.1" max="0.9" step="0.05" bind:value={detThreshold} />
        <span>{detThreshold.toFixed(2)}</span>
      </div>

      <label for="setting-rec-thresh">{$t('recognition_threshold')}</label>
      <div class="slider-row">
        <input id="setting-rec-thresh" type="range" min="0.1" max="0.9" step="0.05" bind:value={recThreshold} />
        <span>{recThreshold.toFixed(2)}</span>
      </div>

      <label for="setting-det-retries">{$t('settings_det_retries')}</label>
      <div class="slider-row">
        <input id="setting-det-retries" type="number" min="0" max="5" step="1" bind:value={detRetries} style="width: 60px;" />
        <span class="hint">{$t('settings_det_retries_hint')}</span>
      </div>

      <label for="setting-det-size">{$t('settings_det_size')}</label>
      <div class="slider-row">
        <select id="setting-det-size" bind:value={detSize}>
          <option value={320}>320 (Fast)</option>
          <option value={640}>640 (Normal)</option>
          <option value={960}>960 (Good)</option>
          <option value={1280}>1280 (High-res)</option>
          <option value={1920}>1920 (Ultra)</option>
        </select>
        <span class="size-hint">{$t('settings_det_size_hint')}</span>
      </div>
      {/if}

      <!-- Detection model: admin = global default, non-admin = personal override -->
      <label for="setting-det-model">{$t('detection_model')}</label>
      <div>
        {#if !isAdmin && globalDetModelHint}
          <p class="hint" style="margin-bottom:4px;">
            {$t('det_model_global_hint')}: {$t('det_model_' + (globalDetModelHint || 'auto').replace('-', ''))}
          </p>
        {/if}
        <select id="setting-det-model" bind:value={detModel}>
          {#each DET_MODELS as m}
            <option value={m.value}>{$t(m.label)}</option>
          {/each}
        </select>
      </div>
    </div>
  </section>

  <!-- VLM settings -->
  <section class="card">
    <h3>{$t('ai_enrichment')}</h3>
    {#if !isAdmin && globalVlmHint}
      <p class="hint" style="margin-bottom:8px;">
        Personal override — global default: {globalVlmHint.vlm_enabled ? 'enabled' : 'disabled'}
        ({globalVlmHint.vlm_provider ?? 'anthropic'}{globalVlmHint.vlm_model ? ' / ' + globalVlmHint.vlm_model : ''}).
      </p>
    {/if}
    <div class="form-grid">
      <label for="setting-vlm-enabled">{$t('enable_vlm')}</label>
      <input id="setting-vlm-enabled" type="checkbox" bind:checked={vlmEnabled} />

      <label for="setting-vlm-prov">{$t('vlm_provider')}</label>
      <select id="setting-vlm-prov" bind:value={vlmProvider} disabled={!vlmEnabled}>
        {#each Object.entries(providers) as [key, p]}
          <option value={key}>{p.display_name}</option>
        {:else}
          <option value="">(Loading...)</option>
        {/each}
      </select>

      <label for="setting-vlm-model">{$t('vlm_model')}</label>
      <div class="model-row">
        <select id="setting-vlm-model" bind:value={vlmModel} disabled={!vlmEnabled}>
          <option value="">{defaultModelLabel}</option>
          {#each vlmModels as m}
            <option value={m}>{m}</option>
          {/each}
        </select>
        <button on:click={doFetchModels} disabled={!vlmEnabled || fetchingModels} aria-label="Refresh VLM models">
          {fetchingModels ? '...' : '🔄'}
        </button>
      </div>
      {#if vlmFetchMsg}
        <div class="save-msg" style="margin-top: 4px; font-size: 10px;" class:error-msg={vlmFetchMsg.startsWith('✗')}>{vlmFetchMsg}</div>
      {/if}
    </div>
  </section>

  <!-- Storage -->
  <section class="card">
    <h3>{$t('settings_storage_section')}</h3>
    <p class="hint">{$t('settings_storage_hint')}</p>
    <div class="form-grid" style="margin-top:8px;">
      <label for="upload-max-dim">{$t('settings_upload_max_dim')}</label>
      <div style="display:flex;gap:8px;align-items:center;">
        <input id="upload-max-dim" type="number" min="0" step="256"
          bind:value={uploadMaxDim} style="width:100px;" />
        <span class="hint">{uploadMaxDim > 0 ? `${$t('settings_resize_hint')}: ${uploadMaxDim}×${uploadMaxDim}px` : $t('settings_no_resize')}</span>
      </div>
    </div>
  </section>

  <button class="primary save-btn" on:click={doSaveSettings} disabled={saving}>
    {saving ? $t('loading') + '…' : '💾 ' + $t('save_settings')}
  </button>
  {#if saveMsg}<div class="save-msg">{saveMsg}</div>{/if}

  <!-- API Keys -->
  <section class="card">
    <h3>{$t('vlm_api_key')}</h3>

    {#if $currentUser?.role === 'user'}
      <p class="hint" style="margin-bottom: 8px;">As a regular user you have access to EU-hosted providers only.</p>
    {/if}
    {#each Object.entries(providers) as [provKey, prov]}
      {@const ki = keyInputs[provKey] ?? { value: '', scope: 'user' }}
      {@const canSystemKey = $currentUser?.role === 'admin' || $currentUser?.role === 'mediamanager'}
      <div class="key-row">
        <div class="key-meta">
          <span class="key-name">{prov.display_name}</span>
          <span class="key-status">
            {#if keyStatus[provKey]?.has_system_key && canSystemKey}
              <span class="has-key">server ✓</span>
              <button class="small danger" on:click={() => doDeleteKey(provKey, 'system')}>×</button>
            {:else if keyStatus[provKey]?.has_user_key}
              <span class="has-key">user ✓</span>
              <button class="small danger" on:click={() => doDeleteKey(provKey, 'user')}>×</button>
            {:else}
              <span class="no-key">{$t('no_key')}</span>
            {/if}
          </span>
        </div>
        <div class="key-input-row">
          <input
            type="password"
            placeholder="{$t('vlm_api_key')}…"
            value={ki.value}
            on:input={e => { keyInputs[provKey] = { ...ki, value: e.target.value }; keyInputs = keyInputs; }}
          />
          {#if canSystemKey}
            <select
              value={ki.scope}
              on:change={e => { keyInputs[provKey] = { ...ki, scope: e.target.value }; keyInputs = keyInputs; }}
            >
              <option value="system">server</option>
              <option value="user">personal</option>
            </select>
          {/if}
          <button class="primary small" on:click={() => doSaveKey(provKey)}>{$t('save')}</button>
          {#if keyStatus[provKey]?.has_system_key || keyStatus[provKey]?.has_user_key}
            <button class="small"
              on:click={() => doTestKey(provKey)}
              disabled={keyTestMsg[provKey] === '…'}
              title="{$t('test_key')}">
              {keyTestMsg[provKey] === '…' ? '…' : $t('test_key')}
            </button>
          {/if}
        </div>
        {#if keyMsg[provKey]}
          <div class="key-msg">{keyMsg[provKey]}</div>
        {/if}
        {#if keyTestMsg[provKey] && keyTestMsg[provKey] !== '…'}
          <div class="key-msg" class:key-msg-err={keyTestMsg[provKey].startsWith('✗')}>{keyTestMsg[provKey]}</div>
        {/if}
      </div>
    {/each}
  </section>
</div>

<ServerUpdateModal bind:show={showUpdateModal} {fixDbPath} />
<ServerLogsModal   bind:show={showLogsModal} />

<style>
  .settings-view {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    max-width: 700px;
  }
  h2 { font-size: 1.1rem; color: #c0c8e0; }
  h3 { font-size: 0.9rem; color: #9090b8; margin-bottom: 12px; }
  .card {
    background: #1a1a28;
    border: 1px solid #2a2a3a;
    border-radius: 8px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .form-grid {
    display: grid;
    grid-template-columns: 180px 1fr;
    gap: 8px;
    align-items: center;
  }
  .form-grid label { font-size: 12px; color: #7080a0; }
  .slider-row { display: flex; gap: 8px; align-items: center; }
  .slider-row input { flex: 1; accent-color: #6080c0; }
  .slider-row span { font-size: 12px; color: #6080a0; min-width: 36px; }
  .size-hint { font-size: 10px; color: #505070; margin-left: 8px; }
  .model-row { display: flex; gap: 4px; }
  .model-row select { flex: 1; }
  .field-row { display: flex; gap: 8px; }
  .auth-row { display: flex; align-items: center; gap: 12px; font-size: 13px; color: #8090a8; }
  .auth-row strong { color: #c0d0f0; }
  .save-btn { align-self: flex-start; padding: 8px 20px; }
  .save-msg { font-size: 12px; color: #80c080; }
  .error-msg { font-size: 12px; color: #e08080; }

  /* Server presets */
  .preset-row { display: flex; align-items: center; gap: 6px; padding: 5px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
  .preset-row:last-child { border-bottom: none; }
  .preset-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .preset-name { font-size: 13px; color: #c0d0f0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .preset-url  { font-size: 11px; color: #6070a0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .preset-connect { font-size: 12px; padding: 3px 10px; flex-shrink: 0; }
  .preset-connect.active-preset { background: #2a4a2a; border-color: #4a8a4a; color: #80c080; }
  .icon-btn { padding: 3px 8px; font-size: 14px; background: transparent; border: 1px solid transparent; border-radius: 4px; cursor: pointer; color: #8090a8; }
  .icon-btn:hover { border-color: rgba(255,255,255,0.15); color: #c0d0f0; }
  .icon-btn.danger:hover { color: #e08080; border-color: rgba(224,128,128,0.3); }

  /* API keys */
  .key-row {
    border-top: 1px solid #252535;
    padding-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .key-row:first-of-type { border-top: none; padding-top: 0; }
  .key-meta { display: flex; align-items: center; gap: 8px; }
  .key-name { font-size: 12px; color: #a0b0c8; font-weight: 600; }
  .key-status { display: flex; align-items: center; gap: 4px; font-size: 11px; }
  .has-key { color: #60c060; }
  .no-key { color: #505070; }
  .key-input-row { display: flex; gap: 6px; }
  .key-input-row input { flex: 1; }
  .key-input-row select { width: 80px; }
  .key-msg { font-size: 11px; color: #80c080; }
  button.small { padding: 3px 8px; font-size: 11px; }
  .hint { font-size: 11px; color: #505070; }
  .hint code { font-family: monospace; background: #1a1a2e; padding: 1px 4px; border-radius: 3px; color: #8090b0; }
  .offline-notice { background: #1a1a10; border-color: #4a4a20; }
  .offline-notice p { font-size: 11px; color: #808060; line-height: 1.5; }
  .sync-stats { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 10px; font-size: 12px; color: #7090c0; }
  .sync-stats .muted { color: #505070; }
  .sync-progress { font-size: 12px; color: #6090b8; margin-top: 8px; font-variant-numeric: tabular-nums; }
  .pending-badge { display: inline-block; margin-top: 10px; padding: 4px 10px; background: #2a1e06; border: 1px solid #6a4a10; border-radius: 12px; font-size: 12px; color: #c09030; }
  .model-cache-section { margin-top: 14px; padding-top: 12px; border-top: 1px solid #2a2a42; display: flex; flex-direction: column; gap: 4px; }
  .model-status-row { display: flex; align-items: center; justify-content: space-between; font-size: 12px; padding: 3px 0; }
  .model-status-label { color: #8090b0; }
  .model-badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; }
  .model-badge.ok { background: #0e2a1e; color: #50c080; border: 1px solid #205040; }
  .model-badge.missing { background: #2a1e06; color: #c09030; border: 1px solid #6a4a10; }
  .mode-selector { display: flex; gap: 10px; margin-top: 4px; }
  .mode-btn { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 12px; border: 2px solid #2a2a42; border-radius: 8px; background: #16161e; cursor: pointer; transition: border-color 0.15s, background 0.15s; }
  .mode-btn:hover { border-color: #4a5a8a; background: #1e1e30; }
  .mode-btn.active { border-color: #4a6fa5; background: #1a2030; }
  .mode-icon { font-size: 1.4rem; }
  .mode-label { font-size: 13px; font-weight: 600; color: #d0d8f0; }
  .mode-desc { font-size: 10px; color: #6878a0; }
  .url-warning { font-size: 11px; color: #c08040; }
  .url-warning code { font-family: monospace; background: #1a1a10; padding: 1px 4px; border-radius: 3px; }
  .db-path-display {
    font-size: 11px; color: #6080a0; font-family: monospace;
    word-break: break-all; padding: 4px 0;
  }

  /* Ingest mode card */
  .mode-radios { display: flex; flex-direction: column; gap: 8px; }
  .radio-row { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; padding: 6px 8px; border-radius: 6px; transition: background 0.15s; }
  .radio-row:hover { background: #22223a; }
  .radio-row input[type=radio] { margin-top: 3px; accent-color: #6080c0; flex-shrink: 0; }
  .radio-label { font-size: 13px; color: #c0c8e0; display: block; }
  .radio-hint { font-size: 11px; color: #505070; display: block; }
  .test-result { font-size: 11px; padding: 2px 0; }
  .test-result.ok { color: #60c060; }
  .test-result:not(.ok) { color: #e08080; }
  .model-table { margin-top: 12px; border: 1px solid #252535; border-radius: 6px; overflow: hidden; }
  .model-table-head { display: grid; grid-template-columns: 1fr 80px 90px; padding: 6px 10px; background: #141422; font-size: 10px; color: #505070; text-transform: uppercase; letter-spacing: 0.5px; }
  .model-row-item { display: grid; grid-template-columns: 1fr 80px 90px; align-items: center; padding: 7px 10px; border-top: 1px solid #1e1e2e; font-size: 12px; }
  .model-row-item.active-model { background: #1a1a30; }
  .model-name { color: #a0b0c8; font-family: monospace; }
  .model-status-badge { font-size: 13px; }
  .model-status-badge.downloaded { color: #60c060; }
  .model-status-badge:not(.downloaded) { color: #604040; }
  .model-action-cell { }
  .badge-active { font-size: 10px; color: #6080c0; background: #1e2040; padding: 2px 6px; border-radius: 3px; }
  .download-msg { font-size: 10px; color: #7090a8; padding: 2px 10px 6px; border-top: 1px solid #1e1e2e; grid-column: 1 / -1; }

  /* Users management */
  .users-table { border: 1px solid #252535; border-radius: 6px; overflow: hidden; font-size: 12px; }
  .users-head {
    display: grid; grid-template-columns: 1fr 110px 55px 130px 90px;
    padding: 5px 10px; background: #141422;
    font-size: 10px; color: #505070; text-transform: uppercase; letter-spacing: 0.5px;
  }
  .user-row {
    display: grid; grid-template-columns: 1fr 110px 55px 130px 90px;
    align-items: center; padding: 6px 10px;
    border-top: 1px solid #1e1e2e;
  }
  .user-row.inactive { opacity: 0.5; }
  .user-name { color: #c0d0f0; font-family: monospace; }
  .user-login { color: #505070; font-size: 11px; }
  .user-actions { display: flex; gap: 4px; align-items: center; }
  .add-user-form { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
  .add-user-form input { flex: 1; min-width: 100px; }
  .add-user-form select { width: 110px; }
  button.danger { background: #402020; color: #e08080; border-color: #604040; }
  button.danger:hover { background: #502020; }

  /* DB health */
  .db-status-grid {
    display: grid; grid-template-columns: 80px 1fr;
    gap: 4px 8px; align-items: baseline; font-size: 12px;
  }
  .db-status-grid .ok { color: #60c060; }
  .db-status-grid .error-badge { color: #e08080; }
  .detector-grid { display: flex; flex-direction: column; gap: 3px; }
  .detector-row {
    display: grid; grid-template-columns: 90px 1fr auto;
    gap: 6px; align-items: baseline; font-size: 12px;
  }
  .det-name { color: #c0c8e0; font-weight: 500; }
  .det-size { font-size: 10px; color: #404060; }
  .detector-row .ok { color: #60c060; }
  .detector-row .error-badge { color: #e08080; }

  /* Admin set-password inline row */
  .set-pass-row {
    display: flex; gap: 6px; align-items: center; flex-wrap: wrap;
    padding: 6px 10px 8px; background: #14142a; border-top: 1px solid #1e1e2e;
  }
  .set-pass-row input { flex: 1; min-width: 140px; }
  .set-pass-msg { font-size: 11px; }

  /* API key test result */
  .key-msg-err { color: #e08080 !important; }

  /* Exempt paths list editor */
  .path-row {
    display: flex; gap: 6px; align-items: center; margin-bottom: 4px;
  }
  .path-row input { flex: 1; }
</style>
