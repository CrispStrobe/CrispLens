<script>
  import { onMount, onDestroy } from 'svelte';
  import { sidebarView, currentUser, stats, allTags, allPeople, allAlbums, translations, lang, galleryMode, backendReady, modelReady, TRANSLATIONS } from './stores.js';
  import { fetchHealth, fetchMe, fetchStats, fetchTags, fetchPeople, fetchAlbums, fetchTranslations, setRemoteBase } from './api.js';

  import Sidebar     from './lib/Sidebar.svelte';
  import Toolbar     from './lib/Toolbar.svelte';
  import StatusBar   from './lib/StatusBar.svelte';
  import SelectionToolbar from './lib/SelectionToolbar.svelte';
  import Gallery     from './lib/Gallery.svelte';
  import TableView   from './lib/TableView.svelte';
  import Lightbox    from './lib/Lightbox.svelte';
  import PeopleView  from './lib/PeopleView.svelte';
  import TagsView    from './lib/TagsView.svelte';
  import DatesView   from './lib/DatesView.svelte';
  import FoldersView from './lib/FoldersView.svelte';
  import ProcessView from './lib/ProcessView.svelte';
  import TrainView   from './lib/TrainView.svelte';
  import SettingsView from './lib/SettingsView.svelte';
  import IdentifyView from './lib/IdentifyView.svelte';
  import FilesystemView from './lib/FilesystemView.svelte';
  import WatchFoldersView from './lib/WatchFoldersView.svelte';
  import DuplicatesView  from './lib/DuplicatesView.svelte';
  import AlbumsView      from './lib/AlbumsView.svelte';
  import KeyboardManager    from './lib/KeyboardManager.svelte';
  import FaceClusterView    from './lib/FaceClusterView.svelte';
  import EventsView         from './lib/EventsView.svelte';
  import CloudDrivesView    from './lib/CloudDrivesView.svelte';
  import GenerateView       from './lib/GenerateView.svelte';
  import BatchJobsView      from './lib/BatchJobsView.svelte';
  import PwaInstallBanner   from './lib/PwaInstallBanner.svelte';
  import LoginScreen        from './lib/LoginScreen.svelte';

  let view = 'all';
  sidebarView.subscribe(v => view = v);

  let checkTimer;
  let modelPollTimer;
  let serverUrl = '';  // set in onMount based on context

  // True when running inside Electron (electronAPI is injected by preload.js)
  const inElectron = !!window.electronAPI;

  // True after fetchMe() has resolved (either user or null) — prevents login flash
  let sessionChecked = false;

  // Debug state for the waiting screen
  let debugLog = [];
  let lastError = '';
  let attemptCount = 0;

  // Browser-only: editable server URL field shown in the waiting screen
  let editableServerUrl = '';

  function dbg(msg) {
    const ts = new Date().toLocaleTimeString();
    debugLog = [...debugLog.slice(-19), `${ts}  ${msg}`]; // keep last 20 lines
    console.log('[backend-check]', msg);
  }

  // Health-check via /api/health (always 200, no auth required).
  // Polling stops as soon as the backend is up; restarts only if it goes down.
  async function checkBackend() {
    attemptCount++;
    const url = serverUrl + '/api/health';
    dbg(`#${attemptCount} GET ${url}`);
    try {
      const h = await fetchHealth();
      lastError = '';
      dbg(`→ 200 OK  model_ready=${h.model_ready}`);
      if (!$backendReady) {
        backendReady.set(true);
        clearInterval(checkTimer);   // stop polling — backend is up
        loadAll();
        // Start polling for model warm-up completion (every 3s until ready)
        if (!h.model_ready) {
          modelPollTimer = setInterval(pollModelReady, 3000);
        } else {
          modelReady.set(true);
        }
      }
    } catch (e) {
      lastError = e?.message || String(e);
      dbg(`→ ERROR: ${lastError}`);
      if ($backendReady) {
        backendReady.set(false);
        modelReady.set(false);
        checkTimer = setInterval(checkBackend, 5000);
      }
    }
  }

  async function pollModelReady() {
    try {
      const h = await fetchHealth();
      if (h.model_ready) {
        modelReady.set(true);
        clearInterval(modelPollTimer);
      }
    } catch { /* ignore */ }
  }

  async function loadAll() {
    // Try to restore existing session
    try { currentUser.set(await fetchMe()); } catch { /* not logged in */ }
    sessionChecked = true;   // show login screen now if still null

    // Load i18n — apply language from backend settings
    try {
      const data = await fetchTranslations(true);
      const language = data.language ?? data.lang ?? 'en';
      lang.set(language);
      // Apply translations: prefer local TRANSLATIONS bundle for non-EN languages
      // (the backend sends an empty translations object for EN since it's baked in)
      const localStrings = language !== 'en' ? (TRANSLATIONS[language] ?? {}) : {};
      const backendStrings = (data.translations && Object.keys(data.translations).length > 0) ? data.translations : {};
      const merged = { ...backendStrings, ...localStrings };  // local wins over backend
      if (Object.keys(merged).length > 0)
        translations.update(cur => ({ ...cur, ...merged }));
      sessionStorage.setItem('i18n_cache', JSON.stringify({ ...data, language, lang: language }));
    } catch (e) { console.error('i18n load error:', e); }

    // Load initial data
    try { stats.set(await fetchStats()); } catch { /* ignore */ }
    try { allTags.set(await fetchTags()); } catch { /* ignore */ }
    try { allPeople.set(await fetchPeople()); } catch { /* ignore */ }
    try { allAlbums.set(await fetchAlbums()); } catch { /* ignore */ }
  }

  function applyServerUrl(url) {
    if (url) {
      setRemoteBase(url);
      serverUrl = url;
    } else {
      // Same-origin — use relative /api paths (no setRemoteBase call)
      serverUrl = window.location.origin;
    }
    editableServerUrl = serverUrl;
  }

  function connectToServer() {
    const url = editableServerUrl.trim().replace(/\/$/, '');
    if (!url) return;
    localStorage.setItem('remote_url', url);
    applyServerUrl(url);
    // Reset and restart health-checks against the new URL
    lastError = '';
    attemptCount = 0;
    debugLog = [];
    clearInterval(checkTimer);
    checkBackend();
    checkTimer = setInterval(checkBackend, 5000);
  }

  onMount(async () => {
    // Restore i18n from session cache immediately (don't wait for backend)
    try {
      const cached = sessionStorage.getItem('i18n_cache');
      if (cached) {
        const data = JSON.parse(cached);
        const language = data.language ?? data.lang ?? 'en';
        lang.set(language);
        const localStrings = language !== 'en' ? (TRANSLATIONS[language] ?? {}) : {};
        if (Object.keys(localStrings).length > 0)
          translations.update(cur => ({ ...cur, ...localStrings }));
      }
    } catch { /* ignore */ }

    // Configure remote base URL (Electron or browser/PWA)
    if (inElectron) {
      try {
        const s = await window.electronAPI.getSettings();
        const client = s?.client || {};
        if (client.connectTo === 'remote' && client.remoteUrl) {
          applyServerUrl(client.remoteUrl);
        } else if (s?.mode === 'remote' && s.remoteUrl) {
          applyServerUrl(s.remoteUrl);
        } else {
          // Local mode — get the actual port assigned to Python
          try {
            const port = await window.electronAPI.getPort();
            applyServerUrl(port ? `http://127.0.0.1:${port}` : '');
          } catch { applyServerUrl(''); }
        }
      } catch { applyServerUrl(''); }
    } else {
      // Browser / PWA — restore saved remote URL (empty = same origin)
      const saved = localStorage.getItem('remote_url') || '';
      applyServerUrl(saved);
    }

    checkBackend();
    checkTimer = setInterval(checkBackend, 5000);
  });

  onDestroy(() => {
    clearInterval(checkTimer);
    clearInterval(modelPollTimer);
  });
</script>

<div class="app-shell">
  <Toolbar />
  <div class="main-area">
    <Sidebar />
    <div class="content">
      {#if view === 'settings'}
        <SettingsView />
      {:else if !$backendReady}
        <div class="backend-waiting">
          <div class="spinner"></div>
          <h2>Connecting to CrispLens…</h2>
          <p class="bw-url">Polling: <code>{serverUrl}/api/health</code></p>

          {#if !inElectron}
            <!-- Browser/PWA mode: let the user configure the server URL -->
            <div class="bw-server-config">
              <label class="bw-server-label">Server URL</label>
              <div class="bw-server-row">
                <input
                  type="url"
                  bind:value={editableServerUrl}
                  placeholder="https://yourserver.com  (leave blank for same origin)"
                  class="bw-server-input"
                  on:keydown={(e) => e.key === 'Enter' && connectToServer()}
                />
                <button class="primary" on:click={connectToServer}>Connect</button>
              </div>
              <p class="bw-server-hint">
                Leave blank if you're visiting this page directly from your CrispLens server.
                Enter the full URL if you're connecting to a remote instance.
              </p>
            </div>
          {/if}

          {#if lastError}
            <div class="bw-error">
              <strong>Error (attempt {attemptCount}):</strong>
              <code>{lastError}</code>
              {#if lastError.toLowerCase().includes('fetch')}
                <span class="bw-hint">
                  "Failed to fetch" usually means: wrong URL, network blocked, or CORS.
                  {#if serverUrl.startsWith('http://')}
                    ⚠ HTTP detected — HTTPS is required for PWA features (and recommended for security).
                  {/if}
                </span>
              {/if}
            </div>
          {:else if attemptCount > 0}
            <div class="bw-ok">Attempt {attemptCount} succeeded but state not yet updated…</div>
          {/if}

          <div class="bw-log">
            {#each debugLog as line}
              <div>{line}</div>
            {/each}
          </div>

          <div class="bw-buttons">
            <button on:click={checkBackend}>Retry Now</button>
            {#if inElectron}
              <button on:click={() => sidebarView.set('settings')}>Open Settings</button>
            {/if}
          </div>
        </div>
      {:else if sessionChecked && !$currentUser}
        <!-- No active session — show full-page login -->
        <LoginScreen on:loggedin={loadAll} />
      {:else if view === 'all'}
        {#if $galleryMode === 'grid'}
          <Gallery />
        {:else}
          <TableView />
        {/if}
      {:else if view === 'people'}
        <PeopleView />
      {:else if view === 'tags'}
        <TagsView />
      {:else if view === 'dates'}
        <DatesView />
      {:else if view === 'folders'}
        <FoldersView />
      {:else if view === 'process'}
        <ProcessView />
      {:else if view === 'train'}
        <TrainView />
      {:else if view === 'identify'}
        <IdentifyView />
      {:else if view === 'generate'}
        <GenerateView />
      {:else if view === 'filesystem'}
        <FilesystemView />
      {:else if view === 'watchfolders'}
        <WatchFoldersView />
      {:else if view === 'duplicates'}
        <DuplicatesView />
      {:else if view === 'albums'}
        <AlbumsView />
      {:else if view === 'faceclusters'}
        <FaceClusterView />
      {:else if view === 'events'}
        <EventsView />
      {:else if view === 'clouddrives'}
        <CloudDrivesView />
      {:else if view === 'batchjobs'}
        <BatchJobsView />
      {/if}
    </div>
  </div>
  <StatusBar />
  <Lightbox />
  <SelectionToolbar />
  <KeyboardManager />
  <PwaInstallBanner />
</div>

<datalist id="people-list">
  {#each $allPeople as p}
    <option value={p.name}></option>
  {/each}
</datalist>

<style>
  :global(*) { box-sizing: border-box; margin: 0; padding: 0; }
  :global(body) {
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #121218;
    color: #e0e0e0;
    font-size: 13px;
  }
  :global(::-webkit-scrollbar) { width: 6px; height: 6px; }
  :global(::-webkit-scrollbar-track) { background: #1e1e2a; }
  :global(::-webkit-scrollbar-thumb) { background: #3a3a5a; border-radius: 3px; }
  :global(::-webkit-scrollbar-thumb:hover) { background: #5a5a8a; }
  :global(button) {
    cursor: pointer;
    border: none;
    background: #2a2a42;
    color: #e0e0e0;
    padding: 5px 12px;
    border-radius: 4px;
    font-size: 12px;
    transition: background 0.15s;
  }
  :global(button:hover) { background: #3a3a5a; }
  :global(button.primary) { background: #4a6fa5; }
  :global(button.primary:hover) { background: #5a85c0; }
  :global(button.danger) { background: #7a2a2a; }
  :global(button.danger:hover) { background: #a03030; }
  :global(input, select, textarea) {
    background: #1e1e2e;
    border: 1px solid #3a3a5a;
    color: #e0e0e0;
    padding: 5px 8px;
    border-radius: 4px;
    font-size: 12px;
    outline: none;
  }
  :global(input:focus, select:focus, textarea:focus) { border-color: #6080c0; }

  .app-shell {
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .main-area {
    flex: 1;
    display: flex;
    overflow: hidden;
  }
  .content {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .backend-waiting {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 20px;
    background: #121218;
    color: #8090b8;
  }
  .backend-waiting { text-align: left; max-width: 640px; width: 100%; }
  .backend-waiting h2 { text-align: center; }
  .bw-url { font-size: 12px; color: #6080a0; text-align: center; margin-bottom: 6px; }
  .bw-url code { font-family: monospace; background: #1e1e2e; padding: 2px 6px; border-radius: 3px; color: #a0b8e0; }
  .bw-error {
    background: #2a1a1a; border: 1px solid #5a2a2a; border-radius: 6px;
    padding: 10px 14px; display: flex; flex-direction: column; gap: 6px;
    font-size: 12px; color: #c08080;
  }
  .bw-error code { font-family: monospace; color: #e08080; word-break: break-all; }
  .bw-hint { font-size: 11px; color: #806060; line-height: 1.5; }
  .bw-ok { font-size: 12px; color: #60a060; }
  .bw-log {
    background: #0e0e18; border: 1px solid #2a2a3a; border-radius: 6px;
    padding: 8px 12px; font-family: monospace; font-size: 11px; color: #5a7090;
    max-height: 200px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px;
    width: 100%; box-sizing: border-box;
  }
  .bw-buttons { display: flex; gap: 10px; justify-content: center; }
  .bw-buttons button { background: #2a3a5a; }
  .bw-buttons button:hover { background: #3a4a70; }

  /* Browser/PWA: server URL config block */
  .bw-server-config {
    width: 100%;
    background: #151525;
    border: 1px solid #2a3a6a;
    border-radius: 8px;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .bw-server-label { font-size: 11px; color: #6080a0; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
  .bw-server-row { display: flex; gap: 8px; }
  .bw-server-input { flex: 1; font-size: 12px; padding: 7px 10px; }
  .bw-server-hint { font-size: 11px; color: #50607a; line-height: 1.5; margin: 0; }
  .backend-waiting code {
    font-family: monospace;
    background: #1e1e2e;
    padding: 2px 6px;
    border-radius: 3px;
    color: #a0b8e0;
  }
  .spinner {
    width: 40px;
    height: 40px;
    border: 3px solid rgba(255,255,255,0.1);
    border-top: 3px solid #4a6fa5;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }
  @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
</style>
