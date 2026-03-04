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
    isLocalMode, setLocalMode,
  } from '../api.js';
  import { currentUser, t, processingMode, localModel, backendReady, stats, allPeople, allTags, allAlbums, translations, lang, TRANSLATIONS, processingBackend } from '../stores.js';
  import syncManager, { loadSyncSettings, saveSyncSettings } from './SyncManager.js';
  import { fetchStats, fetchPeople, fetchTags, fetchAlbums, fetchServerLogs,
           testAdminJson } from '../api.js';
  import ServerUpdateModal from './ServerUpdateModal.svelte';
  import ServerLogsModal   from './ServerLogsModal.svelte';

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
  let vlmEnabled   = false;
  let vlmProvider  = 'anthropic';
  let vlmModel     = '';
  let uploadMaxDim = 0; // 0 = keep full resolution
  // Admin — server management
  let showUpdateModal = false;
  let showLogsModal   = false;
  // Debug test state: label + lines + running flag per button
  let testLabel   = '';
  let testLines   = [];
  let testRunning = false;
  let exemptPaths     = ['/mnt'];
  let fixDbPath       = '';
  let detModel     = 'auto';   // detection model (system default or user override)
  let globalDetModelHint = null; // for non-admin hint

  const BACKENDS   = ['insightface', 'dlib_hog', 'dlib_cnn'];
  const IF_MODELS  = ['buffalo_l', 'buffalo_m', 'buffalo_s', 'buffalo_sc'];
  const LANGUAGES  = [{ code: 'en', label: 'English' }, { code: 'de', label: 'Deutsch' }];

  // ── Remote processing backend ─────────────────────────────────────────────
  let procBackend    = 'local';         // 'local' | 'remote_v2'
  let remoteV2Url    = '';
  let remoteV2User   = '';
  let remoteV2Pass   = '';
  let remoteV2Mode   = 'upload_bytes';  // 'upload_bytes' | 'local_infer'
  let remoteV2TestMsg = '';
  let remoteV2Testing = false;
  const DET_MODELS = [
    { value: 'auto',       label: 'det_model_auto' },
    { value: 'retinaface', label: 'det_model_retinaface' },
    { value: 'scrfd',      label: 'det_model_scrfd' },
    { value: 'yunet',      label: 'det_model_yunet' },
    { value: 'mediapipe',  label: 'det_model_mediapipe' },
  ];

  // ── Auto-load server settings when backend becomes ready ──────────────────
  $: if ($backendReady && !cfg) {
    fetchSettings().then(c => {
      cfg = c;
      language     = c?.ui?.language ?? 'de';
      backend      = c?.face_recognition?.backend ?? 'insightface';
      model        = c?.face_recognition?.insightface?.model ?? 'buffalo_l';
      detThreshold = c?.face_recognition?.insightface?.detection_threshold ?? 0.6;
      recThreshold = c?.face_recognition?.insightface?.recognition_threshold ?? 0.4;
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
        procBackend  = c?.processing?.backend         ?? 'local';
        remoteV2Url  = c?.processing?.remote_v2?.url  ?? '';
        remoteV2User = c?.processing?.remote_v2?.user ?? '';
        remoteV2Mode = c?.processing?.remote_v2?.mode ?? 'upload_bytes';
        processingBackend.set(procBackend);
      }
    }).catch(() => {});
    // Non-admin: load personal VLM prefs (shows effective = override || global fallback)
    if ($currentUser?.role !== 'admin') {
      fetchUserVlmPrefs().then(p => {
        vlmEnabled  = p.effective.vlm_enabled  ?? false;
        vlmProvider = p.effective.vlm_provider ?? 'anthropic';
        vlmModel    = p.effective.vlm_model    ?? '';
        globalVlmHint = p.global;
      }).catch(() => {});
      // Load personal detection model pref
      fetchUserDetPrefs().then(p => {
        detModel = p.effective?.det_model ?? 'auto';
        globalDetModelHint = p.global?.det_model ?? 'auto';
      }).catch(() => {});
    }
    fetchProviders().then(p => { providers = p; }).catch(() => {});
    fetchKeyStatus().then(k => { keyStatus = k; }).catch(() => {});
    fetchEngineStatus().then(s => { engineStatus = s; }).catch(() => {});
    if ($currentUser?.role === 'admin') {
      loadUsers();
      fetchDbStatus().then(s => { dbStatus = s; }).catch(() => {});
    }
  }

  $: if ($currentUser?.role === 'admin' && $backendReady && !usersLoaded && !usersLoading) {
    loadUsers();
  }

  // ── VLM Models ─────────────────────────────────────────────────────────────
  let vlmModels = [];
  let fetchingModels = false;
  let globalVlmHint = null;  // { vlm_enabled, vlm_provider, vlm_model } — for non-admin hint

  $: if (vlmProvider) {
    doFetchModels();
  }

  async function doFetchModels() {
    fetchingModels = true;
    try {
      vlmModels = await fetchVlmModels(vlmProvider);
      // Auto-select first model if current one is blank or not in the list
      if (vlmModels.length > 0 && (!vlmModel || !vlmModels.includes(vlmModel))) {
        vlmModel = vlmModels[0];
      }
    } catch (e) {
      console.warn('Error fetching models:', e.message);
    } finally {
      fetchingModels = false;
    }
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

  // ── Storage mode: 'server' (HTTP) vs 'local' (on-device SQLite) ─────────
  let dbMode = typeof window !== 'undefined'
    ? (localStorage.getItem('db_mode') || 'server')
    : 'server';

  function switchDbMode(mode) {
    setLocalMode(mode === 'local');
    dbMode = mode;
    // Reload so the new mode takes effect immediately
    setTimeout(() => { window.location.reload(); }, 300);
  }

  // ── ONNX model download (for standalone/local mode) ─────────────────────
  let modelStatus = { det_10g: false, w600k_r50: false };
  let modelDownloading = false;
  let modelDownloadMsg = '';

  async function checkModelStatus() {
    try {
      const { faceEngineWeb } = await import('./FaceEngineWeb.js');
      const remoteBase = localStorage.getItem('remote_url') || window.location.origin;
      faceEngineWeb.setModelBaseUrl(remoteBase + '/models');
      modelStatus = await faceEngineWeb.getModelCacheStatus();
    } catch { /* ignore */ }
  }

  async function downloadModels() {
    if (modelDownloading) return;
    modelDownloading = true;
    modelDownloadMsg = '';
    try {
      const { faceEngineWeb } = await import('./FaceEngineWeb.js');
      const remoteUrl = localStorage.getItem('remote_url');
      const remoteBase = remoteUrl || window.location.origin;
      faceEngineWeb.setModelBaseUrl(remoteBase + '/models');
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
  const _syncCfg        = typeof window !== 'undefined' ? loadSyncSettings() : {};
  let syncMaxItems      = _syncCfg.maxItems  ?? 500;
  let syncMaxSizeMb     = _syncCfg.maxSizeMb ?? 500;
  let syncThumbSize     = _syncCfg.thumbSize ?? 200;
  let pendingPushCount  = 0;
  let pushing           = false;
  let pushMsg           = '';
  let syncing           = false;
  let syncProgress      = '';
  let syncMsg           = '';
  let syncStats         = null;

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

  // ── Hybrid DB state ───────────────────────────────────────────────────────
  let currentDbPath = '';       // shown read-only; from settings.server.dbPath
  let newDbPath     = '';       // editable; submitted via switchDb IPC
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

  onMount(async () => {
    isElectron = typeof window.electronAPI !== 'undefined';
    try {
      const s = await window.electronAPI?.getSettings();
      if (s) {
        const client = s.client || {};
        const server = s.server || {};
        // New nested format
        connectionMode      = client.connectTo      || 'local';
        remoteUrl           = client.remoteUrl      || '';
        localPort           = server.port           || 7865;
        processingModeLocal = client.processingMode || 'upload_full';
        localModelLocal     = client.localModel     || 'buffalo_l';
        pythonPath          = client.pythonPath     || server.pythonPath || '';
        currentDbPath       = server.dbPath         || '';
        newDbPath           = currentDbPath;
        // Legacy flat format fallback
        if (!client.connectTo) {
          connectionMode    = s.mode          || 'local';
          remoteUrl         = s.remoteUrl     || '';
          processingModeLocal = s.processingMode || 'upload_full';
          localModelLocal   = s.localModel    || 'buffalo_l';
          pythonPath        = s.pythonPath    || '';
        }
      }
    } catch (e) { console.error('Settings error:', e); }

    if (isElectron) {
      try { localModelStatus = await window.electronAPI.checkLocalModels(); } catch { /* ignore */ }
    }

    // Load offline cache stats (works regardless of backend state)
    if (typeof window !== 'undefined') loadSyncStats();

    if ($backendReady) {
      try {
        cfg = await fetchSettings();
        language     = cfg?.ui?.language ?? 'de';
        backend      = cfg?.face_recognition?.backend ?? 'insightface';
        model        = cfg?.face_recognition?.insightface?.model ?? 'buffalo_l';
        detThreshold = cfg?.face_recognition?.insightface?.detection_threshold ?? 0.6;
        recThreshold = cfg?.face_recognition?.insightface?.recognition_threshold ?? 0.4;
        const ds = cfg?.face_recognition?.insightface?.det_size ?? [640, 640];
        detSize = Array.isArray(ds) ? ds[0] : ds;
          if ($currentUser?.role === 'admin') {
          vlmEnabled  = cfg?.vlm?.enabled ?? false;
          vlmProvider = cfg?.vlm?.provider ?? 'anthropic';
          vlmModel    = cfg?.vlm?.model ?? '';
          detModel    = cfg?.face_recognition?.insightface?.det_model ?? 'auto';
          procBackend  = cfg?.processing?.backend         ?? 'local';
          remoteV2Url  = cfg?.processing?.remote_v2?.url  ?? '';
          remoteV2User = cfg?.processing?.remote_v2?.user ?? '';
          remoteV2Mode = cfg?.processing?.remote_v2?.mode ?? 'upload_bytes';
          processingBackend.set(procBackend);
        }
      } catch (e) { saveMsg = '⚠ Could not load server settings: ' + e.message; }
      if ($currentUser?.role !== 'admin') {
        try {
          const p = await fetchUserVlmPrefs();
          vlmEnabled  = p.effective.vlm_enabled  ?? false;
          vlmProvider = p.effective.vlm_provider ?? 'anthropic';
          vlmModel    = p.effective.vlm_model    ?? '';
          globalVlmHint = p.global;
        } catch { /* ignore */ }
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

  async function doSaveSettings() {
    saving = true;
    saveMsg = '';
    try {
      if (isElectron) {
        // Save Electron / connection settings (works offline)
        const existing = await window.electronAPI?.getSettings() || {};
        await window.electronAPI?.saveSettings({
          ...existing,
          server: {
            ...(existing.server || {}),
            port:   localPort || 7865,
            dbPath: currentDbPath || undefined,
          },
          client: {
            ...(existing.client || {}),
            connectTo:      connectionMode,
            remoteUrl:      connectionMode === 'remote' ? remoteUrl : (existing.client?.remoteUrl || ''),
            processingMode: processingModeLocal,
            localModel:     localModelLocal,
            pythonPath:     pythonPath || undefined,
          },
        });
        // Sync stores so ProcessView picks up changes immediately
        processingMode.set(processingModeLocal);
        localModel.set(localModelLocal);
      } else {
        // Browser/PWA: persist language preference locally
        localStorage.setItem('pwa_language', language);
      }

      // Only try to save server settings when backend is reachable
      if ($backendReady) {
        if (isAdmin) {
          // Admin saves language + face-rec + global VLM defaults + upload settings
          await saveSettings({
            language,
            backend, model,
            det_threshold: detThreshold,
            rec_threshold: recThreshold,
            det_size: detSize,
            det_model: detModel || 'auto',
            vlm_enabled: vlmEnabled,
            vlm_provider: vlmProvider,
            vlm_model: vlmModel || null,
            upload_max_dimension: uploadMaxDim,
            copy_exempt_paths:    exemptPaths.filter(p => p.trim()),
            fix_db_path:          fixDbPath.trim(),
            processing_backend: procBackend,
            remote_v2_url:      remoteV2Url.trim(),
            remote_v2_user:     remoteV2User.trim(),
            remote_v2_mode:     remoteV2Mode,
            ...(remoteV2Pass ? { remote_v2_pass: remoteV2Pass } : {}),
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
          });
          // Personal detection model preference
          await saveUserDetPrefs({ det_model: detModel || null });
        }
        saveMsg = '✓ All settings saved';
      } else {
        saveMsg = isElectron
          ? '✓ Connection settings saved  (server settings require backend)'
          : '✓ Preferences saved  (server settings require backend)';
      }
    } catch (e) {
      saveMsg = '✗ ' + e.message;
    } finally {
      saving = false;
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

  // ── Hybrid DB switching ───────────────────────────────────────────────────
  async function browseDb() {
    if (!window.electronAPI) return;
    const paths = await window.electronAPI.openFileDialog({
      title: 'Select SQLite database',
      filters: [{ name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3'] }],
      properties: ['openFile'],
    });
    if (paths?.length) newDbPath = paths[0];
  }

  async function doSwitchDb() {
    if (!newDbPath?.trim() || newDbPath.trim() === currentDbPath) return;
    switchingDb = true;
    switchDbMsg = '';
    try {
      // switchDb saves new dbPath to settings.server and relaunches
      await window.electronAPI?.switchDb(newDbPath.trim());
      // If we get here, relaunch didn't fire (shouldn't happen)
      switchDbMsg = 'Relaunch triggered…';
    } catch (e) {
      switchDbMsg = '✗ ' + e.message;
      switchingDb = false;
    }
  }

  // ── User management ───────────────────────────────────────────────────────
  async function loadUsers() {
    usersLoading = true;
    try {
      users = await listUsers();
    } catch (e) {
      usersMsg = '✗ ' + e.message;
    } finally {
      usersLoading = false;
      usersLoaded = true;
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
      keyTestMsg = { ...keyTestMsg, [provider]: '✓ ' + r.message };
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
    // Then sync with server (also persists config.yaml on save)
    if ($backendReady) {
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

  // ── Engine reload ─────────────────────────────────────────────────────────
  async function doReloadEngine() {
    engineReloading = true;
    engineReloadMsg = '';
    try {
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
    } catch (e) {
      engineReloadMsg = '✗ ' + e.message;
      engineReloading = false;
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

  <!-- FastAPI Server -->
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
          <span class="hint" style="margin:0;">default 7865 — app finds next free port if taken</span>
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
      <p class="hint">{$t('settings_db_switch_hint')}</p>
      <div class="form-grid" style="margin-top: 8px;">
        <label>{$t('settings_db_current')}</label>
        <span class="db-path-display">{currentDbPath || '(default in app data)'}</span>

        <label>{$t('settings_db_switch_to')}</label>
        <div class="field-row">
          <input type="text" bind:value={newDbPath} placeholder="/path/to/face_recognition.db" style="flex:1;" />
          <button on:click={browseDb} style="flex-shrink:0;">Browse…</button>
        </div>
      </div>
      {#if switchDbMsg}<div class="save-msg" style="margin-top:6px;">{switchDbMsg}</div>{/if}
      <button
        class="primary"
        style="margin-top: 10px; align-self: flex-start;"
        on:click={doSwitchDb}
        disabled={switchingDb || !newDbPath?.trim() || newDbPath.trim() === currentDbPath}
      >
        {switchingDb ? '…' : '🔄 ' + $t('settings_db_switch_btn')}
      </button>
    {:else}
      <p class="hint">{$t('settings_db_remote_info')} <code>{remoteUrl || '(server URL not set)'}</code>.</p>
      <p class="hint" style="margin-top:4px;">Configure the database path on the server (via server's <code>config.yaml</code> or <code>FACE_REC_DB_PATH</code> env var).</p>
    {/if}
  </section>
  {:else}
  <!-- Storage Mode selector (browser/PWA/Capacitor) -->
  <section class="card">
    <h3>Storage Mode</h3>
    <p class="hint" style="margin-bottom:12px;">
      Choose how CrispLens stores data. <strong>Server</strong> connects to a v4 Node.js or v2 FastAPI
      backend. <strong>Standalone (Local)</strong> uses on-device SQLite — no server required, ideal for iOS/Android offline use.
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
      <p class="hint" style="margin-top:10px;color:#c09030;">
        ⚠ Standalone mode: face recognition runs on-device (ONNX). Some features (VLM descriptions, admin panel, cloud drives) are not available without a server.
      </p>
      <!-- ONNX model cache status + download -->
      <div class="model-cache-section">
        <div class="model-status-row">
          <span class="model-status-label">SCRFD detector</span>
          <span class="model-badge" class:ok={modelStatus.det_10g} class:missing={!modelStatus.det_10g}>
            {modelStatus.det_10g ? '✓ cached' : '✗ not downloaded'}
          </span>
        </div>
        <div class="model-status-row">
          <span class="model-status-label">ArcFace recognizer</span>
          <span class="model-badge" class:ok={modelStatus.w600k_r50} class:missing={!modelStatus.w600k_r50}>
            {modelStatus.w600k_r50 ? '✓ cached' : '✗ not downloaded'}
          </span>
        </div>
        {#if modelDownloadMsg}
          <div class="save-msg" class:error-msg={modelDownloadMsg.startsWith('✗')} style="margin-top:8px;">
            {modelDownloadMsg}
          </div>
        {/if}
        <p class="hint" style="margin-top:6px;">
          Models are downloaded from the connected server and cached on-device (~185 MB total).
          Download once while online, then use offline forever.
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
        <input type="range" min="150" max="800" step="50" bind:value={syncThumbSize} style="flex:1;" />
        <span style="width:55px;text-align:right;font-variant-numeric:tabular-nums;">{syncThumbSize}px</span>
      </div>
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
      <p class="hint">Images are processed by the local FastAPI server using InsightFace.</p>
      <div class="form-grid" style="margin-top: 8px;">
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
      </div>
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
      </select>
    </div>
    {#if procBackend === 'remote_v2'}
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
          <span>Username</span><span>Role</span><span>Active</span><span>Last Login</span><span>Actions</span>
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
        <span class="hint">Path</span>       <span class="db-path-display">{dbStatus.db_path}</span>
        <span class="hint">Size</span>        <span class="hint">{dbStatus.file_size_mb ?? '?'} MB</span>
        <span class="hint">Writable</span>   <span class="hint" class:ok={dbStatus.permissions_ok}>{dbStatus.permissions_ok ? '✓' : '✗'}</span>
        <span class="hint">Users</span>      <span class="hint">{dbStatus.user_count ?? '?'}</span>
        <span class="hint">Images</span>     <span class="hint">{dbStatus.image_count ?? '?'}</span>
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
      <div class="hint" style="margin-bottom:4px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;">Detectors</div>
      <div class="detector-grid">
        {#each Object.entries(engineStatus.detectors) as [name, d]}
          {@const ok = d.available && (d.ready ?? (d.model_ok ?? d.model_exists ?? true))}
          <div class="detector-row">
            <span class="det-name">{name}</span>
            <span class:ok={ok} class:error-badge={!ok}>
              {#if !d.available}
                ✗ lib missing
              {:else if d.ready !== undefined && !d.ready}
                ✗ not loaded
              {:else if d.model_ok === false}
                ✗ model corrupt
              {:else if d.model_exists === false}
                ⚠ model not yet downloaded
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
    <div class="field-row" style="margin-top:8px;">
      <button class="small" on:click={doReloadEngine} disabled={engineReloading}>
        {engineReloading ? '…' : $t('settings_reload_engine')}
      </button>
      <button class="small" on:click={() => fetchEngineStatus().then(s => { engineStatus = s; engineReloadMsg = ''; })}>
        {$t('logs_refresh')}
      </button>
    </div>
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
      <label>{$t('fix_db_path_label')}</label>
      <div>
        <input type="text" bind:value={fixDbPath} placeholder="/root/CrispLense/fix_db.sh" style="width:100%;box-sizing:border-box;" />
        <div class="hint">{$t('fix_db_path_hint')}</div>
      </div>

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

      {#if isAdmin}
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
          <option value="">(Default)</option>
          {#each vlmModels as m}
            <option value={m}>{m}</option>
          {/each}
        </select>
        <button on:click={doFetchModels} disabled={!vlmEnabled || fetchingModels} aria-label="Refresh VLM models">
          {fetchingModels ? '...' : '🔄'}
        </button>
      </div>
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
