<script>
  import { streamBatchFiles, streamBatch, scanFolder, thumbnailUrl, fetchStats, fetchPeople, fetchTags, fetchAlbums, importProcessed, uploadLocal, createBatchJob, uploadBatchFile, addFileToBatchJob, isLocalMode, fetchSettings, fetchCreators, fetchCopyrights } from '../api.js';
  import { t, stats, allPeople, allTags, allAlbums, processingMode, localModel, galleryRefreshTick, sidebarView, processingBackend } from '../stores.js';
  import { onMount } from 'svelte';
  import ServerDirPicker from './ServerDirPicker.svelte';
  import syncManager from './SyncManager.js';

  // Detect standalone (local SQLite) mode — no server required
  const localMode = isLocalMode();

  let fileInput;
  let folderInput;
  let serverPickerOpen = false;
  const inElectron = typeof window !== 'undefined' && !!window.electronAPI;
  // Capacitor/mobile: window.Capacitor is injected by the Capacitor runtime
  const isMobile = typeof window !== 'undefined' && !!window.Capacitor;

  // Pre-import Camera plugin eagerly to avoid the 2-click bug on iOS.
  // On first click Capacitor needs the plugin already loaded; dynamic import on click
  // causes the first tap to just resolve the import without opening the picker.
  let _CameraPlugin = null;
  if (isMobile) {
    import('@capacitor/camera').then(m => {
      _CameraPlugin = m.Camera;
      console.log('[ProcessView] @capacitor/camera pre-loaded');
    }).catch(() => {});
  }

  // ── Web / mobile local inference ───────────────────────────────────────────
  // When enabled, files are processed locally (onnxruntime-web + Canvas) and
  // only 512D vectors + thumbnail are posted to the server (import-processed).
  // Works in any browser/PWA — especially useful on mobile where the user can
  // take photos and have faces recognised without uploading full images.
  let webLocalInfer = false;   // toggle; persists across the session
  let webInferMsg   = '';      // per-item progress message from FaceEngineWeb
  let _engineWebModule = null; // lazy import

  async function _getWebEngine() {
    if (!_engineWebModule) {
      _engineWebModule = await import('./FaceEngineWeb.js');
    }
    return _engineWebModule.default || _engineWebModule.faceEngineWeb;
  }

  const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.pgm']);
  function isImage(name) { return IMAGE_EXTS.has(name.slice(name.lastIndexOf('.')).toLowerCase()); }

  /** Compute SHA-256 hash of a File object. Returns hex string or null on failure. */
  async function _computeFileHash(file) {
    try {
      const buf = await file.arrayBuffer();
      const hashBuf = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch { return null; }
  }

  // ── Queue ──────────────────────────────────────────────────────────────────
  // Each item: { id, path, name, file, status: 'pending'|'processing'|'done'|'error'|'queued',
  //              imageId, faces, people, sceneType, description, error, msg }
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

  function retryItem(id) {
    if (running) return;
    queue = queue.map(q => q.id === id ? { ...q, status: 'pending', error: '' } : q);
    finished = false;
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

  function pickFiles() {
    console.log('[ProcessView] pickFiles() clicked');
    if (inElectron) {
      window.electronAPI.openFileDialog({ multiple: true }).then(paths => {
        if (paths?.length) addPaths(paths);
      });
    } else if (localMode && isMobile) {
      pickPhotosFromLibrary();
    } else {
      if (fileInput) {
        console.log('[ProcessView] Triggering click on fileInput ref');
        fileInput.click();
      }
    }
  }

  /** Pick photos from the iOS/Android photo library via @capacitor/camera. */
  async function pickPhotosFromLibrary() {
    // Use pre-imported plugin (avoids 2-click bug on iOS where first tap just
    // loads the dynamic import without actually opening the photo picker).
    const Camera = _CameraPlugin ?? (await import('@capacitor/camera').then(m => {
      _CameraPlugin = m.Camera;
      return m.Camera;
    }).catch(() => null));

    if (!Camera) {
      fileInput?.click();
      return;
    }
    try {
      const result = await Camera.pickImages({ quality: 90, limit: 50 });
      if (!result.photos?.length) return;
      const newItems = result.photos
        .filter(p => {
          const key = p.path || p.webPath;
          return !queue.find(q => q.path === key || q.webPath === p.webPath);
        })
        .map(p => {
          // Extract original filename from native path (permanent) or webPath
          const originPath = p.path || '';  // e.g. /var/mobile/Media/DCIM/100APPLE/IMG_0042.HEIC
          const originName = originPath
            ? originPath.split('/').pop()
            : (p.webPath || 'photo').split('/').pop();
          return {
            id: nextId++,
            path: originPath || p.webPath,  // native path preferred — used as local_path
            webPath: p.webPath,              // Capacitor URL — used only for loading/inference
            name: originName,
            file: null,
            status: 'pending',
            imageId: null, faces: 0, people: [], sceneType: '', description: '', error: '',
          };
        });
      queue = [...queue, ...newItems];
    } catch (e) {
      if (e.message !== 'User cancelled photos app') console.error('Camera picker error:', e);
    }
  }

  function pickFolder() {
    console.log('[ProcessView] pickFolder() clicked');
    if (inElectron) {
      window.electronAPI.openFolderDialog().then(folder => {
        if (folder) addFolderPaths(folder);
      });
    } else {
      if (folderInput) {
        console.log('[ProcessView] Triggering click on folderInput ref');
        folderInput.click();
      }
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

  // ── Tag + Album + Creator + Copyright pickers ─────────────────────────────
  // selectedTags: Array<{id: number|null, name: string}>
  //   id=null means "create new tag"; id=<number> means existing tag
  let selectedTags = [];
  let tagInput = '';
  let tagDropdownOpen = false;

  // selectedAlbum: {id: number|null, name: string} | null
  let selectedAlbum = null;
  let albumInput = '';
  let albumDropdownOpen = false;

  // Creator / Copyright — single free-text with autocomplete from existing DB values
  let creatorInput = '';
  let creatorDropdownOpen = false;
  let allCreators = [];

  let copyrightInput = '';
  let copyrightDropdownOpen = false;
  let allCopyrights = [];

  $: filteredCreators = allCreators.filter(c =>
    creatorInput.trim() && c.toLowerCase().includes(creatorInput.trim().toLowerCase())
  );
  $: filteredCopyrights = allCopyrights.filter(c =>
    copyrightInput.trim() && c.toLowerCase().includes(copyrightInput.trim().toLowerCase())
  );

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
  let batchJobError = '';      // errors from server-folder batch job creation
  let batchQueueStatus = '';   // progress messages for queue → batch job creation
  let batchQueueError = '';    // errors from queue → batch job creation

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

    // Load tags + albums + creators + copyrights for pickers
    try { allTags.set(await fetchTags()); } catch {}
    try { allAlbums.set(await fetchAlbums()); } catch {}
    try { allCreators   = await fetchCreators(); }   catch {}
    try { allCopyrights = await fetchCopyrights(); } catch {}

    // Initialize VLM toggle from global settings
    try {
      const s = await fetchSettings();
      skipVlm = !(s?.vlm?.enabled ?? false);
      console.log(`[ProcessView] VLM skip toggle initialized to: ${skipVlm} (global enabled: ${s?.vlm?.enabled})`);
    } catch (e) {
      console.warn('[ProcessView] Failed to fetch settings for VLM toggle init:', e);
    }
  });

  // ── Detection settings ─────────────────────────────────────────────────────
  let detThresh    = 0.5;
  let minFaceSize  = 60;
  let recThresh    = 0.4;
  let detModel     = 'auto';
  let maxSize      = 0;
  let skipFaces    = false;
  let skipVlm      = false;
  let showDetParams = false;

  const LOCAL_DET_MODELS = [
    { value: 'auto',  label: 'det_model_auto'  },
    { value: 'yunet', label: 'det_model_yunet' },
    { value: 'none',  label: 'det_model_none'  },
  ];
  const REMOTE_DET_MODELS = [
    { value: 'auto',       label: 'det_model_auto'       },
    { value: 'retinaface', label: 'det_model_retinaface' },
    { value: 'scrfd',      label: 'det_model_scrfd'      },
    { value: 'yunet',      label: 'det_model_yunet'      },
    { value: 'mediapipe',  label: 'det_model_mediapipe'  },
    { value: 'none',       label: 'det_model_none'       },
  ];
  $: DET_MODELS = $processingBackend === 'remote_v2' ? REMOTE_DET_MODELS
               : $processingBackend === 'remote_v4' ? LOCAL_DET_MODELS  // v4 remote = same as local (no retinaface/mediapipe)
               : LOCAL_DET_MODELS;

  // ── Standalone VLM Status ──
  let vlmStatusMsg = '';
  let vlmKeys = {}; // track available keys locally for status check
  $: {
    if (localMode) {
      fetchSettings().then(s => {
        if (!s?.vlm?.enabled) {
          vlmStatusMsg = 'AI Enrichment (VLM) is currently disabled in Settings.';
        } else {
          // Also check if we have a key for the provider
          const provider = s?.vlm?.provider || 'anthropic';
          const { localAdapter } = import('./LocalAdapter.js').then(la => {
            la.localAdapter.getVlmKeys().then(keys => {
              vlmKeys = keys;
              if (!keys[provider]) {
                vlmStatusMsg = `⚠ VLM is enabled but no API key found for ${provider} in Settings.`;
              } else {
                vlmStatusMsg = '';
              }
            });
          });
        }
      }).catch(() => {});
    }
  }

  $: detParams = {
    det_thresh:    detThresh,
    min_face_size: minFaceSize,
    rec_thresh:    recThresh,
    det_model:     detModel,
    max_size:      maxSize,
    skip_faces:    skipFaces,
    skip_vlm:      skipVlm,
  };

  // ── Processing state ───────────────────────────────────────────────────────
  let running = false;
  let batchSource = null;
  let totalCount = 0;
  let doneCount = 0;
  let errorCount = 0;
  let queuedCount = 0;       // queued offline; will push on reconnect
  let skippedCount = 0;      // same-user duplicate (already uploaded by this user)
  let sharedDupCount = 0;    // cross-user shared duplicate (another user uploaded the same content)
  let dupSkippedCount = 0;   // skipped due to duplicate_mode=skip
  // duplicate_mode: 'skip' | 'overwrite' | 'always_add'
  let duplicateMode = 'skip';
  let finished = false;
  let cancelled = false;
  let visibility = 'shared'; // 'shared' | 'private'
  // Optional base folder for browser mode (browser can't expose full path).
  // Example: "/Users/alice/Downloads/pics" — prepended to bare filenames.
  let localBasePath = '';

  $: pendingItems    = queue.filter(q => q.status === 'pending');
  $: processingItem  = queue.find(q => q.status === 'processing');
  $: doneItems       = queue.filter(q => q.status === 'done' || q.status === 'error' || q.status === 'skipped' || q.status === 'queued');
  $: progressPct     = totalCount > 0 ? Math.round(doneCount / totalCount * 100) : 0;

  function startProcessing() {
    // Standalone local mode always uses on-device ONNX inference
    if (localMode) { startWebLocalInfer(); return; }
    if (webLocalInfer && !inElectron) { startWebLocalInfer(); return; }
    if ($processingMode === 'local_process') { startLocalProcess(); return; }
    startUploadFull();
  }

  // ── Web local inference — onnxruntime-web + Canvas → import-processed ────
  async function startWebLocalInfer() {
    console.log('[ProcessView] startWebLocalInfer() start');
    const pending = queue.filter(q => q.status === 'pending');
    if (!pending.length) {
      console.warn('[ProcessView] No pending items to process');
      return;
    }
    
    running = true; finished = false; cancelled = false;
    errorCount = 0; queuedCount = 0; doneCount = 0; dupSkippedCount = 0; totalCount = pending.length;

    let engine;
    let vlmCfg = {};
    let vlmKeys = {};
    let syncCfg = {};
    let detRetries = 1;
    let thumb_size_final = 200;

    try {
      console.log('[ProcessView] Initializing web engine...');
      engine = await _getWebEngine();
      
      // Load current settings to get VLM provider/model
      console.log('[ProcessView] Fetching settings for VLM config...');
      const s = await fetchSettings();
      console.log('[ProcessView] Settings retrieved:', s);
      vlmCfg = s?.vlm || {};
      detRetries = s?.face_recognition?.insightface?.det_retries ?? 1;

      // In local mode, we need to fetch keys manually to pass to engine
      if (localMode) {
        const { localAdapter } = await import('./LocalAdapter.js');
        vlmKeys = await localAdapter.getVlmKeys();
        console.log('[ProcessView] Local VLM keys fetched:', Object.keys(vlmKeys));
      }

      // Also get sync settings for thumbnail size
      const { loadSyncSettings } = await import('./SyncManager.js');
      syncCfg = loadSyncSettings();
      thumb_size_final = syncCfg.thumbSize || 200;
      
      const modelBase = localMode
        ? '/ort-wasm'
        : ((localStorage.getItem('remote_url') || window.location.origin) + '/models');
      console.log('[ProcessView] Setting model base URL:', modelBase);
      engine.setModelBaseUrl(modelBase);
    } catch (e) {
      console.error('[ProcessView] Engine or settings load failed:', e);
      errorCount = pending.length;
      queue = queue.map(q => q.status === 'pending' ? { ...q, status: 'error', error: 'Engine load failed: ' + e.message } : q);
      running = false; finished = true;
      return;
    }

    for (const item of pending) {
      if (cancelled) break;
      console.log(`[ProcessView] Processing item ${doneCount + 1}/${totalCount}: ${item.name} (${item.path})`);

      // Resolve the File object — from browser File, or by fetching a Capacitor webPath
      let fileObj = item.file;
      if (!fileObj && item.webPath) {
        try {
          const blob = await fetch(item.webPath).then(r => r.blob());
          fileObj = new File([blob], item.name || 'photo.jpg', { type: blob.type || 'image/jpeg' });
        } catch (fetchErr) {
          console.error(`[ProcessView] Could not load photo for ${item.name}:`, fetchErr);
          errorCount++;
          queue = queue.map(q => q.id === item.id ? { ...q, status: 'error', error: 'Could not load photo: ' + fetchErr.message } : q);
          doneCount++;
          continue;
        }
      }

      if (!fileObj) {
        console.error(`[ProcessView] No file object for ${item.name}`);
        errorCount++;
        queue = queue.map(q => q.id === item.id ? { ...q, status: 'error', error: 'No file object — web local inference requires direct file selection' } : q);
        doneCount++;
        continue;
      }
            queue = queue.map(q => q.id === item.id ? { ...q, status: 'processing' } : q);
            try {
              // ── Duplicate pre-check for 'skip' mode ────────────────────────
              // Compute file hash cheaply before running expensive ONNX inference.
              if (duplicateMode === 'skip' && localMode) {
                const { localAdapter: la } = await import('./LocalAdapter.js');
                const quickHash = await _computeFileHash(fileObj);
                console.log(`[ProcessView] Pre-check hash for ${item.name}: ${quickHash?.slice(0,12)}…`);
                if (quickHash) {
                  const existing = await la.checkDuplicate(quickHash, null);
                  if (existing) {
                    console.log(`[ProcessView] Duplicate found (imageId=${existing}) — skipping ${item.name}`);
                    dupSkippedCount++;
                    queue = queue.map(q => q.id === item.id
                      ? { ...q, status: 'skipped', msg: $t('pv_dup_skipped') }
                      : q);
                    doneCount++;
                    continue;
                  }
                }
              }

              console.log(`[ProcessView] Running engine.processFile for ${item.name}...`);

              // VLM should run if the user hasn't checked 'Skip VLM' in the dialog.
              const vlmEnabledFinal = !detParams.skip_vlm;
              console.log(`[ProcessView] VLM skip toggle value: ${detParams.skip_vlm}, vlmEnabledFinal: ${vlmEnabledFinal}, provider: ${vlmCfg.provider}`);

              const faceData = await engine.processFile(fileObj, {
                det_thresh:    detParams.det_thresh,
                min_face_size: detParams.min_face_size,
                det_model:     detParams.det_model,
                max_retries:   detRetries,
                visibility,
                vlm_enabled:   vlmEnabledFinal,
                vlm_provider:  vlmCfg.provider,
                vlm_model:     vlmCfg.model,
                vlm_prompt:    $t('vlm_prompt'),
                vlm_keys:      vlmKeys,
                thumb_size:    thumb_size_final,
                onProgress: (msg) => { webInferMsg = `[${item.name}] ${msg}`; },
              });

              console.log(`[ProcessView] processFile OK for ${item.name}. VLM description present: ${!!faceData.description}. Importing results...`);
              if (vlmEnabledFinal && !faceData.description) {
                console.warn('[ProcessView] VLM was enabled but NO DESCRIPTION was returned.');
              }

              // Always preserve the original filename so it shows correctly in the image browser.
              if (item.name) faceData.filename = item.name;
              // Preserve origin path (local_path) — the full native path if available.
              const nativePath = item.path;
              if (nativePath && !nativePath.startsWith('blob:') && nativePath !== item.name) {
                faceData.local_path = nativePath;
                if (localMode || inElectron) faceData.filepath = nativePath;
              }
              console.log(`[ProcessView] Importing: filename=${faceData.filename} filepath=${faceData.filepath} local_path=${faceData.local_path || '—'} hash=${faceData.file_hash ? faceData.file_hash.slice(0,12)+'…' : '—'} dup_mode=${duplicateMode}`);

              const resp = await importProcessed({ ...faceData, duplicate_mode: duplicateMode,
                creator: creatorInput.trim() || null, copyright: copyrightInput.trim() || null });

              if (resp.skipped) {
                console.log(`[ProcessView] Import skipped (duplicate) for ${item.name}`);
                dupSkippedCount++;
                queue = queue.map(q => q.id === item.id
                  ? { ...q, status: 'skipped', msg: $t('pv_dup_skipped') }
                  : q);
              } else {
                console.log(`[ProcessView] Import OK for ${item.name}, imageId: ${resp.image_id}`);
                queue = queue.map(q => q.id === item.id
                  ? {
                      ...q,
                      status: 'done',
                      imageId: resp.image_id,
                      faces: resp.face_count ?? faceData.faces.length,
                      description: faceData.description || resp.description,
                      sceneType: resp.scene_type || faceData.scene_type,
                      tags: faceData.tags || resp.tags,
                      people: resp.people || []
                    }
                  : q);
              }

              // Short pause to allow GC and UI thread breathing room (especially for Android)
              await new Promise(r => setTimeout(r, 300));
      } catch (e) {
        console.error(`[ProcessView] Processing failed for ${item.name}:`, e);
        if (!navigator.onLine || /fetch|network|Failed/i.test(e.message)) {
          console.warn('[ProcessView] Offline, queuing for push later');
          // Offline — queue payload locally; push to server on next reconnect
          await syncManager.queueForPush(faceData).catch(() => {});
          queue = queue.map(q => q.id === item.id
            ? { ...q, status: 'queued', msg: $t('pv_queued_offline') }
            : q);
          queuedCount++;
        } else {
          errorCount++;
          queue = queue.map(q => q.id === item.id ? { ...q, status: 'error', error: e.message } : q);
        }
      }
      doneCount++;
    }
    webInferMsg = '';
    running = false; finished = true;
    console.log('[ProcessView] startWebLocalInfer() finished');
    
    // Release ONNX models immediately after batch — they hold ~200 MB of WASM heap.
    // Keeping them alive for even a few seconds after the batch risks an OOM kill
    // on mobile and browser tabs. Re-loading on the next batch takes ~2-3 s and is
    // preferable to crashing.
    try {
      const e = await _getWebEngine();
      if (e && typeof e.releaseModels === 'function') await e.releaseModels();
    } catch (err) {
      console.warn('[ProcessView] Error releasing models after batch:', err);
    }

    refreshGlobalData();
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
        const isAbsolute = /^\/|^[a-zA-Z]:\\/.test(item.path);
        const pathForServer = (base && !isAbsolute)
          ? `${base}/${item.path}`
          : item.path;
        console.log('[ProcessView] upload-local | item.path=%s | localBasePath=%s | pathForServer=%s',
          item.path ?? '(none)', base || '(none)', pathForServer);
        const resp   = await uploadLocal(buffer, pathForServer, visibility, detParams,
          { tagIds: existingTagIds, newTagNames, albumId: selectedAlbum?.id ?? null, newAlbumName: selectedAlbum?.id == null ? selectedAlbum?.name ?? null : null,
            creator: creatorInput.trim() || null, copyright: copyrightInput.trim() || null });
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
            ? {
                ...q, status: 'done', imageId: resp.image_id, faces: resp.face_count ?? 0,
                description: resp.vlm?.description ?? '',
                sceneType:   resp.vlm?.scene_type  ?? '',
                tags:        resp.vlm?.tags        ?? [],
              }
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
          const resp = await importProcessed({ ...result, local_model: $localModel, duplicate_mode: duplicateMode });
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
        sceneType: r.scene_type ?? r.vlm?.scene_type ?? '',
        description: r.vlm?.description ?? '',
        tags: r.tags ?? r.vlm?.tags ?? [],
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
    batchQueueStatus = $t('bj_enum_started');
    batchQueueError = '';

    try {
      // 1. Create the empty job record first
      const jobResp = await createBatchJob({
        batch_files: [], // Start empty; files added one by one below
        visibility,
        det_params: detParams,
        tag_ids: existingTagIds,
        new_tag_names: newTagNames,
        album_id: selectedAlbum?.id ?? null,
        new_album_name: selectedAlbum?.id == null ? selectedAlbum?.name ?? null : null,
      });
      const jobId = jobResp.job_id || jobResp.id;

      // 2. Upload files to server and register them in the job
      let uploadIdx = 0;
      for (const item of pending) {
        batchQueueStatus = `${$t('pv_uploading_progress').replace('{n}', ++uploadIdx).replace('{total}', pending.length)}`;

        const buffer = item.file
          ? await item.file.arrayBuffer()
          : await window.electronAPI.readLocalFile(item.path);

        const base = localBasePath.trim().replace(/\/+$/, '');
        const isAbsolute = /^\/|^[a-zA-Z]:\\/.test(item.path);
        const pathForServer = (base && !isAbsolute)
          ? `${base}/${item.path}`
          : item.path;

        // Upload bytes to temporary server staging area
        const { server_path } = await uploadBatchFile(buffer, pathForServer);

        // Register file in the persistent job
        await addFileToBatchJob(jobId, { filepath: server_path, local_path: pathForServer });
      }

      batchQueueStatus = '';
      sidebarView.set('batchjobs');
    } catch (e) {
      batchQueueStatus = '';
      batchQueueError = e.message;
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
      {#if !inElectron && webLocalInfer}
        <span class="mode-badge mobile">🔬 {$t('pv_mode_web_infer')}</span>
      {:else if $processingMode === 'local_process'}
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
           bind:this={fileInput}
           on:change={e => { addFiles(e.target.files); e.target.value = ''; }} />
    <input type="file" id="pv-folder-input" webkitdirectory accept="image/*" style="display:none"
           bind:this={folderInput}
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
    {#if localMode && isMobile}
      <!-- Standalone Capacitor mode: photo library picker -->
      <div class="drop-icon">📷</div>
      <div class="drop-label">{$t('pv_local_pick_title')}</div>
      <div class="drop-sub">{$t('pv_local_pick_sub')}</div>
      <div class="drop-buttons">
        <button class="primary" on:click={pickPhotosFromLibrary}>📷 {$t('pv_local_pick_btn')}</button>
      </div>
    {:else}
      <div class="drop-icon">📂</div>
      <div class="drop-label">
        {dragOver ? $t('pv_drop_active') : $t('pv_drop_idle')}
      </div>
      <div class="drop-sub">{$t('pv_drop_sub')}</div>
      <div class="drop-buttons">
        <button on:click={pickFiles}>💻 {$t('pv_select_files')}</button>
        <button on:click={pickFolder}>💻 {$t('pv_select_folder_btn')}</button>
      </div>
      {#if !inElectron}
      <!-- Web / mobile local inference toggle -->
      <div class="web-infer-row">
        <label class="web-infer-label">
          <input type="checkbox" bind:checked={webLocalInfer} />
          🔬 {$t('pv_web_local_infer')}
        </label>
        <span class="hint" style="font-size:11px;margin:0;">{$t('pv_web_local_infer_hint')}</span>
      </div>
      {/if}
    {/if}
  </div>
  {#if webInferMsg}
    <div class="web-infer-progress">{webInferMsg}</div>
  {/if}
  {#if localMode && vlmStatusMsg}
    <div class="path-notice" style="background: #2a2010; padding: 6px 10px; border-radius: 4px; margin-top: 4px; display: block; white-space: normal;">
      ⚠️ {vlmStatusMsg} <button class="btn-sm" on:click={() => sidebarView.set('settings')} style="padding: 1px 6px; margin-left: 6px;">Open Settings</button>
    </div>
  {/if}

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
        {#if batchQueueStatus}
          <div class="batch-queue-status">{batchQueueStatus}</div>
        {:else if batchQueueError}
          <div class="batch-queue-error">{batchQueueError} <button on:click={() => batchQueueError = ''}>✕</button></div>
        {:else if !inElectron && !localBasePath.trim() && pendingItems.length > 0}
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

    <!-- Creator picker (single free-text with autocomplete) -->
    <div class="picker-group">
      <label class="picker-label">{$t('pv_creator_label') || 'Creator'}</label>
      <div class="picker-chips">
        {#if creatorInput}
          <span class="chip">{creatorInput}
            <button class="chip-remove" on:click={() => creatorInput = ''}>✕</button>
          </span>
        {:else}
          <div class="picker-input-wrap" style="position:relative">
            <input
              type="text"
              class="picker-input"
              placeholder={$t('pv_creator_placeholder') || 'Creator name…'}
              bind:value={creatorInput}
              on:focus={() => creatorDropdownOpen = true}
              on:blur={() => setTimeout(() => creatorDropdownOpen = false, 150)}
            />
            {#if creatorDropdownOpen && filteredCreators.length}
              <div class="picker-dropdown">
                {#each filteredCreators as c}
                  <button class="picker-option" on:mousedown|preventDefault={() => { creatorInput = c; creatorDropdownOpen = false; }}>{c}</button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>

    <!-- Copyright picker (single free-text with autocomplete) -->
    <div class="picker-group">
      <label class="picker-label">{$t('pv_copyright_label') || 'Copyright'}</label>
      <div class="picker-chips">
        {#if copyrightInput}
          <span class="chip">{copyrightInput}
            <button class="chip-remove" on:click={() => copyrightInput = ''}>✕</button>
          </span>
        {:else}
          <div class="picker-input-wrap" style="position:relative">
            <input
              type="text"
              class="picker-input"
              placeholder={$t('pv_copyright_placeholder') || '© 2025 Name…'}
              bind:value={copyrightInput}
              on:focus={() => copyrightDropdownOpen = true}
              on:blur={() => setTimeout(() => copyrightDropdownOpen = false, 150)}
            />
            {#if copyrightDropdownOpen && filteredCopyrights.length}
              <div class="picker-dropdown">
                {#each filteredCopyrights as c}
                  <button class="picker-option" on:mousedown|preventDefault={() => { copyrightInput = c; copyrightDropdownOpen = false; }}>{c}</button>
                {/each}
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
    <div class="det-settings-header">
      <button class="det-toggle" on:click={() => showDetParams = !showDetParams}>
        ⚙ {$t('pv_det_settings')} {showDetParams ? '▲' : '▼'}
      </button>
      <span class="backend-chip">
        {$processingBackend === 'remote_v2' ? '🌐 ' + $t('pipeline_remote_v2') : $processingBackend === 'remote_v4' ? '🌐 ' + $t('pipeline_remote_v4') : '🖥 ' + $t('pipeline_local')}
      </span>
    </div>
    {#if showDetParams}
      <div class="det-params-box">
        <!-- Skip toggles at the top — affect which pipelines run -->
        <div class="det-skip-row">
          <label class="skip-check">
            <input type="checkbox" bind:checked={skipFaces} />
            {$t('pv_skip_faces')}
          </label>
          <label class="skip-check">
            <input type="checkbox" bind:checked={skipVlm} />
            {$t('pv_skip_vlm')}
          </label>
        </div>
        <!-- Detection tuning params (dimmed when faces are skipped) -->
        <div class:det-disabled={skipFaces}>
          <div class="det-param-row">
            <label>{$t('detection_threshold')}: <strong>{detThresh}</strong></label>
            <input type="range" min="0.1" max="0.9" step="0.05" bind:value={detThresh} disabled={skipFaces} />
          </div>
          <div class="det-param-row">
            <label>{$t('min_face_size')}: <strong>{minFaceSize}px</strong></label>
            <input type="range" min="10" max="200" step="5" bind:value={minFaceSize} disabled={skipFaces} />
          </div>
          <div class="det-param-row">
            <label>{$t('recognition_certainty')}: <strong>{recThresh}</strong></label>
            <input type="range" min="0.1" max="0.9" step="0.05" bind:value={recThresh} disabled={skipFaces} />
          </div>
          <div class="det-param-row">
            <label>{$t('detection_model')}</label>
            <select bind:value={detModel} disabled={skipFaces}>
              {#each DET_MODELS as m}
                <option value={m.value}>{$t(m.label)}</option>
              {/each}
            </select>
          </div>
        </div>
        <div class="det-param-row">
          <label>{$t('pv_max_size_label')} <span class="hint">{$t('pv_max_size_hint')}</span></label>
          <input type="number" bind:value={maxSize} min="0" max="9999" step="100"
                 placeholder="0" class="num-input" />
        </div>
        <div class="det-param-row">
          <label>{$t('pv_dup_mode_label')}</label>
          <select bind:value={duplicateMode}>
            <option value="skip">{$t('pv_dup_mode_skip')}</option>
            <option value="overwrite">{$t('pv_dup_mode_overwrite')}</option>
            <option value="always_add">{$t('pv_dup_mode_add')}</option>
          </select>
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
        {#if queuedCount > 0}<span class="queued-count"> · {queuedCount} {$t('offline_pending_push')}</span>{/if}
        {#if skippedCount > 0}<span class="skip-count"> · {skippedCount} {$t('pv_already_uploaded')}</span>{/if}
        {#if sharedDupCount > 0}<span class="shared-count"> · {sharedDupCount} {$t('pv_shared_by_others')}</span>{/if}
        {#if dupSkippedCount > 0}<span class="skip-count"> · {dupSkippedCount} {$t('pv_dup_skipped')}</span>{/if}
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
        <div class="result-row" class:is-error={item.status === 'error'} class:is-done={item.status === 'done'} class:is-queued={item.status === 'queued'}>
          <!-- Thumbnail or status icon -->
          <div class="thumb-cell">
            {#if item.status === 'done' && item.imageId}
              <img src={thumbnailUrl(item.imageId, 80)} alt="" loading="lazy" />
            {:else if item.status === 'processing'}
              <div class="thumb-placeholder spin">⏳</div>
            {:else if item.status === 'error'}
              <div class="thumb-placeholder err">✗</div>
            {:else if item.status === 'queued'}
              <div class="thumb-placeholder queued">⬆</div>
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
                  <span class="badge faces" title={$t('pv_faces_identified')}>{item.faces} 👤</span>
                {/if}
                {#if item.people?.length > 0}
                  <span class="badge people" title={$t('pv_matched_in_index')}>{item.people.length} ✓</span>
                {/if}
                {#if item.description}
                  <span class="badge vlm" title={$t('pv_vlm_desc_received')}>TXT</span>
                {/if}
                {#if item.tags?.length > 0}
                  <span class="badge vlm" title={$t('pv_vlm_tags_received')}>TAGS</span>
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
              {#if item.status === 'queued'}<span class="badge queued">⬆ {$t('offline_push_btn')}</span>{/if}
            </div>
            <div class="line2">
              {#if item.status === 'done' && item.description}
                <span class="desc">{item.description.slice(0, 120)}{item.description.length > 120 ? '…' : ''}</span>
              {:else if item.status === 'done' && item.sceneType}
                <span class="desc muted">{item.sceneType}</span>
              {:else if item.status === 'error'}
                <div class="err-box">
                  <span class="desc err" title={item.error}>{item.error}</span>
                  {#if !running}
                    <button class="retry-btn" on:click={() => retryItem(item.id)}>🔄 {$t('bj_retry')}</button>
                  {/if}
                </div>
              {:else if item.status === 'queued'}
                <span class="desc muted">{item.msg}</span>
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
  .mode-badge.mobile { background: #1a1a3a; color: #8080e0; }
  .web-infer-row { display: flex; flex-direction: column; gap: 3px; margin-top: 8px; align-items: flex-start; }
  .web-infer-label { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; color: #a0b0d0; }
  .web-infer-label input[type=checkbox] { cursor: pointer; }
  .web-infer-progress { font-size: 12px; color: #8080c0; padding: 4px 8px; background: #12122a; border-radius: 4px; margin-top: 4px; }
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
  .det-settings-header { display: flex; align-items: center; justify-content: space-between; }
  .backend-chip { font-size: 10px; color: #5070a0; padding-right: 14px; }
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
  .queued-count { color: #d0a030; }
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
    height: auto;
    transition: background 0.1s;
  }
  .result-row:hover { background: #1e1e30; }
  .result-row.is-done   { border-left: 2px solid #3a6a3a; }
  .result-row.is-error  { border-left: 2px solid #6a3a3a; }
  .result-row.is-queued { border-left: 2px solid #7a5a1a; }

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
  .thumb-placeholder.spin   { animation: pulse 0.8s infinite alternate; }
  .thumb-placeholder.err    { color: #904040; }
  .thumb-placeholder.queued { color: #a07020; }
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
  .badge.queued     { background: #3a2a0a; color: #c09030; }
  .badge.faces      { background: #1e2a40; color: #6090c0; }
  .badge.people     { background: #2a1e3a; color: #9070c0; }
  .badge.vlm        { background: #3a2a1a; color: #c09040; font-size: 8px; font-weight: bold; }
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
  .desc.err   { color: #e07070; white-space: normal; word-break: break-word; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }

  .err-box {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 2px;
  }
  .retry-btn {
    padding: 2px 6px;
    font-size: 9px;
    background: #2a3a5a;
    border: 1px solid #3a5080;
    color: #a0c4ff;
    border-radius: 3px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .retry-btn:hover { background: #3a5080; }

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

  .det-skip-row {
    display: flex;
    gap: 16px;
    padding-bottom: 6px;
    border-bottom: 1px solid #2a2a3a;
    margin-bottom: 4px;
  }
  .skip-check {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: #90b0d0;
    cursor: pointer;
    user-select: none;
  }
  .skip-check input[type="checkbox"] { accent-color: #5080c0; cursor: pointer; }
  .det-disabled { opacity: 0.35; pointer-events: none; }

  .batch-job-error {
    font-size: 11px;
    color: #c05050;
    margin-top: 4px;
  }
  .batch-queue-status {
    font-size: 10px;
    color: #8090c0;
    margin-left: 8px;
    font-style: italic;
  }
  .batch-queue-error {
    font-size: 10px;
    color: #c05050;
    margin-left: 8px;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .batch-queue-error button {
    background: none;
    border: none;
    color: #c05050;
    cursor: pointer;
    font-size: 10px;
    padding: 0 2px;
  }
</style>
