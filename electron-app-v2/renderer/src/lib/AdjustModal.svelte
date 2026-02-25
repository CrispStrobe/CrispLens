<script>
  /**
   * AdjustModal — Photoshop-style Levels + colour/detail sliders.
   * Props: imageId (number), imageFilename (string)
   * Events: close, adjusted (detail: result)
   */
  import { createEventDispatcher, onMount, onDestroy, tick } from 'svelte';
  import { adjustImage, downloadImage, thumbnailUrl } from '../api.js';

  export let imageId = null;
  export let imageFilename = '';

  const dispatch = createEventDispatcher();

  // ── Levels state ─────────────────────────────────────────────────────────────
  let black_in   = 0;      // 0–253
  let white_in   = 255;    // 2–255
  let gamma_mid  = 1.0;    // 0.10–9.99  (midtone; Photoshop style)
  let black_out  = 0;      // 0–253
  let white_out  = 255;    // 2–255

  // ── Colour / detail sliders ───────────────────────────────────────────────────
  let brightness = 1.0;
  let contrast   = 1.0;
  let saturation = 1.0;
  let sharpness  = 1.0;
  let warmth     = 0.0;
  let preset     = null;
  let saveAs     = 'new_file';
  let suffix     = '_adj';

  // ── UI state ──────────────────────────────────────────────────────────────────
  let saving = false;
  let error  = '';
  let done   = false;
  let result = null;

  // ── Canvas refs ───────────────────────────────────────────────────────────────
  let previewEl;
  let levelsCanvas;   // histogram + input handles
  let outputCanvas;   // output gradient + handles
  let curveCanvas;    // transfer-function preview

  // ── Histogram data (computed once from preview img) ───────────────────────────
  let histR = new Uint32Array(256);
  let histG = new Uint32Array(256);
  let histB = new Uint32Array(256);
  let histMax = 1;

  function computeHistogram() {
    if (!previewEl?.complete || !previewEl.naturalWidth) return;
    const off = document.createElement('canvas');
    off.width = previewEl.naturalWidth; off.height = previewEl.naturalHeight;
    const oc = off.getContext('2d');
    oc.drawImage(previewEl, 0, 0);
    let px;
    try { px = oc.getImageData(0, 0, off.width, off.height).data; }
    catch { return; }
    histR = new Uint32Array(256); histG = new Uint32Array(256); histB = new Uint32Array(256);
    for (let i = 0; i < px.length; i += 4) {
      histR[px[i]]++; histG[px[i+1]]++; histB[px[i+2]]++;
    }
    histMax = Math.max(...histR, ...histG, ...histB, 1);
    redrawAll();
  }

  function onPreviewLoad() { computeHistogram(); }

  // ── Drawing helpers ───────────────────────────────────────────────────────────

  // x in canvas px for the midtone handle (between black_in and white_in)
  function midHandleX(W) {
    const span = Math.max(white_in - black_in, 1);
    const midVal = black_in + span * Math.pow(0.5, gamma_mid);
    return midVal / 255 * W;
  }

  // Upward-pointing triangle (▲): tip at (x, tipY), base above tipY
  function drawTriangle(ctx, x, tipY, size, fill, stroke) {
    ctx.beginPath();
    ctx.moveTo(x,          tipY);
    ctx.lineTo(x - size,   tipY + size * 1.6);
    ctx.lineTo(x + size,   tipY + size * 1.6);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke || 'rgba(100,140,220,0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  const HH = 56;   // histogram height (px in canvas)
  const HA = 22;   // input handle strip height

  function drawLevels() {
    if (!levelsCanvas) return;
    const rect = levelsCanvas.getBoundingClientRect();
    const W = Math.round(rect.width) || 240;
    levelsCanvas.width = W; levelsCanvas.height = HH + HA;
    const ctx = levelsCanvas.getContext('2d');

    // Histogram background
    ctx.fillStyle = '#080810';
    ctx.fillRect(0, 0, W, HH);

    // Histogram bars
    const bw = Math.max(1, W / 256);
    function histBar(bins, col) {
      ctx.fillStyle = col;
      for (let i = 0; i < 256; i++) {
        const bh = (bins[i] / histMax) * (HH - 2);
        ctx.fillRect(i / 256 * W, HH - bh, bw, bh);
      }
    }
    histBar(histR, 'rgba(200,50,50,0.55)');
    histBar(histG, 'rgba(50,190,60,0.45)');
    histBar(histB, 'rgba(50,90,210,0.55)');

    // Active range highlight
    ctx.fillStyle = 'rgba(74,158,255,0.08)';
    ctx.fillRect(black_in / 255 * W, 0, (white_in - black_in) / 255 * W, HH);

    // Clipped-out regions (subtle red tint)
    ctx.fillStyle = 'rgba(220,60,60,0.14)';
    if (black_in > 0)   ctx.fillRect(0, 0, black_in / 255 * W, HH);
    if (white_in < 255) ctx.fillRect(white_in / 255 * W, 0, (255 - white_in) / 255 * W, HH);

    // Handle strip
    ctx.fillStyle = '#111122';
    ctx.fillRect(0, HH, W, HA);

    // Thin separator
    ctx.fillStyle = '#1e1e30';
    ctx.fillRect(0, HH, W, 1);

    // Triangle handles (tip points up into histogram)
    const tipY = HH + 2;
    drawTriangle(ctx, black_in / 255 * W,  tipY, 7, '#000000', '#8090c0');
    drawTriangle(ctx, white_in / 255 * W,  tipY, 7, '#ffffff', '#8090c0');
    drawTriangle(ctx, midHandleX(W),        tipY, 7, '#909090', '#8090c0');
  }

  const OGH = 18;   // output gradient height
  const OHA = 22;   // output handle strip height

  function drawOutput() {
    if (!outputCanvas) return;
    const rect = outputCanvas.getBoundingClientRect();
    const W = Math.round(rect.width) || 240;
    outputCanvas.width = W; outputCanvas.height = OGH + OHA;
    const ctx = outputCanvas.getContext('2d');

    // Gradient bar
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, '#000'); grad.addColorStop(1, '#fff');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, OGH);

    // Active-range highlight on gradient
    ctx.fillStyle = 'rgba(74,158,255,0.14)';
    ctx.fillRect(black_out / 255 * W, 0, (white_out - black_out) / 255 * W, OGH);

    // Handle strip
    ctx.fillStyle = '#111122';
    ctx.fillRect(0, OGH, W, OHA);
    ctx.fillStyle = '#1e1e30';
    ctx.fillRect(0, OGH, W, 1);

    // Output handles — colors inverted so always visible
    const tipY = OGH + 2;
    drawTriangle(ctx, black_out / 255 * W, tipY, 7, '#ffffff', '#8090c0');
    drawTriangle(ctx, white_out / 255 * W, tipY, 7, '#000000', '#8090c0');
  }

  // Transfer function for curve canvas
  function lvlOut(x) {
    const t = Math.max(0, Math.min(1, (x - black_in) / Math.max(white_in - black_in, 1)));
    const tg = Math.pow(t, 1 / Math.max(gamma_mid, 0.001));
    return Math.max(0, Math.min(255, tg * (white_out - black_out) + black_out));
  }

  function drawCurve() {
    if (!curveCanvas) return;
    const rect = curveCanvas.getBoundingClientRect();
    const CW = Math.round(rect.width) || 120;
    const CH = Math.round(rect.height) || 120;
    curveCanvas.width = CW; curveCanvas.height = CH;
    const ctx = curveCanvas.getContext('2d');

    ctx.fillStyle = '#08080e';
    ctx.fillRect(0, 0, CW, CH);

    // Grid
    ctx.strokeStyle = '#1a1a2e'; ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath(); ctx.moveTo(i * CW / 4, 0); ctx.lineTo(i * CW / 4, CH); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * CH / 4); ctx.lineTo(CW, i * CH / 4); ctx.stroke();
    }
    // Neutral diagonal
    ctx.strokeStyle = '#252545'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, CH); ctx.lineTo(CW, 0); ctx.stroke();

    // Levels transfer curve
    ctx.strokeStyle = '#4a9eff'; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let xi = 0; xi <= 255; xi++) {
      const yo = lvlOut(xi);
      const px = xi / 255 * CW, py = CH - yo / 255 * CH;
      xi === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  function redrawAll() { drawLevels(); drawOutput(); drawCurve(); }

  // Reactive redraws
  $: { black_in; white_in; gamma_mid; black_out; white_out; redrawAll(); }

  // ── Drag handling ─────────────────────────────────────────────────────────────
  let dragging = null;  // null | 'black_in' | 'white_in' | 'gamma_mid' | 'black_out' | 'white_out'

  function pickInputHandle(mx, W) {
    const bx = black_in / 255 * W;
    const wx = white_in / 255 * W;
    const gx = midHandleX(W);
    const HR = 14;
    const db = Math.abs(mx - bx), dw = Math.abs(mx - wx), dg = Math.abs(mx - gx);
    const closest = Math.min(db, dw, dg);
    if (closest > HR) return null;
    if (closest === db) return 'black_in';
    if (closest === dw) return 'white_in';
    return 'gamma_mid';
  }

  function onLevelsDown(e) {
    const r = levelsCanvas.getBoundingClientRect();
    dragging = pickInputHandle(e.clientX - r.left, r.width);
  }

  function onOutputDown(e) {
    const r = outputCanvas.getBoundingClientRect();
    const mx = e.clientX - r.left, W = r.width;
    const bx = black_out / 255 * W, wx = white_out / 255 * W;
    const HR = 14;
    if (Math.abs(mx - bx) <= Math.abs(mx - wx) && Math.abs(mx - bx) < HR) dragging = 'black_out';
    else if (Math.abs(mx - wx) < HR) dragging = 'white_out';
  }

  function onWindowMove(e) {
    if (!dragging) return;

    if (dragging === 'black_in' || dragging === 'white_in' || dragging === 'gamma_mid') {
      const r = levelsCanvas.getBoundingClientRect();
      const mx = Math.max(0, Math.min(r.width, e.clientX - r.left));
      const W = r.width;

      if (dragging === 'black_in') {
        black_in = Math.max(0, Math.min(white_in - 2, Math.round(mx / W * 255)));
      } else if (dragging === 'white_in') {
        white_in = Math.max(black_in + 2, Math.min(255, Math.round(mx / W * 255)));
      } else {
        // gamma_mid: derive from midpoint x position
        const span = Math.max(white_in - black_in, 1);
        const midVal = mx / W * 255;
        const t = Math.max(0.001, Math.min(0.999, (midVal - black_in) / span));
        gamma_mid = Math.max(0.10, Math.min(9.99, +(Math.log(0.5) / Math.log(t)).toFixed(2)));
      }
    } else {
      const r = outputCanvas.getBoundingClientRect();
      const mx = Math.max(0, Math.min(r.width, e.clientX - r.left));
      const val = Math.round(mx / r.width * 255);
      if (dragging === 'black_out') black_out = Math.max(0, Math.min(white_out - 2, val));
      else white_out = Math.max(black_out + 2, Math.min(255, val));
    }
  }

  function onWindowUp() { dragging = null; }

  // ── CSS filter preview (for brightness/contrast/saturation/warmth) ────────────
  $: cssFilter = buildCssFilter(brightness, contrast, saturation, warmth, preset);

  function buildCssFilter(br, co, sa, wa, pr) {
    if (pr === 'bw')    return 'grayscale(1)';
    if (pr === 'sepia') return 'sepia(1)';
    let parts = [];
    let _br = br, _co = co, _sa = sa, _wa = wa;
    if (pr === 'cool')          _wa = -0.5;
    if (pr === 'warm')          _wa = 0.5;
    if (pr === 'vivid')         { _sa = Math.max(_sa, 1.6); _co = Math.max(_co, 1.2); }
    if (pr === 'auto_contrast') _co = Math.max(_co, 1.3);
    if (pr === 'lucky')         { _co = Math.max(_co, 1.3); _br = Math.max(_br, 1.05); _sa = Math.max(_sa, 1.15); }
    if (Math.abs(_br - 1) > 0.01) parts.push(`brightness(${_br.toFixed(2)})`);
    if (Math.abs(_co - 1) > 0.01) parts.push(`contrast(${_co.toFixed(2)})`);
    if (Math.abs(_sa - 1) > 0.01) parts.push(`saturate(${_sa.toFixed(2)})`);
    if (_wa > 0.01)       parts.push(`sepia(${(_wa * 0.5).toFixed(2)})`);
    else if (_wa < -0.01) parts.push(`hue-rotate(${(_wa * -25).toFixed(1)}deg)`);
    return parts.join(' ') || 'none';
  }

  // ── Presets ───────────────────────────────────────────────────────────────────
  const PRESETS = [
    { id: 'auto_contrast', label: 'Auto' },
    { id: 'lucky',         label: "I'm Lucky" },
    { id: 'bw',            label: 'B&W' },
    { id: 'sepia',         label: 'Sepia' },
    { id: 'vivid',         label: 'Vivid' },
    { id: 'cool',          label: 'Cool' },
    { id: 'warm',          label: 'Warm' },
  ];

  function applyPreset(id) {
    preset = preset === id ? null : id;
    if (preset) resetSliders();
  }

  function resetSliders() {
    brightness = 1.0; contrast = 1.0; saturation = 1.0;
    sharpness  = 1.0; warmth   = 0.0;
  }

  function resetLevels() {
    black_in = 0; white_in = 255; gamma_mid = 1.0;
    black_out = 0; white_out = 255;
  }

  function resetAll() { resetLevels(); resetSliders(); preset = null; }

  // ── Apply ─────────────────────────────────────────────────────────────────────
  async function doAdjust() {
    saving = true; error = ''; done = false; result = null;
    try {
      result = await adjustImage({
        image_id: imageId,
        black_in, white_in, gamma_mid, black_out, white_out,
        brightness, contrast, saturation, sharpness, warmth,
        preset: preset || null,
        save_as: saveAs, suffix,
      });
      done = true;
    } catch (e) {
      error = e.message || 'Adjustment failed';
    } finally {
      saving = false;
    }
  }

  function handleClose() {
    if (done && result) dispatch('adjusted', result);
    else dispatch('close');
  }

  function onKey(e) { if (e.key === 'Escape') handleClose(); }

  onMount(() => {
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousemove', onWindowMove);
    window.addEventListener('mouseup',  onWindowUp);
    if (previewEl?.complete && previewEl?.naturalWidth) computeHistogram();
  });
  onDestroy(() => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('mousemove', onWindowMove);
    window.removeEventListener('mouseup',  onWindowUp);
  });

  function fmtSigned(v) { return (v >= 0 ? '+' : '') + v.toFixed(2); }
</script>

<!-- svelte-ignore a11y-click-events-have-key-events -->
<div class="modal-overlay" on:click|self={handleClose}>
  <div class="modal">
    <div class="modal-header">
      <span class="title">Adjust: {imageFilename || `Image #${imageId}`}</span>
      <button class="close-btn" on:click={handleClose}>✕</button>
    </div>

    <div class="modal-body">
      {#if done && result}
        <div class="done-panel">
          <div class="done-title">✓ Saved</div>
          <div class="result-path" title={result.filepath}>{result.filepath}</div>
          <div class="done-size">{result.width} × {result.height} px</div>
          <div class="done-actions">
            {#if result.new_image_id}
              <button class="dl-btn" on:click={() => downloadImage(result.new_image_id, result.filepath?.split('/').pop())}>⬇ Download</button>
            {/if}
            <button class="primary" on:click={handleClose}>Close</button>
          </div>
        </div>
      {:else}
        <div class="two-col">

          <!-- ── LEFT: preview + levels ── -->
          <div class="left-col">

            <!-- Preview -->
            <div class="preview-wrap">
              <img
                bind:this={previewEl}
                src={thumbnailUrl(imageId, 280)}
                alt="preview"
                style="filter:{cssFilter};"
                on:load={onPreviewLoad}
                crossorigin="anonymous"
              />
              <span class="preview-note" title="Levels and sharpness are rendered server-side">ⓘ</span>
            </div>

            <!-- INPUT LEVELS -->
            <div class="section-label">
              Input Levels
              <button class="tiny-btn" on:click={resetLevels} title="Reset levels">↺</button>
            </div>

            <!-- Histogram + input handle canvas -->
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <canvas
              bind:this={levelsCanvas}
              class="levels-canvas"
              on:mousedown={onLevelsDown}
              style="cursor:{dragging && dragging !== 'black_out' && dragging !== 'white_out' ? 'ew-resize' : 'default'}"
            ></canvas>

            <!-- Numeric inputs for input levels -->
            <div class="lvl-nums">
              <input class="lvl-num" type="number" min="0" max="252" step="1"
                bind:value={black_in}
                on:change={() => { black_in = Math.max(0, Math.min(white_in-2, black_in)); }}
                title="Input black point" />
              <input class="lvl-num mid" type="number" min="0.10" max="9.99" step="0.01"
                bind:value={gamma_mid}
                on:change={() => { gamma_mid = Math.max(0.10, Math.min(9.99, gamma_mid)); }}
                title="Midtone gamma (1.00 = neutral; <1 = brighter, >1 = darker)" />
              <input class="lvl-num" type="number" min="3" max="255" step="1"
                bind:value={white_in}
                on:change={() => { white_in = Math.max(black_in+2, Math.min(255, white_in)); }}
                title="Input white point" style="text-align:right" />
            </div>

            <!-- OUTPUT LEVELS -->
            <div class="section-label">Output Levels</div>

            <!-- Output gradient + handle canvas -->
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <canvas
              bind:this={outputCanvas}
              class="output-canvas"
              on:mousedown={onOutputDown}
              style="cursor:{dragging === 'black_out' || dragging === 'white_out' ? 'ew-resize' : 'default'}"
            ></canvas>

            <div class="lvl-nums">
              <input class="lvl-num" type="number" min="0" max="252" step="1"
                bind:value={black_out}
                on:change={() => { black_out = Math.max(0, Math.min(white_out-2, black_out)); }}
                title="Output black point" />
              <input class="lvl-num" type="number" min="3" max="255" step="1"
                bind:value={white_out}
                on:change={() => { white_out = Math.max(black_out+2, Math.min(255, white_out)); }}
                title="Output white point" style="text-align:right" />
            </div>

            <!-- Curve preview -->
            <div class="section-label" style="margin-top:6px">Transfer curve</div>
            <canvas bind:this={curveCanvas} class="curve-canvas"></canvas>

          </div><!-- /left-col -->

          <!-- ── RIGHT: sliders ── -->
          <div class="right-col">

            <!-- Presets -->
            <div class="section-label">Presets</div>
            <div class="preset-row">
              {#each PRESETS as p}
                <button class="preset-btn" class:active={preset === p.id} on:click={() => applyPreset(p.id)}>{p.label}</button>
              {/each}
            </div>

            <!-- Light -->
            <div class="section-label">Light</div>

            <div class="slider-row">
              <span class="lbl">Brightness</span>
              <input type="range" min="0.1" max="2" step="0.05" bind:value={brightness} />
              <span class="val">{brightness.toFixed(2)}</span>
              <button class="reset-btn" on:click={() => brightness = 1.0}>↺</button>
            </div>
            <div class="slider-row">
              <span class="lbl">Contrast</span>
              <input type="range" min="0.1" max="2" step="0.05" bind:value={contrast} />
              <span class="val">{contrast.toFixed(2)}</span>
              <button class="reset-btn" on:click={() => contrast = 1.0}>↺</button>
            </div>

            <!-- Colour -->
            <div class="section-label">Colour</div>
            <div class="slider-row">
              <span class="lbl">Saturation</span>
              <input type="range" min="0" max="2" step="0.05" bind:value={saturation} />
              <span class="val">{saturation.toFixed(2)}</span>
              <button class="reset-btn" on:click={() => saturation = 1.0}>↺</button>
            </div>
            <div class="slider-row">
              <span class="lbl">Warmth</span>
              <input type="range" min="-1" max="1" step="0.05" bind:value={warmth} />
              <span class="val">{fmtSigned(warmth)}</span>
              <button class="reset-btn" on:click={() => warmth = 0}>↺</button>
            </div>

            <!-- Detail -->
            <div class="section-label">Detail <span class="server-note">(server-rendered)</span></div>
            <div class="slider-row">
              <span class="lbl">Sharpness</span>
              <input type="range" min="0" max="2" step="0.05" bind:value={sharpness} />
              <span class="val">{sharpness.toFixed(2)}</span>
              <button class="reset-btn" on:click={() => sharpness = 1.0}>↺</button>
            </div>

            <!-- Save -->
            <div class="section-label">Save as</div>
            <div class="save-row">
              <label class="radio"><input type="radio" bind:group={saveAs} value="replace"  /> Replace original</label>
              <label class="radio"><input type="radio" bind:group={saveAs} value="new_file" /> New file</label>
            </div>
            {#if saveAs === 'new_file'}
              <div class="slider-row">
                <span class="lbl">Suffix</span>
                <input type="text" bind:value={suffix} class="text-input" />
              </div>
            {/if}

            {#if error}
              <div class="error">{error}</div>
            {/if}

            <div class="action-row">
              <button class="primary" on:click={doAdjust} disabled={saving}>
                {saving ? 'Applying…' : 'Apply'}
              </button>
              <button on:click={resetAll} disabled={saving}>Reset All</button>
              <button on:click={handleClose} disabled={saving}>Cancel</button>
            </div>

          </div><!-- /right-col -->
        </div><!-- /two-col -->
      {/if}
    </div>
  </div>
</div>

<style>
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.82);
    z-index: 3000; display: flex; align-items: center; justify-content: center;
  }
  .modal {
    background: #1a1a28; border-radius: 10px;
    width: min(96vw, 860px); max-height: 94vh;
    display: flex; flex-direction: column;
    box-shadow: 0 20px 60px rgba(0,0,0,0.7); overflow: hidden;
  }
  .modal-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px; border-bottom: 1px solid #2a2a3a; flex-shrink: 0;
  }
  .title { font-size: 13px; font-weight: 600; color: #c0c8e0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .close-btn { background: transparent; border: none; color: #8090b8; font-size: 16px; cursor: pointer; padding: 2px 6px; border-radius: 4px; }
  .close-btn:hover { color: #e0e0e0; background: #2a2a42; }

  .modal-body { padding: 12px; overflow-y: auto; flex: 1; }
  .two-col { display: flex; gap: 14px; }

  /* ── Left column ── */
  .left-col { flex-shrink: 0; width: 260px; display: flex; flex-direction: column; gap: 6px; }

  .preview-wrap {
    position: relative; background: #0e0e18; border-radius: 6px; overflow: hidden;
  }
  .preview-wrap img { width: 100%; height: auto; display: block; }
  .preview-note {
    position: absolute; bottom: 3px; right: 5px;
    font-size: 9px; color: #3a4060; background: rgba(0,0,0,0.6);
    padding: 0 4px; border-radius: 6px; cursor: help;
  }

  /* INPUT LEVELS canvas */
  .levels-canvas {
    display: block; width: 100%;
    height: 78px;   /* HH+HA = 56+22 */
    border-radius: 4px; border: 1px solid #1a1a2e;
    user-select: none;
  }

  /* OUTPUT canvas */
  .output-canvas {
    display: block; width: 100%;
    height: 40px;   /* OGH+OHA = 18+22 */
    border-radius: 4px; border: 1px solid #1a1a2e;
    user-select: none;
  }

  /* Numeric rows */
  .lvl-nums {
    display: flex; gap: 4px;
  }
  .lvl-num {
    flex: 1; background: #0e0e1c; border: 1px solid #2a2a3a; color: #8090b8;
    padding: 3px 5px; border-radius: 3px; font-size: 11px; font-family: monospace;
    text-align: center; min-width: 0;
  }
  .lvl-num:focus { border-color: #4a6abf; outline: none; color: #c0c8e0; }
  .lvl-num.mid { color: #7090b0; }

  /* Curve preview */
  .curve-canvas {
    display: block; width: 100%; aspect-ratio: 16/9;
    border-radius: 4px; border: 1px solid #1a1a2e;
  }

  /* ── Right column ── */
  .right-col { flex: 1; display: flex; flex-direction: column; gap: 4px; min-width: 0; }

  .section-label {
    font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em;
    color: #505070; padding: 4px 0 2px; border-bottom: 1px solid #1e1e30;
    margin-top: 6px; display: flex; align-items: center; gap: 6px;
  }
  .server-note { font-size: 8px; color: #404060; text-transform: none; letter-spacing: 0; }
  .tiny-btn {
    background: transparent; border: none; color: #3a4060; font-size: 11px;
    cursor: pointer; padding: 0 3px; border-radius: 3px; margin-left: auto;
  }
  .tiny-btn:hover { color: #7090c0; background: #1e1e38; }

  .preset-row { display: flex; flex-wrap: wrap; gap: 4px; }
  .preset-btn {
    font-size: 10px; padding: 3px 9px; border-radius: 10px;
    background: #252540; color: #7080a0; border: 1px solid #333355; cursor: pointer;
  }
  .preset-btn:hover { background: #303060; color: #a0c4ff; }
  .preset-btn.active { background: #3a5080; color: #a0d4ff; border-color: #4a6090; }

  .slider-row { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
  .lbl { font-size: 10px; color: #8090b8; min-width: 68px; flex-shrink: 0; }
  .slider-row input[type="range"] { flex: 1; min-width: 60px; accent-color: #4a7acf; cursor: pointer; }
  .val { font-size: 10px; color: #6070a0; min-width: 38px; text-align: right; font-family: monospace; }
  .reset-btn {
    background: transparent; border: none; color: #3a4060;
    font-size: 12px; cursor: pointer; padding: 0 2px; border-radius: 3px;
  }
  .reset-btn:hover { color: #8090c0; background: #2a2a40; }

  .save-row { display: flex; gap: 14px; flex-wrap: wrap; padding: 2px 0; }
  .radio { display: flex; align-items: center; gap: 4px; font-size: 11px; color: #c0c8e0; cursor: pointer; }
  .text-input { flex: 1; background: #1e1e2e; border: 1px solid #3a3a5a; color: #e0e0e0; padding: 3px 8px; border-radius: 4px; font-size: 12px; }

  .error { color: #ff8080; font-size: 11px; background: #3a1a1a; padding: 6px 8px; border-radius: 4px; }

  .action-row { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  .action-row button { font-size: 12px; padding: 5px 14px; border-radius: 4px; cursor: pointer; border: none; }
  button.primary { background: #3a6abf; color: white; }
  button.primary:hover { background: #4a7acf; }
  button.primary:disabled, .action-row button:disabled { opacity: 0.5; cursor: not-allowed; }
  .action-row button:not(.primary) { background: #252540; color: #9090c0; border: 1px solid #333355; }
  .action-row button:not(.primary):hover { background: #303060; color: #c0c8e0; }

  /* Done panel */
  .done-panel { display: flex; flex-direction: column; gap: 10px; padding: 8px 0; }
  .done-title { font-size: 14px; color: #80d080; }
  .result-path { font-family: monospace; font-size: 11px; color: #7090c0; overflow-wrap: break-word; }
  .done-size { font-size: 11px; color: #506080; }
  .done-actions { display: flex; gap: 8px; }
  .dl-btn { background: #1e3a1e; color: #60c060; border: 1px solid #2a4a2a; padding: 4px 12px; border-radius: 4px; font-size: 12px; cursor: pointer; }
  .dl-btn:hover { background: #2a4a2a; }
</style>
