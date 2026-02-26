<script>
  import { selectedId, galleryImages, t, lightboxKey } from '../stores.js';
  import { fetchImage, fullUrl, previewUrl, thumbnailUrl, rotateImage } from '../api.js';
  import { onMount, onDestroy } from 'svelte';
  import MetaPanel from './MetaPanel.svelte';
  import CropModal from './CropModal.svelte';
  import AdjustModal from './AdjustModal.svelte';
  import AIEditModal from './AIEditModal.svelte';

  let image = null;
  let loading = false;
  let showMeta = true;      // toggled by I key
  let imgVersion = 0;       // incremented after rotate to bust browser cache
  let showCrop = false;
  let showAdjust = false;
  let showAIEdit = false;

  // Zoom + pan state
  let zoomLevel = 1;
  let panX = 0;
  let panY = 0;
  let isDragging = false;
  let dragStart = { x: 0, y: 0 };

  $: if ($selectedId) { loadImage($selectedId); }
  $: if (!$selectedId) { image = null; resetZoom(); }

  // External refresh signal (e.g., from KeyboardManager after rotate elsewhere)
  $: if ($lightboxKey) { imgVersion++; }

  async function loadImage(id) {
    loading = true;
    resetZoom();
    try { image = await fetchImage(id); }
    catch (e) { console.error('Lightbox load error:', e); image = null; }
    finally { loading = false; }
  }

  function close() { selectedId.set(null); }

  function resetZoom() {
    zoomLevel = 1;
    panX = 0;
    panY = 0;
  }

  function navigate(dir) {
    const imgs = $galleryImages;
    const idx = imgs.findIndex(i => i.id === $selectedId);
    if (idx === -1) return;
    const next = imgs[idx + dir];
    if (next) { selectedId.set(next.id); resetZoom(); }
  }

  function navigateFirst() {
    const first = $galleryImages[0];
    if (first) { selectedId.set(first.id); resetZoom(); }
  }

  function navigateLast() {
    const last = $galleryImages[$galleryImages.length - 1];
    if (last) { selectedId.set(last.id); resetZoom(); }
  }

  // ── Zoom & pan ─────────────────────────────────────────────────────────────

  function onWheel(e) {
    e.preventDefault();
    const factor = e.deltaY > 0 ? -0.15 : 0.15;
    zoomLevel = Math.max(0.25, Math.min(8, zoomLevel + factor));
    if (zoomLevel <= 1) { zoomLevel = 1; panX = 0; panY = 0; }
  }

  function onMouseDown(e) {
    if (zoomLevel <= 1 || e.button !== 0) return;
    isDragging = true;
    dragStart = { x: e.clientX - panX, y: e.clientY - panY };
  }

  function onMouseMove(e) {
    if (!isDragging) return;
    panX = e.clientX - dragStart.x;
    panY = e.clientY - dragStart.y;
  }

  function onMouseUp() { isDragging = false; }

  // ── Rotate ─────────────────────────────────────────────────────────────────

  async function doRotate(dir) {
    if (!image) return;
    try {
      const result = await rotateImage(image.id, dir);
      if (result.width) { image = { ...image, width: result.width, height: result.height }; }
      imgVersion++;  // bust browser image cache
    } catch (e) {
      console.error('Rotate failed:', e);
    }
  }

  // ── Keyboard ────────────────────────────────────────────────────────────────

  async function onKey(e) {
    if (!$selectedId) return;
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;

    const key = e.key;

    if (key === 'Escape') { close(); return; }

    if (key === 'ArrowLeft' || key === 'Backspace') {
      e.preventDefault();
      navigate(-1);
      return;
    }
    if (key === 'ArrowRight') { navigate(1); return; }
    if (key === ' ') { e.preventDefault(); navigate(1); return; }
    if (key === 'Home') { e.preventDefault(); navigateFirst(); return; }
    if (key === 'End')  { e.preventDefault(); navigateLast();  return; }

    // Zoom
    if (key === '+' || key === '=') {
      zoomLevel = Math.min(8, zoomLevel + 0.25);
      if (zoomLevel < 1.01) { panX = 0; panY = 0; }
      return;
    }
    if (key === '-') {
      zoomLevel = Math.max(0.25, zoomLevel - 0.25);
      if (zoomLevel <= 1) { zoomLevel = 1; panX = 0; panY = 0; }
      return;
    }
    if (key === '*') { resetZoom(); return; }

    // Info panel
    if (key === 'i' || key === 'I') { showMeta = !showMeta; return; }

    // Rotate
    if (key === 'r' || key === 'R') { await doRotate('cw');  return; }
    if (key === 'l' || key === 'L') { await doRotate('ccw'); return; }

    // Crop
    if (key === 'c' || key === 'C') { showCrop = true; return; }

    // Adjust
    if (key === 'a' || key === 'A') { showAdjust = true; return; }

    // Fullscreen
    if (key === 'f' || key === 'F' || key === 'F11') {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen?.();
      } else {
        document.exitFullscreen?.();
      }
      if (key === 'F11') e.preventDefault();
      return;
    }
  }

  onMount(() => window.addEventListener('keydown', onKey));
  onDestroy(() => window.removeEventListener('keydown', onKey));

  function onSaved()   { loadImage($selectedId); }
  function onDeleted() { close(); }
  function onRenamed(e) { if (image) image.filename = e.detail.new_filename; }

  const isElectron = typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined';

  let imgSrc = '';
  $: {
    // Recompute whenever image or imgVersion changes; also resets any error fallback
    imgSrc = image
      ? (isElectron && (image.origin_path ?? image.local_path)
          ? `localfile://${image.origin_path ?? image.local_path}`
          : previewUrl(image.id) + (imgVersion > 0 ? `?v=${imgVersion}` : ''))
      : '';
  }
  $: imgCursor = zoomLevel > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default';
</script>

{#if $selectedId}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <div class="overlay" on:click|self={close}>
    <div class="lightbox">
      <!-- Header bar -->
      <div class="lb-header">
        <button class="nav-btn" on:click={() => navigate(-1)} title="Previous (←)">←</button>
        <span class="filename">{image?.filename ?? '…'}</span>
        {#if zoomLevel !== 1}
          <span class="zoom-badge">{Math.round(zoomLevel * 100)}%</span>
        {/if}
        <div class="header-actions">
          <button on:click={() => doRotate('ccw')}   title="Rotate CCW (L)">↺</button>
          <button on:click={() => doRotate('cw')}    title="Rotate CW (R)">↻</button>
          <button on:click={() => doRotate('flip_h')} title="Flip horizontal">↔</button>
          <button on:click={() => doRotate('flip_v')} title="Flip vertical">↕</button>
          <button on:click={resetZoom}               title="Fit to window (*)">⊡</button>
          <button on:click={() => showCrop = true}   title="Crop (C)">✂</button>
          <button on:click={() => showAdjust = true} title="Adjust image (A)">🎨</button>
          <button on:click={() => showAIEdit = true} title="AI Edit (BFL)">🤖</button>
          <button
            on:click={() => showMeta = !showMeta}
            class:active-btn={showMeta}
            title="Toggle info panel (I)"
          >ℹ</button>
          <a href={image ? fullUrl(image.id) : '#'} download={image?.filename} title={$t('download')}>⬇</a>
          <button on:click={close} title="{$t('close')} (Esc)">✕</button>
        </div>
      </div>

      <!-- Image area + meta panel -->
      <div class="lb-body">
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <div
          class="image-area"
          on:wheel|preventDefault={onWheel}
          on:mousedown={onMouseDown}
          on:mousemove={onMouseMove}
          on:mouseup={onMouseUp}
          on:mouseleave={onMouseUp}
        >
          {#if loading}
            <div class="loading">{$t('loading')}…</div>
          {:else if image}
            <img
              src={imgSrc}
              alt={image.filename}
              style="transform: scale({zoomLevel}) translate({panX / zoomLevel}px, {panY / zoomLevel}px); cursor: {imgCursor};"
              draggable="false"
              on:error={() => { if (image && !imgSrc.includes('/thumbnail')) imgSrc = thumbnailUrl(image.id, 800); }}
            />
          {/if}

          <button class="nav-overlay left"  on:click={() => navigate(-1)} title={$t('previous')}>‹</button>
          <button class="nav-overlay right" on:click={() => navigate(1)}  title={$t('next')}>›</button>

          {#if !isElectron && (image?.origin_path ?? image?.local_path)}
            <div class="local-only-warn">⚠ Full resolution only available in the desktop app</div>
          {/if}
        </div>

        {#if showMeta}
          <MetaPanel {image} on:saved={onSaved} on:deleted={onDeleted} on:renamed={onRenamed} />
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if showCrop && image}
  <CropModal
    imageId={image.id}
    imageUrl={previewUrl(image.id)}
    on:close={() => showCrop = false}
    on:cropped={() => { showCrop = false; imgVersion++; }}
  />
{/if}

{#if showAdjust && image}
  <AdjustModal
    imageId={image.id}
    imageFilename={image.filename}
    on:close={() => showAdjust = false}
    on:adjusted={(e) => {
      showAdjust = false;
      if (e.detail.save_as === 'replace' || e.detail.image_id === image.id) {
        imgVersion++;
        loadImage(image.id);
      }
    }}
  />
{/if}

{#if showAIEdit && image}
  <AIEditModal
    imageId={image.id}
    imageFilename={image.filename}
    on:close={() => showAIEdit = false}
    on:edited={() => { showAIEdit = false; imgVersion++; loadImage(image.id); }}
  />
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.85);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .lightbox {
    background: #1a1a28;
    border-radius: 8px;
    width: min(95vw, 1200px);
    height: min(92vh, 820px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 20px 60px rgba(0,0,0,0.6);
  }
  .lb-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: #121220;
    border-bottom: 1px solid #2a2a3a;
    flex-shrink: 0;
  }
  .nav-btn {
    background: transparent;
    color: #8090b8;
    font-size: 18px;
    padding: 2px 8px;
  }
  .filename {
    flex: 1;
    font-size: 13px;
    color: #c0c8e0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .zoom-badge {
    font-size: 11px;
    color: #6080b8;
    background: #1e1e2e;
    padding: 2px 6px;
    border-radius: 4px;
    flex-shrink: 0;
  }
  .header-actions {
    display: flex;
    gap: 4px;
    align-items: center;
    flex-shrink: 0;
  }
  .header-actions a {
    color: #8090b8;
    text-decoration: none;
    font-size: 14px;
    padding: 4px 6px;
    background: #2a2a42;
    border-radius: 4px;
    line-height: 1;
  }
  .header-actions button {
    font-size: 13px;
    padding: 4px 7px;
    background: #2a2a42;
    color: #8090b8;
    border-radius: 4px;
  }
  .header-actions button:hover { background: #3a3a5a; color: #a0c4ff; }
  .active-btn { background: #303060 !important; color: #a0c4ff !important; }

  .lb-body {
    flex: 1;
    display: flex;
    overflow: hidden;
  }
  .image-area {
    flex: 1;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #0e0e18;
    overflow: hidden;
    user-select: none;
  }
  .image-area img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    display: block;
    transform-origin: center center;
    transition: transform 0.05s ease-out;
  }
  .loading {
    color: #505070;
    font-size: 1rem;
  }
  .nav-overlay {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    background: rgba(0,0,0,0.4);
    color: #c0c8e0;
    font-size: 32px;
    padding: 12px 6px;
    border-radius: 4px;
    line-height: 1;
    transition: background 0.15s;
    z-index: 2;
  }
  .nav-overlay:hover { background: rgba(80,100,160,0.6); }
  .nav-overlay.left  { left: 8px; }
  .nav-overlay.right { right: 8px; }
  .local-only-warn {
    position: absolute;
    bottom: 8px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(160,100,0,0.75);
    color: #ffe0a0;
    font-size: 11px;
    padding: 4px 10px;
    border-radius: 4px;
    pointer-events: none;
    white-space: nowrap;
  }
</style>
