<script>
  /**
   * AdjustModal — Photoshop-style Levels + colour/detail adjustments.
   * Live preview: all controls rendered client-side via canvas ImageData.
   * Props: imageId (number), imageFilename (string)
   * Events: close, adjusted (detail: result)
   */
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { t } from '../stores.js';
  import { adjustImage, downloadImage, thumbnailUrl, isLocalMode, importProcessed } from '../api.js';

  export let imageId   = null;
  export let imageFilename = '';

  const dispatch = createEventDispatcher();

  // ── Levels ────────────────────────────────────────────────────────────────────
  let black_in  = 0;     // 0–253
  let white_in  = 255;   // 2–255
  let gamma_mid = 1.0;   // 0.10–9.99
  let black_out = 0;     // 0–253
  let white_out = 255;   // 2–255

  // ── Colour / detail ───────────────────────────────────────────────────────────
  let brightness = 1.0;
  let contrast   = 1.0;
  let saturation = 1.0;
  let sharpness  = 1.0;
  let warmth     = 0.0;
  let preset     = null;
  let saveAs     = 'new_file';
  let suffix     = '_adj';

  // ── UI ────────────────────────────────────────────────────────────────────────
  let saving = false, error = '', done = false, result = null;

  // ── Canvas refs ───────────────────────────────────────────────────────────────
  let displayCanvas;   // live pixel preview
  let levelsCanvas;    // histogram + input handles
  let outputCanvas;    // output gradient + handles
  let curveCanvas;     // transfer-function mini-view

  // ── Source pixel cache ────────────────────────────────────────────────────────
  let srcPixels = null;
  let srcW = 0, srcH = 0;
  let histR = new Uint32Array(256);
  let histG = new Uint32Array(256);
  let histB = new Uint32Array(256);
  let histMax = 1;

  function loadSource() {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      srcW = img.naturalWidth; srcH = img.naturalHeight;
      const off = document.createElement('canvas');
      off.width = srcW; off.height = srcH;
      const ctx = off.getContext('2d');
      ctx.drawImage(img, 0, 0);
      try {
        const data = ctx.getImageData(0, 0, srcW, srcH).data;
        srcPixels = new Uint8ClampedArray(data);
        // histogram
        histR = new Uint32Array(256); histG = new Uint32Array(256); histB = new Uint32Array(256);
        for (let i = 0; i < srcPixels.length; i += 4) {
          histR[srcPixels[i]]++; histG[srcPixels[i+1]]++; histB[srcPixels[i+2]]++;
        }
        histMax = Math.max(...histR, ...histG, ...histB, 1);
        redrawAll();
        scheduleRender();
      } catch { /* cross-origin blocked — just no live preview */ }
    };
    img.src = thumbnailUrl(imageId, 300);
  }

  // ── Live preview rendering ────────────────────────────────────────────────────
  let rafPending = false;
  function scheduleRender() {
    if (rafPending || !srcPixels) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; renderPreview(); });
  }

  // Reactive: fire on any control change
  $: { black_in; white_in; gamma_mid; black_out; white_out;
       brightness; contrast; saturation; warmth; sharpness; preset;
       scheduleRender(); }

  function c255(v) { return Math.max(0, Math.min(255, (v + 0.5) | 0)); }

  function buildLUT() {
    const lut = new Uint8ClampedArray(256);
    const span = Math.max(white_in - black_in, 1);
    const inv_g = 1 / Math.max(gamma_mid, 0.001);
    const span_out = white_out - black_out;
    for (let i = 0; i < 256; i++) {
      const t = Math.max(0, Math.min(1, (i - black_in) / span));
      lut[i] = Math.max(0, Math.min(255, (Math.pow(t, inv_g) * span_out + black_out + 0.5) | 0));
    }
    return lut;
  }

  function applySharpness(px, W, H, factor) {
    // Unsharp mask: result = orig + (factor-1)*(orig - boxblur)
    const tmp = new Uint8ClampedArray(px.length);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const base = (y * W + x) * 4;
        for (let c = 0; c < 3; c++) {
          let s = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              s += px[(Math.max(0, Math.min(H-1, y+dy)) * W + Math.max(0, Math.min(W-1, x+dx))) * 4 + c];
            }
          }
          tmp[base + c] = (s / 9 + 0.5) | 0;
        }
        tmp[base + 3] = px[base + 3];
      }
    }
    const k = factor - 1;
    for (let i = 0; i < px.length; i += 4) {
      for (let c = 0; c < 3; c++)
        px[i+c] = Math.max(0, Math.min(255, (px[i+c] + k * (px[i+c] - tmp[i+c]) + 0.5) | 0));
    }
  }

  function renderPreview() {
    if (!srcPixels || !displayCanvas) return;
    const px = new Uint8ClampedArray(srcPixels);

    if (preset === 'bw') {
      for (let i = 0; i < px.length; i += 4) {
        const l = c255(0.299*px[i] + 0.587*px[i+1] + 0.114*px[i+2]);
        px[i] = px[i+1] = px[i+2] = l;
      }
    } else if (preset === 'sepia') {
      for (let i = 0; i < px.length; i += 4) {
        const r=px[i], g=px[i+1], b=px[i+2];
        px[i]   = c255(r*0.393 + g*0.769 + b*0.189);
        px[i+1] = c255(r*0.349 + g*0.686 + b*0.168);
        px[i+2] = c255(r*0.272 + g*0.534 + b*0.131);
      }
    } else {
      const lut = buildLUT();
      let _br=brightness, _co=contrast, _sa=saturation, _wa=warmth;
      if (preset==='cool')          _wa = -0.5;
      if (preset==='warm')          _wa =  0.5;
      if (preset==='vivid')         { _sa=Math.max(_sa,1.6); _co=Math.max(_co,1.2); }
      if (preset==='auto_contrast') _co = Math.max(_co,1.3);
      if (preset==='lucky')         { _co=Math.max(_co,1.3); _br=Math.max(_br,1.05); _sa=Math.max(_sa,1.15); }
      const ws = _wa * 25;

      for (let i = 0; i < px.length; i += 4) {
        let r=lut[px[i]], g=lut[px[i+1]], b=lut[px[i+2]];
        // warmth
        r = c255(r + ws); b = c255(b - ws);
        // saturation
        if (Math.abs(_sa-1) > 0.005) {
          const lum = 0.299*r + 0.587*g + 0.114*b;
          r = c255(lum + (r-lum)*_sa); g = c255(lum + (g-lum)*_sa); b = c255(lum + (b-lum)*_sa);
        }
        // brightness
        if (Math.abs(_br-1) > 0.005) { r=c255(r*_br); g=c255(g*_br); b=c255(b*_br); }
        // contrast (pivot 127.5)
        if (Math.abs(_co-1) > 0.005) {
          r=c255(127.5+(r-127.5)*_co); g=c255(127.5+(g-127.5)*_co); b=c255(127.5+(b-127.5)*_co);
        }
        px[i]=r; px[i+1]=g; px[i+2]=b;
      }
      if (Math.abs(sharpness-1) > 0.05) applySharpness(px, srcW, srcH, sharpness);
    }

    displayCanvas.width  = srcW;
    displayCanvas.height = srcH;
    displayCanvas.getContext('2d').putImageData(new ImageData(px, srcW, srcH), 0, 0);
  }

  // ── Levels / output / curve canvas drawing ────────────────────────────────────
  const HH = 48, HA = 20;         // input histogram height + handle strip
  const OGH = 14, OHA = 18;       // output gradient + handle strip

  $: { black_in; white_in; gamma_mid; black_out; white_out; redrawAll(); }

  function redrawAll() { drawLevels(); drawOutput(); drawCurve(); }

  function midHandleX(W) {
    const span = Math.max(white_in - black_in, 1);
    return (black_in + span * Math.pow(0.5, gamma_mid)) / 255 * W;
  }

  function tri(ctx, x, tipY, size, fill) {
    ctx.beginPath();
    ctx.moveTo(x, tipY);
    ctx.lineTo(x - size, tipY + size * 1.7);
    ctx.lineTo(x + size, tipY + size * 1.7);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = 'rgba(100,140,220,0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function drawLevels() {
    if (!levelsCanvas) return;
    const r = levelsCanvas.getBoundingClientRect();
    const W = Math.round(r.width) || 190;
    levelsCanvas.width = W; levelsCanvas.height = HH + HA;
    const ctx = levelsCanvas.getContext('2d');

    ctx.fillStyle = '#08080e'; ctx.fillRect(0, 0, W, HH);
    const bw = Math.max(1, W / 256);
    function hbar(bins, col) {
      ctx.fillStyle = col;
      for (let i = 0; i < 256; i++) {
        const h = (bins[i] / histMax) * (HH - 1);
        ctx.fillRect(i / 256 * W, HH - h, bw, h);
      }
    }
    hbar(histR, 'rgba(210,50,50,0.55)');
    hbar(histG, 'rgba(50,185,60,0.45)');
    hbar(histB, 'rgba(50,90,210,0.55)');

    // Active range
    ctx.fillStyle = 'rgba(74,158,255,0.07)';
    ctx.fillRect(black_in/255*W, 0, (white_in-black_in)/255*W, HH);
    // Clipped zones
    ctx.fillStyle = 'rgba(220,60,60,0.14)';
    if (black_in > 0)   ctx.fillRect(0, 0, black_in/255*W, HH);
    if (white_in < 255) ctx.fillRect(white_in/255*W, 0, (255-white_in)/255*W, HH);

    ctx.fillStyle = '#0e0e1c'; ctx.fillRect(0, HH, W, HA);
    ctx.fillStyle = '#1a1a2e'; ctx.fillRect(0, HH, W, 1);

    tri(ctx, black_in/255*W,  HH+2, 6, '#111');
    tri(ctx, white_in/255*W,  HH+2, 6, '#eee');
    tri(ctx, midHandleX(W),   HH+2, 6, '#888');
  }

  function drawOutput() {
    if (!outputCanvas) return;
    const r = outputCanvas.getBoundingClientRect();
    const W = Math.round(r.width) || 190;
    outputCanvas.width = W; outputCanvas.height = OGH + OHA;
    const ctx = outputCanvas.getContext('2d');

    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, '#000'); grad.addColorStop(1, '#fff');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, W, OGH);
    ctx.fillStyle = 'rgba(74,158,255,0.12)';
    ctx.fillRect(black_out/255*W, 0, (white_out-black_out)/255*W, OGH);

    ctx.fillStyle = '#0e0e1c'; ctx.fillRect(0, OGH, W, OHA);
    ctx.fillStyle = '#1a1a2e'; ctx.fillRect(0, OGH, W, 1);

    tri(ctx, black_out/255*W, OGH+2, 6, '#eee');
    tri(ctx, white_out/255*W, OGH+2, 6, '#111');
  }

  function lvlOut(x) {
    const t = Math.max(0, Math.min(1, (x - black_in) / Math.max(white_in - black_in, 1)));
    return Math.max(0, Math.min(255, Math.pow(t, 1/Math.max(gamma_mid,0.001)) * (white_out-black_out) + black_out));
  }

  function drawCurve() {
    if (!curveCanvas) return;
    const r = curveCanvas.getBoundingClientRect();
    const CW = Math.round(r.width) || 190, CH = Math.round(r.height) || 60;
    curveCanvas.width = CW; curveCanvas.height = CH;
    const ctx = curveCanvas.getContext('2d');
    ctx.fillStyle = '#08080e'; ctx.fillRect(0, 0, CW, CH);
    // grid
    ctx.strokeStyle = '#16162a'; ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath(); ctx.moveTo(i*CW/4,0); ctx.lineTo(i*CW/4,CH); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0,i*CH/4); ctx.lineTo(CW,i*CH/4); ctx.stroke();
    }
    // diagonal
    ctx.strokeStyle='#222240'; ctx.beginPath(); ctx.moveTo(0,CH); ctx.lineTo(CW,0); ctx.stroke();
    // curve
    ctx.strokeStyle='#4a9eff'; ctx.lineWidth=2; ctx.beginPath();
    for (let xi=0; xi<=255; xi++) {
      const yo=lvlOut(xi);
      xi===0 ? ctx.moveTo(0,CH) : ctx.lineTo(xi/255*CW, CH-yo/255*CH);
    }
    ctx.stroke();
  }

  // ── Drag ──────────────────────────────────────────────────────────────────────
  let dragging = null;

  function onLevelsDown(e) {
    const r = levelsCanvas.getBoundingClientRect();
    const mx = e.clientX - r.left, W = r.width;
    const bx=black_in/255*W, wx=white_in/255*W, gx=midHandleX(W), HR=14;
    const db=Math.abs(mx-bx), dw=Math.abs(mx-wx), dg=Math.abs(mx-gx);
    const mn=Math.min(db,dw,dg);
    if (mn>HR) return;
    dragging = mn===db ? 'black_in' : mn===dw ? 'white_in' : 'gamma_mid';
  }

  function onOutputDown(e) {
    const r = outputCanvas.getBoundingClientRect();
    const mx=e.clientX-r.left, W=r.width, HR=14;
    const db=Math.abs(mx-black_out/255*W), dw=Math.abs(mx-white_out/255*W);
    if (Math.min(db,dw)>HR) return;
    dragging = db<=dw ? 'black_out' : 'white_out';
  }

  function onWindowMove(e) {
    if (!dragging) return;
    if (dragging==='black_in'||dragging==='white_in'||dragging==='gamma_mid') {
      const r=levelsCanvas.getBoundingClientRect();
      const mx=Math.max(0,Math.min(r.width,e.clientX-r.left)), W=r.width;
      const val=Math.round(mx/W*255);
      if (dragging==='black_in')
        black_in=Math.max(0,Math.min(white_in-2,val));
      else if (dragging==='white_in')
        white_in=Math.max(black_in+2,Math.min(255,val));
      else {
        const span=Math.max(white_in-black_in,1);
        const t=Math.max(0.001,Math.min(0.999,(mx/W*255-black_in)/span));
        gamma_mid=Math.max(0.10,Math.min(9.99,+(Math.log(0.5)/Math.log(t)).toFixed(2)));
      }
    } else {
      const r=outputCanvas.getBoundingClientRect();
      const val=Math.round(Math.max(0,Math.min(r.width,e.clientX-r.left))/r.width*255);
      if (dragging==='black_out') black_out=Math.max(0,Math.min(white_out-2,val));
      else white_out=Math.max(black_out+2,Math.min(255,val));
    }
  }

  function onWindowUp() { dragging = null; }

  // ── Presets ───────────────────────────────────────────────────────────────────
  const PRESETS = [
    {id:'auto_contrast',label:'Auto'},
    {id:'lucky',label:"Lucky"},
    {id:'bw',label:'B&W'},
    {id:'sepia',label:'Sepia'},
    {id:'vivid',label:'Vivid'},
    {id:'cool',label:'Cool'},
    {id:'warm',label:'Warm'},
  ];

  function applyPreset(id) {
    preset = preset===id ? null : id;
    if (preset) { brightness=1; contrast=1; saturation=1; sharpness=1; warmth=0; }
  }

  function resetAll() {
    black_in=0; white_in=255; gamma_mid=1; black_out=0; white_out=255;
    brightness=1; contrast=1; saturation=1; sharpness=1; warmth=0; preset=null;
  }

  // ── Apply ─────────────────────────────────────────────────────────────────────
  async function doAdjust() {
    saving=true; error=''; done=false; result=null;
    try {
      if (isLocalMode() && displayCanvas && srcPixels) {
        // Standalone mode: canvas already has adjusted pixels — convert to blob and import
        renderPreview(); // ensure latest params are rendered
        const blob = await new Promise(res => displayCanvas.toBlob(res, 'image/jpeg', 0.92));
        const baseName = (imageFilename || `image_${imageId}`).replace(/\.[^.]+$/, '');
        const adjName = `${baseName}${suffix || '_adj'}.jpg`;
        const adjHash = `adj_${imageId}_${Date.now()}`;
        // Convert blob to base64 for thumbnail storage
        const b64 = await new Promise(res => {
          const reader = new FileReader();
          reader.onload = () => res(reader.result.split(',')[1]);
          reader.readAsDataURL(blob);
        });
        const res = await importProcessed({
          filepath:     `browser:${adjHash}.jpg`,
          filename:     adjName,
          width:        srcW,
          height:       srcH,
          file_size:    blob.size,
          thumbnail_b64: b64,
          faces:        [],
          duplicate_mode: 'skip',
        });
        result = {
          ok: true,
          new_image_id: res.image_id ?? null,
          filepath: adjName,
          width: srcW,
          height: srcH,
        };
      } else {
        result = await adjustImage({
          image_id:imageId,
          black_in,white_in,gamma_mid,black_out,white_out,
          brightness,contrast,saturation,sharpness,warmth,
          preset:preset||null, save_as:saveAs, suffix,
        });
      }
      done=true;
    } catch(e) { error=e.message||'Adjustment failed'; }
    finally { saving=false; }
  }

  function handleClose() {
    if (done&&result) dispatch('adjusted',result);
    else dispatch('close');
  }

  onMount(() => {
    window.addEventListener('keydown', e => { if(e.key==='Escape') handleClose(); });
    window.addEventListener('mousemove', onWindowMove);
    window.addEventListener('mouseup',  onWindowUp);
    loadSource();
  });
  onDestroy(() => {
    window.removeEventListener('mousemove', onWindowMove);
    window.removeEventListener('mouseup',  onWindowUp);
  });

  function fmtS(v) { return (v>=0?'+':'')+v.toFixed(2); }
</script>

<!-- svelte-ignore a11y-click-events-have-key-events -->
<div class="overlay" on:click|self={handleClose}>
  <div class="modal">

    <div class="mhead">
      <span class="title">Adjust — {imageFilename||`#${imageId}`}</span>
      <button class="xbtn" on:click={handleClose}>✕</button>
    </div>

    <div class="mbody">
      {#if done && result}
        <div class="done">
          <div class="done-ok">{$t('adj_saved')}</div>
          <div class="done-path" title={result.filepath}>{result.filepath}</div>
          <div class="done-dim">{result.width} × {result.height} px</div>
          <div class="done-btns">
            {#if result.new_image_id}
              <button class="dl" on:click={() => downloadImage(result.new_image_id, result.filepath?.split('/').pop())}>⬇ {$t('download')}</button>
            {/if}
            <button class="primary" on:click={handleClose}>{$t('close')}</button>
          </div>
        </div>
      {:else}
        <div class="cols">

          <!-- ─── LEFT: live preview + levels ─── -->
          <div class="lcol">

            <!-- Live preview canvas -->
            <div class="prev-wrap">
              {#if srcPixels}
                <canvas bind:this={displayCanvas} class="prev-canvas"></canvas>
              {:else}
                <!-- Fallback while loading -->
                <img src={thumbnailUrl(imageId, 280)} alt="preview" class="prev-fallback" />
              {/if}
            </div>

            <!-- INPUT LEVELS -->
            <div class="slabel">
              {$t('adj_input_levels')}
              <button class="tinybtn" on:click={() => { black_in=0; white_in=255; gamma_mid=1; }}>↺</button>
            </div>
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <canvas bind:this={levelsCanvas} class="lvl-canvas" on:mousedown={onLevelsDown}
              style="cursor:{dragging&&dragging!=='black_out'&&dragging!=='white_out'?'ew-resize':'crosshair'}">
            </canvas>
            <div class="nrow">
              <input class="nbox" type="number" min="0" max="252" bind:value={black_in}
                on:change={() => black_in=Math.max(0,Math.min(white_in-2,+black_in||0))}
                title="Input black point" />
              <input class="nbox mid" type="number" min="0.10" max="9.99" step="0.01" bind:value={gamma_mid}
                on:change={() => gamma_mid=Math.max(0.10,Math.min(9.99,+gamma_mid||1))}
                title="Midtone gamma (1.00 = neutral)" />
              <input class="nbox" type="number" min="3" max="255" bind:value={white_in}
                on:change={() => white_in=Math.max(black_in+2,Math.min(255,+white_in||255))}
                title="Input white point" style="text-align:right" />
            </div>

            <!-- OUTPUT LEVELS -->
            <div class="slabel">
              {$t('adj_output')}
              <button class="tinybtn" on:click={() => { black_out=0; white_out=255; }}>↺</button>
            </div>
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <canvas bind:this={outputCanvas} class="out-canvas" on:mousedown={onOutputDown}
              style="cursor:{dragging==='black_out'||dragging==='white_out'?'ew-resize':'crosshair'}">
            </canvas>
            <div class="nrow">
              <input class="nbox" type="number" min="0" max="252" bind:value={black_out}
                on:change={() => black_out=Math.max(0,Math.min(white_out-2,+black_out||0))}
                title="Output black point" />
              <input class="nbox" type="number" min="3" max="255" bind:value={white_out}
                on:change={() => white_out=Math.max(black_out+2,Math.min(255,+white_out||255))}
                title="Output white point" style="text-align:right" />
            </div>

            <!-- Curve preview -->
            <canvas bind:this={curveCanvas} class="curve-canvas"></canvas>

          </div>

          <!-- ─── RIGHT: sliders ─── -->
          <div class="rcol">

            <div class="slabel">{$t('adj_presets')}</div>
            <div class="presets">
              {#each PRESETS as p}
                <button class="pbtn" class:on={preset===p.id} on:click={() => applyPreset(p.id)}>{p.label}</button>
              {/each}
            </div>

            <div class="slabel">{$t('adj_light')}</div>
            <div class="srow">
              <span class="lbl">{$t('adj_brightness')}</span>
              <input type="range" min="0.1" max="2" step="0.05" bind:value={brightness} />
              <span class="val">{brightness.toFixed(2)}</span>
              <button class="rb" on:click={() => brightness=1}>↺</button>
            </div>
            <div class="srow">
              <span class="lbl">{$t('adj_contrast')}</span>
              <input type="range" min="0.1" max="2" step="0.05" bind:value={contrast} />
              <span class="val">{contrast.toFixed(2)}</span>
              <button class="rb" on:click={() => contrast=1}>↺</button>
            </div>

            <div class="slabel">{$t('adj_colour')}</div>
            <div class="srow">
              <span class="lbl">{$t('adj_saturation')}</span>
              <input type="range" min="0" max="2" step="0.05" bind:value={saturation} />
              <span class="val">{saturation.toFixed(2)}</span>
              <button class="rb" on:click={() => saturation=1}>↺</button>
            </div>
            <div class="srow">
              <span class="lbl">{$t('adj_warmth')}</span>
              <input type="range" min="-1" max="1" step="0.05" bind:value={warmth} />
              <span class="val">{fmtS(warmth)}</span>
              <button class="rb" on:click={() => warmth=0}>↺</button>
            </div>

            <div class="slabel">{$t('adj_detail')}</div>
            <div class="srow">
              <span class="lbl">{$t('adj_sharpness')}</span>
              <input type="range" min="0" max="2" step="0.05" bind:value={sharpness} />
              <span class="val">{sharpness.toFixed(2)}</span>
              <button class="rb" on:click={() => sharpness=1}>↺</button>
            </div>

            <div class="slabel">{$t('adj_save_as')}</div>
            <div class="save-row">
              <label class="radio"><input type="radio" bind:group={saveAs} value="replace"  /> {$t('adj_replace_orig')}</label>
              <label class="radio"><input type="radio" bind:group={saveAs} value="new_file" /> {$t('adj_new_file')}</label>
            </div>
            {#if saveAs==='new_file'}
              <div class="srow">
                <span class="lbl">{$t('adj_suffix')}</span>
                <input type="text" bind:value={suffix} class="tinput" />
              </div>
            {/if}

            {#if error}<div class="err">{error}</div>{/if}

            <div class="acts">
              <button class="primary" on:click={doAdjust} disabled={saving}>
                {saving ? $t('adj_applying') : $t('apply')}
              </button>
              <button class="sec" on:click={resetAll} disabled={saving}>{$t('adj_reset_all')}</button>
              <button class="sec" on:click={handleClose} disabled={saving}>{$t('cancel')}</button>
            </div>

          </div>
        </div>
      {/if}
    </div>

  </div>
</div>

<style>
  .overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.82);
    z-index: 3000; display: flex; align-items: center; justify-content: center;
  }
  .modal {
    background: #181824; border-radius: 10px;
    width: min(96vw, 720px); max-height: 90vh;
    display: flex; flex-direction: column;
    box-shadow: 0 20px 60px rgba(0,0,0,0.7); overflow: hidden;
  }
  .mhead {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 12px; border-bottom: 1px solid #252535; flex-shrink: 0;
  }
  .title { font-size: 12px; font-weight: 600; color: #b0b8d0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .xbtn { background: transparent; border: none; color: #707090; font-size: 14px; cursor: pointer; padding: 2px 5px; border-radius: 3px; }
  .xbtn:hover { color: #e0e0e0; background: #2a2a42; }

  .mbody { padding: 10px; overflow-y: auto; flex: 1; }

  .cols { display: flex; gap: 12px; }

  /* ─── Left column ─── */
  .lcol { flex-shrink: 0; width: 190px; display: flex; flex-direction: column; gap: 5px; }

  .prev-wrap { background: #080810; border-radius: 5px; overflow: hidden; min-height: 40px; }
  .prev-canvas { display: block; width: 100%; height: auto; }
  .prev-fallback { display: block; width: 100%; height: auto; }

  .lvl-canvas {
    display: block; width: 100%; height: 68px;   /* HH+HA = 48+20 */
    border-radius: 3px; border: 1px solid #181828; user-select: none;
  }
  .out-canvas {
    display: block; width: 100%; height: 32px;   /* OGH+OHA = 14+18 */
    border-radius: 3px; border: 1px solid #181828; user-select: none;
  }
  .curve-canvas {
    display: block; width: 100%; height: 60px;
    border-radius: 3px; border: 1px solid #181828;
  }

  .nrow { display: flex; gap: 3px; }
  .nbox {
    flex: 1; background: #0c0c18; border: 1px solid #222232; color: #7090b8;
    padding: 2px 4px; border-radius: 3px; font-size: 10px; font-family: monospace;
    text-align: center; min-width: 0;
  }
  .nbox:focus { border-color: #4a6abf; outline: none; color: #b0c0d8; }
  .nbox.mid { color: #6090b0; }

  /* ─── Right column ─── */
  .rcol { flex: 1; display: flex; flex-direction: column; gap: 3px; min-width: 0; }

  .slabel {
    font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em;
    color: #454565; border-bottom: 1px solid #1c1c2c; padding: 4px 0 2px;
    margin-top: 5px; display: flex; align-items: center; gap: 5px;
  }
  .slabel:first-child { margin-top: 0; }
  .tinybtn {
    background: transparent; border: none; color: #333355; font-size: 10px;
    cursor: pointer; padding: 0 3px; border-radius: 3px; margin-left: auto;
  }
  .tinybtn:hover { color: #6090c0; background: #1e1e38; }

  .presets { display: flex; flex-wrap: wrap; gap: 3px; }
  .pbtn {
    font-size: 10px; padding: 2px 7px; border-radius: 8px;
    background: #20203a; color: #606090; border: 1px solid #2a2a50; cursor: pointer;
  }
  .pbtn:hover { background: #28286a; color: #a0b8ff; }
  .pbtn.on { background: #30508a; color: #90c4ff; border-color: #3a6090; }

  .srow { display: flex; align-items: center; gap: 5px; padding: 1px 0; }
  .lbl { font-size: 10px; color: #7080a8; min-width: 62px; flex-shrink: 0; }
  .srow input[type=range] { flex: 1; min-width: 50px; accent-color: #4a7acf; cursor: pointer; }
  .val { font-size: 10px; color: #505578; min-width: 34px; text-align: right; font-family: monospace; }
  .rb {
    background: transparent; border: none; color: #30305a; font-size: 11px;
    cursor: pointer; padding: 0 2px; border-radius: 3px; line-height: 1;
  }
  .rb:hover { color: #7090c0; background: #1e1e38; }

  .save-row { display: flex; gap: 12px; flex-wrap: wrap; padding: 2px 0; }
  .radio { display: flex; align-items: center; gap: 4px; font-size: 11px; color: #a0b0c8; cursor: pointer; }
  .tinput { flex: 1; background: #14141e; border: 1px solid #2a2a4a; color: #c0c8e0; padding: 3px 6px; border-radius: 3px; font-size: 11px; }

  .err { color: #ff7070; font-size: 11px; background: #2a1010; padding: 5px 8px; border-radius: 4px; }

  .acts { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
  .acts button { font-size: 11px; padding: 4px 12px; border-radius: 4px; cursor: pointer; border: none; }
  button.primary { background: #3060b0; color: #dde8ff; }
  button.primary:hover { background: #4070c0; }
  button.primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .sec { background: #1e1e38; color: #7080a8; border: 1px solid #2a2a50 !important; }
  .sec:hover { background: #252550; color: #a0b0d0; }
  .sec:disabled { opacity: 0.5; cursor: not-allowed; }

  /* Done panel */
  .done { display: flex; flex-direction: column; gap: 8px; padding: 6px 0; }
  .done-ok { font-size: 14px; color: #70c870; }
  .done-path { font-family: monospace; font-size: 11px; color: #6080b8; overflow-wrap: break-word; }
  .done-dim { font-size: 10px; color: #404860; }
  .done-btns { display: flex; gap: 8px; }
  .dl { background: #183018; color: #60c060; border: 1px solid #284028; padding: 4px 10px; border-radius: 4px; font-size: 11px; cursor: pointer; }
  .dl:hover { background: #224022; }
</style>
