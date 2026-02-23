<script>
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { cropImage } from '../api.js';

  export let imageId;
  export let imageUrl;

  const dispatch = createEventDispatcher();

  const PRESETS = [
    ['Free', 0, 0],
    ['1:1',  1, 1],
    ['4:3',  4, 3],
    ['3:2',  3, 2],
    ['16:9', 16, 9],
  ];
  let presetIdx = 0;
  $: aspectRatio = PRESETS[presetIdx][1] && PRESETS[presetIdx][2]
    ? PRESETS[presetIdx][1] / PRESETS[presetIdx][2]
    : 0;

  // Selection in natural image pixels
  let selX = 0, selY = 0, selW = 0, selH = 0;

  let imgEl, canvasEl;
  let naturalW = 0, naturalH = 0;
  let displayW = 0, displayH = 0;
  let scale = 1; // naturalW / displayW  (and Y, assuming uniform scaling)

  // Drag
  let dragging = false;
  let dragMode = null; // 'create' | 'move' | 'tl' | 'tr' | 'bl' | 'br'
  let dragStart = { x: 0, y: 0, sx: 0, sy: 0, sw: 0, sh: 0 };

  // Save options
  let saveAs   = 'replace';
  let newFilename = '';
  let saving   = false;
  let errorMsg = '';

  onMount(() => {
    window.addEventListener('keydown',   onKey);
    window.addEventListener('mousemove', onWindowMouseMove);
    window.addEventListener('mouseup',   onWindowMouseUp);
  });
  onDestroy(() => {
    window.removeEventListener('keydown',   onKey);
    window.removeEventListener('mousemove', onWindowMouseMove);
    window.removeEventListener('mouseup',   onWindowMouseUp);
  });

  function onKey(e) {
    if (e.key === 'Escape') dispatch('close');
  }

  function onImgLoad() {
    naturalW = imgEl.naturalWidth;
    naturalH = imgEl.naturalHeight;
    // Use offsetWidth/Height — available immediately after load on a block element
    displayW = imgEl.offsetWidth;
    displayH = imgEl.offsetHeight;
    scale    = naturalW / displayW;
    // Set canvas internal resolution to match the image pixel-for-pixel
    canvasEl.width  = displayW;
    canvasEl.height = displayH;
    // Default selection = full image
    selX = 0; selY = 0; selW = naturalW; selH = naturalH;
    drawOverlay();
  }

  // ── Coordinate helpers ────────────────────────────────────────────────────

  // natural ↔ display pixel conversion
  function n2d(v) { return v / scale; }
  function d2n(v) { return v * scale; }

  // Map a mouse event to canvas-pixel coordinates (handles CSS ≠ internal size)
  function canvasPos(e) {
    const r  = canvasEl.getBoundingClientRect();
    const sx = canvasEl.width  / r.width;
    const sy = canvasEl.height / r.height;
    return {
      x: (e.clientX - r.left) * sx,
      y: (e.clientY - r.top)  * sy,
    };
  }

  // ── Hit testing ───────────────────────────────────────────────────────────

  const HIT = 12; // px in canvas (display) space

  function hitHandle(px, py) {
    const dx = n2d(selX), dy = n2d(selY), dw = n2d(selW), dh = n2d(selH);
    const inL = px >= dx   - HIT && px <= dx   + HIT;
    const inR = px >= dx+dw- HIT && px <= dx+dw+ HIT;
    const inT = py >= dy   - HIT && py <= dy   + HIT;
    const inB = py >= dy+dh- HIT && py <= dy+dh+ HIT;
    if (inL && inT) return 'tl';
    if (inR && inT) return 'tr';
    if (inL && inB) return 'bl';
    if (inR && inB) return 'br';
    return null;
  }

  function hitInside(px, py) {
    const dx = n2d(selX), dy = n2d(selY), dw = n2d(selW), dh = n2d(selH);
    return px > dx + HIT && px < dx+dw - HIT &&
           py > dy + HIT && py < dy+dh - HIT;
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  function drawOverlay() {
    if (!canvasEl || !displayW) return;
    const ctx = canvasEl.getContext('2d');
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

    const dx = n2d(selX), dy = n2d(selY), dw = n2d(selW), dh = n2d(selH);

    // Darken everything outside selection
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);
    ctx.clearRect(dx, dy, dw, dh);

    // Selection border
    ctx.strokeStyle = '#4a9eff';
    ctx.lineWidth   = 2;
    ctx.strokeRect(dx, dy, dw, dh);

    // Rule-of-thirds guides inside selection
    ctx.strokeStyle = 'rgba(74,158,255,0.25)';
    ctx.lineWidth   = 1;
    for (let i = 1; i < 3; i++) {
      ctx.beginPath(); ctx.moveTo(dx + dw*i/3, dy); ctx.lineTo(dx + dw*i/3, dy+dh); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(dx, dy + dh*i/3); ctx.lineTo(dx+dw, dy + dh*i/3); ctx.stroke();
    }

    // Corner handles
    const hs = 8;
    ctx.fillStyle = '#4a9eff';
    [
      [dx,       dy],
      [dx+dw-hs, dy],
      [dx,       dy+dh-hs],
      [dx+dw-hs, dy+dh-hs],
    ].forEach(([hx, hy]) => ctx.fillRect(hx, hy, hs, hs));

    // Size label
    const lbl = `${selW} × ${selH}`;
    ctx.font = '11px monospace';
    const tw = ctx.measureText(lbl).width + 8;
    const ly = dy >= 22 ? dy - 22 : dy + dh + 4;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(dx, ly, tw, 18);
    ctx.fillStyle = '#a0c4ff';
    ctx.fillText(lbl, dx + 4, ly + 13);
  }

  $: { selX; selY; selW; selH; drawOverlay(); }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function applyAspect(w, h) {
    if (!aspectRatio) return { w: Math.round(w), h: Math.round(h) };
    if (w / h > aspectRatio) w = h * aspectRatio;
    else                      h = w / aspectRatio;
    return { w: Math.round(w), h: Math.round(h) };
  }

  // ── Mouse handlers ────────────────────────────────────────────────────────

  function onMouseDown(e) {
    if (e.button !== 0 || !displayW) return;
    e.preventDefault();
    const { x, y } = canvasPos(e);
    const handle = hitHandle(x, y);
    dragMode = handle ?? (hitInside(x, y) ? 'move' : 'create');
    dragging  = true;
    dragStart = { x, y, sx: selX, sy: selY, sw: selW, sh: selH };
  }

  function onWindowMouseMove(e) {
    if (!dragging || !canvasEl) return;
    const { x, y } = canvasPos(e);
    const ddx = d2n(x - dragStart.x);
    const ddy = d2n(y - dragStart.y);

    if (dragMode === 'create') {
      let x0 = d2n(dragStart.x), y0 = d2n(dragStart.y);
      let x1 = d2n(x),           y1 = d2n(y);
      if (x1 < x0) [x0, x1] = [x1, x0];
      if (y1 < y0) [y0, y1] = [y1, y0];
      x0 = clamp(x0, 0, naturalW); x1 = clamp(x1, 0, naturalW);
      y0 = clamp(y0, 0, naturalH); y1 = clamp(y1, 0, naturalH);
      const { w, h } = applyAspect(x1 - x0, y1 - y0);
      selX = x0; selY = y0; selW = Math.max(1, w); selH = Math.max(1, h);

    } else if (dragMode === 'move') {
      selX = clamp(dragStart.sx + ddx, 0, naturalW - selW);
      selY = clamp(dragStart.sy + ddy, 0, naturalH - selH);

    } else {
      // Corner resize: recompute the rect from which corner moved
      let { sx, sy, sw, sh } = dragStart;
      let x0 = sx, y0 = sy, x1 = sx+sw, y1 = sy+sh;
      if (dragMode === 'tl') { x0 += ddx; y0 += ddy; }
      if (dragMode === 'tr') { x1 += ddx; y0 += ddy; }
      if (dragMode === 'bl') { x0 += ddx; y1 += ddy; }
      if (dragMode === 'br') { x1 += ddx; y1 += ddy; }
      if (x1 < x0) [x0, x1] = [x1, x0];
      if (y1 < y0) [y0, y1] = [y1, y0];
      x0 = clamp(x0, 0, naturalW); x1 = clamp(x1, 0, naturalW);
      y0 = clamp(y0, 0, naturalH); y1 = clamp(y1, 0, naturalH);
      const { w, h } = applyAspect(x1 - x0, y1 - y0);
      selX = x0; selY = y0; selW = Math.max(1, w); selH = Math.max(1, h);
    }
    drawOverlay();
  }

  function onWindowMouseUp() { dragging = false; }

  // ── Controls ──────────────────────────────────────────────────────────────

  function setPreset(idx) {
    presetIdx = idx;
    if (PRESETS[idx][1]) {
      const { w, h } = applyAspect(selW, selH);
      selW = w; selH = h;
    }
  }

  function resetSelection() {
    selX = 0; selY = 0; selW = naturalW; selH = naturalH;
  }

  async function doCrop() {
    if (!selW || !selH) return;
    saving   = true;
    errorMsg = '';
    try {
      const result = await cropImage(
        imageId, selX, selY, selW, selH,
        saveAs,
        saveAs === 'new_file' ? (newFilename || null) : null,
      );
      dispatch('cropped', result);
      dispatch('close');
    } catch (err) {
      errorMsg = err.message;
    } finally {
      saving = false;
    }
  }
</script>

<!-- svelte-ignore a11y-click-events-have-key-events -->
<div class="modal-overlay" on:click|self={() => dispatch('close')}>
  <div class="modal">
    <div class="modal-header">
      <span class="title">Crop Image</span>
      <button on:click={() => dispatch('close')}>✕</button>
    </div>

    <div class="modal-body">
      <!-- Image area: canvas-wrapper shrinks to exactly the image size -->
      <div class="image-wrap">
        <div class="canvas-wrapper">
          <img
            src={imageUrl}
            alt=""
            bind:this={imgEl}
            on:load={onImgLoad}
            draggable="false"
          />
          <!-- svelte-ignore a11y-click-events-have-key-events -->
          <canvas
            bind:this={canvasEl}
            class="crop-canvas"
            on:mousedown={onMouseDown}
          ></canvas>
        </div>
      </div>

      <!-- Controls panel -->
      <div class="controls-panel">

        <!-- Aspect ratio presets -->
        <div class="section-label">Aspect ratio</div>
        <div class="preset-row">
          {#each PRESETS as p, i}
            <button
              class="preset-btn"
              class:active={presetIdx === i}
              on:click={() => setPreset(i)}
            >{p[0]}</button>
          {/each}
        </div>

        <!-- Pixel inputs -->
        <div class="section-label">Selection (px)</div>
        <div class="inputs-grid">
          <label>X
            <input type="number"
              value={selX}
              min="0" max={naturalW - 1}
              on:change={e => { selX = clamp(+e.target.value || 0, 0, naturalW - selW); }}
            />
          </label>
          <label>Y
            <input type="number"
              value={selY}
              min="0" max={naturalH - 1}
              on:change={e => { selY = clamp(+e.target.value || 0, 0, naturalH - selH); }}
            />
          </label>
          <label>W
            <input type="number"
              value={selW}
              min="1" max={naturalW}
              on:change={e => {
                const w = clamp(+e.target.value || 1, 1, naturalW - selX);
                const r = applyAspect(w, selH);
                selW = r.w; selH = r.h;
              }}
            />
          </label>
          <label>H
            <input type="number"
              value={selH}
              min="1" max={naturalH}
              on:change={e => {
                const h = clamp(+e.target.value || 1, 1, naturalH - selY);
                const r = applyAspect(selW, h);
                selW = r.w; selH = r.h;
              }}
            />
          </label>
        </div>

        <div class="dim-row">
          Image: {naturalW} × {naturalH} px
          <button class="reset-btn" on:click={resetSelection} title="Reset to full image">↺ Reset</button>
        </div>

        <!-- Save options -->
        <div class="section-label">Save as</div>
        <div class="radio-group">
          <label class="radio">
            <input type="radio" bind:group={saveAs} value="replace" />
            Replace original
          </label>
          <label class="radio">
            <input type="radio" bind:group={saveAs} value="new_file" />
            New file
          </label>
        </div>

        {#if saveAs === 'new_file'}
          <input
            type="text"
            bind:value={newFilename}
            placeholder="Filename (auto if blank)"
            class="filename-input"
          />
        {/if}

        {#if errorMsg}
          <div class="error-msg">{errorMsg}</div>
        {/if}

        <div class="action-row">
          <button class="btn-primary" on:click={doCrop} disabled={saving || !selW}>
            {saving ? 'Saving…' : 'Crop & Save'}
          </button>
          <button on:click={() => dispatch('close')}>Cancel</button>
        </div>
      </div>
    </div>
  </div>
</div>

<style>
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.82);
    z-index: 3000;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .modal {
    background: #1a1a28;
    border-radius: 10px;
    width: min(96vw, 1020px);
    max-height: 94vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 20px 60px rgba(0,0,0,0.75);
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid #2a2a3a;
    flex-shrink: 0;
  }
  .title { font-size: 14px; font-weight: 600; color: #c0c8e0; }
  .modal-header button {
    background: none;
    border: none;
    color: #6070a0;
    font-size: 16px;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .modal-header button:hover { color: #c0c8e0; background: #2a2a42; }

  /* ── Body layout ── */
  .modal-body {
    flex: 1;
    display: flex;
    gap: 0;
    overflow: hidden;
    min-height: 0;
  }

  /* ── Image area ── */
  .image-wrap {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #0c0c18;
    overflow: hidden;
    min-width: 0;
  }

  /*
   * canvas-wrapper shrinks to exactly the image's rendered size.
   * The canvas is then pinned over it with inset:0.
   * No JS positioning required.
   */
  .canvas-wrapper {
    position: relative;
    display: inline-block;
    line-height: 0; /* kill inline gap below img */
  }

  .canvas-wrapper img {
    display: block;
    max-width: 100%;
    max-height: calc(94vh - 100px);
    object-fit: contain;
    user-select: none;
    -webkit-user-drag: none;
  }

  .crop-canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    cursor: crosshair;
    touch-action: none;
  }

  /* ── Controls panel ── */
  .controls-panel {
    width: 240px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 14px 12px;
    overflow-y: auto;
    border-left: 1px solid #222232;
  }

  .section-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: #505070;
    margin-top: 4px;
  }

  .preset-row { display: flex; gap: 4px; flex-wrap: wrap; }
  .preset-btn {
    font-size: 11px;
    padding: 3px 8px;
    border-radius: 4px;
    background: #252540;
    color: #7080a8;
    border: 1px solid #303050;
    cursor: pointer;
  }
  .preset-btn:hover  { background: #2e2e52; color: #a0b0d0; }
  .preset-btn.active { background: #2a3a6a; color: #a0c4ff; border-color: #4a6aaa; }

  .inputs-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }
  .inputs-grid label {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 10px;
    color: #7080a0;
  }
  .inputs-grid input {
    width: 100%;
    font-size: 12px;
    padding: 4px 6px;
    background: #121220;
    border: 1px solid #2a2a42;
    border-radius: 4px;
    color: #b0c0e0;
    text-align: right;
  }
  .inputs-grid input:focus { border-color: #4a6aaa; outline: none; }

  .dim-row {
    font-size: 10px;
    color: #404058;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .reset-btn {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 4px;
    background: #252540;
    color: #7080a8;
    border: 1px solid #303050;
    cursor: pointer;
    margin-left: auto;
  }
  .reset-btn:hover { background: #2e2e52; color: #a0b0d0; }

  .radio-group { display: flex; flex-direction: column; gap: 5px; }
  .radio {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: #9098b8;
    cursor: pointer;
  }

  .filename-input {
    width: 100%;
    font-size: 12px;
    padding: 5px 8px;
    background: #121220;
    border: 1px solid #2a2a42;
    border-radius: 4px;
    color: #b0c0e0;
    box-sizing: border-box;
  }
  .filename-input:focus { border-color: #4a6aaa; outline: none; }

  .error-msg {
    font-size: 11px;
    color: #e07070;
    background: #2a1010;
    border: 1px solid #5a2020;
    padding: 6px 8px;
    border-radius: 4px;
  }

  .action-row {
    display: flex;
    gap: 8px;
    margin-top: auto;
    padding-top: 8px;
  }
  .action-row button {
    font-size: 12px;
    padding: 6px 14px;
    border-radius: 5px;
    cursor: pointer;
  }
  .btn-primary {
    background: #2a4a8a;
    border: 1px solid #3a6aba;
    color: #c0d8ff;
    flex: 1;
  }
  .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-primary:not(:disabled):hover { background: #3a5a9a; }
</style>
