<script>
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { allPeople, t, processingBackend } from '../stores.js';
  import { fetchImage, fetchImageFaces, fetchPeople, previewUrl, faceCropUrl, reassignFace, deleteFace, reDetectFaces, addManualFace, clearIdentifications, clearDetections, fetchUserDetPrefs, saveUserDetPrefs, isLocalMode, fetchImageAsUrl, fetchSettings } from '../api.js';
  import { Capacitor } from '@capacitor/core';

  export let imageId;

  const dispatch = createEventDispatcher();
  const localMode = isLocalMode();

  /** 
   * Svelte action to handle authenticated image loading on mobile.
   * Standard <img> tags don't send cookies to cross-origin servers on iOS.
   */
  function lazySrc(node, url) {
    let objectUrl = null;

    async function update(newUrl) {
      if (!newUrl) return;
      console.log(`[lazySrc] update | url=${newUrl.slice(0, 100)}`);
      
      // Handle local crop protocol
      if (newUrl.startsWith('local-crop://')) {
        console.log(`[lazySrc] detected local-crop marker: ${newUrl}`);
        const parts = newUrl.replace('local-crop://', '').split('?');
        const [ids, query] = parts;
        const [imageId, faceId] = ids.split('/');
        const size = new URLSearchParams(query || '').get('size') || 128;
        
        console.log(`[lazySrc] Requesting local crop imageId=${imageId} faceId=${faceId} size=${size}`);
        const { localAdapter } = await import('./LocalAdapter.js');
        const blobUrl = await localAdapter.getFaceCrop(imageId, faceId, parseInt(size));
        console.log(`[lazySrc] getFaceCrop result: ${blobUrl ? 'SUCCESS' : 'FAILED'}`);
        
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = blobUrl;
        node.src = blobUrl;
        return;
      }

      if (!Capacitor.isNativePlatform() || localMode || newUrl.startsWith('data:')) {
        node.src = newUrl;
        return;
      }

      // On Mobile + Remote mode: fetch via Native HTTP to include cookies
      console.log(`[lazySrc] Mobile remote: fetching ${newUrl} via fetchImageAsUrl`);
      const blobUrl = await fetchImageAsUrl(newUrl);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = blobUrl;
      node.src = blobUrl;
    }

    update(url);

    return {
      update,
      destroy() {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      }
    };
  }

  let faces = [];
  let vlmInfo = { description: false, tags: 0 };
  let imgEl;
  let displayW = 0, displayH = 0;
  let loading = true;
  let saving = {};       // { [face_id]: bool }
  let saved  = {};       // { [face_id]: bool } — flash green
  let names  = {};       // { [face_id]: string } — controlled autocomplete inputs
  let activeFaceId = null;
  let anyChanged = false;
  let vlmSaved = false; // flash on success

  // ── Zoom & pan ──────────────────────────────────────────────────────────────
  let zoomLevel = 1;
  let panX = 0, panY = 0;
  let isPanning = false;
  let panStart = { x: 0, y: 0 };

  function zoomIn()  { zoomLevel = Math.min(8, zoomLevel * 1.3); }
  function zoomOut() {
    zoomLevel = Math.max(0.5, zoomLevel / 1.3);
    if (zoomLevel < 1.05) { zoomLevel = 1; panX = 0; panY = 0; }
  }
  function fitToScreen() { zoomLevel = 1; panX = 0; panY = 0; }

  function onPanelWheel(e) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 0.88;
    zoomLevel = Math.max(0.5, Math.min(8, zoomLevel * factor));
    if (zoomLevel < 1.05) { zoomLevel = 1; panX = 0; panY = 0; }
  }

  function onPanelMouseDown(e) {
    if (zoomLevel <= 1 || e.button !== 0 || isDrawing) return;
    isPanning = true;
    panStart = { x: e.clientX - panX, y: e.clientY - panY };
  }
  function onPanelMouseMove(e) {
    if (!isPanning) return;
    panX = e.clientX - panStart.x;
    panY = e.clientY - panStart.y;
  }
  function onPanelMouseUp() { isPanning = false; }

  // ── Manual face drawing ─────────────────────────────────────────────────────
  let isDrawing = false;
  let startX = 0, startY = 0;
  let drawBox = null;   // { x, y, w, h } in SVG coordinate space

  function onSvgMouseDown(e) {
    if (isPanning) return;
    if (activeFaceId !== null) { activeFaceId = null; return; }
    const rect = e.currentTarget.getBoundingClientRect();
    isDrawing = true;
    // Divide by zoomLevel: SVG coordinate = screen offset / zoom
    startX = (e.clientX - rect.left) / zoomLevel;
    startY = (e.clientY - rect.top) / zoomLevel;
    drawBox = { x: startX, y: startY, w: 0, h: 0 };
  }

  function onSvgMouseMove(e) {
    if (!isDrawing) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const curX = (e.clientX - rect.left) / zoomLevel;
    const curY = (e.clientY - rect.top) / zoomLevel;
    drawBox = {
      x: Math.min(startX, curX),
      y: Math.min(startY, curY),
      w: Math.abs(startX - curX),
      h: Math.abs(startY - curY)
    };
  }

  // Parameters for re-detection
  let detThresh = 0.5;
  let minFaceSize = 60;
  let recThresh = 0.4;
  let detRetries = 1;
  let alsoRunVlm = false;   // when true, also re-runs VLM enrichment after face detection
  let detModel = 'auto';    // detection model override
  let maxSize = 0;          // 0 = no resize; >0 = max long-edge px before detection
  let vlmMaxSize = 0;       // 0 = send original to VLM; >0 = resize long-edge before VLM
  let showParams = false;
  let reDetecting = false;

  // Local det models for v4 Node.js backend. Extended when remote_v2 backend active.
  const LOCAL_DET_MODELS = [
    { value: 'auto',  label: 'det_model_auto'  },  // SCRFD (buffalo_l)
    { value: 'yunet', label: 'det_model_yunet' },  // YuNet (lightweight)
    { value: 'none',  label: 'det_model_none'  },  // VLM only
  ];
  const REMOTE_DET_MODELS = [
    { value: 'auto',       label: 'det_model_auto'       },
    { value: 'retinaface', label: 'det_model_retinaface' },
    { value: 'scrfd',      label: 'det_model_scrfd'      },
    { value: 'yunet',      label: 'det_model_yunet'      },
    { value: 'mediapipe',  label: 'det_model_mediapipe'  },
    { value: 'none',       label: 'det_model_none'       },
  ];
  $: DET_MODELS = $processingBackend === 'remote_v2' ? REMOTE_DET_MODELS : LOCAL_DET_MODELS;

  // When "none (VLM only)" is selected, VLM must run — force the toggle on
  $: if (detModel === 'none') alsoRunVlm = true;

  let vlmStatusMsg = '';
  $: if (alsoRunVlm && localMode) {
    fetchSettings().then(s => {
      const provider = s?.vlm?.provider || 'anthropic';
      import('./LocalAdapter.js').then(la => {
        la.localAdapter.getVlmKeys().then(keys => {
          if (!keys[provider]) {
            vlmStatusMsg = `⚠ No API key for ${provider}`;
          } else {
            vlmStatusMsg = '';
          }
        });
      });
    });
  } else {
    vlmStatusMsg = '';
  }

  async function onSvgMouseUp() {
    if (!isDrawing) return;
    isDrawing = false;
    if (!drawBox || drawBox.w < 10 || drawBox.h < 10) {
      drawBox = null;
      return;
    }
    // Convert SVG coords (0..displayW, 0..displayH) to normalised 0-1
    const bbox = {
      top:    drawBox.y / displayH,
      left:   drawBox.x / displayW,
      bottom: (drawBox.y + drawBox.h) / displayH,
      right:  (drawBox.x + drawBox.w) / displayW
    };
    drawBox = null;
    try {
      const res = await addManualFace(imageId, bbox, recThresh);
      if (res.success) {
        anyChanged = true;
        await loadFaces();
        activeFaceId = res.face.face_id;
      }
    } catch (err) {
      alert(`Manual add failed: ${err.message}`);
    }
  }

  $: imageUrl = previewUrl(imageId);

  async function loadFaces() {
    loading = true;
    try {
      faces = await fetchImageFaces(imageId);
      console.log('[FaceIdentifyModal] loadFaces result:', faces);
      names = {};
      for (const f of faces) {
        names[f.face_id] = f.person_name || '';
      }
      
      // Also fetch image metadata to check VLM results
      const img = await fetchImage(imageId);
      vlmInfo = {
        description: !!(img.ai_description || img.description),
        tags: img.ai_tags?.length || img.ai_tags_list?.length || 0
      };

      if (faces.length === 0) showParams = true;
    } catch (e) {
      console.error('loadFaces error:', e);
    } finally {
      loading = false;
    }
  }

  function onImgLoad(e) {
    const rect = e.target.getBoundingClientRect();
    displayW = rect.width;
    displayH = rect.height;
  }

  async function saveFace(face) {
    const name = (names[face.face_id] || '').trim();
    if (!name) return;
    saving = { ...saving, [face.face_id]: true };
    try {
      await reassignFace(face.face_id, name);
      saved = { ...saved, [face.face_id]: true };
      anyChanged = true;
      await loadFaces();
      await refreshPeople();
      setTimeout(() => { saved = { ...saved, [face.face_id]: false }; }, 1500);
    } catch (e) {
      alert(`Error saving: ${e.message}`);
    } finally {
      saving = { ...saving, [face.face_id]: false };
    }
  }

  async function saveAll() {
    let savedAny = false;
    for (const face of faces) {
      const name = (names[face.face_id] || '').trim();
      if (name) {
        saving = { ...saving, [face.face_id]: true };
        try {
          await reassignFace(face.face_id, name);
          saved = { ...saved, [face.face_id]: true };
          anyChanged = true;
          savedAny = true;
        } catch (e) {
          console.error(`Error saving face ${face.face_id}:`, e);
        } finally {
          saving = { ...saving, [face.face_id]: false };
        }
      }
    }
    if (savedAny) {
      await refreshPeople();
      // If we are closing, we don't strictly need to loadFaces() but it's good for state consistency
      // However, the user wants to return to the main UI, so we just close.
    }
    close();
  }

  async function onRemoveFace(face_id) {
    if (!confirm($t('remove_detection') + '?')) return;
    try {
      await deleteFace(imageId, face_id);
      anyChanged = true;
      await loadFaces();
    } catch (e) {
      alert(`Error: ${e.message}`);
    }
  }

  async function onClearIdentifications() {
    if (!confirm($t('clear_all_identifications') + '?')) return;
    try {
      await clearIdentifications(imageId);
      anyChanged = true;
      await loadFaces();
    } catch (e) {
      alert(`Error: ${e.message}`);
    }
  }

  async function onClearDetections() {
    if (!confirm($t('clear_all_detections') + '?')) return;
    try {
      await clearDetections(imageId);
      anyChanged = true;
      await loadFaces();
    } catch (e) {
      alert(`Error: ${e.message}`);
    }
  }

  async function onReDetect() {
    reDetecting = true;
    // Persist the chosen model as the user's default (best-effort, silent on failure)
    saveUserDetPrefs({ det_model: detModel, det_retries: detRetries }).catch(() => {});
    console.log(`[FaceIdentifyModal] onReDetect start for imageId=${imageId} | model=${detModel} | thresh=${detThresh} | retries=${detRetries}`);
    try {
      let vlmKeys = {};
      if (localMode) {
        const { localAdapter } = await import('./LocalAdapter.js');
        vlmKeys = await localAdapter.getVlmKeys();
      }

      const res = await reDetectFaces(imageId, {
        det_thresh:    detThresh,
        min_face_size: minFaceSize,
        rec_thresh:    recThresh,
        skip_vlm:      !alsoRunVlm,
        det_model:     detModel,
        max_retries:   detRetries,
        max_size:      maxSize,
        vlm_max_size:  vlmMaxSize,
        vlm_prompt:    $t('vlm_prompt'),
        vlm_keys:      vlmKeys,
      });
      console.log('[FaceIdentifyModal] reDetectFaces finished:', res);
      if (alsoRunVlm || detModel === "none") {
        vlmSaved = true;
        setTimeout(() => { vlmSaved = false; }, 3000);
      }
      anyChanged = true;
      
      if (localMode) {
        // In local/standalone mode, the call is already awaited and done
        console.log('[FaceIdentifyModal] LocalMode: loading faces immediately...');
        await loadFaces();
      } else {
        // Server responds immediately (fire-and-forget); poll until face count changes (max ~30s)
        const prevCount = faces.length;
        console.log(`[FaceIdentifyModal] ServerMode: polling for results (prevCount=${prevCount})...`);
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 2000));
          await loadFaces();
          if (faces.length !== prevCount) break;
        }
      }
      showParams = false;
    } catch (e) {
      console.error('[FaceIdentifyModal] onReDetect FAILED:', e);
      alert(`${$t('run_detection')} failed: ${e.message}`);
    } finally {
      reDetecting = false;
    }
  }

  async function refreshPeople() {
    try { allPeople.set(await fetchPeople()); } catch {}
  }

  $: matchedCount = faces.filter(f => f.person_id).length;

  function close() {
    dispatch('close', { saved: anyChanged });
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
    
    // Don't intercept zoom/pan keys if typing in an input
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;

    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomIn(); }
    if (e.key === '-') { e.preventDefault(); zoomOut(); }
    if (e.key === '*') { e.preventDefault(); fitToScreen(); }
  }

  function faceColor(face) {
    if (!face) return '#e07030';
    if (face.verified && face.person_id) return '#50c878';   // green
    if (face.person_id) return '#f0c040';                    // yellow
    return '#e07030';                                        // orange
  }

  // Convert normalised bbox → pixel coords in the displayed image area
  function bboxPx(bbox) {
    if (!displayW || !displayH || !bbox) return { x: 0, y: 0, w: 0, h: 0 };
    return {
      x: (bbox.left || 0)   * displayW,
      y: (bbox.top || 0)    * displayH,
      w: ((bbox.right || 0)  - (bbox.left || 0)) * displayW,
      h: ((bbox.bottom || 0) - (bbox.top || 0))  * displayH,
    };
  }

  function recalcSize() {
    if (!imgEl) return;
    try {
      const rect = imgEl.getBoundingClientRect();
      // getBoundingClientRect returns zoomed dimensions; divide by zoomLevel for true display size
      displayW = rect.width  / zoomLevel;
      displayH = rect.height / zoomLevel;
    } catch (e) {
      console.warn('[FaceIdentifyModal] recalcSize failed:', e);
    }
  }

  onMount(() => {
    loadFaces();
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', recalcSize);
    // Load user's preferred detection model and VLM status
    fetchUserDetPrefs().then(p => {
      detModel = p.effective?.det_model || 'auto';
      detRetries = p.effective?.det_retries ?? 1;
    }).catch(() => {});

    fetchSettings().then(s => {
      alsoRunVlm = s?.vlm?.enabled ?? false;
    }).catch(() => {});
  });

  onDestroy(() => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', recalcSize);
  });
</script>

<!-- svelte-ignore a11y-click-events-have-key-events -->
<div class="overlay" on:click|self={close} role="button" aria-label="Close modal" tabindex="-1">
  <div class="modal" role="dialog" aria-modal="true">

    <!-- Image panel with zoom controls and SVG overlay -->
    <div
      class="img-panel"
      on:wheel|preventDefault={onPanelWheel}
      on:mousedown={onPanelMouseDown}
      on:mousemove={onPanelMouseMove}
      on:mouseup={onPanelMouseUp}
      on:mouseleave={onPanelMouseUp}
    >
      <!-- Zoom toolbar -->
      <div class="zoom-bar">
        <button class="zoom-btn" on:click|stopPropagation={zoomOut} title={$t('zoom_out')}>−</button>
        <button class="zoom-btn" on:click|stopPropagation={fitToScreen} title={$t('fit_to_screen')}>⊡</button>
        <button class="zoom-btn" on:click|stopPropagation={zoomIn}  title={$t('zoom_in')}>+</button>
        {#if zoomLevel !== 1}
          <span class="zoom-pct">{Math.round(zoomLevel * 100)}%</span>
        {/if}
      </div>

      <!-- Zoomable container -->
      <div
        class="img-wrap"
        style="transform: scale({zoomLevel}) translate({panX / zoomLevel}px, {panY / zoomLevel}px); cursor: {isPanning ? 'grabbing' : zoomLevel > 1 ? 'grab' : 'crosshair'};"
      >
        <img
          use:lazySrc={imageUrl}
          alt=""
          bind:this={imgEl}
          on:load={onImgLoad}
          draggable="false"
        />
        {#if displayW && displayH}
          <svg
            class="overlay-svg"
            width={displayW}
            height={displayH}
            viewBox="0 0 {displayW} {displayH}"
            on:mousedown={onSvgMouseDown}
            on:mousemove={onSvgMouseMove}
            on:mouseup={onSvgMouseUp}
            role="presentation"
          >
            {#each faces as face (face.face_id)}
              {#if face.bbox}
                {@const px = bboxPx(face.bbox)}
                {@const color = faceColor(face)}
                {@const isActive = activeFaceId === face.face_id}
                <!-- svelte-ignore a11y-no-static-element-interactions -->
                <rect
                  x={px.x} y={px.y}
                  width={px.w} height={px.h}
                  fill="none"
                  stroke={color}
                  stroke-width={isActive ? 3 : 1.5}
                  stroke-dasharray={isActive ? 'none' : '4 2'}
                  rx="3"
                  style="cursor:pointer"
                  on:mousedown|stopPropagation
                  on:click|stopPropagation={() => activeFaceId = face.face_id}
                  role="button"
                  aria-label="Select face"
                />
                {#if face.person_name}
                  <text
                    x={px.x + 4} y={px.y - 4}
                    fill={color}
                    font-size="10"
                    font-family="sans-serif"
                    style="pointer-events: none; user-select: none;"
                  >{face.person_name}</text>
                {/if}
              {/if}
            {/each}

            {#if drawBox}
              <rect
                x={drawBox.x} y={drawBox.y}
                width={drawBox.w} height={drawBox.h}
                fill="rgba(80, 160, 255, 0.2)"
                stroke="#50a0ff"
                stroke-width="2"
                stroke-dasharray="5 3"
                rx="2"
              />
            {/if}
          </svg>
        {/if}
      </div>
    </div>

    <!-- Side panel: face list -->
    <div class="side-panel">
      <div class="side-header">
        <span class="side-title">{$t('face_identification')}</span>
        <button class="close-btn" on:click={close}>✕</button>
      </div>

      <div class="drawing-hint">
        💡 {$t('drag_to_mark_face')}
      </div>

      {#if faces.length > 0}
        <div class="clear-bar">
          {#if faces.some(f => f.person_id)}
            <button class="btn-danger-sm" on:click={onClearIdentifications}>
              🗑 {$t('clear_all_identifications')}
            </button>
          {/if}
          <button class="btn-danger-sm" on:click={onClearDetections}>
            ✕ {$t('clear_all_detections')}
          </button>
        </div>
      {/if}

      {#if loading}
        <div class="loading">{$t('loading')}</div>
      {:else if faces.length === 0}
        <div class="no-faces">
          <p>{$t('no_faces_in_image')}</p>
          <p class="sub">{$t('lower_threshold_hint')}</p>
        </div>

        <div class="params-box visible">
          <div class="backend-badge" title={$t('processing_backend_section')}>
            {$processingBackend === 'remote_v2' ? '🌐 ' + $t('pipeline_remote_v2') : $processingBackend === 'remote_v4' ? '🌐 ' + $t('pipeline_remote_v4') : '🖥 ' + $t('pipeline_local')}
          </div>
          <div class="param-row">
            <label for="id-det-thresh-e">{$t('detection_threshold')}: {detThresh}</label>
            <input id="id-det-thresh-e" type="range" min="0.1" max="0.9" step="0.05" bind:value={detThresh} />
          </div>
          <div class="param-row">
            <label for="id-min-size-e">{$t('min_face_size')}: {minFaceSize}px</label>
            <input id="id-min-size-e" type="range" min="10" max="100" step="5" bind:value={minFaceSize} />
          </div>
          <div class="param-row">
            <label for="id-rec-thresh-e">{$t('recognition_certainty')}: {recThresh}</label>
            <input id="id-rec-thresh-e" type="range" min="0.1" max="0.9" step="0.05" bind:value={recThresh} />
          </div>
          <div class="param-row">
            <label for="id-det-retries-e">Detection Retries: {detRetries}</label>
            <input id="id-det-retries-e" type="number" min="0" max="5" step="1" bind:value={detRetries} class="num-input" />
          </div>
          <div class="param-row">
            <label for="id-det-model-e">{$t('detection_model')}</label>
            <select id="id-det-model-e" bind:value={detModel}>
              {#each DET_MODELS as m}
                <option value={m.value}>{$t(m.label)}</option>
              {/each}
            </select>
          </div>
          <div class="param-row">
            <label for="id-max-size-e">{$t('downsize_before_detect')}</label>
            <input id="id-max-size-e" type="number" bind:value={maxSize}
              min="0" max="9999" step="100" placeholder="0 = Original" class="num-input" />
          </div>
          <label class="vlm-toggle" class:forced={detModel === 'none'}>
            <input type="checkbox" bind:checked={alsoRunVlm} disabled={detModel === 'none'} />
            {$t('also_run_vlm')}
          </label>
          {#if vlmStatusMsg}
            <div class="vlm-status-warn" style="color:#e08080; font-size:10px; margin-top:2px;">{vlmStatusMsg}</div>
          {/if}
          {#if alsoRunVlm || detModel === 'none'}
          <div class="param-row">
            <label for="id-vlm-size-e">{$t('downsize_before_vlm')}</label>
            <input id="id-vlm-size-e" type="number" bind:value={vlmMaxSize}
              min="0" max="9999" step="100" placeholder="0 = Original" class="num-input" />
          </div>
          {/if}
          <button class="primary full" on:click={onReDetect} disabled={reDetecting}>
            {reDetecting ? $t('scanning') : detModel === 'none' ? $t('run_vlm_only') : $t('run_detection')}
          </button>
        </div>

        <div class="save-all-row">
          <button class="btn-sm" on:click={close}>{$t('cancel')}</button>
          <span class="hint">{$t('press_esc_to_close')}</span>
        </div>
      {:else}
        <div class="face-list">
          {#each faces as face, i (face.face_id)}
            {@const color = faceColor(face)}
            {@const isActive = activeFaceId === face.face_id}
            <div
              class="face-row"
              class:active={isActive}
              style="--accent: {color}"
              on:click={() => activeFaceId = face.face_id}
              role="button"
              tabindex="0"
              on:keydown={e => e.key === 'Enter' && (activeFaceId = face.face_id)}
              aria-pressed={isActive}
            >
              <div class="face-crop-wrap">
                <img
                  class="face-crop"
                  use:lazySrc={faceCropUrl(imageId, face.face_id, 64)}
                  alt=""
                />
              </div>
              <div class="face-info">
                <div class="face-num-row">
                  <span class="face-num">{$t('face_num')} {i + 1}</span>
                  <button class="remove-face-btn" title={$t('remove_detection')} on:click|stopPropagation={() => onRemoveFace(face.face_id)}>✕</button>
                </div>
                {#if face.person_name && !names[face.face_id]}
                  <div class="current-person" style="color:{color}">{face.person_name}</div>
                {/if}
                <div class="input-row">
                  <input
                    type="text"
                    list="people-list"
                    autocomplete="off"
                    aria-label="{$t('face_num')} {i+1}"
                    placeholder={$t('type_name_placeholder')}
                    bind:value={names[face.face_id]}
                    class="name-input"
                    class:saved={saved[face.face_id]}
                    on:focus={() => activeFaceId = face.face_id}
                    on:keydown={e => { if (e.key === 'Enter' && !saving[face.face_id]) saveFace(face); }}
                  />
                  <button
                    class="save-btn"
                    class:saved={saved[face.face_id]}
                    disabled={saving[face.face_id] || !names[face.face_id]?.trim()}
                    on:click|stopPropagation={() => saveFace(face)}
                  >
                    {saving[face.face_id] ? '…' : saved[face.face_id] ? '✓' : $t('save')}
                  </button>
                </div>
                <div class="meta">
                  {$t('conf_short')} {(face.detection_confidence * 100).toFixed(0)}%
                  {#if face.face_quality !== null && face.face_quality !== undefined}
                    · {$t('quality')} {(face.face_quality * 100).toFixed(0)}%
                  {/if}
                </div>
              </div>
            </div>
          {/each}
        </div>

        <div class="result-summary">
          <span class="badge faces" title={$t('pv_faces_identified')}>👤 {faces.length}</span>
          {#if matchedCount > 0}
            <span class="badge people" title={$t('pv_matched_in_index')}>✓ {matchedCount}</span>
          {/if}
          {#if vlmInfo.description}
            <span class="badge vlm" title={$t('pv_vlm_desc_received')}>TXT ✓</span>
          {/if}
          {#if vlmInfo.tags > 0}
            <span class="badge vlm" title={$t('pv_vlm_tags_received')}>TAGS: {vlmInfo.tags}</span>
          {/if}
        </div>

        <div class="save-all-row">
          <button class="primary" on:click={saveAll} disabled={reDetecting || loading}>
            {reDetecting ? $t('scanning') : $t('save_all')}
          </button>
          <button class="btn-sm" on:click={close}>{$t('close')}</button>
          <button class="btn-sm" on:click={() => showParams = !showParams}>{$t('rescan')}</button>
        </div>

        {#if showParams}
          <div class="params-box">
            <div class="backend-badge" title={$t('processing_backend_section')}>
              {$processingBackend === 'remote_v2' ? '🌐 ' + $t('pipeline_remote_v2') : $processingBackend === 'remote_v4' ? '🌐 ' + $t('pipeline_remote_v4') : '🖥 ' + $t('pipeline_local')}
            </div>
            <div class="param-row">
              <label for="id-det-thresh">{$t('detection_threshold')}: {detThresh}</label>
              <input id="id-det-thresh" type="range" min="0.1" max="0.9" step="0.05" bind:value={detThresh} />
            </div>
            <div class="param-row">
              <label for="id-min-size">{$t('min_face_size')}: {minFaceSize}px</label>
              <input id="id-min-size" type="range" min="10" max="100" step="5" bind:value={minFaceSize} />
            </div>
            <div class="param-row">
              <label for="id-rec-thresh">{$t('recognition_certainty')}: {recThresh}</label>
              <input id="id-rec-thresh" type="range" min="0.1" max="0.9" step="0.05" bind:value={recThresh} />
            </div>
            <div class="param-row">
              <label for="id-det-retries">Detection Retries: {detRetries}</label>
              <input id="id-det-retries" type="number" min="0" max="5" step="1" bind:value={detRetries} class="num-input" />
            </div>
            <div class="param-row">
              <label for="id-det-model">{$t('detection_model')}</label>
              <select id="id-det-model" bind:value={detModel}>
                {#each DET_MODELS as m}
                  <option value={m.value}>{$t(m.label)}</option>
                {/each}
              </select>
            </div>
            <div class="param-row">
              <label for="id-max-size">{$t('downsize_before_detect')}</label>
              <input id="id-max-size" type="number" bind:value={maxSize}
                min="0" max="9999" step="100" placeholder="0 = Original" class="num-input" />
            </div>
            <label class="vlm-toggle" class:forced={detModel === 'none'}>
              <input type="checkbox" bind:checked={alsoRunVlm} disabled={detModel === 'none'} />
              {$t('also_run_vlm')}
            </label>
            {#if alsoRunVlm || detModel === 'none'}
            <div class="param-row">
              <label for="id-vlm-size">{$t('downsize_before_vlm')}</label>
              <input id="id-vlm-size" type="number" bind:value={vlmMaxSize}
                min="0" max="9999" step="100" placeholder="0 = Original" class="num-input" />
            </div>
            {/if}
            <button class="primary full" on:click={onReDetect} disabled={reDetecting}>
              {reDetecting ? $t('scanning') : detModel === 'none' ? $t('run_vlm_only') : $t('run_detection')}
            </button>
          </div>
        {/if}
      {/if}
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.82);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .modal {
    display: flex;
    width: min(92vw, 1200px);
    height: min(88vh, 800px);
    background: #16161f;
    border: 1px solid #2a2a3a;
    border-radius: 10px;
    overflow: hidden;
  }

  /* ── Image panel ── */
  .img-panel {
    flex: 3;
    background: #0a0a12;
    overflow: hidden;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  /* Zoom toolbar (absolute, top-left) */
  .zoom-bar {
    position: absolute;
    top: 8px;
    left: 8px;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 4px;
    background: rgba(10,10,20,0.75);
    border-radius: 6px;
    padding: 3px 6px;
    backdrop-filter: blur(4px);
    pointer-events: auto;
  }
  .zoom-btn {
    background: #2a2a42;
    color: #8090b8;
    border: none;
    border-radius: 4px;
    font-size: 14px;
    width: 26px;
    height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0;
    line-height: 1;
  }
  .zoom-btn:hover { background: #3a3a5a; color: #a0c4ff; }
  .zoom-pct {
    font-size: 11px;
    color: #6080a0;
    min-width: 36px;
    text-align: center;
  }

  .img-wrap {
    position: relative;
    width: 100%;
    height: 100%;
    transform-origin: center center;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.05s ease-out;
  }
  .img-wrap img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    display: block;
    user-select: none;
    pointer-events: none;
  }
  .overlay-svg {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    pointer-events: auto;
  }

  /* ── Side panel ── */
  .side-panel {
    flex: 2;
    min-width: 280px;
    max-width: 360px;
    display: flex;
    flex-direction: column;
    border-left: 1px solid #2a2a3a;
    overflow: hidden;
  }
  .side-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
    border-bottom: 1px solid #2a2a3a;
    flex-shrink: 0;
  }
  .side-title { font-size: 13px; font-weight: 600; color: #c0c0e0; }
  .close-btn {
    background: transparent;
    color: #606080;
    font-size: 14px;
    padding: 2px 6px;
  }
  .close-btn:hover { color: #e0e0f0; background: #2a2a3a; }

  .drawing-hint {
    background: #1e2e50;
    color: #80a8d8;
    padding: 6px 12px;
    font-size: 10px;
    text-align: center;
    border-bottom: 1px solid #2a2a3a;
  }
  .clear-bar {
    padding: 6px 12px;
    border-bottom: 1px solid #2a2a3a;
    display: flex;
    justify-content: flex-end;
  }
  .btn-danger-sm {
    font-size: 11px;
    padding: 3px 10px;
    background: #3a1818;
    color: #e07070;
    border: 1px solid #5a2828;
    border-radius: 4px;
    cursor: pointer;
  }
  .btn-danger-sm:hover { background: #501818; color: #ff9090; }

  .loading, .no-faces {
    padding: 20px;
    color: #505070;
    text-align: center;
  }
  .no-faces { padding-top: 40px; }
  .no-faces .sub { font-size: 11px; margin-top: 8px; color: #404060; }

  .face-list { flex: 1; overflow-y: auto; padding: 8px; }

  .face-row {
    display: flex;
    gap: 10px;
    padding: 8px;
    border-radius: 6px;
    border: 1px solid transparent;
    margin-bottom: 6px;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
  }
  .face-row:hover { background: #1e1e30; }
  .face-row.active { background: #202035; border-color: var(--accent); }

  .face-crop-wrap {
    width: 64px;
    height: 64px;
    border-radius: 4px;
    overflow: hidden;
    flex-shrink: 0;
    border: 2px solid var(--accent);
    background: #0e0e18;
  }
  .face-crop { display: block; width: 64px; height: 64px; object-fit: cover; }

  .face-info { flex: 1; min-width: 0; }
  .face-num { font-size: 10px; color: #606080; }
  .face-num-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px; }
  .remove-face-btn { background: transparent; color: #505070; border: none; font-size: 10px; cursor: pointer; padding: 0 4px; }
  .remove-face-btn:hover { color: #ff6060; }
  .current-person { font-size: 11px; font-weight: 600; margin-bottom: 4px; }
  .input-row { display: flex; gap: 5px; margin-bottom: 4px; }
  .name-input {
    flex: 1;
    font-size: 11px;
    transition: border-color 0.2s;
  }
  .name-input.saved { border-color: #50c878; }
  .save-btn {
    font-size: 11px;
    padding: 3px 9px;
    background: #2a3a5a;
    flex-shrink: 0;
  }
  .save-btn:hover:not(:disabled) { background: #3a5080; }
  .save-btn.saved { background: #2a5040; color: #50c878; }
  .save-btn:disabled { opacity: 0.4; cursor: default; }
  .meta { font-size: 9px; color: #404060; }

  .save-all-row {
    padding: 10px 12px;
    border-top: 1px solid #2a2a3a;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }
  .result-summary {
    padding: 8px 12px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    border-top: 1px solid #2a2a3a;
  }
  .badge {
    font-size: 9px;
    padding: 2px 6px;
    border-radius: 4px;
    white-space: nowrap;
  }
  .badge.faces { background: #1e2a40; color: #6090d0; }
  .badge.vlm   { background: #3a2a1a; color: #c09040; font-weight: bold; transition: all 0.3s; }
  .badge.vlm.saved-flash { background: #2a5040; color: #50c878; transform: scale(1.1); box-shadow: 0 0 8px #50c878; }
  .hint { font-size: 10px; color: #404060; }

  .params-box {
    background: #1a1a28;
    border: 1px solid #2a2a3a;
    border-radius: 6px;
    padding: 10px;
    margin: 0 12px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 11px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  }
  .params-box.visible { border-color: #4a6fa5; }
  .backend-badge { font-size: 10px; color: #7090c0; padding: 2px 0; opacity: 0.8; }
  .param-row { display: flex; flex-direction: column; gap: 4px; }
  .param-row label { color: #8090b0; }
  .param-row input[type="range"] { width: 100%; }
  .num-input { width: 100%; padding: 4px 6px; background: #1a2030; border: 1px solid #3a4a60; border-radius: 4px; color: #c8d8f0; font-size: 12px; }
  .full { width: 100%; }
  .vlm-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: #7080a0;
    cursor: pointer;
    user-select: none;
  }
  .vlm-toggle input { cursor: pointer; }
</style>
