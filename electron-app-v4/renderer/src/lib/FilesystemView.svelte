<script>
  import { onMount, onDestroy } from 'svelte';
  import { t, fsCurrentPath, backgroundTask, galleryRefreshTick, filters, sidebarView, selectedId } from '../stores.js';
  import { browseFilesystem, addToDb, thumbnailUrl, uploadLocal,
           fetchCloudDrives, browseCloudDrive, ingestCloudDrive,
           renameCloudDriveItem, trashCloudDriveItem, deleteCloudDriveItem,
           downloadImage, openInOs, openFolderInOs } from '../api.js';

  const hasElectron = typeof window !== 'undefined' && !!window.electronAPI;
  const hasFSA      = typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  const canLocalMode = true;

  // Image extension set for client-side detection
  const IMAGE_EXTS = new Set(['.jpg','.jpeg','.png','.gif','.bmp','.webp','.tiff','.tif','.pgm']);

  // ── Mode: 'server' | 'local' | 'cloud' ────────────────────────────────────
  let mode = 'server';
  $: localMode = mode === 'local';
  $: cloudMode = mode === 'cloud';

  // ── FSA (File System Access API) state — browser local mode ──────────────
  let fsaDirHandle = null;  // current FileSystemDirectoryHandle
  let fsaStack = [];        // [{name, handle}] — navigation history

  let currentPath = '';
  let fsUnsubscribe;

  let entries = [];
  let parentPath = null;
  let loading = false;
  let error = '';

  // Selection
  let selected = new Set();
  let lastClickedPath = null;

  // Add-to-DB / upload / ingest progress
  let adding = false;
  let addProgress = { total: 0, done: 0, errors: 0, skipped: 0, current: '' };
  let addDone = false;
  let addStream = null;
  let addErrorList = []; // [{name, error}] for upload failures
  let visibility = 'shared'; // 'shared' | 'private'

  // ── View mode: 'grid' | 'list' ────────────────────────────────────────────
  let fsView = 'grid';

  function refresh() {
    if (cloudMode && cloudDriveId !== null) browse(currentPath);
    else if (cloudMode) loadCloudDrives();
    else if (localMode && !hasElectron && hasFSA && fsaDirHandle) loadFSADir(fsaDirHandle);
    else if (!localMode) browse(currentPath);
  }

  // ── Cloud drive state ──────────────────────────────────────────────────────
  let cloudDrives = [];       // [{id, name, type, is_mounted, ...}]
  let cloudDriveId = null;    // active drive id (null = picker shown)
  let cloudDriveName = '';
  let cloudDriveType = '';
  let cloudLoading = false;
  let cloudPathTrail = [];    // [{path, name}] — navigation history for breadcrumbs

  // Restore path from store (server mode only)
  fsUnsubscribe = fsCurrentPath.subscribe(p => {
    if (mode === 'server' && p && p !== currentPath) {
      currentPath = p;
    }
  });

  // ── Browse ─────────────────────────────────────────────────────────────────
  async function browse(browsePath) {
    loading = true;
    error = '';
    selected = new Set();
    lastClickedPath = null;
    try {
      if (cloudMode && cloudDriveId !== null) {
        const data = await browseCloudDrive(cloudDriveId, browsePath || '/');
        currentPath = data.path;
        parentPath  = data.parent || null;
        entries     = data.entries;
      } else if (localMode) {
        const data = await window.electronAPI.readLocalDir(browsePath || '');
        currentPath = data.path;
        parentPath  = data.parent;
        entries     = data.entries;
      } else {
        const data = await browseFilesystem(browsePath || '');
        currentPath = data.path;
        parentPath  = data.parent;
        entries     = data.entries;
        fsCurrentPath.set(currentPath);
      }
    } catch (e) {
      error = e.message;
      console.error('[FilesystemView] browse error for', browsePath, ':', e.message);
    } finally {
      loading = false;
    }
  }

  // ── Cloud drive management ─────────────────────────────────────────────────
  async function loadCloudDrives() {
    cloudLoading = true;
    error = '';
    try {
      cloudDrives = await fetchCloudDrives();
    } catch (e) {
      error = `Could not load cloud drives: ${e.message}`;
    } finally {
      cloudLoading = false;
    }
  }

  function selectCloudDrive(drive) {
    if (!drive.is_mounted) {
      error = `"${drive.name}" is not connected. Connect it in Cloud Drives settings first.`;
      return;
    }
    cloudDriveId   = drive.id;
    cloudDriveName = drive.name;
    cloudDriveType = drive.type;
    currentPath    = '/';
    parentPath     = null;
    entries        = [];
    selected       = new Set();
    error          = '';
    cloudPathTrail = [];
    browse('/');
  }

  function leaveCloudDrive() {
    cloudDriveId = null;
    cloudDriveName = '';
    cloudDriveType = '';
    entries = [];
    selected = new Set();
    currentPath = '/';
    parentPath = null;
    cloudPathTrail = [];
    loadCloudDrives();
  }

  // ── Cloud file operations (rename / trash / delete) ───────────────────────
  let renameModal = null;   // { path, name } or null
  let renameValue = '';
  let cloudOpsMsg = '';     // inline success/error feedback

  async function openRename() {
    const paths = [...selected];
    if (paths.length !== 1 || cloudDriveId === null) return;
    const entry = entries.find(e => e.path === paths[0]);
    renameModal = { path: paths[0], name: entry?.name || paths[0].split('/').pop() };
    renameValue = renameModal.name;
  }

  async function doRename() {
    if (!renameModal || !renameValue.trim()) return;
    try {
      await renameCloudDriveItem(cloudDriveId, renameModal.path, renameValue.trim());
      cloudOpsMsg = `Renamed to "${renameValue.trim()}"`;
      renameModal = null;
      browse(currentPath);
    } catch (e) {
      cloudOpsMsg = `Rename failed: ${e.message}`;
      renameModal = null;
    }
  }

  async function doTrash() {
    const paths = [...selected];
    if (paths.length === 0 || cloudDriveId === null) return;
    const isDeletion = cloudDriveType === 'smb' || cloudDriveType === 'sftp';
    const action = isDeletion ? 'permanently delete' : 'trash';
    if (!confirm(`${action} ${paths.length} item${paths.length > 1 ? 's' : ''} on "${cloudDriveName}"?`)) return;
    let ok = 0, fail = 0;
    for (const path of paths) {
      try { await trashCloudDriveItem(cloudDriveId, path); ok++; }
      catch { fail++; }
    }
    cloudOpsMsg = `${ok} item${ok > 1 ? 's' : ''} ${isDeletion ? 'deleted' : 'trashed'}${fail > 0 ? `, ${fail} failed` : ''}.`;
    browse(currentPath);
  }

  async function doDelete() {
    const paths = [...selected];
    if (paths.length === 0 || cloudDriveId === null) return;
    if (!confirm(`Permanently delete ${paths.length} item${paths.length > 1 ? 's' : ''} on "${cloudDriveName}"? This cannot be undone.`)) return;
    let ok = 0, fail = 0;
    for (const path of paths) {
      try { await deleteCloudDriveItem(cloudDriveId, path); ok++; }
      catch { fail++; }
    }
    cloudOpsMsg = `${ok} item${ok > 1 ? 's' : ''} permanently deleted${fail > 0 ? `, ${fail} failed` : ''}.`;
    browse(currentPath);
  }

  // ── Mode switch ────────────────────────────────────────────────────────────
  async function switchMode(toMode) {
    if (toMode === mode) return;
    entries = [];
    selected = new Set();
    error = '';
    addDone = false;
    if (addStream) { addStream.close(); addStream = null; }
    cloudDriveId = null;
    cloudDriveName = '';

    if (toMode === 'local') {
      if (!hasElectron && hasFSA) {
        mode = 'local';
        currentPath = '';
        await pickFSARoot();
      } else if (!hasElectron && !hasFSA) {
        mode = 'local';
        currentPath = '';
        fallbackFiles = [];
        fallbackFinished = false;
      } else {
        mode = 'local';
        currentPath = '';
        await browse('');
      }
    } else if (toMode === 'cloud') {
      mode = 'cloud';
      currentPath = '/';
      await loadCloudDrives();
    } else {
      mode = 'server';
      currentPath = '';
      await browse('');
    }
  }

  // ── Navigation ─────────────────────────────────────────────────────────────
  function navigate(p, name = null) {
    if (localMode && !hasElectron && hasFSA) { navigateFSA(p); return; }
    if (cloudMode && name) {
      cloudPathTrail = [...cloudPathTrail, { path: p, name }];
    }
    browse(p);
  }
  function goUp() {
    if (localMode && !hasElectron && hasFSA) { goUpFSA(); return; }
    if (cloudMode && cloudDriveId !== null && !parentPath) {
      leaveCloudDrive(); return;
    }
    if (cloudMode && cloudPathTrail.length > 0) {
      cloudPathTrail = cloudPathTrail.slice(0, -1);
    }
    if (parentPath) browse(parentPath);
  }

  function cloudBreadcrumbs() {
    return cloudPathTrail;
  }

  function breadcrumbs(p) {
    if (!p) return [];
    const parts = p.split('/').filter(Boolean);
    return parts.map((seg, i) => ({
      label: seg,
      path:  '/' + parts.slice(0, i + 1).join('/'),
    }));
  }

  // ── Selection ──────────────────────────────────────────────────────────────
  function isSelectable(entry) {
    if (cloudMode) return true;      // files + dirs; backend filters images
    if (localMode) return entry.is_image; // local: only image files
    return true;                         // server: dirs + files
  }

  function isCloudImageFile(entry) {
    if (entry.is_dir) return false;
    const dot = entry.name.lastIndexOf('.');
    if (dot === -1) return false;
    return IMAGE_EXTS.has(entry.name.slice(dot).toLowerCase());
  }

  function toggleSelect(p, isShift = false, isMulti = false) {
    const entry = entries.find(e => e.path === p);
    if (!isSelectable(entry)) return;

    const s = new Set(selected);
    if (isShift && lastClickedPath !== null) {
      const paths = entries.filter(e => isSelectable(e)).map(e => e.path);
      const start = paths.indexOf(lastClickedPath);
      const end   = paths.indexOf(p);
      const [low, high] = [Math.min(start, end), Math.max(start, end)];
      for (let i = low; i <= high; i++) s.add(paths[i]);
    } else if (isMulti) {
      s.has(p) ? s.delete(p) : s.add(p);
    } else {
      if (s.has(p) && s.size === 1) s.delete(p);
      else { s.clear(); s.add(p); }
    }
    selected = s;
    lastClickedPath = p;
  }

  function selectAll() {
    selected = new Set(entries.filter(e => isSelectable(e)).map(e => e.path));
  }
  function clearSelection() { selected = new Set(); lastClickedPath = null; }

  // ── Context menu ───────────────────────────────────────────────────────────
  let ctxMenu = null;   // { entry, x, y } | null
  let ctxVisible = false;
  let ctxMenuEl;

  function showCtxMenu(e, entry) {
    e.preventDefault();
    e.stopPropagation();
    ctxMenu = { entry, x: e.clientX, y: e.clientY };
    ctxVisible = false;
  }

  function closeCtxMenu() { ctxMenu = null; ctxVisible = false; }

  // After ctxMenuEl binds, check overflow and make visible
  $: if (ctxMenu && ctxMenuEl) {
    const rect = ctxMenuEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 8;
    if (rect.right  > vw - pad) ctxMenu = { ...ctxMenu, x: Math.max(pad, ctxMenu.x - rect.width) };
    if (rect.bottom > vh - pad) ctxMenu = { ...ctxMenu, y: Math.max(pad, ctxMenu.y - rect.height) };
    ctxVisible = true;
  }

  async function handleCtxAction(action) {
    const entry = ctxMenu?.entry;
    closeCtxMenu();
    if (!entry) return;

    if (action === 'navigate') {
      navigate(entry.path, entry.name);
    } else if (action === 'browse-gallery') {
      // Show images in this folder in the gallery
      const folderPath = entry.is_dir ? entry.path : entry.path.substring(0, entry.path.lastIndexOf('/'));
      filters.set({ person: '', tag: '', scene: '', path: '', dateFrom: '', dateTo: '', folder: folderPath });
      sidebarView.set('all');
    } else if (action === 'view-lightbox') {
      if (entry.image_id) selectedId.set(entry.image_id);
    } else if (action === 'download') {
      if (entry.image_id) downloadImage(entry.image_id, entry.name);
    } else if (action === 'open-os') {
      if (entry.image_id) {
        const res = await openInOs(entry.image_id).catch(() => null);
        if (res && !res.ok && res.headless) alert(`Server path:\n${res.path}`);
      }
    } else if (action === 'open-folder-os') {
      if (entry.image_id) {
        const res = await openFolderInOs(entry.image_id).catch(() => null);
        if (res && !res.ok && res.headless) {
          await navigator.clipboard.writeText(res.path).catch(() => {});
          alert(`Server folder (copied):\n${res.path}`);
        }
      }
    } else if (action === 'add-to-db') {
      selected = new Set([entry.path]);
      startAddToDb();
    } else if (action === 'rename') {
      selected = new Set([entry.path]);
      openRename();
    } else if (action === 'trash') {
      selected = new Set([entry.path]);
      doTrash();
    } else if (action === 'copy-path') {
      navigator.clipboard.writeText(entry.path).catch(() => {});
    }
  }

  // ── Download selected (server mode, in-DB files) ───────────────────────────
  async function downloadSelected() {
    const inDbEntries = [...selected]
      .map(p => entries.find(e => e.path === p))
      .filter(e => e && !e.is_dir && e.in_db && e.image_id);
    for (let i = 0; i < inDbEntries.length; i++) {
      downloadImage(inDbEntries[i].image_id, inDbEntries[i].name);
      if (i < inDbEntries.length - 1) await new Promise(r => setTimeout(r, 300));
    }
  }

  $: selectedInDbCount = [...selected]
    .map(p => entries.find(e => e.path === p))
    .filter(e => e && !e.is_dir && e?.in_db && e?.image_id).length;

  // ── Server mode helpers ────────────────────────────────────────────────────
  function dbStatusClass(entry) {
    if (!entry.is_dir) return entry.in_db ? 'in-db' : 'not-db';
    if (entry.total_files === 0) return 'dir-empty';
    if (entry.db_count === 0) return 'not-db';
    if (entry.db_count >= entry.total_files) return 'in-db';
    return 'partial-db';
  }

  function dirLabel(entry) {
    if (entry.total_files === 0) return '';
    if (entry.db_count >= entry.total_files) return `${entry.db_count} ${$t('fs_in_db')}`;
    return `${entry.db_count}/${entry.total_files} ${$t('fs_in_db')}`;
  }

  // ── Server mode: add-to-DB via SSE ────────────────────────────────────────
  function startServerAddToDb() {
    if (selected.size === 0 || adding) return;
    adding = true;
    addDone = false;
    addProgress = { total: 0, done: 0, errors: 0, current: '' };
    backgroundTask.set({ label: 'Adding to DB', done: 0, total: 0 });

    const paths  = [...selected];
    const hasDirs = paths.some(p => entries.find(e => e.path === p)?.is_dir);

    addStream = addToDb(paths, hasDirs, event => {
      if (event.started) {
        addProgress = { ...addProgress, total: event.total };
        backgroundTask.set({ label: 'Adding to DB', done: 0, total: event.total });
      } else if (event.done) {
        adding = false;
        addDone = true;
        addStream = null;
        addProgress = { ...addProgress, skipped: event.skipped ?? 0 };
        backgroundTask.set(null);
        galleryRefreshTick.update(n => n + 1);
        browse(currentPath);
      } else if (event.skipped) {
        addProgress = {
          ...addProgress,
          done:    event.index,
          current: event.path?.split('/').pop() || '',
          skipped: addProgress.skipped + 1,
        };
        backgroundTask.set({ label: 'Adding to DB', done: event.index, total: addProgress.total });
      } else {
        addProgress = {
          ...addProgress,
          done:   event.index,
          current: event.path?.split('/').pop() || '',
          errors:  addProgress.errors + (event.error ? 1 : 0),
        };
        backgroundTask.set({ label: 'Adding to DB', done: event.index, total: addProgress.total });
      }
    }, visibility);
  }

  // ── Cloud mode: ingest via SSE ─────────────────────────────────────────────
  function startCloudIngest() {
    if (selected.size === 0 || adding) return;
    adding = true;
    addDone = false;
    addProgress = { total: 0, done: 0, errors: 0, skipped: 0, current: '' };
    backgroundTask.set({ label: 'Fetching from cloud', done: 0, total: 0 });

    const paths   = [...selected];
    const hasDirs = paths.some(p => entries.find(e => e.path === p)?.is_dir);

    addStream = ingestCloudDrive(cloudDriveId, paths, hasDirs, visibility, event => {
      if (event.started) {
        addProgress = { ...addProgress, total: event.total };
        backgroundTask.set({ label: 'Fetching from cloud', done: 0, total: event.total });
      } else if (event.done) {
        adding = false;
        addDone = true;
        addStream = null;
        backgroundTask.set(null);
        galleryRefreshTick.update(n => n + 1);
      } else if (event.error && event.done !== true) {
        // stream-level error
        adding = false;
        addDone = false;
        addStream = null;
        backgroundTask.set(null);
        error = event.error;
      } else {
        addProgress = {
          ...addProgress,
          done:    event.index,
          current: event.path?.split('/').pop() || event.path || '',
          errors:  addProgress.errors + (event.error ? 1 : 0),
        };
        backgroundTask.set({ label: 'Fetching from cloud', done: event.index, total: addProgress.total });
      }
    });
  }

  // ── Local mode: upload selected images to server ──────────────────────────
  async function startLocalUpload() {
    if (selected.size === 0 || adding) return;
    adding = true;
    addDone = false;
    addErrorList = [];

    const filePaths = [...selected].filter(p => {
      const e = entries.find(en => en.path === p);
      return e && e.is_image;
    });

    addProgress = { total: filePaths.length, done: 0, errors: 0, current: '' };
    backgroundTask.set({ label: 'Uploading to DB', done: 0, total: filePaths.length });

    for (const filePath of filePaths) {
      if (!adding) break;
      const name = filePath.split('/').pop();
      addProgress = { ...addProgress, current: name };
      try {
        const buffer = await window.electronAPI.readLocalFile(filePath);
        await uploadLocal(buffer, filePath, visibility);
        addProgress = { ...addProgress, done: addProgress.done + 1 };
      } catch (e) {
        addErrorList = [...addErrorList, { name, error: e?.message || String(e) }];
        addProgress = { ...addProgress, done: addProgress.done + 1, errors: addProgress.errors + 1 };
      }
      backgroundTask.set({ label: 'Uploading to DB', done: addProgress.done, total: filePaths.length });
    }

    adding = false;
    addDone = true;
    backgroundTask.set(null);
    galleryRefreshTick.update(n => n + 1);
  }

  function startAddToDb() {
    if (cloudMode)  { startCloudIngest(); return; }
    if (localMode && !hasElectron && hasFSA) startFSAUpload();
    else if (localMode) startLocalUpload();
    else startServerAddToDb();
  }

  function cancelAdd() {
    if (addStream) { addStream.close(); addStream = null; }
    adding = false;
    backgroundTask.set(null);
  }

  // ── Browser/PWA: File System Access API local mode ────────────────────────

  async function pickFSARoot() {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'read' });
      fsaDirHandle = handle;
      fsaStack = [{ name: handle.name, handle }];
      await loadFSADir(handle);
    } catch (e) {
      if (e.name !== 'AbortError') error = e.message;
      if (!fsaDirHandle) mode = 'server';
    }
  }

  async function loadFSADir(dirHandle) {
    loading = true;
    error = '';
    selected = new Set();
    lastClickedPath = null;
    const results = [];
    for await (const [name, handle] of dirHandle.entries()) {
      if (name.startsWith('.')) continue;
      const isDir = handle.kind === 'directory';
      const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
      results.push({
        path: name, name, handle,
        is_dir: isDir,
        is_image: !isDir && IMAGE_EXTS.has(ext),
      });
    }
    results.sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    entries = results;
    parentPath = fsaStack.length > 1 ? '__fsa_parent__' : null;
    loading = false;
  }

  async function navigateFSA(name) {
    const entry = entries.find(e => e.path === name && e.is_dir);
    if (!entry) return;
    fsaStack = [...fsaStack, { name: entry.name, handle: entry.handle }];
    fsaDirHandle = entry.handle;
    await loadFSADir(entry.handle);
  }

  async function goUpFSA() {
    if (fsaStack.length <= 1) return;
    fsaStack = fsaStack.slice(0, -1);
    fsaDirHandle = fsaStack[fsaStack.length - 1].handle;
    await loadFSADir(fsaDirHandle);
    parentPath = fsaStack.length > 1 ? '__fsa_parent__' : null;
  }

  async function navigateFSAToIndex(i) {
    fsaStack = fsaStack.slice(0, i + 1);
    fsaDirHandle = fsaStack[fsaStack.length - 1].handle;
    await loadFSADir(fsaDirHandle);
    parentPath = fsaStack.length > 1 ? '__fsa_parent__' : null;
  }

  async function startFSAUpload() {
    const selEntries = entries.filter(e => selected.has(e.path) && e.is_image);
    if (!selEntries.length || adding) return;
    adding = true;
    addDone = false;
    addErrorList = [];
    addProgress = { total: selEntries.length, done: 0, errors: 0, current: '' };
    backgroundTask.set({ label: 'Uploading to DB', done: 0, total: selEntries.length });
    for (const entry of selEntries) {
      if (!adding) break;
      addProgress = { ...addProgress, current: entry.name };
      try {
        const file = await entry.handle.getFile();
        await uploadLocal(await file.arrayBuffer(), entry.name, visibility);
        addProgress = { ...addProgress, done: addProgress.done + 1 };
      } catch (e) {
        addErrorList = [...addErrorList, { name: entry.name, error: e?.message || String(e) }];
        addProgress = { ...addProgress, done: addProgress.done + 1, errors: addProgress.errors + 1 };
      }
      backgroundTask.set({ label: 'Uploading to DB', done: addProgress.done, total: selEntries.length });
    }
    adding = false;
    addDone = true;
    backgroundTask.set(null);
    galleryRefreshTick.update(n => n + 1);
  }

  // ── Browser fallback: plain <input type="file"> for Firefox/Safari ────────
  let fallbackFiles = [];
  let fallbackRunning = false;
  let fallbackDone = 0;
  let fallbackTotal = 0;
  let fallbackErrors = 0;
  let fallbackFinished = false;

  function onFallbackPick(e) {
    const newFiles = [...e.target.files].filter(f =>
      IMAGE_EXTS.has(f.name.slice(f.name.lastIndexOf('.')).toLowerCase()) &&
      !fallbackFiles.find(x => x.name === f.name && x.size === f.size)
    );
    e.target.value = '';
    fallbackFiles = [...fallbackFiles, ...newFiles];
  }

  async function startFallbackUpload() {
    if (!fallbackFiles.length || fallbackRunning) return;
    const toUpload = [...fallbackFiles];
    fallbackRunning = true;
    fallbackDone = 0;
    fallbackErrors = 0;
    fallbackTotal = toUpload.length;
    fallbackFinished = false;
    backgroundTask.set({ label: 'Uploading to DB', done: 0, total: fallbackTotal });
    for (const f of toUpload) {
      try {
        await uploadLocal(await f.arrayBuffer(), f.name, visibility);
        fallbackDone++;
      } catch {
        fallbackErrors++;
        fallbackDone++;
      }
      backgroundTask.set({ label: 'Uploading to DB', done: fallbackDone, total: fallbackTotal });
    }
    fallbackRunning = false;
    fallbackFinished = true;
    fallbackFiles = [];
    backgroundTask.set(null);
    galleryRefreshTick.update(n => n + 1);
  }

  onMount(() => {
    console.log('[FilesystemView] mode detection:', {
      hasElectron,
      hasFSA,
      userAgent: navigator.userAgent,
    });
    browse(currentPath);
  });
  onDestroy(() => {
    if (fsUnsubscribe) fsUnsubscribe();
    if (addStream) { addStream.close(); addStream = null; }
    if (adding) backgroundTask.set(null);
  });
</script>

<div class="fs-view">
  <!-- Navigation bar -->
  <div class="nav-bar">
    <!-- Mode toggle -->
    {#if canLocalMode}
      <div class="mode-toggle">
        <button
          class="mode-btn"
          class:active={mode === 'server'}
          on:click={() => switchMode('server')}
        >📡 {$t('fs_server_mode')}</button>
        <button
          class="mode-btn"
          class:active={mode === 'local'}
          on:click={() => switchMode('local')}
        >{hasElectron ? '💻' : '📂'} {$t('fs_local_mode')}</button>
        <button
          class="mode-btn"
          class:active={mode === 'cloud'}
          on:click={() => switchMode('cloud')}
        >☁ {$t('fs_cloud_mode')}</button>
      </div>
    {/if}

    <!-- Up button -->
    <button class="up-btn"
      on:click={goUp}
      disabled={!parentPath && !(cloudMode && cloudDriveId !== null) || loading || (localMode && !hasElectron && !hasFSA)}
      title="Up">↑</button>

    <!-- Refresh -->
    <button class="up-btn" on:click={refresh} disabled={loading} title="Refresh">🔄</button>

    <!-- View toggle (grid / list) — shown when we have content -->
    <div class="view-toggle">
      <button class="view-btn" class:active={fsView === 'grid'} on:click={() => fsView = 'grid'} title="Grid view">⊞</button>
      <button class="view-btn" class:active={fsView === 'list'} on:click={() => fsView = 'list'} title="List view">≡</button>
    </div>

    <!-- Breadcrumbs -->
    {#if cloudMode && cloudDriveId !== null}
      <!-- Cloud: drive name + path segments -->
      <div class="breadcrumbs">
        <button class="crumb cloud-root" on:click={leaveCloudDrive}
          title="Back to drive list">
          {cloudDriveType === 'smb' ? '🗄' : cloudDriveType === 'sftp' ? '🔒' : cloudDriveType === 'filen' ? '☁' : '🌐'}
          {cloudDriveName}
        </button>
        {#each cloudBreadcrumbs() as crumb, i}
          <span class="crumb-sep">/</span>
          <button class="crumb" on:click={() => {
            cloudPathTrail = cloudPathTrail.slice(0, i + 1);
            browse(crumb.path);
          }}>{crumb.name}</button>
        {/each}
      </div>
    {:else if localMode && !hasElectron && hasFSA && fsaStack.length > 0}
      <div class="breadcrumbs">
        {#each fsaStack as crumb, i}
          {#if i > 0}<span class="crumb-sep">/</span>{/if}
          <button class="crumb" on:click={() => navigateFSAToIndex(i)}>{crumb.name}</button>
        {/each}
      </div>
    {:else if localMode && !hasElectron && !hasFSA}
      <div class="breadcrumbs"></div>
    {:else if cloudMode && cloudDriveId === null}
      <!-- Picker: no breadcrumbs -->
      <div class="breadcrumbs"><span class="crumb-hint">{$t('select_drive_below')}</span></div>
    {:else}
      <!-- Server mode: absolute path breadcrumbs + path input -->
      <div class="breadcrumbs">
        <button class="crumb" on:click={() => navigate('/')}>/</button>
        {#each breadcrumbs(currentPath) as crumb}
          <span class="crumb-sep">/</span>
          <button class="crumb" on:click={() => navigate(crumb.path)}>{crumb.label}</button>
        {/each}
      </div>
      <input
        class="path-input"
        type="text"
        bind:value={currentPath}
        placeholder={$t('fs_path_placeholder')}
        on:keydown={e => { if (e.key === 'Enter') { error = ''; console.log('[FilesystemView] Go:', currentPath); navigate(currentPath); } }}
      />
      <button on:click={() => { error = ''; console.log('[FilesystemView] Go button:', currentPath); navigate(currentPath); }} disabled={loading}>{$t('fs_go')}</button>
    {/if}
  </div>

  <!-- Mode banners -->
  {#if cloudMode && cloudDriveId !== null}
    <div class="mode-banner cloud-banner">
      ☁ <strong>{cloudDriveName}</strong>
      <span class="drive-type-tag">{cloudDriveType.toUpperCase()}</span>
      — {$t('fs_select_drive_to_add')}
      <button class="btn-sm" style="margin-left:10px;" on:click={leaveCloudDrive}>← Drives</button>
    </div>
  {:else if localMode}
    <div class="mode-banner local-banner">
      {#if hasElectron}
        💻 {$t('fs_upload_to_server')}
      {:else if hasFSA && fsaStack.length > 0}
        📂 {fsaStack.map(s => s.name).join('/')} — {$t('fs_upload_to_db')}
        <button class="btn-sm" style="margin-left:8px;" on:click={pickFSARoot}>{$t('fs_change_folder')}</button>
      {:else if hasFSA}
        📂 {$t('fs_local_folder_hint')}
      {:else}
        📂 {$t('fs_local_upload_hint')}
      {/if}
    </div>
  {/if}

  <!-- Error bar -->
  {#if error}
    <div class="error-bar">{error} <button class="btn-sm err-dismiss" on:click={() => error = ''}>✕</button></div>
  {/if}


  <!-- ── Cloud drive picker ──────────────────────────────────────────────── -->
  {#if cloudMode && cloudDriveId === null}
    <div class="cloud-picker">
      {#if cloudLoading}
        <div class="picker-loading">{$t('fs_loading_drives')}</div>
      {:else if cloudDrives.length === 0}
        <div class="picker-empty">
          <div class="picker-icon">☁️</div>
          <p>{$t('fs_no_cloud_drives_fs')}</p>
          <p class="hint">{$t('fs_add_in_settings')}</p>
        </div>
      {:else}
        <div class="picker-title">{$t('fs_select_cloud_drive')}</div>
        <div class="picker-list">
          {#each cloudDrives as drive (drive.id)}
            <div
              class="picker-card"
              class:mounted={drive.is_mounted}
              class:offline={!drive.is_mounted}
              role="button"
              tabindex="0"
              on:click={() => selectCloudDrive(drive)}
              on:keydown={e => e.key === 'Enter' && selectCloudDrive(drive)}
              title={drive.is_mounted ? `Browse ${drive.name}` : $t('fs_not_connected')}
            >
              <span class="picker-icon-sm">
                {drive.type === 'smb' ? '🗄' : drive.type === 'sftp' ? '🔒' : drive.type === 'filen' ? '☁' : '🌐'}
              </span>
              <div class="picker-meta">
                <span class="picker-name">{drive.name}</span>
                <span class="picker-badge">{drive.type.toUpperCase()}</span>
              </div>
              <div class="picker-status">
                <span class="status-dot" class:on={drive.is_mounted}></span>
                <span class="status-text">{drive.is_mounted ? $t('drive_status_connected') : $t('drive_status_offline')}</span>
              </div>
            </div>
          {/each}
        </div>
        <button class="btn-sm" style="margin-top:8px;" on:click={loadCloudDrives}>🔄 Refresh</button>
      {/if}
    </div>
  {/if}

  <!-- Local mode overlays (browser only) -->
  {#if localMode && !hasElectron}
    {#if hasFSA && !fsaDirHandle}
      <div class="fsa-prompt">
        <div class="fsa-icon">📂</div>
        <p>{$t('fs_pick_local_folder')}</p>
        <button class="primary" on:click={pickFSARoot}>{$t('fs_grant_access')}</button>
      </div>
    {:else if !hasFSA}
      <input type="file" id="fb-files"  multiple accept="image/*" style="display:none"
             on:change={onFallbackPick} />
      <input type="file" id="fb-folder" webkitdirectory accept="image/*" style="display:none"
             on:change={onFallbackPick} />
      <div class="fallback-local">
        <div class="fallback-pick-row">
          <button on:click={() => document.getElementById('fb-files').click()}
                  disabled={fallbackRunning}>{$t('fs_select_images')}</button>
          <button on:click={() => document.getElementById('fb-folder').click()}
                  disabled={fallbackRunning}>{$t('fs_select_folder_btn')}</button>
        </div>
        {#if fallbackFiles.length > 0 && !fallbackRunning}
          <div class="fallback-file-list">
            {#each fallbackFiles as f, i}
              <div class="fallback-file-row">
                <span class="fb-name">{f.name}</span>
                <span class="fb-size">{(f.size/1024).toFixed(0)} KB</span>
                <button class="btn-sm" on:click={() => fallbackFiles = fallbackFiles.filter((_,j) => j !== i)}>✕</button>
              </div>
            {/each}
          </div>
          <div class="fallback-actions">
            <select bind:value={visibility} class="vis-select">
              <option value="shared">{$t('fs_shared')}</option>
              <option value="private">{$t('fs_private')}</option>
            </select>
            <button class="primary" on:click={startFallbackUpload}>
              ⬆ Upload {fallbackFiles.length} image{fallbackFiles.length !== 1 ? 's' : ''}
            </button>
            <button class="btn-sm" on:click={() => fallbackFiles = []}>Clear</button>
          </div>
        {:else if fallbackRunning}
          <div class="dv-progress">
            {$t('fs_uploading')} {fallbackDone}/{fallbackTotal}…
            <div class="prog-bar-wrap" style="width:100px;display:inline-block;margin-left:8px;">
              <div class="prog-bar" style="width:{fallbackTotal ? (fallbackDone/fallbackTotal)*100 : 0}%"></div>
            </div>
          </div>
        {:else if fallbackFinished}
          <div class="dv-done">
            ✓ {fallbackDone - fallbackErrors} {$t('fs_uploading')} OK
            {#if fallbackErrors > 0}<span class="err-count">, {fallbackErrors} {$t('errors_label')}</span>{/if}
            <button class="btn-sm" style="margin-left:8px;"
                    on:click={() => { fallbackFinished = false; }}>{$t('dismiss')}</button>
          </div>
        {:else}
          <p class="fallback-hint">{$t('fs_pick_local_folder')}</p>
        {/if}
      </div>
    {/if}
  {/if}

  <!-- Content grid (hidden in browser-only local modes until a dir is loaded,
       or in cloud mode until a drive is selected) -->
  {#if !(cloudMode && cloudDriveId === null) && !(localMode && !hasElectron && !hasFSA)}
    <div class="content">
      {#if loading}
        <div class="empty-state">{$t('loading')}</div>
      {:else if entries.length === 0 && (!localMode || hasElectron || (hasFSA && fsaDirHandle))}
        <div class="empty-state">{$t('fs_empty_folder')}</div>
      {:else if entries.length > 0}
        <!-- Select toolbar -->
        <div class="select-bar">
          <button on:click={selectAll} class="btn-sm">{$t('select_all')}</button>
          <button on:click={clearSelection} class="btn-sm">{$t('deselect')}</button>
          <span class="sel-count">{selected.size} {$t('selected_label')}</span>
          {#if localMode}
            <span class="sel-hint">{$t('fs_images_only')}</span>
          {:else if cloudMode}
            <span class="sel-hint">{$t('fs_images_folders')}</span>
          {/if}
        </div>

        {#if fsView === 'grid'}
          <!-- ── Grid view ── -->
          <div class="grid no-select">
            {#each entries as entry (entry.path)}
              {@const selectable = isSelectable(entry)}
              {@const cls = cloudMode
                ? (entry.is_dir ? 'dir-cloud' : isCloudImageFile(entry) ? 'cloud-img' : 'not-db')
                : localMode
                  ? (entry.is_image ? 'in-db' : 'not-db')
                  : dbStatusClass(entry)}
              <div
                class="entry"
                class:selected={selected.has(entry.path)}
                class:not-selectable={!selectable && !entry.is_dir}
                role="button"
                tabindex="0"
                on:click={(e) => entry.is_dir && !e.shiftKey && !e.metaKey && !e.ctrlKey
                  ? navigate(entry.path, entry.name)
                  : toggleSelect(entry.path, e.shiftKey, e.metaKey || e.ctrlKey)}
                on:keydown={e => e.key === 'Enter' && (entry.is_dir ? navigate(entry.path, entry.name) : toggleSelect(entry.path))}
                on:contextmenu={(e) => showCtxMenu(e, entry)}
              >
                {#if selectable}
                  <div class="cb"
                    on:click|stopPropagation={(e) => toggleSelect(entry.path, e.shiftKey, e.metaKey || e.ctrlKey)}
                    role="checkbox" aria-checked={selected.has(entry.path)} tabindex="-1"
                    on:keydown={e => e.key === ' ' && toggleSelect(entry.path)}>
                    {selected.has(entry.path) ? '☑' : '☐'}
                  </div>
                {:else}
                  <div class="cb-placeholder"></div>
                {/if}

                {#if entry.is_dir}
                  <div class="dir-icon">{entry.is_symlink ? '🔗' : '📁'}</div>
                  <div class="entry-info">
                    <div class="entry-name" title={entry.is_symlink ? `→ symlink: ${entry.name}` : entry.name}>{entry.name}{entry.is_symlink ? ' ⇢' : ''}</div>
                    {#if !localMode && !cloudMode}
                      <div class="db-badge {cls}">{dirLabel(entry) || $t('fs_no_images')}</div>
                    {:else if cloudMode}
                      <div class="db-badge dir-cloud">{$t('fs_folder_label')}</div>
                    {/if}
                  </div>
                {:else}
                  <div class="file-thumb">
                    {#if !localMode && !cloudMode && entry.in_db && entry.image_id}
                      <img src={thumbnailUrl(entry.image_id, 80)} alt="" loading="lazy" />
                    {:else if (localMode && entry.is_image) || (cloudMode && isCloudImageFile(entry))}
                      <div class="file-icon">🖼</div>
                    {:else}
                      <div class="file-icon faded">📄</div>
                    {/if}
                  </div>
                  <div class="entry-info">
                    <div class="entry-name" title={entry.name}>{entry.name}</div>
                    {#if cloudMode}
                      <div class="db-badge {cls}">
                        {isCloudImageFile(entry) ? $t('fs_image_label') : $t('fs_file_label')}
                        {#if entry.size}{' · '}{(entry.size/1024).toFixed(0)} KB{/if}
                      </div>
                    {:else if localMode}
                      <div class="db-badge {entry.is_image ? 'local-img' : 'not-db'}">{entry.is_image ? $t('fs_image_label') : $t('fs_file_label')}</div>
                    {:else}
                      <div class="db-badge {cls}">{entry.in_db ? $t('fs_in_db') : $t('fs_not_in_db')}</div>
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
          </div>

        {:else}
          <!-- ── List / table view ── -->
          <table class="list-table no-select">
            <thead>
              <tr>
                <th class="lt-cb"></th>
                <th class="lt-icon"></th>
                <th class="lt-name">{$t('fs_name_col')}</th>
                {#if !localMode}
                  <th class="lt-status">{$t('fs_status_col')}</th>
                {/if}
                {#if cloudMode || (!localMode && !cloudMode)}
                  <th class="lt-size">{$t('fs_size_col')}</th>
                {/if}
              </tr>
            </thead>
            <tbody>
              {#each entries as entry (entry.path)}
                {@const selectable = isSelectable(entry)}
                {@const cls = cloudMode
                  ? (entry.is_dir ? 'dir-cloud' : isCloudImageFile(entry) ? 'cloud-img' : 'not-db')
                  : localMode
                    ? (entry.is_image ? 'in-db' : 'not-db')
                    : dbStatusClass(entry)}
                <tr
                  class:lt-selected={selected.has(entry.path)}
                  class:lt-dim={!selectable && !entry.is_dir}
                  on:click={(e) => entry.is_dir && !e.shiftKey && !e.metaKey && !e.ctrlKey
                    ? navigate(entry.path)
                    : toggleSelect(entry.path, e.shiftKey, e.metaKey || e.ctrlKey)}
                  on:keydown={e => e.key === 'Enter' && (entry.is_dir ? navigate(entry.path) : toggleSelect(entry.path))}
                  on:contextmenu={(e) => showCtxMenu(e, entry)}
                  role="row"
                  tabindex="0"
                >
                  <td class="lt-cb">
                    {#if selectable}
                      <div class="cb"
                        on:click|stopPropagation={(e) => toggleSelect(entry.path, e.shiftKey, e.metaKey || e.ctrlKey)}
                        role="checkbox" aria-checked={selected.has(entry.path)} tabindex="-1"
                        on:keydown={e => e.key === ' ' && toggleSelect(entry.path)}>
                        {selected.has(entry.path) ? '☑' : '☐'}
                      </div>
                    {/if}
                  </td>
                  <td class="lt-icon-cell">
                    {#if entry.is_dir}
                      📁
                    {:else if !localMode && !cloudMode && entry.in_db && entry.image_id}
                      <img class="lt-thumb" src={thumbnailUrl(entry.image_id, 50)} alt="" loading="lazy" on:error={(e) => e.target.style.display='none'} />
                    {:else if (localMode && entry.is_image) || (cloudMode && isCloudImageFile(entry))}
                      🖼
                    {:else}
                      <span style="opacity:0.35">📄</span>
                    {/if}
                  </td>
                  <td class="lt-name-cell">
                    <span class="lt-entry-name" title={entry.name}>{entry.name}</span>
                  </td>
                  {#if !localMode}
                    <td class="lt-status-cell">
                      <span class="db-badge {cls}">
                        {#if cloudMode}
                          {entry.is_dir ? $t('fs_folder_label') : isCloudImageFile(entry) ? $t('fs_image_label') : $t('fs_file_label')}
                        {:else}
                          {entry.is_dir ? (dirLabel(entry) || $t('fs_no_images')) : (entry.in_db ? $t('fs_in_db') : $t('fs_not_in_db'))}
                        {/if}
                      </span>
                    </td>
                  {/if}
                  {#if cloudMode || (!localMode && !cloudMode)}
                    <td class="lt-size-cell">
                      {#if entry.size != null}{(entry.size / 1024).toFixed(0)} KB{/if}
                    </td>
                  {/if}
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      {/if}
    </div>
  {/if}

  <!-- Cloud ops feedback message -->
  {#if cloudMode && cloudOpsMsg}
    <div class="cloud-ops-msg">
      {cloudOpsMsg}
      <button class="btn-sm" on:click={() => cloudOpsMsg = ''}>✕</button>
    </div>
  {/if}

  <!-- Bottom action bar -->
  {#if selected.size > 0 || adding || addDone}
    <div class="action-bar">
      {#if adding}
        <div class="progress-area">
          <div class="prog-label">
            {cloudMode ? $t('fs_fetching') : localMode ? $t('fs_uploading') : $t('fs_adding')}
            {addProgress.done}/{addProgress.total}
            {#if addProgress.current}— {addProgress.current}{/if}
            {#if addProgress.errors > 0}
              <span class="err-count">({addProgress.errors} {$t('errors_label')})</span>
            {/if}
          </div>
          <div class="prog-bar-wrap">
            <div
              class="prog-bar"
              style="width: {addProgress.total ? (addProgress.done / addProgress.total) * 100 : 0}%"
            ></div>
          </div>
          <button class="btn-sm" on:click={cancelAdd}>{$t('cancel')}</button>
        </div>
      {:else if addDone}
        <div class="done-block">
          <span class="done-msg">
            ✅ {addProgress.done - addProgress.errors - addProgress.skipped}
            {cloudMode ? $t('fs_fetching') : localMode ? $t('fs_uploading') : $t('fs_adding')} OK.
            {#if addProgress.skipped > 0}<span class="skip-count">{addProgress.skipped} {$t('fs_already_in_db')}</span>{/if}
            {#if addProgress.errors > 0}<span class="err-count">{addProgress.errors} {$t('errors_label')}</span>{/if}
          </span>
          {#if addErrorList.length > 0}
            <details class="err-details">
              <summary>{addErrorList.length} {$t('errors_label')}</summary>
              {#each addErrorList as {name, error}}
                <div class="err-item"><b>{name}</b>: {error}</div>
              {/each}
            </details>
          {/if}
          <button class="btn-sm" on:click={() => { addDone = false; addErrorList = []; clearSelection(); }}>{$t('dismiss')}</button>
        </div>
      {:else}
        <span class="sel-summary">{selected.size} {$t('selected_label')}</span>
        <select bind:value={visibility} class="vis-select" title="Visibility">
          <option value="shared">{$t('fs_shared')}</option>
          <option value="private">{$t('fs_private')}</option>
        </select>
        <button class="primary" on:click={startAddToDb}>
          {cloudMode ? '⬇ ' + $t('fs_add_to_db_cloud') : localMode ? '⬆ ' + $t('fs_upload_to_db') : $t('fs_add_to_db')}
        </button>
        {#if !cloudMode && !localMode && selectedInDbCount > 0}
          <button class="btn-sm" on:click={downloadSelected}>
            ⬇ {$t('download')} ({selectedInDbCount})
          </button>
        {/if}
        {#if cloudMode && cloudDriveId !== null}
          <button class="btn-sm" on:click={openRename}
            disabled={selected.size !== 1}>✏ {$t('fs_rename')}</button>
          <button class="btn-sm btn-trash" on:click={doTrash}>
            🗑 {cloudDriveType === 'smb' || cloudDriveType === 'sftp' ? $t('delete') : $t('fs_trash')}
          </button>
        {/if}
        <button class="btn-sm" on:click={clearSelection}>{$t('deselect')}</button>
      {/if}
    </div>
  {/if}
</div>

<!-- Context menu (filesystem entries) -->
<!-- svelte-ignore a11y-click-events-have-key-events -->
<svelte:window on:click={closeCtxMenu} on:keydown={(e) => e.key === 'Escape' && closeCtxMenu()} />
{#if ctxMenu}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <div
    class="fs-ctx-menu"
    bind:this={ctxMenuEl}
    style="top:{ctxMenu.y}px; left:{ctxMenu.x}px; opacity:{ctxVisible ? 1 : 0};"
    on:click|stopPropagation
  >
    {#if ctxMenu.entry.is_dir}
      <button on:click={() => handleCtxAction('navigate')}>📁 {$t('ctx_open_folder')}</button>
      <button on:click={() => handleCtxAction('browse-gallery')}>🔍 {$t('ctx_browse_folder')}</button>
      <div class="ctx-divider"></div>
      <button on:click={() => handleCtxAction('add-to-db')}>＋ {$t('fs_add_to_db')}</button>
      {#if cloudMode}
        <div class="ctx-divider"></div>
        <button on:click={() => handleCtxAction('rename')}>✏ {$t('fs_rename')}</button>
        <button on:click={() => handleCtxAction('trash')}>🗑 {$t('fs_trash')}</button>
      {/if}
    {:else}
      {#if !cloudMode && !localMode && ctxMenu.entry.in_db && ctxMenu.entry.image_id}
        <button on:click={() => handleCtxAction('view-lightbox')}>👁 {$t('view')}</button>
        <button on:click={() => handleCtxAction('browse-gallery')}>🔍 {$t('ctx_browse_folder')}</button>
        <div class="ctx-divider"></div>
        <button on:click={() => handleCtxAction('download')}>⬇ {$t('download')}</button>
        <button on:click={() => handleCtxAction('open-os')}>🖼 {$t('ctx_open_external')}</button>
        <button on:click={() => handleCtxAction('open-folder-os')}>📂 {$t('ctx_open_folder')}</button>
        <div class="ctx-divider"></div>
      {:else if !cloudMode && !localMode}
        <button on:click={() => handleCtxAction('add-to-db')}>＋ {$t('fs_add_to_db')}</button>
        <div class="ctx-divider"></div>
      {/if}
      {#if cloudMode}
        <button on:click={() => handleCtxAction('add-to-db')}>⬇ {$t('fs_add_to_db_cloud')}</button>
        <div class="ctx-divider"></div>
        <button on:click={() => handleCtxAction('rename')}>✏ {$t('fs_rename')}</button>
        <button on:click={() => handleCtxAction('trash')}>🗑 {$t('fs_trash')}</button>
        <div class="ctx-divider"></div>
      {/if}
      <button on:click={() => handleCtxAction('copy-path')}>📋 {$t('ctx_copy_path')}</button>
    {/if}
  </div>
{/if}

<!-- Rename modal -->
{#if renameModal}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <div class="modal-backdrop" on:click|self={() => renameModal = null}>
    <div class="rename-modal">
      <div class="rename-title">{$t('fs_rename')}</div>
      <div class="rename-path">{renameModal.path}</div>
      <input
        class="rename-input"
        type="text"
        bind:value={renameValue}
        on:keydown={e => { if (e.key === 'Enter') doRename(); else if (e.key === 'Escape') renameModal = null; }}
        autofocus
      />
      <div class="rename-actions">
        <button on:click={() => renameModal = null}>{$t('cancel')}</button>
        <button class="primary" on:click={doRename} disabled={!renameValue.trim() || renameValue.trim() === renameModal.name}>
          {$t('fs_rename')}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .fs-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  /* ── Mode toggle ── */
  .mode-toggle {
    display: flex;
    border: 1px solid #2a2a3a;
    border-radius: 5px;
    overflow: hidden;
    flex-shrink: 0;
  }
  .mode-btn {
    background: #141422;
    border: none;
    color: #606080;
    font-size: 11px;
    padding: 4px 10px;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
    white-space: nowrap;
  }
  .mode-btn:hover { background: #1e1e30; color: #a0a0c0; }
  .mode-btn.active { background: #2a3a5a; color: #a0c0ff; }

  .mode-banner {
    font-size: 11px;
    padding: 5px 12px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .local-banner { background: #1a2a1a; color: #60a060; border-bottom: 1px solid #2a3a2a; }
  .cloud-banner { background: #1a1a2e; color: #8090d0; border-bottom: 1px solid #2a2a4a; }
  .drive-type-tag {
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 4px;
    background: #252540;
    color: #6070a0;
    font-weight: 600;
  }

  /* ── Nav ── */
  .nav-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    border-bottom: 1px solid #2a2a3a;
    flex-shrink: 0;
    overflow: hidden;
  }
  .up-btn {
    background: #1e1e2e;
    border: 1px solid #3a3a5a;
    padding: 4px 8px;
    font-size: 13px;
  }
  .breadcrumbs {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 1;
    overflow: hidden;
    min-width: 0;
  }
  .crumb {
    background: transparent;
    border: none;
    color: #8090c0;
    font-size: 11px;
    padding: 2px 3px;
    cursor: pointer;
    white-space: nowrap;
  }
  .crumb:hover { color: #b0c0f0; }
  .crumb.cloud-root {
    color: #7090c0;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .crumb.cloud-root:hover { color: #a0c0f0; }
  .crumb-sep { color: #3a3a5a; font-size: 11px; }
  .crumb-hint { font-size: 11px; color: #404060; font-style: italic; }
  .path-input { flex: 2; max-width: 320px; font-size: 11px; }

  /* ── View toggle ── */
  .view-toggle {
    display: flex;
    border: 1px solid #2a2a3a;
    border-radius: 5px;
    overflow: hidden;
    flex-shrink: 0;
    margin-left: 2px;
  }
  .view-btn {
    background: #141422;
    border: none;
    color: #606080;
    font-size: 14px;
    padding: 3px 8px;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }
  .view-btn:hover { background: #1e1e30; color: #a0a0c0; }
  .view-btn.active { background: #2a3a5a; color: #a0c0ff; }

  .error-bar {
    background: #3a1a1a;
    color: #e06060;
    padding: 6px 12px;
    font-size: 11px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .err-dismiss {
    margin-left: auto;
    background: transparent;
    color: #e06060;
    border-color: #6a2020;
  }

  /* ── Cloud picker ── */
  .cloud-picker {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
  }
  .picker-loading,
  .picker-title { font-size: 12px; color: #7080a0; margin-bottom: 10px; }
  .picker-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: #505070;
    font-size: 13px;
  }
  .picker-icon { font-size: 40px; }
  .picker-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .picker-card {
    display: flex;
    align-items: center;
    gap: 10px;
    background: #1a1a2a;
    border: 1px solid #2a2a3a;
    border-radius: 7px;
    padding: 10px 14px;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
  }
  .picker-card.mounted:hover { background: #1e2040; border-color: #3a4a8a; }
  .picker-card.offline { opacity: 0.55; cursor: not-allowed; }
  .picker-icon-sm { font-size: 20px; flex-shrink: 0; }
  .picker-meta { flex: 1; display: flex; align-items: center; gap: 8px; min-width: 0; }
  .picker-name { font-size: 13px; font-weight: 600; color: #c0c8e0; }
  .picker-badge {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 4px;
    background: #252540;
    color: #6070a0;
    font-weight: 600;
  }
  .picker-status { display: flex; align-items: center; gap: 5px; flex-shrink: 0; }
  .status-dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    background: #404060;
  }
  .status-dot.on { background: #40a060; }
  .status-text { font-size: 11px; color: #607090; }
  .hint { font-size: 11px; color: #404060; }

  /* ── Content ── */
  .content {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
  }

  .select-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 2px 8px;
    flex-shrink: 0;
  }
  .sel-count { font-size: 11px; color: #505070; margin-left: 4px; }
  .sel-hint  { font-size: 10px; color: #404058; }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 6px;
  }
  .no-select { user-select: none; -webkit-user-select: none; }

  .entry {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    background: #1a1a28;
    border: 1px solid #242438;
    border-radius: 5px;
    cursor: pointer;
    transition: background 0.1s, border-color 0.1s;
    min-width: 0;
    position: relative;
  }
  .entry:hover { background: #202035; border-color: #3a3a60; }
  .entry.selected { border-color: #4a6fa5; background: #1a2040; }
  .entry.not-selectable { opacity: 0.5; cursor: default; }

  .cb {
    font-size: 14px;
    color: #606080;
    flex-shrink: 0;
    cursor: pointer;
  }
  .cb-placeholder { width: 16px; flex-shrink: 0; }
  .entry.selected .cb { color: #5080c0; }

  .dir-icon { font-size: 22px; flex-shrink: 0; }

  .file-thumb {
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    border-radius: 3px;
    overflow: hidden;
    background: #0e0e18;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .file-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .file-icon { font-size: 18px; }
  .file-icon.faded { opacity: 0.35; }

  .entry-info { flex: 1; min-width: 0; }
  .entry-name {
    font-size: 11px;
    color: #c0c0d8;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .db-badge {
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 8px;
    margin-top: 3px;
    display: inline-block;
  }
  .in-db      { background: #1a3a28; color: #50c878; }
  .not-db     { background: #2a2a3a; color: #505070; }
  .partial-db { background: #3a2a10; color: #d0903a; }
  .dir-empty  { background: #2a2a3a; color: #404060; }
  .local-img  { background: #1a2a3a; color: #6090c0; }
  .cloud-img  { background: #1a2040; color: #7090d0; }
  .dir-cloud  { background: #1e2030; color: #6070a0; }

  /* ── Action bar ── */
  .action-bar {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 8px 12px;
    border-top: 1px solid #2a2a3a;
    background: #16161f;
    flex-shrink: 0;
  }
  .sel-summary { font-size: 12px; color: #a0a0c0; flex: 1; }
  .vis-select { font-size: 11px; padding: 3px 6px; width: 90px; }
  .progress-area { display: flex; align-items: center; gap: 8px; flex: 1; }
  .prog-label { font-size: 11px; color: #8090b0; flex: 1; }
  .prog-bar-wrap {
    width: 120px;
    height: 6px;
    background: #2a2a42;
    border-radius: 3px;
    overflow: hidden;
  }
  .prog-bar { height: 100%; background: #4a6fa5; transition: width 0.2s; }
  .err-count  { color: #e06060; margin-left: 4px; }
  .skip-count { color: #8090b0; margin-left: 4px; }
  .done-block { display: flex; flex-direction: column; gap: 6px; flex: 1; }
  .done-msg   { font-size: 12px; color: #50c878; }
  .btn-sm     { font-size: 11px; padding: 4px 10px; align-self: flex-start; }

  .err-details {
    font-size: 11px;
    color: #e06060;
    background: #2a1212;
    border: 1px solid #4a2020;
    border-radius: 4px;
    padding: 4px 8px;
    max-height: 120px;
    overflow-y: auto;
  }
  .err-details summary { cursor: pointer; color: #c05050; margin-bottom: 4px; }
  .err-item { padding: 2px 0; color: #c05050; word-break: break-all; }

  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 200px;
    color: #404060;
    font-size: 13px;
  }

  button { padding: 5px 12px; font-size: 12px; }
  .primary { background: #2a4a8a; border-color: #3a6aba; color: #c0d8ff; }

  /* ── FSA local mode ── */
  .fsa-prompt {
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; height: 200px; gap: 12px;
  }
  .fsa-icon { font-size: 48px; }
  .fsa-prompt p { font-size: 13px; color: #6080a0; text-align: center; max-width: 280px; margin: 0; }
  .fsa-hint { font-size: 10px; color: #505060; margin-left: 8px; }

  /* ── Fallback local mode (no FSA) ── */
  .fallback-local {
    flex: 1; padding: 16px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto;
  }
  .fallback-pick-row { display: flex; gap: 8px; flex-wrap: wrap; }
  .fallback-hint { font-size: 12px; color: #505070; margin: 0; }
  .fallback-file-list {
    display: flex; flex-direction: column; gap: 3px;
    max-height: 300px; overflow-y: auto;
    border: 1px solid #2a2a3a; border-radius: 5px; padding: 6px;
  }
  .fallback-file-row {
    display: flex; align-items: center; gap: 8px;
    font-size: 11px; padding: 3px 4px; border-radius: 3px;
  }
  .fallback-file-row:hover { background: #1e1e2e; }
  .fb-name { flex: 1; color: #b0b8d0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fb-size { color: #505070; flex-shrink: 0; }
  .fallback-actions { display: flex; align-items: center; gap: 8px; }
  .dv-progress { font-size: 11px; color: #8090b0; display: flex; align-items: center; }
  .dv-done { font-size: 11px; color: #50c878; display: flex; align-items: center; }

  /* ── List / table view ── */
  .list-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    color: #c0c0d8;
  }
  .list-table thead th {
    text-align: left;
    padding: 5px 8px;
    border-bottom: 1px solid #2a2a3a;
    font-size: 10px;
    color: #606080;
    text-transform: uppercase;
    font-weight: 600;
    white-space: nowrap;
  }
  .list-table tbody tr {
    cursor: pointer;
    border-bottom: 1px solid #1e1e28;
    transition: background 0.1s;
  }
  .list-table tbody tr:hover { background: #1e1e2e; }
  .list-table tbody tr.lt-selected { background: #1a2040; border-left: 2px solid #4a6fa5; }
  .list-table tbody tr.lt-dim { opacity: 0.45; cursor: default; }
  .list-table td { padding: 5px 8px; vertical-align: middle; }
  .lt-cb { width: 20px; padding: 5px 4px !important; }
  .lt-icon-cell { width: 28px; font-size: 16px; text-align: center; padding: 4px !important; }
  .lt-thumb { width: 28px; height: 28px; object-fit: cover; border-radius: 2px; display: block; }
  .lt-name-cell { flex: 1; }
  .lt-entry-name {
    font-size: 12px;
    color: #c0c0d8;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 400px;
    display: block;
  }
  .lt-status-cell { white-space: nowrap; }
  .lt-size-cell { color: #505070; font-size: 10px; white-space: nowrap; text-align: right; }

  /* ── Cloud file ops ── */
  .cloud-ops-msg {
    background: #1a2a1a;
    color: #70c070;
    font-size: 11px;
    padding: 5px 12px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    border-bottom: 1px solid #2a3a2a;
  }
  .btn-trash { color: #c07070; }
  .btn-trash:hover { background: #2a1a1a; color: #e08080; }

  /* ── Rename modal ── */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }
  .rename-modal {
    background: #1a1a2e;
    border: 1px solid #3a3a5a;
    border-radius: 8px;
    padding: 18px;
    width: 360px;
    max-width: 95vw;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .rename-title { font-size: 13px; font-weight: 600; color: #c0c8e0; }
  .rename-path { font-size: 10px; color: #505070; word-break: break-all; }
  .rename-input {
    background: #111120;
    border: 1px solid #3a3a5a;
    border-radius: 4px;
    color: #c0c8e0;
    font-size: 12px;
    padding: 6px 8px;
  }
  .rename-actions { display: flex; justify-content: flex-end; gap: 8px; }

  /* ── Filesystem context menu ── */
  .fs-ctx-menu {
    position: fixed;
    background: #2a2a42;
    border: 1px solid #4a4a6a;
    border-radius: 8px;
    padding: 4px;
    min-width: 190px;
    box-shadow: 0 10px 25px rgba(0,0,0,0.55);
    z-index: 3000;
    display: flex;
    flex-direction: column;
    transition: opacity 0.07s;
  }
  .fs-ctx-menu button {
    background: transparent;
    border: none;
    color: #e0e0e0;
    text-align: left;
    padding: 7px 12px;
    font-size: 12px;
    border-radius: 4px;
    cursor: pointer;
    width: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .fs-ctx-menu button:hover { background: #3a3a5a; color: #a0c4ff; }
  .ctx-divider { height: 1px; background: #3a3a5a; margin: 4px; }
</style>
