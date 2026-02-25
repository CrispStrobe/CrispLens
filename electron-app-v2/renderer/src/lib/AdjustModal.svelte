<script>
  /**
   * AdjustModal — Picasa-style tonal / colour adjustments.
   * Props: imageId (number), imageFilename (string)
   * Events: close, adjusted (detail: result)
   */
  import { createEventDispatcher, onMount, onDestroy, tick } from 'svelte';
  import { adjustImage, downloadImage, thumbnailUrl } from '../api.js';

  export let imageId = null;
  export let imageFilename = '';

  const dispatch = createEventDispatcher();

  // ── Slider state ─────────────────────────────────────────────────────────────
  let brightness  = 1.0;
  let contrast    = 1.0;
  let saturation  = 1.0;
  let sharpness   = 1.0;
  let gamma       = 1.0;    // 0.5–3.0
  let shadows     = 0.0;    // -1..+1
  let highlights  = 0.0;    // -1..+1
  let warmth      = 0.0;
  let preset      = null;
  let saveAs      = 'new_file';
  let suffix      = '_adj';

  // ── UI state ──────────────────────────────────────────────────────────────────
  let saving = false;
  let error  = '';
  let done   = false;
  let result = null;

  // ── Preview ───────────────────────────────────────────────────────────────────
  let previewEl;

  $: cssFilter = buildCssFilter(brightness, contrast, saturation, gamma, warmth, preset);

  function buildCssFilter(br, co, sa, ga, wa, pr) {
    if (pr === 'bw')    return 'grayscale(1)';
    if (pr === 'sepia') return 'sepia(1)';
    let parts = [];
    let _br = br, _co = co, _sa = sa, _wa = wa;
    if (pr === 'cool')          _wa = -0.5;
    if (pr === 'warm')          _wa = 0.5;
    if (pr === 'vivid')         { _sa = Math.max(_sa, 1.6); _co = Math.max(_co, 1.2); }
    if (pr === 'auto_contrast') _co = Math.max(_co, 1.3);
    if (pr === 'lucky')         { _co = Math.max(_co, 1.3); _br = Math.max(_br, 1.05); _sa = Math.max(_sa, 1.15); }

    if (Math.abs(_br - 1.0) > 0.01) parts.push(`brightness(${_br.toFixed(2)})`);
    if (Math.abs(_co - 1.0) > 0.01) parts.push(`contrast(${_co.toFixed(2)})`);
    if (Math.abs(_sa - 1.0) > 0.01) parts.push(`saturate(${_sa.toFixed(2)})`);
    if (Math.abs(ga - 1.0) > 0.02)
      parts.push(`brightness(${(1/ga).toFixed(2)}) contrast(${ga.toFixed(2)})`);
    if (_wa > 0.01)       parts.push(`sepia(${(_wa * 0.5).toFixed(2)})`);
    else if (_wa < -0.01) parts.push(`hue-rotate(${(_wa * -25).toFixed(1)}deg)`);
    return parts.join(' ') || 'none';
  }

  // ── Histogram ─────────────────────────────────────────────────────────────────
  let histCanvas;

  async function drawHistogram() {
    if (!histCanvas || !previewEl || !previewEl.complete || !previewEl.naturalWidth) return;
    await tick();
    const W = histCanvas.width  = histCanvas.offsetWidth  || 300;
    const H = histCanvas.height = 48;
    const ctx = histCanvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    const off = document.createElement('canvas');
    off.width = previewEl.naturalWidth; off.height = previewEl.naturalHeight;
    const oc = off.getContext('2d');
    oc.drawImage(previewEl, 0, 0);
    let pixels;
    try { pixels = oc.getImageData(0, 0, off.width, off.height).data; }
    catch { return; }
    const rB = new Uint32Array(256), gB = new Uint32Array(256), bB = new Uint32Array(256);
    for (let i = 0; i < pixels.length; i += 4) {
      rB[pixels[i]]++; gB[pixels[i+1]]++; bB[pixels[i+2]]++;
    }
    const maxV = Math.max(...rB, ...gB, ...bB, 1);
    const bw = Math.max(1, Math.round(W / 256));
    function ch(bins, colour) {
      ctx.fillStyle = colour;
      for (let i = 0; i < 256; i++) {
        const bh = Math.round((bins[i] / maxV) * H);
        ctx.fillRect(Math.round(i / 256 * W), H - bh, bw, bh);
      }
    }
    ch(rB, 'rgba(220,60,60,0.55)');
    ch(gB, 'rgba(60,200,80,0.45)');
    ch(bB, 'rgba(60,100,220,0.55)');
  }

  function onPreviewLoad() { drawHistogram(); }

  // ── Curves canvas ─────────────────────────────────────────────────────────────
  // Interactive gamma/tonal transfer curve.
  // Handles:
  //   • mid  — drag up/down  → adjusts gamma
  //   • shad — drag up/down at x=0 → adjusts shadows
  //   • hi   — drag up/down at x=255 → adjusts highlights
  let curveCanvas;
  let curveDrag = null;   // null | 'mid' | 'shad' | 'hi'
  const CW = 180, CH = 180;   // logical canvas size

  // Compute the transfer curve output for input x∈[0,255]
  function curveOut(x, ga, sh, hi) {
    // 1. gamma
    let y = 255 * Math.pow(x / 255, 1 / Math.max(ga, 0.01));
    // 2. tonal
    const t = y / 255;
    const sl = sh * Math.pow(1 - t, 2) * 255;
    const hp = hi * Math.pow(t,     2) * 128;
    return Math.max(0, Math.min(255, y + sl - hp));
  }

  // Handle positions in canvas coords
  function midHandlePos(ga, sh, hi) {
    const outY = curveOut(127, ga, sh, hi);
    return { x: 127 / 255 * CW, y: CH - outY / 255 * CH };
  }
  function shadHandlePos(sh, hi) {
    const outY = curveOut(0, 1, sh, hi);   // gamma not applied at 0
    return { x: 4, y: CH - outY / 255 * CH };
  }
  function hiHandlePos(ga, sh, hi) {
    const outY = curveOut(255, ga, sh, hi);
    return { x: CW - 4, y: CH - outY / 255 * CH };
  }

  function drawCurve() {
    if (!curveCanvas) return;
    curveCanvas.width = CW; curveCanvas.height = CH;
    const ctx = curveCanvas.getContext('2d');

    // Background
    ctx.fillStyle = '#0a0a16';
    ctx.fillRect(0, 0, CW, CH);

    // Grid lines
    ctx.strokeStyle = '#1a1a2e';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const gx = i * CW / 4, gy = i * CH / 4;
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, CH); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(CW, gy); ctx.stroke();
    }

    // Neutral diagonal
    ctx.strokeStyle = '#252540';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, CH); ctx.lineTo(CW, 0); ctx.stroke();

    // Transfer curve
    ctx.strokeStyle = '#4a9eff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let xi = 0; xi <= 255; xi++) {
      const yo = curveOut(xi, gamma, shadows, highlights);
      const cx = xi / 255 * CW;
      const cy = CH - yo / 255 * CH;
      xi === 0 ? ctx.moveTo(cx, cy) : ctx.lineTo(cx, cy);
    }
    ctx.stroke();

    // Handles
    const R = 6;
    function dot(x, y, col) {
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1; ctx.stroke();
    }
    const mid  = midHandlePos(gamma, shadows, highlights);
    const shad = shadHandlePos(shadows, highlights);
    const hi   = hiHandlePos(gamma, shadows, highlights);
    dot(shad.x, shad.y, '#a04040');
    dot(hi.x,   hi.y,   '#a0a040');
    dot(mid.x,  mid.y,  '#4a9eff');
  }

  // Reactive redraw whenever gamma/shadows/highlights change
  $: { gamma; shadows; highlights; drawCurve(); }

  // Curve drag interaction
  function onCurveDown(e) {
    const r = curveCanvas.getBoundingClientRect();
    const scaleX = CW / r.width, scaleY = CH / r.height;
    const mx = (e.clientX - r.left) * scaleX;
    const my = (e.clientY - r.top)  * scaleY;

    const hit = (hx, hy) => Math.hypot(mx - hx, my - hy) < 14;
    const mid  = midHandlePos(gamma, shadows, highlights);
    const shad = shadHandlePos(shadows, highlights);
    const hi   = hiHandlePos(gamma, shadows, highlights);

    if (hit(mid.x,  mid.y))  curveDrag = 'mid';
    else if (hit(shad.x, shad.y)) curveDrag = 'shad';
    else if (hit(hi.x,   hi.y))   curveDrag = 'hi';
  }

  function onCurveMove(e) {
    if (!curveDrag) return;
    const r = curveCanvas.getBoundingClientRect();
    const scaleY = CH / r.height;
    const my = (e.clientY - r.top) * scaleY;

    if (curveDrag === 'mid') {
      // Mid output value from y position (clamped away from extremes)
      const outY = Math.max(4, Math.min(251, (CH - my) / CH * 255));
      // Derive gamma: outY = 255*(127/255)^(1/gamma)
      // → gamma = log(127/255) / log(outY/255)
      const logBase = Math.log(127 / 255);
      const logOut  = Math.log(outY / 255);
      if (Math.abs(logOut) > 1e-6)
        gamma = Math.max(0.5, Math.min(3.0, logBase / logOut));
    } else if (curveDrag === 'shad') {
      // Output at x=0 → direct shadow lift
      const outY = Math.max(0, Math.min(200, (CH - my) / CH * 255));
      // shadows * 1^2 * 255 = outY → shadows = outY/255
      shadows = Math.max(-1, Math.min(1, outY / 255));
    } else if (curveDrag === 'hi') {
      // Output at x=255: 255 - highlights*255*1^2*128/255 ≈ 255 - highlights*128
      const outY = Math.max(55, Math.min(255, (CH - my) / CH * 255));
      highlights = Math.max(-1, Math.min(1, (255 - outY) / 128));
    }
  }

  function onCurveUp() { curveDrag = null; }

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
    if (preset) {
      brightness = 1.0; contrast = 1.0; saturation = 1.0;
      sharpness  = 1.0; gamma   = 1.0; shadows    = 0.0;
      highlights = 0.0; warmth  = 0.0;
    }
  }

  function resetAll() {
    brightness = 1.0; contrast = 1.0; saturation = 1.0;
    sharpness  = 1.0; gamma   = 1.0; shadows    = 0.0;
    highlights = 0.0; warmth  = 0.0; preset = null;
  }

  // ── Apply ─────────────────────────────────────────────────────────────────────
  async function doAdjust() {
    saving = true; error = ''; done = false; result = null;
    try {
      result = await adjustImage({
        image_id: imageId,
        brightness, contrast, saturation, sharpness,
        gamma, shadows, highlights, warmth,
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
    window.addEventListener('mousemove', onCurveMove);
    window.addEventListener('mouseup', onCurveUp);
    if (previewEl?.complete && previewEl?.naturalWidth) drawHistogram();
  });
  onDestroy(() => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('mousemove', onCurveMove);
    window.removeEventListener('mouseup', onCurveUp);
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
          <div class="done-title">✓ Saved successfully</div>
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

          <!-- ── Left: preview + histogram + curves ── -->
          <div class="left-col">
            <div class="preview-wrap">
              <img
                bind:this={previewEl}
                src={thumbnailUrl(imageId, 300)}
                alt="preview"
                style="filter: {cssFilter};"
                on:load={onPreviewLoad}
                crossorigin="anonymous"
              />
              <div class="filter-note" title="Shadows, highlights and sharpness are applied server-side only">ⓘ Server renders full result</div>
            </div>
            <canvas bind:this={histCanvas} class="histogram"></canvas>

            <!-- Curves canvas -->
            <div class="curve-section">
              <div class="curve-label">
                Tone curve
                <span class="curve-hint">drag ● to adjust</span>
              </div>
              <!-- svelte-ignore a11y-click-events-have-key-events -->
              <canvas
                bind:this={curveCanvas}
                class="curve-canvas"
                width={CW} height={CH}
                on:mousedown={onCurveDown}
              ></canvas>
              <div class="curve-legend">
                <span class="dot-shad">●</span> Shadows
                <span class="dot-mid">●</span> Gamma
                <span class="dot-hi">●</span> Highlights
              </div>
            </div>
          </div>

          <!-- ── Right: controls ── -->
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
              <button class="reset-btn" on:click={() => brightness = 1.0} title="Reset">↺</button>
            </div>

            <div class="slider-row">
              <span class="lbl">Contrast</span>
              <input type="range" min="0.1" max="2" step="0.05" bind:value={contrast} />
              <span class="val">{contrast.toFixed(2)}</span>
              <button class="reset-btn" on:click={() => contrast = 1.0} title="Reset">↺</button>
            </div>

            <!-- Tone -->
            <div class="section-label">Tone curve controls</div>

            <div class="slider-row">
              <span class="lbl">Gamma</span>
              <input type="range" min="0.5" max="3" step="0.05" bind:value={gamma} />
              <span class="val">{gamma.toFixed(2)}</span>
              <button class="reset-btn" on:click={() => gamma = 1.0} title="Reset">↺</button>
            </div>

            <div class="slider-row">
              <span class="lbl">Shadows</span>
              <input type="range" min="-1" max="1" step="0.05" bind:value={shadows} />
              <span class="val">{fmtSigned(shadows)}</span>
              <button class="reset-btn" on:click={() => shadows = 0} title="Reset">↺</button>
            </div>

            <div class="slider-row">
              <span class="lbl">Highlights</span>
              <input type="range" min="-1" max="1" step="0.05" bind:value={highlights} />
              <span class="val">{fmtSigned(highlights)}</span>
              <button class="reset-btn" on:click={() => highlights = 0} title="Reset">↺</button>
            </div>

            <!-- Colour -->
            <div class="section-label">Colour</div>

            <div class="slider-row">
              <span class="lbl">Saturation</span>
              <input type="range" min="0" max="2" step="0.05" bind:value={saturation} />
              <span class="val">{saturation.toFixed(2)}</span>
              <button class="reset-btn" on:click={() => saturation = 1.0} title="Reset">↺</button>
            </div>

            <div class="slider-row">
              <span class="lbl">Warmth</span>
              <input type="range" min="-1" max="1" step="0.05" bind:value={warmth} />
              <span class="val">{fmtSigned(warmth)}</span>
              <button class="reset-btn" on:click={() => warmth = 0} title="Reset">↺</button>
            </div>

            <!-- Detail -->
            <div class="section-label">Detail <span class="server-note">(server-rendered)</span></div>

            <div class="slider-row">
              <span class="lbl">Sharpness</span>
              <input type="range" min="0" max="2" step="0.05" bind:value={sharpness} />
              <span class="val">{sharpness.toFixed(2)}</span>
              <button class="reset-btn" on:click={() => sharpness = 1.0} title="Reset">↺</button>
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
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.8);
    z-index: 3000;
    display: flex; align-items: center; justify-content: center;
  }
  .modal {
    background: #1a1a28;
    border-radius: 10px;
    width: min(96vw, 860px);
    max-height: 94vh;
    display: flex; flex-direction: column;
    box-shadow: 0 20px 60px rgba(0,0,0,0.7);
    overflow: hidden;
  }
  .modal-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px; border-bottom: 1px solid #2a2a3a; flex-shrink: 0;
  }
  .title { font-size: 13px; font-weight: 600; color: #c0c8e0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .close-btn { background: transparent; border: none; color: #8090b8; font-size: 16px; cursor: pointer; padding: 2px 6px; border-radius: 4px; }
  .close-btn:hover { color: #e0e0e0; background: #2a2a42; }

  .modal-body { padding: 12px; overflow-y: auto; flex: 1; }

  .two-col { display: flex; gap: 16px; }

  /* ── Left column ── */
  .left-col { flex-shrink: 0; width: 200px; display: flex; flex-direction: column; gap: 8px; }
  .preview-wrap { position: relative; background: #0e0e18; border-radius: 6px; overflow: hidden; min-height: 60px; }
  .preview-wrap img { width: 100%; height: auto; display: block; }
  .filter-note {
    position: absolute; bottom: 4px; right: 6px;
    font-size: 9px; color: #4a5070; background: rgba(10,10,20,0.75);
    padding: 1px 5px; border-radius: 8px; cursor: help;
  }
  .histogram { width: 100%; height: 48px; background: #0e0e18; border-radius: 4px; display: block; }

  /* Curves */
  .curve-section { display: flex; flex-direction: column; gap: 4px; }
  .curve-label {
    font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em;
    color: #505070; display: flex; align-items: center; gap: 6px;
  }
  .curve-hint { text-transform: none; letter-spacing: 0; color: #3a3a58; font-size: 8px; }
  .curve-canvas {
    width: 100%; aspect-ratio: 1;
    display: block; cursor: crosshair;
    border-radius: 4px;
    border: 1px solid #1a1a2e;
    box-sizing: border-box;
  }
  .curve-legend {
    font-size: 9px; color: #4a5070;
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
  }
  .dot-shad { color: #a04040; }
  .dot-mid  { color: #4a9eff; }
  .dot-hi   { color: #a0a040; }

  /* ── Right column ── */
  .right-col { flex: 1; display: flex; flex-direction: column; gap: 4px; min-width: 0; overflow-y: auto; }

  .section-label {
    font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em;
    color: #505070; padding: 6px 0 2px; border-bottom: 1px solid #1e1e30; margin-top: 4px;
  }
  .server-note { font-size: 8px; color: #404060; text-transform: none; letter-spacing: 0; }

  /* Presets */
  .preset-row { display: flex; flex-wrap: wrap; gap: 4px; }
  .preset-btn {
    font-size: 10px; padding: 3px 9px; border-radius: 10px;
    background: #252540; color: #7080a0; border: 1px solid #333355;
    cursor: pointer; transition: background 0.1s;
  }
  .preset-btn:hover { background: #303060; color: #a0c4ff; }
  .preset-btn.active { background: #3a5080; color: #a0d4ff; border-color: #4a6090; }

  /* Slider rows */
  .slider-row { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
  .lbl { font-size: 10px; color: #8090b8; min-width: 68px; flex-shrink: 0; }
  .slider-row input[type="range"] { flex: 1; min-width: 60px; accent-color: #4a7acf; height: 4px; cursor: pointer; }
  .val { font-size: 10px; color: #6070a0; min-width: 38px; text-align: right; font-family: monospace; }
  .reset-btn {
    background: transparent; border: none; color: #3a4060;
    font-size: 12px; cursor: pointer; padding: 0 2px; border-radius: 3px; line-height: 1;
  }
  .reset-btn:hover { color: #8090c0; background: #2a2a40; }

  /* Save */
  .save-row { display: flex; gap: 14px; flex-wrap: wrap; padding: 2px 0; }
  .radio { display: flex; align-items: center; gap: 4px; font-size: 11px; color: #c0c8e0; cursor: pointer; }
  .text-input { flex: 1; background: #1e1e2e; border: 1px solid #3a3a5a; color: #e0e0e0; padding: 3px 8px; border-radius: 4px; font-size: 12px; }

  /* Error */
  .error { color: #ff8080; font-size: 11px; background: #3a1a1a; padding: 6px 8px; border-radius: 4px; }

  /* Actions */
  .action-row { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  .action-row button { font-size: 12px; padding: 5px 14px; border-radius: 4px; cursor: pointer; border: none; }
  button.primary { background: #3a6abf; color: white; }
  button.primary:hover { background: #4a7acf; }
  button.primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .action-row button:not(.primary) { background: #252540; color: #9090c0; border: 1px solid #333355; }
  .action-row button:not(.primary):hover { background: #303060; color: #c0c8e0; }
  .action-row button:disabled { opacity: 0.5; cursor: not-allowed; }

  /* Done panel */
  .done-panel { display: flex; flex-direction: column; gap: 10px; padding: 8px 0; }
  .done-title { font-size: 14px; color: #80d080; }
  .result-path { font-family: monospace; font-size: 11px; color: #7090c0; overflow-wrap: break-word; }
  .done-size { font-size: 11px; color: #506080; }
  .done-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .dl-btn { background: #1e3a1e; color: #60c060; border: 1px solid #2a4a2a; padding: 4px 12px; border-radius: 4px; font-size: 12px; cursor: pointer; }
  .dl-btn:hover { background: #2a4a2a; }
</style>
