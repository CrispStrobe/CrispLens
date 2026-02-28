<script>
  import { streamBatchFiles, streamBatch, scanFolder, thumbnailUrl, fetchStats, fetchPeople, fetchTags, fetchAlbums, importProcessed, uploadLocal, createBatchJob, uploadBatchFile, addFileToBatchJob } from '../api.js';
  import { t, stats, allPeople, allTags, allAlbums, processingMode, localModel, galleryRefreshTick, sidebarView } from '../stores.js';
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
    // Use f.path when available (Electron).
    // Use webkitRelativePath when available (browser picking folder).
    // Fall back to f.name (browser mode picking files).
    const files = [...fileList].filter(f => isImage(f.name));
    const newFiles = files.filter(f => {
      const path = f.path || f.webkitRelativePath || f.name;
      return !queue.find(q => q.path === path);
    });
    queue = [
      ...queue,
      ...newFiles.map(f => ({
        id: nextId++,
        path: f.path || f.webkitRelativePath || f.name,
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
      const paths = files.map(f => f.path).filter(Boolean);
      if (paths.length) {
        // contextIsolation: false or Electron version that exposes f.path on drop
        addPaths(paths);
      } else {
        // contextIsolation: true — f.path not injected on drag-and-drop events.
        // addFiles() will pick up f.path from <input>-style File objects if available.
        addFiles(files);
      }
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

  // ── Tag + Album pickers ────────────────────────────────────────────────────
  // selectedTags: Array<{id: number|null, name: string}>
  //   id=null means "create new tag"; id=<number> means existing tag
  let selectedTags = [];
  let tagInput = '';
  let tagDropdownOpen = false;

  // selectedAlbum: {id: number|null, name: string} | null
  let selectedAlbum = null;
  let albumInput = '';
  let albumDropdownOpen = false;

  $: filteredTags = $allTags.filter(tag =>
    tagInput.trim() &&
    tag.name.toLowerCase().includes(tagInput.trim().toLowerCase()) &&
    !selectedTags.find(s => s.id === tag.id)
  );

  $: filteredAlbums = $allAlbums.filter(a =>
    albumInput.trim() &&
    a.name.toLowerCase().includes(albumInput.trim().toLowerCase())
  );

  function addTag(tag) {
    if (!selectedTags.find(s => s.id === tag.id)) {
      selectedTags = [...selectedTags, { id: tag.id, name: tag.name }];
    }
    tagInput = '';
    tagDropdownOpen = false;
  }

  function addNewTag() {
    const name = tagInput.trim();
    if (!name) return;
    if (!selectedTags.find(s => s.name.toLowerCase() === name.toLowerCase())) {
      selectedTags = [...selectedTags, { id: null, name }];
    }
    tagInput = '';
    tagDropdownOpen = false;
  }

  function removeTag(name) {
    selectedTags = selectedTags.filter(s => s.name !== name);
  }

  function selectAlbum(album) {
    selectedAlbum = { id: album.id, name: album.name };
    albumInput = '';
    albumDropdownOpen = false;
  }

  function setNewAlbum() {
    const name = albumInput.trim();
    if (!name) return;
    selectedAlbum = { id: null, name };
    albumInput = '';
    albumDropdownOpen = false;
  }

  function clearAlbum() {
    selectedAlbum = null;
    albumInput = '';
  }

  $: existingTagIds  = selectedTags.filter(s => s.id !== null).map(s => s.id);
  $: newTagNames     = selectedTags.filter(s => s.id === null).map(s => s.name);

  // ── Batch folder mode (mode A — server-side path) ─────────────────────────
  // Persisted to localStorage so it survives page refreshes.
  let batchFolder = '';
  let batchRecursive = true;
  let batchFollowSymlinks = false;
  let batchJobCreating = false;
  let batchJobError = '';

  // Persist batchFolder to localStorage on change
  $: if (typeof localStorage !== 'undefined') {
    localStorage.setItem('processView.batchFolder', batchFolder);
  }

  // ── Electron / python path ─────────────────────────────────────────────────
  let pythonPath = '';
  onMount(async () => {
    // Restore last batch folder
    const saved = typeof localStorage !== 'undefined' && localStorage.getItem('processView.batchFolder');
    if (saved) batchFolder = saved;

    if (typeof window.electronAPI !== 'undefined') {
      try {
        const s = await window.electronAPI.getSettings();
        if (s) pythonPath = s.pythonPath || '';
      } catch { /* ignore */ }
    }

    // Load tags + albums for pickers
    try { allTags.set(await fetchTags()); } catch {}
    try { allAlbums.set(await fetchAlbums()); } catch {}
  });

  // ── Detection settings ─────────────────────────────────────────────────────
  let detThresh    = 0.5;
  let minFaceSize  = 60;
  let recThresh    = 0.4;
  let detModel     = 'auto';
  let maxSize      = 0;
  let showDetParams = false;

  const DET_MODELS = [
    { value: 'auto',       label: 'Auto (Standard)' },
    { value: 'retinaface', label: 'RetinaFace' },
    { value: 'scrfd',      label: 'SCRFD' },
    { value: 'yunet',      label: 'YuNet' },
    { value: 'mediapipe',  label: 'MediaPipe' },
  ];

  $: detParams = {
    det_thresh:    detThresh,
    min_face_size: minFaceSize,
    rec_thresh:    recThresh,
    det_model:     detModel,
    max_size:      maxSize,
  };

  // ── Processing state ───────────────────────────────────────────────────────
  let running = false;
  let batchSource = null;
  let totalCount = 0;
  let doneCount = 0;
  let errorCount = 0;
  let skippedCount = 0;      // same-user duplicate (already uploaded by this user)
  let sharedDupCount = 0;    // cross-user shared duplicate (another user uploaded the same content)
  let finished = false;
  let cancelled = false;
  let visibility = 'shared'; // 'shared' | 'private'
  // Optional base folder for browser mode (browser can't expose full path).
  // Example: "/Users/alice/Downloads/pics" — prepended to bare filenames.
  let localBasePath = '';

  $: pendingItems    = queue.filter(q => q.status === 'pending');
  $: processingItem  = queue.find(q => q.status === 'processing');
  $: doneItems       = queue.filter(q => q.status === 'done' || q.status === 'error' || q.status === 'skipped');
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
    errorCount = 0; skippedCount = 0; sharedDupCount = 0; doneCount = 0; totalCount = pending.length;

    for (const item of pending) {
      if (cancelled) break;
      queue = queue.map(q => q.id === item.id ? { ...q, status: 'processing' } : q);
      try {
        const buffer = item.file
          ? await item.file.arrayBuffer()
          : await window.electronAPI.readLocalFile(item.path);
        // item.path is the best available path:
        //   Electron + openFileDialog → full absolute path
        //   Electron + drag-and-drop (contextIsolation:false) → full absolute path
        //   Electron + <input> File → f.path (full) thanks to addFiles() fix
        //   Browser mode → f.name (basename only — browser security limitation)
        // If the user set localBasePath and the path is basename-only, prepend it.
        const base = localBasePath.trim().replace(/\/+$/, '');
        const pathForServer = (base && item.path && !item.path.includes('/'))
          ? `${base}/${item.path}`
          : item.path;
        console.log('[ProcessView] upload-local | item.path=%s | localBasePath=%s | pathForServer=%s',
          item.path ?? '(none)', base || '(none)', pathForServer);
        const resp   = await uploadLocal(buffer, pathForServer, visibility, detParams,
          { tagIds: existingTagIds, newTagNames, albumId: selectedAlbum?.id ?? null, newAlbumName: selectedAlbum?.id == null ? selectedAlbum?.name ?? null : null });
        console.log('[ProcessView] upload-local response | image_id=%s | skipped=%s | shared_duplicate=%s',
          resp.image_id, resp.skipped, resp.shared_duplicate ?? false);
        if (resp.skipped) {
          if (resp.shared_duplicate) {
            sharedDupCount++;
            queue = queue.map(q => q.id === item.id
              ? { ...q, status: 'skipped', imageId: resp.image_id, skipReason: 'shared' }
              : q);
          } else {
            skippedCount++;
            queue = queue.map(q => q.id === item.id
              ? { ...q, status: 'skipped', imageId: resp.image_id, skipReason: 'own' }
              : q);
          }
        } else {
          queue = queue.map(q => q.id === item.id
            ? { ...q, status: 'done', imageId: resp.image_id, faces: resp.face_count ?? 0 }
            : q);
        }
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

  // Folder-mode: create persistent batch job and navigate to Batch Jobs view
  async function createBatchJobAndNavigate() {
    if (!batchFolder.trim() || batchJobCreating) return;
    batchJobCreating = true;
    batchJobError = '';
    try {
      await createBatchJob({
        folder: batchFolder.trim(),
        recursive: batchRecursive,
        follow_symlinks: batchFollowSymlinks,
        visibility,
        det_params: detParams,
        tag_ids: existingTagIds,
        new_tag_names: newTagNames,
        album_id: selectedAlbum?.id ?? null,
        new_album_name: selectedAlbum?.id == null ? selectedAlbum?.name ?? null : null,
      });
      sidebarView.set('batchjobs');
    } catch (e) {
      batchJobError = e.message;
    } finally {
      batchJobCreating = false;
    }
  }

  async function createBatchJobFromQueue() {
    const pending = queue.filter(q => q.status === 'pending');
    if (!pending.length || batchJobCreating) return;
    batchJobCreating = true;
    batchJobError = '';
    
    try {
      // 1. Create the empty job record first
      batchJobError = 'Initializing job...';
      const jobResp = await createBatchJob({
        batch_files: [], // Start empty
        visibility,
        det_params: detParams,
        tag_ids: existingTagIds,
        new_tag_names: newTagNames,
        album_id: selectedAlbum?.id ?? null,
        new_album_name: selectedAlbum?.id == null ? selectedAlbum?.name ?? null : null,
      });
      const jobId = jobResp.job_id;

      // 2. Upload and add files piece by piece (similar to "Direct" mode)
      let uploadIdx = 0;
      for (const item of pending) {
        batchJobError = `Uploading ${++uploadIdx} / ${pending.length}...`;
        
        const buffer = item.file
          ? await item.file.arrayBuffer()
          : await window.electronAPI.readLocalFile(item.path);
          
        const base = localBasePath.trim().replace(/\/+$/, '');
        const pathForServer = (base && item.path && !item.path.includes('/'))
          ? `${base}/${item.path}`
          : item.path;
          
        // Upload bytes to server
        const { server_path } = await uploadBatchFile(buffer, pathForServer);
        
        // Register this file in the persistent job
        await addFileToBatchJob(jobId, { filepath: server_path, local_path: pathForServer });
      }

      sidebarView.set('batchjobs');
    } catch (e) {
      batchJobError = e.message;
    } finally {
      batchJobCreating = false;
    }
  }

  async function refreshGlobalData() {
    try { stats.set(await fetchStats()); } catch {}
    try { allPeople.set(await fetchPeople()); } catch {}
    try { allTags.set(await fetchTags()); } catch {}
    try { allAlbums.set(await fetchAlbums()); } catch {}
    galleryRefreshTick.update(n => n + 1);
  }


</script>

<ServerDirPicker bind:open={serverPickerOpen} title="📡 {$t('pv_server_folder_label')}"
  startPath={batchFolder}
  on:select={e => batchFolder = e.detail} />

<div class="process-view">
  <div class="view-header">
    <h2>
      {$t('tab_batch')}
      {#if $processingMode === 'local_process'}
        <span class="mode-badge local">⚡ {$t('pv_mode_local')}</span>
      {:else}
        <span class="mode-badge upload">⬆ {$t('pv_mode_upload')}</span>
      {/if}
    </h2>
    {#if queue.length > 0 && !running}
      <div class="header-actions">
        <button class="btn-sm" on:click={clearDone} disabled={doneItems.length === 0}>
          {$t('pv_clear_done')} ({doneItems.length})
        </button>
        <button class="btn-sm danger" on:click={clearAll}>{$t('pv_clear_all')}</button>
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

  <!-- Local base path (browser mode only — Electron has real paths) -->
  {#if !inElectron}
    <div class="base-path-row">
      <label class="base-path-label" for="pv-base-path">{$t('pv_local_base_label')}</label>
      <input id="pv-base-path" class="base-path-input" type="text" placeholder={$t('pv_local_base_placeholder')}
             bind:value={localBasePath}
             title={$t('pv_local_base_hint')} />
    </div>
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
      {dragOver ? $t('pv_drop_active') : $t('pv_drop_idle')}
    </div>
    <div class="drop-sub">{$t('pv_drop_sub')}</div>
    <div class="drop-buttons">
      <button on:click={pickFiles}>💻 {$t('pv_select_files')}</button>
      <button on:click={pickFolder}>💻 {$t('pv_select_folder_btn')}</button>
    </div>
  </div>

  <!-- Queue controls for local files -->
  {#if queue.length > 0}
    <div class="controls-bar">
      <span class="queue-count">
        {#if finished}✓ {$t('batch_complete').replace('!','')} —{/if}
        {queue.length} {queue.length !== 1 ? $t('pv_items') : $t('pv_item')}
        ({pendingItems.length} {$t('pv_pending')})
      </span>
      {#if !running}
        <select bind:value={visibility} class="vis-select" title="Visibility">
          <option value="shared">{$t('fs_shared')}</option>
          <option value="private">{$t('fs_private')}</option>
        </select>
        <div class="proc-btn-group">
          <button
            class="primary"
            on:click={startProcessing}
            disabled={pendingItems.length === 0 || running}
            title={$t('pv_process_direct_hint')}
          >
            {$t('pv_process_btn')} {pendingItems.length} {pendingItems.length !== 1 ? $t('pv_images') : $t('pv_image')} ({$t('pv_process_direct')})
          </button>
          <button
            class="act-btn start"
            on:click={createBatchJobFromQueue}
            disabled={pendingItems.length === 0 || batchJobCreating}
            title={$t('bj_persistent_hint')}
          >
            📡 {$t('pv_process_as_batch')}
          </button>
        </div>
        {#if !inElectron && !localBasePath.trim() && pendingItems.length > 0}
          <div class="path-notice">
            ⚠️ {$t('pv_local_path_notice')}
          </div>
        {/if}
      {:else}
        <button class="danger" on:click={cancelProcessing}>{$t('stop_processing')}</button>
      {/if}
    </div>
  {/if}

  <!-- Tag + Album pickers (file mode + folder mode) -->
  <div class="meta-pickers">
    <!-- Tag picker -->
    <div class="picker-group">
      <label class="picker-label">{$t('pv_tags_label')}</label>
      <div class="picker-chips">
        {#each selectedTags as tag}
          <span class="chip">{tag.name}{#if tag.id === null} <em>+</em>{/if}
            <button class="chip-remove" on:click={() => removeTag(tag.name)}>✕</button>
          </span>
        {/each}
        <div class="picker-input-wrap" style="position:relative">
          <input
            type="text"
            class="picker-input"
            placeholder={$t('pv_tags_placeholder')}
            bind:value={tagInput}
            on:focus={() => tagDropdownOpen = true}
            on:blur={() => setTimeout(() => tagDropdownOpen = false, 150)}
            on:keydown={e => { if (e.key === 'Enter') { e.preventDefault(); filteredTags.length ? addTag(filteredTags[0]) : addNewTag(); } }}
          />
          {#if tagDropdownOpen && tagInput.trim()}
            <div class="picker-dropdown">
              {#each filteredTags as tag}
                <button class="picker-option" on:mousedown|preventDefault={() => addTag(tag)}>{tag.name}</button>
              {/each}
              {#if !filteredTags.find(tag => tag.name.toLowerCase() === tagInput.trim().toLowerCase())}
                <button class="picker-option new-item" on:mousedown|preventDefault={addNewTag}>
                  {$t('pv_album_new_prefix')} <strong>{tagInput.trim()}</strong>
                </button>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    </div>

    <!-- Album picker (single selection) -->
    <div class="picker-group">
      <label class="picker-label">{$t('pv_album_label')}</label>
      <div class="picker-chips">
        {#if selectedAlbum}
          <span class="chip">{selectedAlbum.name}{#if selectedAlbum.id === null} <em>+</em>{/if}
            <button class="chip-remove" on:click={clearAlbum}>✕</button>
          </span>
        {:else}
          <div class="picker-input-wrap" style="position:relative">
            <input
              type="text"
              class="picker-input"
              placeholder={$t('pv_album_placeholder')}
              bind:value={albumInput}
              on:focus={() => albumDropdownOpen = true}
              on:blur={() => setTimeout(() => albumDropdownOpen = false, 150)}
              on:keydown={e => { if (e.key === 'Enter') { e.preventDefault(); filteredAlbums.length ? selectAlbum(filteredAlbums[0]) : setNewAlbum(); } }}
            />
            {#if albumDropdownOpen && albumInput.trim()}
              <div class="picker-dropdown">
                {#each filteredAlbums as album}
                  <button class="picker-option" on:mousedown|preventDefault={() => selectAlbum(album)}>{album.name}</button>
                {/each}
                {#if !filteredAlbums.find(a => a.name.toLowerCase() === albumInput.trim().toLowerCase())}
                  <button class="picker-option new-item" on:mousedown|preventDefault={setNewAlbum}>
                    {$t('pv_album_new_prefix')} <strong>{albumInput.trim()}</strong>
                  </button>
                {/if}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </div>

  <!-- Server folder section: creates persistent batch job -->
  <div class="server-path-input">
    <span class="server-path-label">📡 {$t('pv_server_folder_label')}</span>
    <div class="server-path-row">
      <input type="text" bind:value={batchFolder} placeholder={$t('pv_server_folder_ph')} class="flex1" />
      <button on:click={() => serverPickerOpen = true} title="Browse server filesystem">{$t('pv_browse')}</button>
    </div>
    <div class="server-folder-row2">
      <label class="checkbox-row">
        <input type="checkbox" bind:checked={batchRecursive} /> {$t('pv_subfolders')}
      </label>
      <label class="checkbox-row">
        <input type="checkbox" bind:checked={batchFollowSymlinks} /> {$t('pv_follow_symlinks')}
      </label>
      {#if batchFolder.trim()}
        <button class="primary" on:click={createBatchJobAndNavigate} disabled={batchJobCreating}>
          {batchJobCreating ? $t('bj_enum_started') : $t('pv_submit_batch_job')}
        </button>
      {/if}
    </div>
    {#if batchJobError}
      <div class="batch-job-error">{batchJobError}</div>
    {/if}
  </div>

  <!-- Detection settings (collapsible) -->
  <div class="det-settings">
    <button class="det-toggle" on:click={() => showDetParams = !showDetParams}>
      ⚙ {$t('pv_det_settings')} {showDetParams ? '▲' : '▼'}
    </button>
    {#if showDetParams}
      <div class="det-params-box">
        <div class="det-param-row">
          <label>{$t('detection_threshold')}: <strong>{detThresh}</strong></label>
          <input type="range" min="0.1" max="0.9" step="0.05" bind:value={detThresh} />
        </div>
        <div class="det-param-row">
          <label>{$t('min_face_size')}: <strong>{minFaceSize}px</strong></label>
          <input type="range" min="10" max="200" step="5" bind:value={minFaceSize} />
        </div>
        <div class="det-param-row">
          <label>{$t('recognition_certainty')}: <strong>{recThresh}</strong></label>
          <input type="range" min="0.1" max="0.9" step="0.05" bind:value={recThresh} />
        </div>
        <div class="det-param-row">
          <label>{$t('detection_model')}</label>
          <select bind:value={detModel}>
            {#each DET_MODELS as m}
              <option value={m.value}>{m.label}</option>
            {/each}
          </select>
        </div>
        <div class="det-param-row">
          <label>{$t('pv_max_size_label')} <span class="hint">{$t('pv_max_size_hint')}</span></label>
          <input type="number" bind:value={maxSize} min="0" max="9999" step="100"
                 placeholder="0" class="num-input" />
        </div>
      </div>
    {/if}
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
        {#if skippedCount > 0}<span class="skip-count"> · {skippedCount} {$t('pv_already_uploaded')}</span>{/if}
        {#if sharedDupCount > 0}<span class="shared-count"> · {sharedDupCount} {$t('pv_shared_by_others')}</span>{/if}
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
              {#if item.status === 'pending'}<span class="badge pending">{$t('pv_badge_pending')}</span>{/if}
              {#if item.status === 'processing'}<span class="badge processing">{$t('pv_badge_processing')}</span>{/if}
              {#if item.status === 'done'}
                <span class="badge done">✓</span>
                {#if item.faces > 0}
                  <span class="badge faces">{item.faces} {item.faces !== 1 ? $t('pv_images') : $t('pv_image')}</span>
                {/if}
                {#if item.people?.length > 0}
                  <span class="badge people">{item.people.join(', ')}</span>
                {/if}
              {/if}
              {#if item.status === 'skipped'}
                {#if item.skipReason === 'shared'}
                  <span class="badge shared-dup" title={$t('pv_shared_dup_title')}>↩ {$t('fs_shared').toLowerCase()}</span>
                {:else}
                  <span class="badge skipped" title={$t('pv_own_dup_title')}>↩ {$t('skipped').toLowerCase()}</span>
                {/if}
              {/if}
              {#if item.status === 'error'}<span class="badge error">{$t('pv_badge_error')}</span>{/if}
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
            <button class="remove-btn" title={$t('pv_remove')} on:click={() => removeItem(item.id)}>✕</button>
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

  /* ── Detection settings ── */
  .det-settings {
    display: flex; flex-direction: column; gap: 0;
    background: #141422; border: 1px solid #2a2a3a; border-radius: 8px;
    flex-shrink: 0; overflow: hidden;
  }
  .det-toggle {
    background: none; border: none; text-align: left;
    padding: 8px 14px; font-size: 11px; color: #6080a0; cursor: pointer;
    width: 100%;
  }
  .det-toggle:hover { color: #90b0d0; background: #1a1a2e; }
  .det-params-box {
    display: flex; flex-direction: column; gap: 8px;
    padding: 10px 14px; border-top: 1px solid #2a2a3a;
  }
  .det-param-row {
    display: flex; align-items: center; gap: 10px;
  }
  .det-param-row label {
    font-size: 11px; color: #8090b0; white-space: nowrap; min-width: 200px;
  }
  .det-param-row label strong { color: #c0d0f0; }
  .det-param-row input[type="range"] { flex: 1; accent-color: #5080c0; }
  .det-param-row select {
    flex: 1; font-size: 11px; padding: 3px 6px;
    background: #0e0e1e; border: 1px solid #3a3a5a; border-radius: 4px; color: #c0c8e0;
  }
  .det-param-row .num-input {
    width: 90px; font-size: 11px; padding: 3px 8px;
    background: #0e0e1e; border: 1px solid #3a3a5a; border-radius: 4px; color: #c0c8e0;
  }
  .det-param-row .hint { font-size: 10px; color: #505070; margin-left: 4px; }

  /* ── Local base path (browser mode) ── */
  .base-path-row {
    display: flex; align-items: center; gap: 8px;
    margin-bottom: 8px; padding: 6px 10px;
    background: #1a1a2e; border-radius: 6px; border: 1px solid #2a2a42;
  }
  .base-path-label { font-size: 11px; color: #7080a0; white-space: nowrap; }
  .base-path-input {
    flex: 1; font-size: 11px; padding: 3px 8px;
    background: #12121e; border: 1px solid #3a3a5a; border-radius: 4px; color: #c0c8e0;
  }
  .base-path-input::placeholder { color: #3a3a58; }

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

  .proc-btn-group {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .path-notice {
    font-size: 10px;
    color: #c09040;
    margin-left: 8px;
    white-space: nowrap;
  }

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
  .err-count    { color: #d07070; }
  .skip-count   { color: #8090b0; }
  .shared-count { color: #b09040; }

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
  .badge.skipped    { background: #252535; color: #707090; }
  .badge.shared-dup { background: #2e2a18; color: #b09040; }

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

  .act-btn {
    font-size: 10px;
    padding: 3px 8px;
    border-radius: 4px;
    cursor: pointer;
    margin-right: 4px;
    border: 1px solid;
  }
  .act-btn.start  { background: #1e3a1e; border-color: #3a6a3a; color: #70c070; }

  /* ── Tag + Album pickers ── */
  .meta-pickers {
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: #141422;
    border: 1px solid #2a2a3a;
    border-radius: 8px;
    padding: 10px 14px;
    flex-shrink: 0;
  }
  .picker-group {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }
  .picker-label {
    font-size: 11px;
    color: #6080a0;
    white-space: nowrap;
    padding-top: 4px;
    min-width: 50px;
  }
  .picker-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    flex: 1;
    align-items: center;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: #1e2e50;
    color: #7090d0;
    border-radius: 12px;
    padding: 2px 8px 2px 10px;
    font-size: 11px;
    white-space: nowrap;
  }
  .chip em { color: #50a050; font-style: normal; font-size: 10px; }
  .chip-remove {
    background: none;
    border: none;
    color: #507090;
    font-size: 9px;
    padding: 0 2px;
    cursor: pointer;
    line-height: 1;
  }
  .chip-remove:hover { color: #c05050; }
  .picker-input-wrap { flex: 1; min-width: 130px; }
  .picker-input {
    width: 100%;
    font-size: 11px;
    padding: 3px 8px;
    background: #0e0e1e;
    border: 1px solid #3a3a5a;
    border-radius: 4px;
    color: #c0c8e0;
    box-sizing: border-box;
  }
  .picker-input::placeholder { color: #3a3a58; }
  .picker-dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    background: #1a1a2e;
    border: 1px solid #3a3a5a;
    border-radius: 4px;
    z-index: 50;
    max-height: 160px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  .picker-option {
    background: none;
    border: none;
    text-align: left;
    padding: 5px 10px;
    font-size: 11px;
    color: #b0b8d0;
    cursor: pointer;
    border-radius: 0;
  }
  .picker-option:hover { background: #252540; }
  .picker-option.new-item { color: #50a050; border-top: 1px solid #2a2a42; }

  .batch-job-error {
    font-size: 11px;
    color: #c05050;
    margin-top: 4px;
  }
</style>
