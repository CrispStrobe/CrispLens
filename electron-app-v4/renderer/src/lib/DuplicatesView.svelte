<script>
  import { onMount } from 'svelte';
  import {
    fetchDuplicateStats,
    fetchDuplicateGroups,
    resolveDuplicate,
    resolveDuplicateBatch,
    scanPhash,
    scanHashes,
    thumbnailUrl,
    downloadCleanupScript,
  } from '../api.js';
  import { currentUser, t } from '../stores.js';

  // Role guard: only admin and mediamanager may resolve duplicates
  $: canResolve = $currentUser?.role === 'admin' || $currentUser?.role === 'mediamanager';

  // ── State ──────────────────────────────────────────────────────────────────
  let stats    = null;
  let groups   = [];
  let loading  = false;
  let method   = 'hash';         // name_size | hash | visual
  let threshold = 8;             // pHash hamming threshold (0–20)
  let keepStrategy = 'most_faces'; // most_faces | oldest | largest

  // Per-group "which to keep" (map: group key → image id)
  let keepMap = {};

  // Multi-select for batch resolve
  let selectedGroups = new Set(); // Set<group.key>

  // Batch action
  let batchAction = 'delete_file';  // delete_file | db_only | symlink
  let mergeFaces  = true;

  // Individual resolve state
  let resolving = {};   // { [group.key]: bool }
  let resolved  = {};   // { [group.key]: 'ok' | 'error' }

  // Batch resolve state
  let batchResolving = false;
  let batchDone      = false;
  let batchResult    = null;

  // Local cleanup panel (shown after resolve when origin_path differs from server_path)
  let pendingCleanupFiles = [];   // [{origin_path, server_path, kept_origin_path, filename}]
  let cleanupFormat       = 'bash';
  let cleanupAction       = 'trash';  // 'trash' | 'delete' | 'symlink'
  let cleanupBusy         = false;
  let cleanupResult       = null; // null | {trashed: int, errors: [{path, error}]}

  // JSON import (Electron only — execute a previously-downloaded cleanup JSON locally)
  let importBusy   = false;
  let importResult = null;  // null | {trashed: int, errors: [{path, error}]}

  // Context detection
  let isElectron = typeof window !== 'undefined' && !!window.electronAPI;
  let isRemote   = false;

  // pHash scan state
  let scanning    = false;
  let scanStream  = null;
  let scanProg    = { total: 0, done: 0 };
  let scanDone    = false;

  // SHA-256 hash scan state
  let hashScanning = false;
  let hashStream   = null;
  let hashProg     = { total: 0, done: 0 };
  let hashScanDone = false;

  // ── Data loading ──────────────────────────────────────────────────────────
  async function loadStats() {
    try { stats = await fetchDuplicateStats(); } catch { stats = null; }
  }

  async function loadGroups() {
    loading = true;
    keepMap = {};
    selectedGroups = new Set();
    resolved = {};
    try {
      groups = await fetchDuplicateGroups(method, threshold);
      // Auto-assign keep based on strategy
      for (const g of groups) {
        keepMap[g.key] = autoKeep(g.images);
      }
    } catch (e) {
      console.error('loadGroups error:', e);
      groups = [];
    } finally {
      loading = false;
    }
  }

  function autoKeep(images) {
    if (!images || images.length === 0) return null;
    if (keepStrategy === 'most_faces') {
      return images.reduce((a, b) => (b.face_count ?? 0) > (a.face_count ?? 0) ? b : a).id;
    }
    if (keepStrategy === 'oldest') {
      return images.reduce((a, b) => (a.created_at ?? '') < (b.created_at ?? '') ? a : b).id;
    }
    if (keepStrategy === 'largest') {
      return images.reduce((a, b) => (b.file_size ?? 0) > (a.file_size ?? 0) ? b : a).id;
    }
    return images[0].id;
  }

  function reapplyKeepStrategy() {
    for (const g of groups) {
      keepMap[g.key] = autoKeep(g.images);
    }
    keepMap = { ...keepMap };
  }

  // ── Group selection ───────────────────────────────────────────────────────
  function toggleGroup(key) {
    const s = new Set(selectedGroups);
    s.has(key) ? s.delete(key) : s.add(key);
    selectedGroups = s;
  }

  function selectAll()   { selectedGroups = new Set(groups.map(g => g.key)); }
  function deselectAll() { selectedGroups = new Set(); }

  // ── Resolve single group ──────────────────────────────────────────────────
  async function resolveGroup(group, action) {
    const keepId = keepMap[group.key];
    if (!keepId) { alert($t('dup_keep') + '?'); return; }
    const deleteIds = group.images.map(i => i.id).filter(id => id !== keepId);
    if (deleteIds.length === 0) return;

    resolving = { ...resolving, [group.key]: true };
    try {
      // Collect origin files before resolve deletes the DB records
      const newCleanup = collectCleanupFiles(group.images, keepId);
      await resolveDuplicate(keepId, deleteIds, action, mergeFaces);
      resolved = { ...resolved, [group.key]: 'ok' };
      if (newCleanup.length > 0) {
        pendingCleanupFiles = [...pendingCleanupFiles, ...newCleanup];
        cleanupResult = null;
      }
      groups = groups.filter(g => g.key !== group.key);
      selectedGroups.delete(group.key);
      selectedGroups = new Set(selectedGroups);
      await loadStats();
    } catch (e) {
      resolved = { ...resolved, [group.key]: 'error' };
      alert(`Error: ${e.message}`);
    } finally {
      resolving = { ...resolving, [group.key]: false };
    }
  }

  // ── Batch resolve ─────────────────────────────────────────────────────────
  async function resolveBatch() {
    if (selectedGroups.size === 0 || batchResolving) return;
    batchResolving = true;
    batchDone = false;
    batchResult = null;

    // Collect cleanup candidates BEFORE resolve (DB records deleted afterward)
    const newCleanup = [];
    const groupsToResolve = groups
      .filter(g => selectedGroups.has(g.key))
      .map(g => {
        const keepId    = keepMap[g.key];
        const deleteIds = g.images.map(i => i.id).filter(id => id !== keepId);
        newCleanup.push(...collectCleanupFiles(g.images, keepId));
        return { keep_id: keepId, delete_ids: deleteIds };
      })
      .filter(g => g.keep_id && g.delete_ids.length > 0);

    try {
      const result = await resolveDuplicateBatch(groupsToResolve, batchAction, mergeFaces);
      batchResult = result;
      batchDone = true;
      if (newCleanup.length > 0) {
        pendingCleanupFiles = [...pendingCleanupFiles, ...newCleanup];
        cleanupResult = null;
      }
      await loadGroups();
      await loadStats();
    } catch (e) {
      alert(`Batch resolve error: ${e.message}`);
    } finally {
      batchResolving = false;
    }
  }

  // ── pHash scan ───────────────────────────────────────────────────────────
  function startScan() {
    if (scanning) return;
    scanning = true;
    scanDone = false;
    scanProg = { total: 0, done: 0 };

    scanStream = scanPhash(event => {
      // v4: { available: false } → library not ready
      if (event.available === false && !event.started) {
        scanning = false;
        alert('pHash scanning not available on this server.');
        return;
      }
      // Start: v4 { started: true, total } or v2 { type: 'start', total }
      if (event.started || event.type === 'start') {
        scanProg = { total: event.total, done: 0 };
      // Done: v4 { done: true } or v2 { type: 'done' }
      } else if (event.done === true || event.type === 'done') {
        scanning = false;
        scanDone = true;
        scanStream = null;
        loadStats();
        if (method === 'visual') loadGroups();
      // Progress: v4 { index: N } or v2 { index: N }
      } else {
        scanProg = { ...scanProg, done: event.index ?? scanProg.done + 1 };
      }
    });
  }

  function cancelScan() {
    if (scanStream) { scanStream.close(); scanStream = null; }
    scanning = false;
  }

  // ── SHA-256 hash scan ─────────────────────────────────────────────────────
  function startHashScan() {
    if (hashScanning) return;
    hashScanning = true;
    hashScanDone = false;
    hashProg = { total: 0, done: 0 };

    hashStream = scanHashes(event => {
      // Start: v4 { started: true, total } or v2 { type: 'start', total }
      if (event.started || event.type === 'start') {
        hashProg = { total: event.total, done: 0 };
      // Done: v4 { done: true } or v2 { type: 'done' }
      } else if (event.done === true || event.type === 'done') {
        hashScanning = false;
        hashScanDone = true;
        hashStream = null;
        loadStats();
        if (method === 'hash') loadGroups();
      // Progress: v4/v2 { index: N }
      } else {
        hashProg = { ...hashProg, done: event.index ?? hashProg.done + 1 };
      }
    });
  }

  function cancelHashScan() {
    if (hashStream) { hashStream.close(); hashStream = null; }
    hashScanning = false;
  }

  // ── Formatting helpers ────────────────────────────────────────────────────
  function fmtBytes(b) {
    if (!b) return '0 B';
    if (b < 1024) return `${b} B`;
    if (b < 1024*1024) return `${(b/1024).toFixed(1)} KB`;
    if (b < 1024**3)   return `${(b/1024/1024).toFixed(1)} MB`;
    return `${(b/1024**3).toFixed(2)} GB`;
  }

  function fmtDate(ts) {
    if (!ts) return '—';
    try { return new Date(ts).toLocaleDateString(); } catch { return ts; }
  }

  function folderOf(path) {
    if (!path) return '';
    const parts = path.replace(/\\/g, '/').split('/');
    return parts.slice(0, -1).join('/') || '/';
  }

  // ── Local cleanup helpers ─────────────────────────────────────────────────
  function collectCleanupFiles(groupImages, keepId) {
    const keepImg = groupImages.find(img => img.id === keepId);
    const keptOrigin = keepImg?.origin_path ?? keepImg?.server_path ?? keepImg?.filepath ?? '';
    return groupImages
      .filter(img => img.id !== keepId)
      .filter(img => img.origin_path && img.origin_path !== (img.server_path ?? img.filepath))
      .map(img => ({
        origin_path:      img.origin_path,
        server_path:      img.server_path ?? img.filepath ?? '',
        kept_origin_path: keptOrigin,
        filename:         img.filename,
      }));
  }

  async function doElectronTrash() {
    if (cleanupBusy) return;
    cleanupBusy  = true;
    cleanupResult = null;
    try {
      const paths   = pendingCleanupFiles.map(f => f.origin_path);
      const results = await window.electronAPI.trashItems(paths);
      const trashed = results.filter(r => r.ok).length;
      const errors  = results.filter(r => !r.ok).map(r => ({ path: r.path, error: r.error }));
      cleanupResult = { trashed, errors };
      if (errors.length === 0) pendingCleanupFiles = [];
    } catch (e) {
      alert(`Trash error: ${e.message}`);
    } finally {
      cleanupBusy = false;
    }
  }

  async function doScriptDownload(fmt, action) {
    if (cleanupBusy) return;
    cleanupBusy = true;
    try {
      await downloadCleanupScript(
        pendingCleanupFiles,
        fmt ?? cleanupFormat,
        action ?? cleanupAction,
      );
    } catch (e) {
      alert(`Script download error: ${e.message}`);
    } finally {
      cleanupBusy = false;
    }
  }

  async function doBrowserDelete() {
    if (cleanupBusy) return;
    cleanupBusy  = true;
    cleanupResult = null;
    let trashed = 0;
    const errors = [];
    // Group by parent directory so we request one picker per directory
    const byDir = {};
    for (const f of pendingCleanupFiles) {
      const normalized = f.origin_path.replace(/\\/g, '/');
      const dir  = normalized.substring(0, normalized.lastIndexOf('/')) || '/';
      const name = normalized.substring(normalized.lastIndexOf('/') + 1);
      (byDir[dir] = byDir[dir] || []).push({ name, fullPath: f.origin_path });
    }
    try {
      for (const [dir, files] of Object.entries(byDir)) {
        let handle;
        try {
          handle = await window.showDirectoryPicker({ startIn: 'pictures' });
        } catch (e) {
          if (e.name === 'AbortError') break;
          errors.push({ path: dir, error: e.message });
          continue;
        }
        for (const { name } of files) {
          try {
            await handle.removeEntry(name);
            trashed++;
          } catch (e) {
            errors.push({ path: `${dir}/${name}`, error: e.message });
          }
        }
      }
      cleanupResult = { trashed, errors };
      if (errors.length === 0) pendingCleanupFiles = [];
    } catch (e) {
      alert(`Browser delete error: ${e.message}`);
    } finally {
      cleanupBusy = false;
    }
  }

  async function doImportJson() {
    if (importBusy) return;
    importBusy   = true;
    importResult = null;
    try {
      const paths = await window.electronAPI.openFileDialog({
        filters: [{ name: 'JSON', extensions: ['json'] }],
        multiple: false,
      });
      if (!paths?.length) { importBusy = false; return; }
      const raw     = await window.electronAPI.readLocalFile(paths[0]);
      const text    = new TextDecoder().decode(raw);
      const data    = JSON.parse(text);
      if (data.version !== 1 || !Array.isArray(data.files)) {
        throw new Error('Invalid cleanup JSON format — version must be 1 and files must be an array.');
      }
      const validActions = ['trash_files', 'delete_files', 'symlink_files'];
      if (!validActions.includes(data.action)) {
        throw new Error(`Unknown action "${data.action}". Expected: ${validActions.join(', ')}`);
      }
      const filePaths = data.files.map(f => f.origin_path).filter(Boolean);
      if (filePaths.length === 0) { importResult = { trashed: 0, errors: [] }; importBusy = false; return; }
      const results = await window.electronAPI.trashItems(filePaths);
      const trashed = results.filter(r => r.ok).length;
      const errors  = results.filter(r => !r.ok).map(r => ({ path: r.path, error: r.error }));
      importResult  = { trashed, errors, total: filePaths.length };
    } catch (e) {
      importResult = { trashed: 0, errors: [{ path: '', error: e.message }], total: 0 };
    } finally {
      importBusy = false;
    }
  }

  onMount(async () => {
    if (isElectron) {
      try {
        const s = await window.electronAPI.getSettings();
        isRemote = s?.client?.connectTo === 'remote';
      } catch { isRemote = false; }
    }
    // Auto-select script format based on client OS
    const platform = navigator.userAgentData?.platform ?? navigator.platform ?? '';
    if (/win/i.test(platform)) {
      cleanupFormat = 'powershell';
    } else {
      cleanupFormat = 'bash'; // macOS, Linux
    }
    await loadStats();
    await loadGroups();
  });
</script>

<div class="dup-view">
  <!-- ── Header ── -->
  <div class="header">
    <div class="header-left">
      <span class="title">{$t('duplicates')}</span>
      {#if stats}
        <span class="sub">
          {stats.hash_groups + stats.name_size_groups} {$t('dup_groups')} ·
          {fmtBytes(stats.wasted_bytes)} {$t('recoverable')}
        </span>
      {/if}
    </div>

    <div class="controls">
      <label class="ctrl-label">{$t('dup_method')}</label>
      <select bind:value={method} on:change={loadGroups}>
        <option value="name_size">{$t('dup_method_name_size')}</option>
        <option value="hash">{$t('dup_method_hash')}</option>
        <option value="visual" disabled={!stats?.phash_available}>
          {$t('dup_method_visual')}{stats?.phash_available ? '' : ' — not installed'}
        </option>
      </select>

      {#if method === 'visual'}
        <label class="ctrl-label">{$t('dup_threshold')}</label>
        <input type="range" min="1" max="20" step="1"
          bind:value={threshold} on:change={loadGroups}
          style="width:80px" />
        <span class="ctrl-val">{threshold}</span>
      {/if}

      <label class="ctrl-label">{$t('dup_keep')}</label>
      <select bind:value={keepStrategy} on:change={reapplyKeepStrategy}>
        <option value="most_faces">{$t('dup_keep_most_faces')}</option>
        <option value="oldest">{$t('dup_keep_oldest')}</option>
        <option value="largest">{$t('dup_keep_largest')}</option>
      </select>

      <button on:click={loadGroups} disabled={loading}>
        {loading ? '…' : $t('refresh')}
      </button>
    </div>
  </div>

  <!-- ── SHA-256 hash scan bar (shown when there are missing hashes) ── -->
  {#if stats?.hash_missing > 0 || hashScanning || hashScanDone}
    <div class="scan-bar">
      {#if hashScanning}
        <div class="scan-prog">
          {$t('computing_hashes')} {hashProg.done}/{hashProg.total}
          <div class="prog-wrap">
            <div class="prog-fill"
              style="width: {hashProg.total ? (hashProg.done/hashProg.total)*100 : 0}%"></div>
          </div>
          <button class="btn-sm" on:click={cancelHashScan}>{$t('cancel')}</button>
        </div>
      {:else if hashScanDone}
        <span class="scan-ok">✅ {$t('hash_scan_complete')}</span>
      {:else}
        <span class="scan-hint">
          {stats.hash_missing} {stats.hash_missing === 1 ? $t('fs_image_label') : $t('photos')} missing SHA-256 hash
        </span>
        <button class="primary btn-sm" on:click={startHashScan}>{$t('fill_hashes')}</button>
      {/if}
    </div>
  {/if}

  <!-- ── pHash scan bar ── -->
  {#if method === 'visual' && stats?.phash_available}
    <div class="scan-bar">
      {#if scanning}
        <div class="scan-prog">
          {$t('scanning_phash')} {scanProg.done}/{scanProg.total}
          <div class="prog-wrap">
            <div class="prog-fill"
              style="width: {scanProg.total ? (scanProg.done/scanProg.total)*100 : 0}%"></div>
          </div>
          <button class="btn-sm" on:click={cancelScan}>{$t('cancel')}</button>
        </div>
      {:else if stats?.phash_missing > 0}
        <span class="scan-hint">
          {stats.phash_missing} {stats.phash_missing === 1 ? $t('fs_image_label') : $t('photos')} need pHash computed
        </span>
        <button class="primary btn-sm" on:click={startScan}>{$t('scan_phash_btn')}</button>
      {:else if scanDone}
        <span class="scan-ok">✅ {$t('phash_scan_complete')}</span>
      {:else}
        <span class="scan-ok">✅ {$t('all_images_have_phash')}</span>
      {/if}
    </div>
  {:else if method === 'visual' && !stats?.phash_available}
    <div class="scan-bar warn">
      {$t('imagehash_not_installed')}
      Run <code>pip install imagehash</code> and restart.
    </div>
  {/if}

  <!-- ── Batch toolbar ── -->
  {#if selectedGroups.size > 0}
    <div class="batch-bar">
      <span class="batch-label">{selectedGroups.size} {selectedGroups.size === 1 ? $t('dup_groups').replace(/n$/, '') : $t('dup_groups')} selected</span>
      {#if canResolve}
        <label class="ctrl-label">{$t('dup_action')}</label>
        <select bind:value={batchAction}>
          <option value="delete_file">{$t('dup_delete_from_disk')}</option>
          <option value="db_only">{$t('dup_remove_db_only')}</option>
          <option value="symlink">{$t('dup_replace_symlink')}</option>
        </select>
        <label class="toggle-label">
          <input type="checkbox" bind:checked={mergeFaces} />
          {$t('dup_merge_faces')}
        </label>
        <button class="primary" on:click={resolveBatch} disabled={batchResolving}>
          {batchResolving ? $t('dup_resolving') : $t('dup_resolve_selected')}
        </button>
      {:else}
        <span class="role-guard-hint">{$t('dup_role_guard')}</span>
      {/if}
      <button class="btn-sm" on:click={deselectAll}>{$t('deselect')}</button>
    </div>
  {/if}

  <!-- ── Group list ── -->
  <div class="list">
    {#if loading}
      <div class="empty">{$t('loading')}</div>
    {:else if groups.length === 0}
      <div class="empty">
        <div class="empty-icon">✨</div>
        <div>{$t('no_duplicates')}</div>
        {#if method === 'visual' && stats?.phash_missing > 0}
          <div class="empty-sub">{$t('dup_run_scan_first')}</div>
        {/if}
      </div>
    {:else}
      <!-- Select all bar -->
      <div class="sel-bar">
        <button class="btn-sm" on:click={selectAll}>{$t('select_all')}</button>
        <button class="btn-sm" on:click={deselectAll}>{$t('deselect_all')}</button>
        <span class="sel-count">{groups.length} {$t('dup_groups')}</span>
      </div>

      {#each groups as group (group.key)}
        {@const isSelected = selectedGroups.has(group.key)}
        {@const isResolving = resolving[group.key]}
        {@const isResolved  = resolved[group.key]}

        <div class="group-card" class:selected={isSelected}>
          <!-- Group header -->
          <div class="group-header">
            <div
              class="g-cb"
              on:click={() => toggleGroup(group.key)}
              role="checkbox"
              aria-checked={isSelected}
              tabindex="0"
              on:keydown={e => e.key === ' ' && toggleGroup(group.key)}
            >{isSelected ? '☑' : '☐'}</div>

            <span class="sim-badge">{group.similarity}</span>
            <span class="img-count">{group.images.length} {$t('dup_copies')}</span>

            <div class="group-actions">
              <!-- Per-group resolve dropdown -->
              <div class="resolve-menu">
                {#if isResolving}
                  <span class="resolving-text">{$t('dup_resolving')}</span>
                {:else if isResolved === 'ok'}
                  <span class="resolved-ok">{$t('dup_resolved')}</span>
                {:else if canResolve}
                  <button class="btn-sm primary"
                    on:click={() => resolveGroup(group, batchAction)}>
                    {$t('dup_resolve')}
                  </button>
                  <select bind:value={batchAction} class="action-sel">
                    <option value="delete_file">{$t('dup_delete_from_disk')}</option>
                    <option value="db_only">{$t('dup_remove_db_only')}</option>
                    <option value="symlink">{$t('dup_replace_symlink')}</option>
                  </select>
                {:else}
                  <span class="role-guard-hint">{$t('dup_view_only')}</span>
                {/if}
              </div>
            </div>
          </div>

          <!-- Image rows -->
          <div class="img-rows">
            {#each group.images as img (img.id)}
              {@const isKept = keepMap[group.key] === img.id}
              <div class="img-row" class:kept={isKept}>
                <img
                  src={thumbnailUrl(img.id, 80)}
                  alt={img.filename}
                  loading="lazy"
                  class="thumb"
                />
                <div class="img-meta">
                  <div class="img-name" title={img.filename}>{img.filename}</div>
                  <div class="img-path" title={img.server_path ?? img.filepath}>{folderOf(img.server_path ?? img.filepath)}</div>
                  {#if img.origin_path && img.origin_path !== (img.server_path ?? img.filepath)}
                    <div class="img-origin" title={img.origin_path}>{$t('origin_label')} {img.origin_path}</div>
                  {/if}
                  <div class="img-stats">
                    {fmtBytes(img.file_size)}
                    {#if img.face_count} · {img.face_count} face{img.face_count === 1 ? '' : 's'}{/if}
                    {#if img.width && img.height} · {img.width}×{img.height}{/if}
                    · {fmtDate(img.created_at)}
                  </div>
                </div>
                <div class="keep-col">
                  <label class="keep-radio" title={$t('dup_keep')}>
                    <input
                      type="radio"
                      name="keep-{group.key}"
                      value={img.id}
                      bind:group={keepMap[group.key]}
                    />
                    {$t('dup_keep')}
                  </label>
                  {#if isKept}
                    <span class="kept-chip">{$t('dup_keep_chip')}</span>
                  {:else}
                    <span class="del-chip">{$t('dup_del_chip')}</span>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/each}
    {/if}
  </div>

  <!-- ── Local cleanup panel ── -->
  {#if pendingCleanupFiles.length > 0}
    <div class="cleanup-panel">
      <div class="cleanup-header">
        <span class="cleanup-title">{$t('cleanup_source_files')}</span>
        <span class="cleanup-count">
          {pendingCleanupFiles.length} {pendingCleanupFiles.length === 1 ? $t('fs_file_label') : $t('fs_file_label') + 's'}
        </span>
        <button class="btn-sm" on:click={() => { pendingCleanupFiles = []; cleanupResult = null; }}>
          {$t('dismiss')}
        </button>
      </div>
      <div class="cleanup-hint">{$t('cleanup_originals_hint')}</div>

      <!-- Action selector (applies to script download) -->
      <div class="cleanup-row">
        <label class="cleanup-label">{$t('cleanup_action')}</label>
        <select bind:value={cleanupAction} class="fmt-sel">
          <option value="trash">{$t('cleanup_trash_opt')}</option>
          <option value="delete">{$t('cleanup_delete_opt')}</option>
          <option value="symlink">{$t('cleanup_symlink_opt')}</option>
        </select>
      </div>

      <!-- Path 1 — Shell script (always available) -->
      <div class="cleanup-row">
        <select bind:value={cleanupFormat} class="fmt-sel">
          <option value="bash">Bash (.sh) — macOS / Linux</option>
          <option value="powershell">PowerShell (.ps1) — Windows</option>
          <option value="json">JSON — custom / Electron import</option>
        </select>
        <button class="btn-sm primary" disabled={cleanupBusy} on:click={() => doScriptDownload(cleanupFormat, cleanupAction)}>
          {$t('download_script')}
        </button>
        <span class="cleanup-hint-sm">{$t('review_before_run')}</span>
      </div>

      <!-- Path 2 — File System Access API (browser, local server only) -->
      {#if typeof window !== 'undefined' && 'showDirectoryPicker' in window && !isRemote}
        <div class="cleanup-row">
          <button class="btn-sm" disabled={cleanupBusy} on:click={doBrowserDelete}>
            {$t('delete_via_browser')}
          </button>
          <span class="cleanup-hint-sm">{$t('browser_local_only')}</span>
        </div>
      {/if}

      <!-- Path 3a — Electron local: direct IPC trash -->
      {#if isElectron && !isRemote}
        <div class="cleanup-row">
          <button class="btn-sm primary" disabled={cleanupBusy} on:click={doElectronTrash}>
            {$t('move_to_trash')}
          </button>
          <span class="cleanup-hint-sm">{$t('sends_to_os_trash')}</span>
        </div>
      {/if}

      <!-- Path 3b — Electron remote: JSON download for local Electron to import -->
      {#if isElectron && isRemote}
        <div class="cleanup-row">
          <button class="btn-sm" disabled={cleanupBusy} on:click={() => doScriptDownload('json')}>
            {$t('download_json_list')}
          </button>
          <span class="cleanup-hint-sm">{$t('import_to_local')}</span>
        </div>
      {/if}

      <!-- Result -->
      {#if cleanupResult}
        <div class="cleanup-result" class:has-errors={cleanupResult.errors?.length > 0}>
          {$t('move_to_trash')}: {cleanupResult.trashed}.
          {#if cleanupResult.errors?.length > 0}
            <span class="cleanup-err-count">{cleanupResult.errors.length} {$t('errors_label')}:</span>
            {#each cleanupResult.errors as err}
              <div class="cleanup-err-item">{err.path}: {err.error}</div>
            {/each}
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  <!-- ── Import cleanup JSON (Electron only) ── -->
  {#if isElectron}
    <div class="import-json-bar">
      <button class="btn-sm" disabled={importBusy} on:click={doImportJson}>
        {importBusy ? '…' : '📥 ' + $t('import_cleanup_json')}
      </button>
      <span class="cleanup-hint-sm">{$t('execute_downloaded_json')}</span>
      {#if importResult}
        <span class:import-ok={importResult.errors.length === 0} class:import-err={importResult.errors.length > 0}>
          {importResult.trashed}/{importResult.total} trashed
          {#if importResult.errors.length > 0}
            · {importResult.errors.length} failed:
            {importResult.errors.map(e => `${e.path}: ${e.error}`).join(', ')}
          {/if}
        </span>
        <button class="btn-sm" on:click={() => importResult = null}>✕</button>
      {/if}
    </div>
  {/if}

  <!-- ── Stats footer ── -->
  {#if stats}
    <div class="footer">
      <span>{$t('by_name_size')} <b>{stats.name_size_groups}</b> {$t('dup_groups')}</span>
      <span>{$t('by_hash')} <b>{stats.hash_groups}</b> {$t('dup_groups')}</span>
      {#if stats.phash_available}
        <span>{$t('stat_visual')} <b>{stats.visual_groups}</b> {$t('dup_groups')}</span>
      {:else}
        <span class="hint">{$t('dup_method_visual')}: <code>pip install imagehash</code></span>
      {/if}
      <span>{$t('wasted')} <b>{fmtBytes(stats.wasted_bytes)}</b></span>
    </div>
  {/if}
</div>

<style>
  .dup-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  /* ── Header ── */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 14px;
    border-bottom: 1px solid #2a2a3a;
    flex-shrink: 0;
    gap: 12px;
    flex-wrap: wrap;
  }
  .header-left { display: flex; align-items: baseline; gap: 10px; }
  .title { font-size: 14px; font-weight: 600; color: #d0d0f0; }
  .sub  { font-size: 11px; color: #606080; }
  .controls { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
  .ctrl-label { font-size: 10px; color: #606080; }
  .ctrl-val  { font-size: 11px; color: #8090b0; min-width: 18px; }

  /* ── Scan bar ── */
  .scan-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 14px;
    background: #141422;
    border-bottom: 1px solid #2a2a3a;
    font-size: 11px;
    color: #8090b0;
    flex-shrink: 0;
  }
  .scan-bar.warn { color: #e08040; background: #2a1a10; }
  .scan-bar code { background: #2a2a40; padding: 1px 5px; border-radius: 3px; color: #c0c0f0; }
  .scan-prog { display: flex; align-items: center; gap: 8px; flex: 1; }
  .prog-wrap { width: 100px; height: 5px; background: #2a2a42; border-radius: 3px; overflow: hidden; }
  .prog-fill { height: 100%; background: #4a6fa5; transition: width 0.2s; }
  .scan-hint { color: #d08040; }
  .scan-ok  { color: #50c878; }

  /* ── Batch bar ── */
  .batch-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: #1a1a32;
    border-bottom: 1px solid #3a3a60;
    flex-shrink: 0;
    flex-wrap: wrap;
  }
  .batch-label { font-size: 12px; color: #a0a0d0; flex: 1; }
  .toggle-label { display: flex; align-items: center; gap: 4px; font-size: 11px; color: #8090b0; cursor: pointer; }

  /* ── Group list ── */
  .list {
    flex: 1;
    overflow-y: auto;
    padding: 8px 10px;
  }
  .sel-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 2px 8px;
  }
  .sel-count { font-size: 11px; color: #505070; margin-left: 4px; }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 280px;
    color: #505070;
    gap: 8px;
  }
  .empty-icon { font-size: 38px; margin-bottom: 4px; }
  .empty-sub { font-size: 11px; color: #404060; }

  /* ── Group card ── */
  .group-card {
    background: #1a1a28;
    border: 1px solid #242438;
    border-radius: 7px;
    margin-bottom: 8px;
    overflow: hidden;
  }
  .group-card.selected { border-color: #4a6fa5; }

  .group-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: #14142a;
    border-bottom: 1px solid #1e1e36;
  }
  .g-cb { font-size: 14px; color: #606080; cursor: pointer; flex-shrink: 0; }
  .group-card.selected .g-cb { color: #5080c0; }
  .sim-badge {
    font-size: 10px;
    background: #2a2a50;
    color: #8090d0;
    padding: 1px 6px;
    border-radius: 8px;
  }
  .img-count { font-size: 10px; color: #505070; flex: 1; }
  .group-actions { display: flex; align-items: center; gap: 5px; }
  .resolve-menu { display: flex; align-items: center; gap: 5px; }
  .action-sel { font-size: 11px; padding: 2px 5px; }
  .resolving-text { font-size: 11px; color: #8090b0; }
  .resolved-ok { font-size: 11px; color: #50c878; }

  /* ── Image rows ── */
  .img-rows { padding: 4px 0; }
  .img-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    border-bottom: 1px solid #1e1e30;
    transition: background 0.1s;
  }
  .img-row:last-child { border-bottom: none; }
  .img-row.kept { background: #1a2a1a; }
  .img-row:not(.kept) { opacity: 0.75; }

  .thumb {
    width: 64px;
    height: 64px;
    object-fit: cover;
    border-radius: 4px;
    flex-shrink: 0;
    background: #0e0e18;
    display: block;
  }
  .img-meta { flex: 1; min-width: 0; }
  .img-name { font-size: 11px; color: #c0c0e0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .img-path { font-size: 9px; color: #505070; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
  .img-origin { font-size: 9px; color: #40607a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; font-style: italic; }
  .img-stats { font-size: 9px; color: #404060; margin-top: 2px; }

  .keep-col { display: flex; flex-direction: column; align-items: center; gap: 4px; flex-shrink: 0; min-width: 58px; }
  .keep-radio { display: flex; align-items: center; gap: 4px; font-size: 10px; color: #606080; cursor: pointer; }
  .kept-chip {
    font-size: 9px; padding: 2px 6px; border-radius: 8px;
    background: #1a3a20; color: #50c878;
  }
  .del-chip {
    font-size: 9px; padding: 2px 6px; border-radius: 8px;
    background: #2a1a1a; color: #805060;
  }

  /* ── Footer ── */
  .footer {
    display: flex;
    gap: 20px;
    padding: 6px 14px;
    border-top: 1px solid #2a2a3a;
    font-size: 10px;
    color: #505070;
    flex-shrink: 0;
    flex-wrap: wrap;
  }
  .footer b { color: #8090b0; }
  .hint { color: #404060; }
  .hint code { background: #2a2a40; padding: 1px 4px; border-radius: 3px; }

  .btn-sm { font-size: 11px; padding: 3px 10px; }

  /* ── Cleanup panel ── */
  .cleanup-panel {
    border-top: 1px solid #2a2a3a;
    background: #0f0f1c;
    padding: 8px 14px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .cleanup-header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .cleanup-title { font-size: 12px; font-weight: 600; color: #c0a840; }
  .cleanup-count { font-size: 11px; color: #806840; flex: 1; }
  .cleanup-hint { font-size: 10px; color: #505068; }
  .cleanup-hint-sm { font-size: 9px; color: #404058; }
  .cleanup-label { font-size: 10px; color: #706880; white-space: nowrap; }
  .cleanup-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .fmt-sel { font-size: 11px; padding: 2px 5px; background: #1e1e30; color: #a0a0c0; border: 1px solid #3a3a5a; border-radius: 4px; }
  .cleanup-result { font-size: 11px; color: #50c878; padding: 3px 0; }
  .cleanup-result.has-errors { color: #e05050; }
  .cleanup-err-count { font-size: 10px; margin-left: 6px; }
  .cleanup-err-item { font-size: 10px; color: #c04040; margin-left: 10px; }

  /* ── Role guard ── */
  .role-guard-hint { font-size: 10px; color: #504858; font-style: italic; }

  /* ── Import JSON bar ── */
  .import-json-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: #0f0f1c;
    border-top: 1px solid #1e1e30;
    flex-wrap: wrap;
  }
  .import-ok { font-size: 10px; color: #50a050; }
  .import-err { font-size: 10px; color: #e05050; }
</style>
