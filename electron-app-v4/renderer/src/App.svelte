<script>
  import { onMount, onDestroy } from 'svelte';
  import { sidebarView, currentUser, stats, allTags, allPeople, allAlbums, translations, lang, galleryMode, backendReady, modelReady, TRANSLATIONS, processingBackend, isOffline, galleryImages, serverLoginNeeded } from './stores.js';
  import { fetchHealth, fetchMe, fetchStats, fetchTags, fetchPeople, fetchAlbums, fetchTranslations, setRemoteBase, fetchSettings, fetchImages, isLocalMode, setLocalMode } from './api.js';
  import { installConsoleCapture } from './lib/ConsoleCapture.js';
  installConsoleCapture(); // capture console output for in-app log viewer (standalone mode)
  import syncManager from './lib/SyncManager.js';

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

  // True when bundled inside Capacitor (iOS/Android) — origin is 'capacitor://localhost'
  const inCapacitor = window.location.protocol === 'capacitor:';

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
      // Validate it's actually a CrispLens backend response (not an HTML fallback page)
      if (!h || typeof h !== 'object' || !h.ok) throw new Error('Not a CrispLens backend — is the URL correct?');
      lastError = '';
      dbg(`→ 200 OK | Version: ${h.version || '4.0.0'} | Model Ready: ${h.model_ready}`);
      console.log('%c[System] Backend Version:', 'color: #e89050; font-weight: bold', h.version, '| Server Time:', h.server_time);
      
      // Stop polling as soon as we get a valid response
      if (checkTimer) {
        clearInterval(checkTimer);
        checkTimer = null;
      }

      if (!$backendReady) {
        backendReady.set(true);
        isOffline.set(false);
        loadAll();
        // Auto-push any items processed while offline
        const apiBase = localStorage.getItem('remote_url') || window.location.origin;
        syncManager.pushPending(apiBase).then(({ pushed }) => {
          if (pushed > 0) {
            console.log(`[reconnect] pushed ${pushed} queued item(s)`);
            fetchImages().then(imgs => galleryImages.set(imgs)).catch(() => {});
          }
        }).catch(() => {});
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
      // If we have cached data, switch to offline mode so gallery remains usable
      if (!$isOffline) {
        const hasCached = await syncManager.hasCachedData().catch(() => false);
        if (hasCached) {
          isOffline.set(true);
          sessionChecked = true;
          try {
            const cached = await syncManager.getImages({ limit: 200 });
            galleryImages.set(cached);
            const cachedPeople = await syncManager.getPeople();
            allPeople.set(cachedPeople);
          } catch { /* ignore */ }
        }
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
    dbg('Starting data load...');
    // Try to restore existing session
    try {
      dbg('Checking session (/auth/me)...');
      const user = await fetchMe();
      currentUser.set(user);
      dbg(`Session OK: logged in as ${user.username}`);
    } catch (e) {
      dbg(`No active session: ${e.message}`);
    }
    sessionChecked = true;   // show login screen now if still null

    // Load i18n — apply language from backend settings
    try {
      dbg('Fetching translations from backend...');
      const data = await fetchTranslations(true);
      const language = data.language ?? data.lang ?? 'en';
      dbg(`[i18n] Backend reported language: "${language}"`);
      
      lang.set(language);
      
      // Apply translations: prefer local TRANSLATIONS bundle for non-EN languages
      const localStrings = TRANSLATIONS[language] ?? {};
      const backendStrings = data.translations ?? {};
      
      dbg(`[i18n] Local strings for "${language}": ${Object.keys(localStrings).length} keys`);
      dbg(`[i18n] Backend strings: ${Object.keys(backendStrings).length} keys`);
      
      // Reset translations to EN first if switching to a known language to ensure a clean base
      const merged = { ...backendStrings, ...localStrings };
      
      if (Object.keys(merged).length > 0) {
        dbg(`[i18n] Applying ${Object.keys(merged).length} merged strings to UI`);
        // We MUST use translations.set() with a full object to ensure Svelte store subscribers trigger
        // and we include EN as base for any missing keys in the target language.
        translations.set({ ...TRANSLATIONS.en, ...merged });
        dbg(`[i18n] UI update successful. Current app_title: "${merged.app_title || 'N/A'}"`);
      } else {
        dbg('[i18n] No strings found to merge, staying with default (EN)');
        translations.set(TRANSLATIONS.en);
      }
      
      sessionStorage.setItem('i18n_cache', JSON.stringify({ ...data, language, lang: language }));
    } catch (e) { 
      dbg(`i18n load failed: ${e.message}`);
      console.error('[i18n] Critical error loading translations:', e);
    }

    // Load initial data
    try {
      dbg('Fetching stats, tags, people, albums, settings...');
      const [sStats, sTags, sPeople, sAlbums, sSettings] = await Promise.all([
        fetchStats().then(r => { dbg('✓ Stats loaded'); return r; }).catch(e => { dbg(`✗ fetchStats error: ${e.message}`); return {}; }),
        fetchTags().then(r => { dbg('✓ Tags loaded'); return r; }).catch(e => { dbg(`✗ fetchTags error: ${e.message}`); return []; }),
        fetchPeople().then(r => { dbg('✓ People loaded'); return r; }).catch(e => { dbg(`✗ fetchPeople error: ${e.message}`); return []; }),
        fetchAlbums().then(r => { dbg('✓ Albums loaded'); return r; }).catch(e => { dbg(`✗ fetchAlbums error: ${e.message}`); return []; }),
        fetchSettings().then(r => { dbg('✓ Settings loaded'); return r; }).catch(e => { dbg(`✗ fetchSettings error: ${e.message}`); return null; })
      ]);

      stats.set(sStats);
      allTags.set(sTags);
      allPeople.set(sPeople);
      allAlbums.set(sAlbums);
      if (sSettings) {
        processingBackend.set(sSettings?.processing?.backend ?? 'local');
        // Log full settings at startup so we can verify what was loaded
        console.log('[App] Settings loaded at startup:');
        console.log('  processing.backend:', sSettings?.processing?.backend);
        console.log('  vlm.enabled:', sSettings?.vlm?.enabled, '| provider:', sSettings?.vlm?.provider, '| model:', sSettings?.vlm?.model);
        const fi = sSettings?.face_recognition?.insightface;
        console.log('  det_model:', fi?.det_model, '| det_thresh:', fi?.detection_threshold, '| rec_thresh:', fi?.recognition_threshold);
        const sy = sSettings?.sync;
        if (sy) {
          console.log('  sync.thumb_size:', sy.thumb_size, '| max_items:', sy.max_items, '| max_size_mb:', sy.max_size_mb);
          // Mirror to localStorage so SyncManager reads the authoritative value
          try {
            const ls = JSON.parse(localStorage.getItem('crisplens_sync_settings') || '{}');
            const merged = { ...ls, thumbSize: sy.thumb_size, maxItems: sy.max_items, maxSizeMb: sy.max_size_mb };
            localStorage.setItem('crisplens_sync_settings', JSON.stringify(merged));
            console.log('[App] Sync settings mirrored to localStorage:', merged);
          } catch(e) { console.warn('[App] Could not mirror sync settings to localStorage:', e.message); }
        }
      }
      dbg('Initial data load complete.');
    } catch (e) {
      dbg(`General data load error: ${e.message}`);
    }
  }

  function applyServerUrl(url) {
    if (url) {
      setRemoteBase(url);
      serverUrl = url;
    } else {
      // Same-origin — use relative /api paths (no setRemoteBase call)
      serverUrl = window.location.origin;
    }
    // In Capacitor, capacitor://localhost is meaningless as a displayed URL
    editableServerUrl = (inCapacitor && !url) ? '' : serverUrl;
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
    console.log('[App] onMount start');
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
        console.log(`[App] i18n restored from cache: ${language}`);
      }
    } catch { /* ignore */ }

    // ── Local (standalone) mode: browser WASM SQLite for image/face data ────────
    // _localMode only controls WHERE image/face data comes from (local WASM vs server).
    // Cloud drives + filesystem are always server-side and must work regardless.
    if (isLocalMode()) {
      console.log('[App] Standalone mode — initializing local WASM engine...');
      setTimeout(async () => {
        try {
          const { getDB } = await import('./lib/LocalDB.js');
          await getDB();
          console.log('[App] Standalone engine initialized');
        } catch (e) {
          console.error('[App] Standalone engine initialization failed:', e);
        }
      }, 500);

      backendReady.set(true);
      modelReady.set(true);
      sessionChecked = true;
      loadAll(); // _guard routes to local adapter; sets currentUser={username:'local',role:'admin'}

      // Probe server auth in background — cloud drives / filesystem need a session.
      // Use raw fetch (not api.js) so _localMode doesn't intercept it.
      setTimeout(async () => {
        try {
          const base = (localStorage.getItem('remote_url') || window.location.origin).replace(/\/$/, '');
          const r = await fetch(`${base}/api/auth/me`, { credentials: 'include' });
          if (r.status === 401) {
            console.log('[App] Standalone: server reachable but no session → cloud drives need login');
            serverLoginNeeded.set(true);
          } else if (r.ok) {
            console.log('[App] Standalone: server session valid → cloud drives will work');
            serverLoginNeeded.set(false);
          }
        } catch {
          // Server not reachable — pure offline local mode, cloud drives unavailable
          console.log('[App] Standalone: server not reachable — cloud drives unavailable');
        }
      }, 800);

      return;
    }

    console.log('[App] Server mode, checking backend connectivity...');
    // Configure remote base URL (Electron or browser/PWA)
    if (inElectron) {
      console.log('[App] Running in Electron');
      try {
        const s = await window.electronAPI.getSettings();
        const client = s?.client || {};
        if (client.connectTo === 'remote' && client.remoteUrl) {
          console.log(`[App] Connecting to remote: ${client.remoteUrl}`);
          applyServerUrl(client.remoteUrl);
        } else if (s?.mode === 'remote' && s.remoteUrl) {
          console.log(`[App] Connecting to remote (legacy): ${s.remoteUrl}`);
          applyServerUrl(s.remoteUrl);
        } else {
          // Local mode — get the actual port assigned to Python
          try {
            const port = await window.electronAPI.getPort();
            console.log(`[App] Local server port: ${port}`);
            applyServerUrl(port ? `http://127.0.0.1:${port}` : '');
          } catch { 
            console.warn('[App] Failed to get port via IPC');
            applyServerUrl(''); 
          }
        }
      } catch (err) { 
        console.error('[App] Failed to get settings via IPC:', err);
        applyServerUrl(''); 
      }
    } else {
      // Browser / PWA — restore saved remote URL (empty = same origin)
      const saved = localStorage.getItem('remote_url') || '';
      console.log(`[App] Browser mode, saved remote_url: ${saved}`);
      if (inCapacitor && !saved) {
        // First run in Capacitor with no saved server URL.
        // Don't poll capacitor://localhost — just show the connect screen.
        console.log('[App] First run in Capacitor, showing connect screen');
        editableServerUrl = '';
        sessionChecked = true;  // prevent login flash
        return;
      }
      applyServerUrl(saved);
    }

    console.log(`[App] Final serverUrl: ${serverUrl}`);
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
      {#if $isOffline && !$backendReady}
        <div class="offline-banner">⚡ Offline — showing cached data</div>
      {/if}

      {#if view === 'settings'}
        <SettingsView />
      {:else if !$backendReady && !$isOffline}
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
                  placeholder={inCapacitor ? 'https://your-server.com or http://192.168.x.x:7861' : 'https://yourserver.com  (leave blank for same origin)'}
                  class="bw-server-input"
                  on:keydown={(e) => e.key === 'Enter' && connectToServer()}
                />
                <button class="primary" on:click={connectToServer}>Connect</button>
              </div>
              {#if inCapacitor}
                <p class="bw-server-hint">
                  Enter the URL of your CrispLens server.<br>
                  • <strong>HTTPS</strong>: use your domain (e.g. <code>https://img.example.com</code>)<br>
                  • <strong>LAN</strong>: use your Mac's IP, not localhost (e.g. <code>http://192.168.1.x:7861</code>)<br>
                  • <strong>CORS</strong>: the server must allow origin <code>capacitor://localhost</code> — v4 Node.js does this automatically.
                </p>
              {:else}
                <p class="bw-server-hint">
                  Leave blank if you're visiting this page directly from your CrispLens server.
                  Enter the full URL if you're connecting to a remote instance.
                </p>
              {/if}
            </div>
          {/if}

          {#if lastError}
            <div class="bw-error">
              <strong>Error (attempt {attemptCount}):</strong>
              <code>{lastError}</code>
              {#if lastError.toLowerCase().includes('fetch') || lastError.toLowerCase().includes('load failed')}
                <span class="bw-hint">
                  {lastError.toLowerCase().includes('load failed') ? '"Load failed"' : '"Failed to fetch"'} usually means: wrong URL, network unreachable, or CORS rejected.
                  {#if inCapacitor}
                    <br>• The server must respond with <code>Access-Control-Allow-Origin: capacitor://localhost</code> — v4 Node.js does this automatically; v2 FastAPI may need configuration.
                    <br>• Use your machine's LAN IP (<code>192.168.x.x</code>), not <code>localhost</code>.
                    {#if serverUrl.startsWith('http://')}
                      <br>• HTTP is blocked by iOS by default — see ATS setup below, or use HTTPS.
                    {/if}
                  {:else if serverUrl.startsWith('http://')}
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
            <button class="danger" on:click={async () => { 
              if (confirm('Hard Reset? This will purge EVERYTHING: database, settings, and all locally cached data. The app will reload. Continue?')) {
                const { hardResetApp } = await import('./lib/LocalDB.js');
                await hardResetApp();
              }
            }}>Reset App State (Hard Reset)</button>
          </div>
        </div>
      {:else if !sessionChecked && !$isOffline}
        <!-- Session check in progress — prevent content views from mounting unauthenticated -->
        <div style="flex:1;display:flex;align-items:center;justify-content:center;color:#505070;font-size:13px">Checking session…</div>
      {:else if !$currentUser && !$isOffline}
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

  <!-- Server login modal: shown in standalone mode when server session is missing -->
  {#if $serverLoginNeeded}
    {@const doLogin = async () => {
      const u = document.getElementById('sli-user')?.value?.trim();
      const p = document.getElementById('sli-pass')?.value;
      if (!u) return;
      const errEl = document.getElementById('sli-err');
      try {
        const base = (localStorage.getItem('remote_url') || window.location.origin).replace(/\/$/, '');
        const r = await fetch(`${base}/api/auth/login`, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: u, password: p }),
        });
        if (r.ok) { serverLoginNeeded.set(false); }
        else { if (errEl) errEl.textContent = 'Login failed'; }
      } catch (e) { if (errEl) errEl.textContent = e.message; }
    }}
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <div class="sli-backdrop" on:click|self={() => serverLoginNeeded.set(false)}>
      <div class="sli-modal">
        <div class="sli-title">🔐 Server login needed</div>
        <div class="sli-hint">You are in standalone mode. Log in to the server to access cloud drives and filesystem browse.</div>
        <input id="sli-user" type="text" placeholder="Username" class="sli-input"
          on:keydown={e => e.key === 'Enter' && doLogin()} />
        <input id="sli-pass" type="password" placeholder="Password" class="sli-input"
          on:keydown={e => e.key === 'Enter' && doLogin()} />
        <div id="sli-err" class="sli-err"></div>
        <div class="sli-actions">
          <button on:click={() => serverLoginNeeded.set(false)}>Cancel</button>
          <button class="primary" on:click={doLogin}>Log in to server</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<datalist id="people-list">
  {#each $allPeople as p}
    <option value={p.name}></option>
  {/each}
</datalist>

<style>
  .sli-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,.65);
    display: flex; align-items: center; justify-content: center; z-index: 9000;
  }
  .sli-modal {
    background: #1a1a2e; border: 1px solid #3a3a60; border-radius: 10px;
    padding: 22px 24px; width: 340px; display: flex; flex-direction: column; gap: 12px;
  }
  .sli-title { font-size: 14px; font-weight: 600; color: #c0c8e0; }
  .sli-hint  { font-size: 11px; color: #6070a0; line-height: 1.5; }
  .sli-input {
    background: #111120; border: 1px solid #2a2a4a; border-radius: 4px;
    color: #c0c8e0; font-size: 13px; padding: 6px 10px; width: 100%;
  }
  .sli-err { font-size: 11px; color: #e06060; min-height: 14px; }
  .sli-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }

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
  .offline-banner {
    background: #2a2a10;
    border-bottom: 1px solid #6a6a20;
    color: #c0c060;
    font-size: 11px;
    padding: 4px 16px;
    text-align: center;
    flex-shrink: 0;
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
