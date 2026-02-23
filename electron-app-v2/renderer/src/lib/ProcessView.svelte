<script>
  import { streamBatchFiles, streamBatch, scanFolder, thumbnailUrl, fetchStats, fetchPeople, fetchTags, importProcessed, uploadLocal } from '../api.js';
  import { t, stats, allPeople, allTags, processingMode, localModel, galleryRefreshTick } from '../stores.js';
  import { onMount } from 'svelte';
  import ServerDirPicker from './ServerDirPicker.svelte';

  let serverPickerOpen = false;
  const inElectron = typeof window !== 'undefined' && !!window.electronAPI;

  const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.pgm']);
  function isImage(name) { return IMAGE_EXTS.has(name.slice(name.lastIndexOf('.')).toLowerCase()); }

  // ── Queue ──────────────────────────────────────────────────────────────────
  // Each item: { id, path, name, file, status: 'pending'|'processing'|'done'|'error',
  //              imageId, faces, people, sceneType, description, error }
  // `file` is a browser File object (browser mode) or null (Electron mode)
  let queue = [];
  let nextId = 0;

  function addPaths(paths) {
    const toAdd = paths.filter(p => isImage(p) && !queue.find(q => q.path === p));
    queue = [
      ...queue,
      ...toAdd.map(p => ({
        id: nextId++,
        path: p,
        name: p.split('/').pop(),
        file: null,
        status: 'pending',
        imageId: null, faces: 0, people: [], sceneType: '', description: '', error: '',
      })),
    ];
  }

  function addFiles(fileList) {
    const files = [...fileList].filter(f => isImage(f.name) && !queue.find(q => q.path === f.name));
    queue = [
      ...queue,
      ...files.map(f => ({
        id: nextId++,
        path: f.name,
        name: f.name,
        file: f,
        status: 'pending',
        imageId: null, faces: 0, people: [], sceneType: '', description: '', error: '',
      })),
    ];
  }

  function removeItem(id) {
    if (running) return;
    queue = queue.filter(q => q.id !== id);
  }

  function clearDone() {
    queue = queue.filter(q => q.status === 'pending' || q.status === 'processing');
  }

  function clearAll() {
    if (running) return;
    queue = [];
  }

  // ── Drop zone ─────────────────────────────────────────────────────────────
  let dragOver = false;

  function onDragOver(e) { e.preventDefault(); dragOver = true; }
  function onDragLeave()  { dragOver = false; }

  function onDrop(e) {
    e.preventDefault();
    dragOver = false;
    const files = [...(e.dataTransfer.files || [])];
    if (inElectron) {
      addPaths(files.map(f => f.path).filter(Boolean));
    } else {
      addFiles(files);
    }
  }

  async function pickFiles() {
    if (inElectron) {
      const paths = await window.electronAPI.openFileDialog({ multiple: true });
      if (paths?.length) addPaths(paths);
    } else {
      document.getElementById('pv-file-input').click();
    }
  }

  async function pickFolder() {
    if (inElectron) {
      const folder = await window.electronAPI.openFolderDialog();
      if (folder) addFolderPaths(folder);
    } else {
      document.getElementById('pv-folder-input').click();
    }
  }

  async function addFolderPaths(folder) {
    try {
      const data = await scanFolder(folder, batchRecursive);
      if (data.paths?.length) addPaths(data.paths);
    } catch {
      // Fallback: legacy folder-batch mode
      batchFolder = folder;
    }
  }

  // ── Batch folder mode (mode A — server-side path) ─────────────────────────
  let batchFolder = '';
  let batchRecursive = true;

  // ── Electron / python path ─────────────────────────────────────────────────
  let pythonPath = '';
  onMount(async () => {
    if (typeof window.electronAPI !== 'undefined') {
      try {
        const s = await window.electronAPI.getSettings();
        if (s) pythonPath = s.pythonPath || '';
      } catch { /* ignore */ }
    }
  });

  // ── Processing state ───────────────────────────────────────────────────────
  let running = false;
  let batchSource = null;
  let totalCount = 0;
  let doneCount = 0;
  let errorCount = 0;
  let finished = false;
  let cancelled = false;
  let visibility = 'shared'; // 'shared' | 'private'

  $: pendingItems    = queue.filter(q => q.status === 'pending');
  $: processingItem  = queue.find(q => q.status === 'processing');
  $: doneItems       = queue.filter(q => q.status === 'done' || q.status === 'error');
  $: progressPct     = totalCount > 0 ? Math.round(doneCount / totalCount * 100) : 0;

  function startProcessing() {
    if ($processingMode === 'local_process') { startLocalProcess(); return; }
    startUploadFull();
  }

  // ── Mode B: upload_full — Electron reads file, VPS processes ──────────────
  async function startUploadFull() {
    const pending = queue.filter(q => q.status === 'pending');
    if (!pending.length) return;
    running = true; finished = false; cancelled = false;
    errorCount = 0; doneCount = 0; totalCount = pending.length;

    for (const item of pending) {
      if (cancelled) break;
      queue = queue.map(q => q.id === item.id ? { ...q, status: 'processing' } : q);
      try {
        const buffer = item.file
          ? await item.file.arrayBuffer()
          : await window.electronAPI.readLocalFile(item.path);
        const pathForServer = item.file ? item.file.name : item.path;
        const resp   = await uploadLocal(buffer, pathForServer, visibility);
        queue = queue.map(q => q.id === item.id
          ? { ...q, status: 'done', imageId: resp.image_id, faces: resp.face_count ?? 0 }
          : q);
      } catch (e) {
        errorCount++;
        queue = queue.map(q => q.id === item.id ? { ...q, status: 'error', error: e.message } : q);
      }
      doneCount++;
    }
    running = false; finished = true;
    refreshGlobalData();
  }

  // ── Mode C: local_process — Electron runs InsightFace, uploads embeddings ──
  async function startLocalProcess() {
    const pending = queue.filter(q => q.status === 'pending');
    if (!pending.length) return;
    running = true; finished = false; cancelled = false;
    errorCount = 0; doneCount = 0; totalCount = pending.length;

    // Mark first pending as processing
    let markedFirst = false;
    queue = queue.map(q => {
      if (q.status === 'pending' && !markedFirst) { markedFirst = true; return { ...q, status: 'processing' }; }
      return q;
    });

    let resultIdx = 0;
    const removeListener = window.electronAPI.onLocalProcessResult(async (result) => {
      if (result.error) {
        errorCount++;
        queue = queue.map(q => q.path === result.path ? { ...q, status: 'error', error: result.error } : q);
      } else {
        try {
          const resp = await importProcessed({ ...result, local_model: $localModel });
          queue = queue.map(q => q.path === result.path ? {
            ...q, status: 'done',
            imageId: resp.image_id,
            faces:   resp.face_count ?? 0,
            people:  resp.people ?? [],
          } : q);
        } catch (e) {
          errorCount++;
          queue = queue.map(q => q.path === result.path ? { ...q, status: 'error', error: e.message } : q);
        }
      }
      doneCount = ++resultIdx;
      // Mark next pending as processing
      let found = false;
      queue = queue.map(q => {
        if (!found && q.status === 'pending') { found = true; return { ...q, status: 'processing' }; }
        return q;
      });
    });

    try {
      await window.electronAPI.processImagesLocally(
        pending.map(q => q.path),
        $localModel,
        pythonPath || null,
      );
    } finally {
      removeListener();
    }
    running = false; finished = true;
    refreshGlobalData();
  }

  function onBatchEvent(data) {
    if (data.started) {
      // server confirmed total
      totalCount = data.total ?? totalCount;
      return;
    }
    if (data.done) {
      running  = false;
      finished = true;
      batchSource = null;
      // Mark any remaining processing item as done (edge case)
      queue = queue.map(q => q.status === 'processing' ? { ...q, status: 'done' } : q);
      refreshGlobalData();
      return;
    }
    // Per-file event
    const path = data.path;
    doneCount = data.index ?? doneCount + 1;

    queue = queue.map(q => {
      if (q.path !== path) return q;
      if (data.error) {
        errorCount++;
        return { ...q, status: 'error', error: data.error };
      }
      const r = data.result || {};
      return {
        ...q,
        status: 'done',
        imageId: data.image_id ?? null,
        faces: r.faces_detected ?? 0,
        people: r.people ?? [],
        sceneType: r.scene_type ?? '',
        description: r.vlm?.description ?? '',
      };
    });

    // Mark the *next* pending item as processing (visual indication)
    let foundProcessing = false;
    queue = queue.map(q => {
      if (q.status === 'processing') return q;
      if (!foundProcessing && q.status === 'pending') {
        foundProcessing = true;
        return { ...q, status: 'processing' };
      }
      return q;
    });
  }

  function cancelProcessing() {
    batchSource?.close();
    batchSource = null;
    running   = false;
    cancelled = true;
    queue = queue.map(q => q.status === 'processing' ? { ...q, status: 'pending' } : q);
  }

  // Folder-mode start (legacy drop-target for folder path)
  function startFolderBatch() {
    if (!batchFolder.trim() || running) return;
    running   = true;
    finished  = false;
    cancelled = false;
    errorCount = 0;
    doneCount  = 0;
    totalCount = 0;
    queue = [];   // folder mode resets queue

    batchSource = streamBatch(batchFolder.trim(), batchRecursive, ev => {
      if (ev.started) { totalCount = ev.total ?? 0; return; }
      if (ev.done)    { running = false; finished = true; batchSource = null; refreshGlobalData(); return; }
      if (ev.path) {
        doneCount = ev.index ?? doneCount + 1;
        const r = ev.result || {};
        const item = {
          id: nextId++,
          path: ev.path,
          name: ev.path.split('/').pop(),
          status: ev.error ? 'error' : 'done',
          imageId: ev.image_id ?? null,
          faces: r.faces_detected ?? 0,
          people: r.people ?? [],
          sceneType: r.scene_type ?? '',
          description: r.vlm?.description ?? '',
          error: ev.error ?? '',
        };
        if (ev.error) errorCount++;
        queue = [...queue.slice(-199), item];
      }
    });
  }

  async function refreshGlobalData() {
    try { stats.set(await fetchStats()); } catch {}
    try { allPeople.set(await fetchPeople()); } catch {}
    try { allTags.set(await fetchTags()); } catch {}
    galleryRefreshTick.update(n => n + 1);
  }


</script>

<ServerDirPicker bind:open={serverPickerOpen} title="Select server folder to process"
  on:select={e => batchFolder = e.detail} />

<div class="process-view">
  <div class="view-header">
    <h2>
      {$t('tab_batch')}
      {#if $processingMode === 'local_process'}
        <span class="mode-badge local">⚡ Local process</span>
      {:else}
        <span class="mode-badge upload">⬆ Upload full</span>
      {/if}
    </h2>
    {#if queue.length > 0 && !running}
      <div class="header-actions">
        <button class="btn-sm" on:click={clearDone} disabled={doneItems.length === 0}>
          Clear done ({doneItems.length})
        </button>
        <button class="btn-sm danger" on:click={clearAll}>Clear all</button>
      </div>
    {/if}
  </div>

  <!-- Hidden file inputs for browser/PWA mode -->
  {#if !inElectron}
    <input type="file" id="pv-file-input" multiple accept="image/*" style="display:none"
           on:change={e => { addFiles(e.target.files); e.target.value = ''; }} />
    <input type="file" id="pv-folder-input" webkitdirectory accept="image/*" style="display:none"
           on:change={e => { addFiles(e.target.files); e.target.value = ''; }} />
  {/if}

  <!-- Drop zone: local files (always visible) -->
  <div
    class="drop-zone"
    class:drag-over={dragOver}
    on:dragover={onDragOver}
    on:dragleave={onDragLeave}
    on:drop={onDrop}
    role="region"
    aria-label="Drop images here"
  >
    <div class="drop-icon">📂</div>
    <div class="drop-label">
      {dragOver ? 'Drop to add to queue' : 'Drop images or folders here'}
    </div>
    <div class="drop-sub">Multiple files supported · JPEG, PNG, WebP, …</div>
    <div class="drop-buttons">
      <button on:click={pickFiles}>💻 Select files…</button>
      <button on:click={pickFolder}>💻 Select folder…</button>
    </div>
  </div>

  <!-- Queue controls for local files -->
  {#if queue.length > 0}
    <div class="controls-bar">
      <span class="queue-count">
        {#if finished}✓ Done —{/if}
        {queue.length} item{queue.length !== 1 ? 's' : ''}
        ({pendingItems.length} pending)
      </span>
      {#if !running}
        <select bind:value={visibility} class="vis-select" title="Visibility">
          <option value="shared">Shared</option>
          <option value="private">Private</option>
        </select>
        <button
          class="primary"
          on:click={startProcessing}
          disabled={pendingItems.length === 0}
        >
          ▶ Process {pendingItems.length} image{pendingItems.length !== 1 ? 's' : ''}
        </button>
      {:else}
        <button class="danger" on:click={cancelProcessing}>{$t('stop_processing')}</button>
      {/if}
    </div>
  {/if}

  <!-- Server folder section: always visible alongside drop zone -->
  <div class="server-path-input">
    <span class="server-path-label">📡 Or process a server-side folder directly</span>
    <div class="server-path-row">
      <input type="text" bind:value={batchFolder} placeholder="/data/photos  (path on the VPS)" class="flex1" />
      <button on:click={() => serverPickerOpen = true} title="Browse server filesystem">Browse…</button>
    </div>
    <div class="server-folder-row2">
      <label class="checkbox-row">
        <input type="checkbox" bind:checked={batchRecursive} /> Subfolders
      </label>
      {#if batchFolder.trim() && !running}
        <button class="primary" on:click={startFolderBatch}>{$t('process_folder')}</button>
      {:else if running}
        <button class="danger" on:click={cancelProcessing}>{$t('stop_processing')}</button>
      {/if}
    </div>
  </div>

  <!-- Progress bar -->
  {#if running || finished || cancelled}
    <div class="progress-section">
      <div class="progress-bar-wrap">
        <div class="progress-bar" style="width:{progressPct}%"></div>
      </div>
      <div class="progress-label">
        {doneCount} / {totalCount}
        {#if errorCount > 0}<span class="err-count"> · {errorCount} {$t('failed')}</span>{/if}
        {#if finished} · {$t('batch_complete')} ✓{/if}
        {#if cancelled} · {$t('operation_cancelled')}{/if}
        <span class="pct">{progressPct}%</span>
      </div>
    </div>
  {/if}

  <!-- Results list -->
  {#if queue.length > 0}
    <div class="results-list">
      {#each queue as item (item.id)}
        <div class="result-row" class:is-error={item.status === 'error'} class:is-done={item.status === 'done'}>
          <!-- Thumbnail or status icon -->
          <div class="thumb-cell">
            {#if item.status === 'done' && item.imageId}
              <img src={thumbnailUrl(item.imageId, 80)} alt="" loading="lazy" />
            {:else if item.status === 'processing'}
              <div class="thumb-placeholder spin">⏳</div>
            {:else if item.status === 'error'}
              <div class="thumb-placeholder err">✗</div>
            {:else}
              <div class="thumb-placeholder">🖼</div>
            {/if}
          </div>

          <!-- Info: 2 lines max -->
          <div class="info-cell">
            <div class="line1">
              <span class="item-name" title={item.path}>{item.name}</span>
              {#if item.status === 'pending'}<span class="badge pending">pending</span>{/if}
              {#if item.status === 'processing'}<span class="badge processing">processing…</span>{/if}
              {#if item.status === 'done'}
                <span class="badge done">✓</span>
                {#if item.faces > 0}
                  <span class="badge faces">{item.faces} face{item.faces !== 1 ? 's' : ''}</span>
                {/if}
                {#if item.people?.length > 0}
                  <span class="badge people">{item.people.join(', ')}</span>
                {/if}
              {/if}
              {#if item.status === 'error'}<span class="badge error">error</span>{/if}
            </div>
            <div class="line2">
              {#if item.status === 'done' && item.description}
                <span class="desc">{item.description.slice(0, 120)}{item.description.length > 120 ? '…' : ''}</span>
              {:else if item.status === 'done' && item.sceneType}
                <span class="desc muted">{item.sceneType}</span>
              {:else if item.status === 'error'}
                <span class="desc err">{item.error}</span>
              {:else if item.status === 'pending' || item.status === 'processing'}
                <span class="desc muted">{item.path}</span>
              {/if}
            </div>
          </div>

          <!-- Remove button (only when not running) -->
          {#if !running}
            <button class="remove-btn" title="Remove" on:click={() => removeItem(item.id)}>✕</button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .process-view {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .view-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
  }
  h2 { font-size: 1rem; color: #c0c8e0; margin: 0; display: flex; align-items: center; gap: 8px; }
  .header-actions { display: flex; gap: 6px; }
  .mode-badge { font-size: 10px; padding: 2px 7px; border-radius: 4px; font-weight: 500; }
.mode-badge.upload { background: #2a2010; color: #c09040; }
  .mode-badge.local  { background: #1a2a1a; color: #60c060; }
  .server-path-input {
    display: flex; flex-direction: column; gap: 8px;
    background: #141422; border: 1px solid #2a2a3a; border-radius: 8px;
    padding: 10px 14px; flex-shrink: 0;
  }
  .server-path-label { font-size: 12px; color: #6080a0; white-space: nowrap; }
  .server-path-row { display: flex; gap: 6px; align-items: center; }
  .server-path-row .flex1 { flex: 1; }
  .server-path-input input { flex: 1; }
  .server-folder-row2 { display: flex; gap: 10px; align-items: center; }

  /* ── Drop zone ── */
  .drop-zone {
    border: 2px dashed #3a3a5a;
    border-radius: 8px;
    padding: 24px 16px;
    text-align: center;
    transition: border-color 0.15s, background 0.15s;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }
  .drop-zone.drag-over { border-color: #6080c0; background: #1a2040; }
  .drop-icon { font-size: 28px; line-height: 1; }
  .drop-label { font-size: 13px; color: #8090b0; font-weight: 500; }
  .drop-sub   { font-size: 11px; color: #505070; }
  .drop-buttons { display: flex; gap: 8px; margin-top: 4px; }

  .vis-select { font-size: 11px; padding: 3px 6px; width: 90px; }

  /* ── Controls bar ── */
  .controls-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    background: #1a1a28;
    border: 1px solid #2a2a3a;
    border-radius: 6px;
    flex-shrink: 0;
  }
  .queue-count { font-size: 12px; color: #8090a8; flex: 1; }
.checkbox-row { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #8090a8; cursor: pointer; }

  /* ── Progress ── */
  .progress-section {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex-shrink: 0;
  }
  .progress-bar-wrap {
    height: 6px;
    background: #2a2a42;
    border-radius: 3px;
    overflow: hidden;
  }
  .progress-bar {
    height: 100%;
    background: #5080c0;
    border-radius: 3px;
    transition: width 0.25s;
  }
  .progress-label {
    font-size: 11px;
    color: #6080a0;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .progress-label .pct { margin-left: auto; color: #5070a0; }
  .err-count { color: #d07070; }

  /* ── Results list ── */
  .results-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }

  .result-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 8px;
    background: #181826;
    border: 1px solid #222234;
    border-radius: 4px;
    min-height: 52px;
    transition: background 0.1s;
  }
  .result-row:hover { background: #1e1e30; }
  .result-row.is-done  { border-left: 2px solid #3a6a3a; }
  .result-row.is-error { border-left: 2px solid #6a3a3a; }

  /* Thumbnail cell */
  .thumb-cell {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: 3px;
    overflow: hidden;
    background: #0e0e1a;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .thumb-cell img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .thumb-placeholder {
    font-size: 18px;
    color: #404060;
  }
  .thumb-placeholder.spin { animation: pulse 0.8s infinite alternate; }
  .thumb-placeholder.err  { color: #904040; }
  @keyframes pulse { from { opacity: 0.4; } to { opacity: 1; } }

  /* Info cell */
  .info-cell {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .line1 {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-wrap: wrap;
  }
  .line2 { min-height: 14px; }

  .item-name {
    font-size: 12px;
    color: #b0b8d0;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 240px;
  }

  .badge {
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 6px;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .badge.pending    { background: #252540; color: #606080; }
  .badge.processing { background: #1e2e50; color: #6090d0; }
  .badge.done       { background: #1a3a1a; color: #50b050; }
  .badge.error      { background: #3a1a1a; color: #c05050; }
  .badge.faces      { background: #1e2a40; color: #6090c0; }
  .badge.people     { background: #2a1e3a; color: #9070c0; }

  .desc {
    font-size: 10px;
    color: #606880;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: block;
    max-width: 100%;
  }
  .desc.muted { color: #404055; }
  .desc.err   { color: #904040; }

  /* Remove button */
  .remove-btn {
    background: transparent;
    border: none;
    color: #404060;
    font-size: 11px;
    padding: 2px 5px;
    cursor: pointer;
    flex-shrink: 0;
    border-radius: 3px;
  }
  .remove-btn:hover { color: #c05050; background: #2a1a1a; }

  /* Shared button styles */
  button { padding: 5px 12px; font-size: 12px; }
  .btn-sm { font-size: 11px; padding: 3px 8px; }
  .btn-sm.danger { color: #e07070; border-color: #5a2828; }
  .primary { background: #2a4a8a; border-color: #3a6aba; color: #c0d8ff; }
  .primary:disabled { opacity: 0.4; cursor: not-allowed; }
  .danger  { background: #3a1818; border-color: #6a2828; color: #e07070; }
</style>
