<script>
  /**
   * AIEditModal — BFL AI image editing + generation.
   * Props: imageId (number), imageFilename (string), imageW (number), imageH (number)
   * Events: close, edited (detail: { new_image_id, filepath })
   */
  import { createEventDispatcher, onMount, onDestroy, tick } from 'svelte';
  import { t } from '../stores.js';
  import { thumbnailUrl, downloadImage,
           outpaintImage, inpaintImage, aiEditImage, generateImage,
           bflPreviewUrl, registerBflFile, downloadBflFile } from '../api.js';

  export let imageId       = null;
  export let imageFilename = '';
  export let imageW        = 0;   // original image width (optional, improves inpaint accuracy)
  export let imageH        = 0;   // original image height (optional)
  export let initialTab    = null; // pre-select a tab on open (e.g. 'outpaint' from CropModal)
  export let initialBorders = null; // { top, bottom, left, right } pre-fill outpaint borders

  const dispatch = createEventDispatcher();

  let tab = 'outpaint'; // 'outpaint' | 'inpaint' | 'ai-edit' | 'generate'

  // ── Outpaint state ────────────────────────────────────────────────────────
  let addTop    = 256;
  let addBottom = 256;
  let addLeft   = 256;
  let addRight  = 256;
  let outpaintPrompt = '';

  // Outpaint interactive
  let opImgEl = null;
  let opNatW = 1, opNatH = 1, opDispW = 200, opDispH = 200;
  let opZoom = 1.0;
  let opDrag = null; // { side, startX, startY, startVal }

  function onOpImgLoad(e) {
    opNatW  = e.target.naturalWidth  || 1;
    opNatH  = e.target.naturalHeight || 1;
    opDispW = e.target.offsetWidth   || 200;
    opDispH = e.target.offsetHeight  || 200;
  }

  // Scale: how many display pixels per natural pixel
  $: opScale = opDispW / opNatW;

  // Use original image dimensions if provided; fall back to thumbnail's natural dims
  $: opRefW = (imageW > 0) ? imageW : opNatW;
  $: opRefH = (imageH > 0) ? imageH : opNatH;

  // Scale for visualizing borders in the preview (capped so total area fits in preview container)
  $: opVisScale = Math.min(
    opDispW / Math.max(opRefW + addLeft + addRight, 1),
    opDispH / Math.max(opRefH + addTop  + addBottom, 1)
  ) * opZoom;

  $: opImgVisW  = Math.round(opRefW * opVisScale);
  $: opImgVisH  = Math.round(opRefH * opVisScale);
  $: opAddTopPx    = Math.round(addTop    * opVisScale);
  $: opAddBottomPx = Math.round(addBottom * opVisScale);
  $: opAddLeftPx   = Math.round(addLeft   * opVisScale);
  $: opAddRightPx  = Math.round(addRight  * opVisScale);

  function onOpHandleDown(e, side) {
    e.preventDefault();
    const isV = side === 'top' || side === 'bottom';
    const startPos = isV ? e.clientY : e.clientX;
    const startVal = side === 'top' ? addTop : side === 'bottom' ? addBottom
                   : side === 'left' ? addLeft : addRight;
    opDrag = { side, startPos, startVal };
    window.addEventListener('mousemove', onOpDragMove);
    window.addEventListener('mouseup',   onOpDragUp);
  }

  function onOpDragMove(e) {
    if (!opDrag) return;
    const { side, startPos, startVal } = opDrag;
    const isV = side === 'top' || side === 'bottom';
    const delta = (isV ? e.clientY : e.clientX) - startPos;
    // Dragging outward = increasing border
    const naturalDelta = delta / (opVisScale || 0.01);
    let raw;
    if (side === 'top')    raw = startVal - naturalDelta; // drag up
    else if (side === 'bottom') raw = startVal + naturalDelta; // drag down
    else if (side === 'left')   raw = startVal - naturalDelta; // drag left
    else                        raw = startVal + naturalDelta; // drag right
    const snapped = Math.max(0, Math.round(raw / 16) * 16);
    if (side === 'top')    addTop    = snapped;
    else if (side === 'bottom') addBottom = snapped;
    else if (side === 'left')   addLeft   = snapped;
    else                        addRight  = snapped;
  }

  function onOpDragUp() {
    opDrag = null;
    window.removeEventListener('mousemove', onOpDragMove);
    window.removeEventListener('mouseup',   onOpDragUp);
  }

  // ── Inpaint state ─────────────────────────────────────────────────────────
  let maskX = 0, maskY = 0, maskW = 0, maskH = 0;
  let inpaintPrompt = '';

  // Inpaint canvas
  let ipCanvasEl = null, ipImgEl = null;
  let ipNatW = 1, ipNatH = 1, ipDispW = 200, ipDispH = 200;
  let ipScale = 1;   // ipNatW / ipDispW
  // coordScale: multiply canvas coords by this to get original image coords
  $: ipCoordScale = (imageW > 0 && ipNatW > 0) ? imageW / ipNatW : 1;

  function onIpImgLoad(e) {
    ipNatW  = e.target.naturalWidth  || 1;
    ipNatH  = e.target.naturalHeight || 1;
    ipDispW = e.target.offsetWidth   || 200;
    ipDispH = e.target.offsetHeight  || 200;
    ipScale = ipNatW / ipDispW;
    if (ipCanvasEl) {
      ipCanvasEl.width  = ipDispW;
      ipCanvasEl.height = ipDispH;
    }
    // Initialize mask to center 50% if not set
    if (maskW === 0) {
      const fullW = imageW > 0 ? imageW : ipNatW;
      const fullH = imageH > 0 ? imageH : ipNatH;
      maskX = Math.round(fullW * 0.25);
      maskY = Math.round(fullH * 0.25);
      maskW = Math.round(fullW * 0.5);
      maskH = Math.round(fullH * 0.5);
    }
    tick().then(drawIpCanvas);
  }

  // Convert original image coordinates to canvas display pixels
  function ipOrigToDisp(v, axis) {
    const origDim = axis === 'x' ? (imageW > 0 ? imageW : ipNatW) : (imageH > 0 ? imageH : ipNatH);
    const dispDim = axis === 'x' ? ipDispW : ipDispH;
    return v * (dispDim / origDim);
  }

  function ipDispToOrig(v, axis) {
    const origDim = axis === 'x' ? (imageW > 0 ? imageW : ipNatW) : (imageH > 0 ? imageH : ipNatH);
    const dispDim = axis === 'x' ? ipDispW : ipDispH;
    return v * (origDim / dispDim);
  }

  function ipCanvasPos(e) {
    if (!ipCanvasEl) return { x: 0, y: 0 };
    const r = ipCanvasEl.getBoundingClientRect();
    const sx = ipCanvasEl.width  / r.width;
    const sy = ipCanvasEl.height / r.height;
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
  }

  // Hit-testing in canvas (display) pixel space
  const IP_HIT = 12;

  function ipHitHandle(px, py) {
    const dx = ipOrigToDisp(maskX, 'x'), dy = ipOrigToDisp(maskY, 'y');
    const dw = ipOrigToDisp(maskW, 'x'), dh = ipOrigToDisp(maskH, 'y');
    const inL = px >= dx - IP_HIT && px <= dx + IP_HIT;
    const inR = px >= dx+dw - IP_HIT && px <= dx+dw + IP_HIT;
    const inT = py >= dy - IP_HIT && py <= dy + IP_HIT;
    const inB = py >= dy+dh - IP_HIT && py <= dy+dh + IP_HIT;
    if (inL && inT) return 'tl';
    if (inR && inT) return 'tr';
    if (inL && inB) return 'bl';
    if (inR && inB) return 'br';
    return null;
  }

  function ipHitInside(px, py) {
    const dx = ipOrigToDisp(maskX, 'x'), dy = ipOrigToDisp(maskY, 'y');
    const dw = ipOrigToDisp(maskW, 'x'), dh = ipOrigToDisp(maskH, 'y');
    return px > dx + IP_HIT && px < dx+dw - IP_HIT
        && py > dy + IP_HIT && py < dy+dh - IP_HIT;
  }

  function drawIpCanvas() {
    if (!ipCanvasEl || !ipDispW) return;
    const ctx = ipCanvasEl.getContext('2d');
    ctx.clearRect(0, 0, ipCanvasEl.width, ipCanvasEl.height);
    if (maskW <= 0 || maskH <= 0) return;

    const dx = ipOrigToDisp(maskX, 'x'), dy = ipOrigToDisp(maskY, 'y');
    const dw = ipOrigToDisp(maskW, 'x'), dh = ipOrigToDisp(maskH, 'y');

    // Fill mask area (the region to be inpainted)
    ctx.fillStyle = 'rgba(255,120,40,0.35)';
    ctx.fillRect(dx, dy, dw, dh);

    // Dashed border
    ctx.strokeStyle = '#ff9a50';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(dx, dy, dw, dh);
    ctx.setLineDash([]);

    // Corner handles
    const hs = 8;
    ctx.fillStyle = '#ff9a50';
    [[dx, dy], [dx+dw-hs, dy], [dx, dy+dh-hs], [dx+dw-hs, dy+dh-hs]]
      .forEach(([hx, hy]) => ctx.fillRect(hx, hy, hs, hs));

    // Dim label
    const lbl = `${maskW} × ${maskH}`;
    ctx.font = '10px monospace';
    const tw = ctx.measureText(lbl).width + 6;
    const ly = dy >= 16 ? dy - 16 : dy + dh + 2;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(dx, ly, tw, 14);
    ctx.fillStyle = '#ffa060';
    ctx.fillText(lbl, dx + 3, ly + 10);
  }

  $: { maskX; maskY; maskW; maskH; drawIpCanvas(); }

  let ipDragging = false;
  let ipDragMode = null;
  let ipDragStart = { x: 0, y: 0, sx: 0, sy: 0, sw: 0, sh: 0 };

  function onIpMouseDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const { x, y } = ipCanvasPos(e);
    const handle = ipHitHandle(x, y);
    ipDragMode = handle ?? (ipHitInside(x, y) ? 'move' : 'create');
    ipDragging = true;
    ipDragStart = { x, y, sx: maskX, sy: maskY, sw: maskW, sh: maskH };
  }

  function onIpWindowMouseMove(e) {
    if (!ipDragging || !ipCanvasEl) return;
    const { x, y } = ipCanvasPos(e);
    const fullW = imageW > 0 ? imageW : ipNatW;
    const fullH = imageH > 0 ? imageH : ipNatH;
    const ddx = ipDispToOrig(x - ipDragStart.x, 'x');
    const ddy = ipDispToOrig(y - ipDragStart.y, 'y');

    function cl(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

    if (ipDragMode === 'create') {
      let ox0 = ipDispToOrig(ipDragStart.x, 'x'), oy0 = ipDispToOrig(ipDragStart.y, 'y');
      let ox1 = ipDispToOrig(x, 'x'), oy1 = ipDispToOrig(y, 'y');
      if (ox1 < ox0) [ox0, ox1] = [ox1, ox0];
      if (oy1 < oy0) [oy0, oy1] = [oy1, oy0];
      maskX = Math.round(cl(ox0, 0, fullW)); maskY = Math.round(cl(oy0, 0, fullH));
      maskW = Math.round(Math.max(1, cl(ox1, 0, fullW) - maskX));
      maskH = Math.round(Math.max(1, cl(oy1, 0, fullH) - maskY));

    } else if (ipDragMode === 'move') {
      maskX = Math.round(cl(ipDragStart.sx + ddx, 0, fullW - maskW));
      maskY = Math.round(cl(ipDragStart.sy + ddy, 0, fullH - maskH));

    } else {
      let { sx, sy, sw, sh } = ipDragStart;
      let ox0 = sx, oy0 = sy, ox1 = sx+sw, oy1 = sy+sh;
      if (ipDragMode === 'tl') { ox0 += ddx; oy0 += ddy; }
      if (ipDragMode === 'tr') { ox1 += ddx; oy0 += ddy; }
      if (ipDragMode === 'bl') { ox0 += ddx; oy1 += ddy; }
      if (ipDragMode === 'br') { ox1 += ddx; oy1 += ddy; }
      if (ox1 < ox0) [ox0, ox1] = [ox1, ox0];
      if (oy1 < oy0) [oy0, oy1] = [oy1, oy0];
      ox0 = cl(ox0, 0, fullW); ox1 = cl(ox1, 0, fullW);
      oy0 = cl(oy0, 0, fullH); oy1 = cl(oy1, 0, fullH);
      maskX = Math.round(ox0); maskY = Math.round(oy0);
      maskW = Math.round(Math.max(1, ox1 - ox0));
      maskH = Math.round(Math.max(1, oy1 - oy0));
    }
    drawIpCanvas();
  }

  function onIpWindowMouseUp() { ipDragging = false; }

  // ── AI Edit state ─────────────────────────────────────────────────────────
  let editPrompt  = '';
  let editModel   = 'flux-kontext-pro';
  let editAspect  = '';
  let editSeed    = '';
  const EDIT_MODELS = [
    'flux-kontext-pro',
    'flux-2-pro', 'flux-2-max', 'flux-2-flex', 'flux-2-klein-4b',
  ];
  const ASPECT_RATIOS = ['', '1:1', '16:9', '4:3', '3:4', '9:16', '2:3', '3:2', '21:9'];

  // ── Generate state ────────────────────────────────────────────────────────
  let genPrompt        = '';
  let genModel         = 'flux-kontext-pro';
  let genAspect        = '1:1';
  let genW             = 1024;
  let genH             = 1024;
  let genSteps         = 50;
  let genGuidance      = 4.5;
  let genSeed          = '';
  let genFolder        = '';
  let genPrefix        = 'generated';
  let genIncludeImage  = false;   // send imageId as input_image reference

  const GEN_MODELS = [
    { group: 'FLUX.1', value: 'flux-kontext-pro', label: 'Flux Kontext Pro' },
    { group: 'FLUX.1', value: 'flux-pro-1.1',     label: 'Flux Pro 1.1' },
    { group: 'FLUX.1', value: 'flux-pro',         label: 'Flux Pro' },
    { group: 'FLUX.1', value: 'flux-dev',         label: 'Flux Dev (experimental)' },
    { group: 'FLUX.2', value: 'flux-2-klein-4b',  label: 'Flux 2 Klein 4B (sub-second)' },
    { group: 'FLUX.2', value: 'flux-2-klein-9b',  label: 'Flux 2 Klein 9B (fast)' },
    { group: 'FLUX.2', value: 'flux-2-pro',       label: 'Flux 2 Pro' },
    { group: 'FLUX.2', value: 'flux-2-max',       label: 'Flux 2 Max (best quality)' },
    { group: 'FLUX.2', value: 'flux-2-flex',      label: 'Flux 2 Flex (adjustable)' },
  ];
  $: genIsFlux2 = genModel.startsWith('flux-2-');
  $: genIsFlex  = genModel === 'flux-2-flex';

  // ── Shared state ──────────────────────────────────────────────────────────
  let saveAs = 'new_file';
  $: suffix = tab === 'outpaint' ? '_outpainted'
            : tab === 'inpaint'  ? '_inpainted'
            : '_edited';
  let suffixOverride = '';
  $: effectiveSuffix = suffixOverride || suffix;

  let applying    = false;
  let error       = '';
  let done        = false;
  let result      = null;
  let registering = false;    // true while calling /api/bfl/register
  let previewBlob = null;     // object URL for preview when not yet in DB

  // When done panel appears and image is not yet registered, load a preview blob
  $: if (done && result?.filepath && !result?.new_image_id && !previewBlob) {
    loadPreviewBlob(result.filepath);
  }

  async function loadPreviewBlob(filepath) {
    console.log('[AIEditModal] loadPreviewBlob | filepath=%s', filepath);
    try {
      const resp = await fetch(bflPreviewUrl(filepath), { credentials: 'include' });
      if (!resp.ok) throw new Error(`preview ${resp.status}`);
      const blob = await resp.blob();
      previewBlob = URL.createObjectURL(blob);
      console.log('[AIEditModal] previewBlob ready | url=%s', previewBlob);
    } catch(e) {
      console.error('[AIEditModal] loadPreviewBlob error:', e);
    }
  }

  async function doViewRaw() {
    console.log('[AIEditModal] doViewRaw | filepath=%s | new_image_id=%s', result?.filepath, result?.new_image_id);
    if (result?.new_image_id) {
      // Already in DB — open full-size via existing endpoint
      const url = `${bflPreviewUrl(result.filepath)}`;
      const resp = await fetch(url, { credentials: 'include' });
      const blob = await resp.blob();
      window.open(URL.createObjectURL(blob), '_blank');
    } else if (previewBlob) {
      window.open(previewBlob, '_blank');
    }
  }

  async function doDownload() {
    console.log('[AIEditModal] doDownload | filepath=%s | new_image_id=%s', result?.filepath, result?.new_image_id);
    if (result?.new_image_id) {
      downloadImage(result.new_image_id, result.filepath?.split('/').pop());
    } else {
      try {
        await downloadBflFile(result.filepath, result.filepath?.split('/').pop());
      } catch(e) {
        error = 'Download failed: ' + e.message;
      }
    }
  }

  async function doAddToDB(action) {
    if (!result?.filepath) return;
    console.log('[AIEditModal] doAddToDB | action=%s | filepath=%s | already_registered=%s',
                action, result.filepath, result.new_image_id);
    if (result.new_image_id) {
      // Already registered — just dispatch the action
      console.log('[AIEditModal] already registered new_image_id=%s, dispatch action=%s', result.new_image_id, action);
      dispatch('edited', { ...result, action });
      return;
    }
    registering = true;
    try {
      const reg = await registerBflFile(result.filepath);
      result = { ...result, new_image_id: reg.new_image_id };
      console.log('[AIEditModal] registered | new_image_id=%s | action=%s', reg.new_image_id, action);
      dispatch('edited', { ...result, action });
    } catch(e) {
      console.error('[AIEditModal] register error:', e);
      error = 'Registration failed: ' + e.message;
    } finally {
      registering = false;
    }
  }

  function doGenerateAnother() {
    console.log('[AIEditModal] doGenerateAnother | resetting done state');
    if (previewBlob) { URL.revokeObjectURL(previewBlob); previewBlob = null; }
    done   = false;
    result = null;
    error  = '';
  }

  function onKey(e) { if (e.key === 'Escape') handleClose(); }

  onMount(() => {
    // Apply initial tab + border values when opened from CropModal outpaint
    if (initialTab) tab = initialTab;
    if (initialBorders) {
      addTop    = initialBorders.top    ?? addTop;
      addBottom = initialBorders.bottom ?? addBottom;
      addLeft   = initialBorders.left   ?? addLeft;
      addRight  = initialBorders.right  ?? addRight;
    }
    window.addEventListener('keydown',   onKey);
    window.addEventListener('mousemove', onIpWindowMouseMove);
    window.addEventListener('mouseup',   onIpWindowMouseUp);
  });
  onDestroy(() => {
    window.removeEventListener('keydown',   onKey);
    window.removeEventListener('mousemove', onIpWindowMouseMove);
    window.removeEventListener('mouseup',   onIpWindowMouseUp);
    window.removeEventListener('mousemove', onOpDragMove);
    window.removeEventListener('mouseup',   onOpDragUp);
  });

  $: tab, (suffixOverride = '');

  function handleClose() {
    if (previewBlob) { URL.revokeObjectURL(previewBlob); previewBlob = null; }
    if (done) dispatch('edited', { ...(result || {}), action: 'silent' });
    else      dispatch('close');
  }

  async function doApply() {
    applying = true;
    error    = '';
    done     = false;
    result   = null;

    try {
      let r;
      if (tab === 'outpaint') {
        r = await outpaintImage({
          image_id:   imageId,
          add_top:    addTop,
          add_bottom: addBottom,
          add_left:   addLeft,
          add_right:  addRight,
          prompt:     outpaintPrompt,
          save_as:    saveAs,
          suffix:     effectiveSuffix,
        });
      } else if (tab === 'inpaint') {
        r = await inpaintImage({
          image_id: imageId,
          prompt:   inpaintPrompt,
          mask_x:   maskX,
          mask_y:   maskY,
          mask_w:   maskW,
          mask_h:   maskH,
          save_as:  saveAs,
          suffix:   effectiveSuffix,
        });
      } else if (tab === 'ai-edit') {
        r = await aiEditImage({
          image_id:     imageId,
          prompt:       editPrompt,
          model:        editModel,
          aspect_ratio: editAspect || undefined,
          seed:         editSeed ? parseInt(editSeed, 10) : null,
          save_as:      saveAs,
          suffix:       effectiveSuffix,
        });
      } else {
        r = await generateImage({
          prompt:          genPrompt,
          model:           genModel,
          // FLUX.1: aspect_ratio; FLUX.2: width/height
          ...(genIsFlux2
            ? { width: genW, height: genH }
            : { aspect_ratio: genAspect || '1:1' }),
          // FLUX.2 flex: steps + guidance
          ...(genIsFlex ? { steps: genSteps, guidance: genGuidance } : {}),
          seed:            genSeed ? parseInt(genSeed, 10) : null,
          output_folder:   genFolder,
          filename_prefix: genPrefix,
          // Optional reference image from current lightbox/gallery image
          image_id:        genIncludeImage ? imageId : undefined,
        });
      }
      result = r;
      done   = true;
    } catch (e) {
      error = e.message || String(e);
    } finally {
      applying = false;
    }
  }

  $: canApply = !applying && (() => {
    if (tab === 'outpaint') return (addTop + addBottom + addLeft + addRight) > 0;
    if (tab === 'inpaint')  return inpaintPrompt.trim().length > 0 && maskW > 0 && maskH > 0;
    if (tab === 'ai-edit')  return editPrompt.trim().length > 0;
    return genPrompt.trim().length > 0;
  })();
</script>

<!-- svelte-ignore a11y-click-events-have-key-events -->
<div class="modal-overlay" on:click|self={handleClose}>
  <div class="modal">
    <div class="modal-header">
      <span class="title">🤖 {$t('bfl_ai_edit')} — {imageFilename}</span>
      <button on:click={handleClose}>✕</button>
    </div>

    {#if done && result}
      <!-- ── Done panel ─────────────────────────────────────────────── -->
      <div class="modal-body">
        <div class="done-panel">
          <div class="done-title">✓ {$t('bfl_done')}</div>

          <!-- Preview image -->
          {#if result.new_image_id}
            <img src={thumbnailUrl(result.new_image_id, 400)} alt="Result" class="result-thumb" />
          {:else if previewBlob}
            <img src={previewBlob} alt="Result" class="result-thumb" />
          {:else}
            <div class="preview-loading">Loading preview…</div>
          {/if}

          <div class="result-path" title={result.filepath}>{result.filepath}</div>
          {#if result.width}
            <div class="result-dim">{result.width} × {result.height} px</div>
          {/if}

          <!-- Without-DB actions -->
          <div class="action-group">
            <div class="action-group-label">{$t('done_without_db')}</div>
            <div class="action-row">
              <button on:click={doViewRaw}
                disabled={!result.filepath || (!previewBlob && !result.new_image_id)}>
                👁 {$t('done_view_raw')}
              </button>
              <button on:click={doDownload}
                disabled={!result.filepath}>
                ⬇ {$t('done_download_raw')}
              </button>
            </div>
          </div>

          <!-- Add to DB actions -->
          <div class="action-group">
            <div class="action-group-label">{$t('done_save_to_db')}</div>
            <div class="action-row">
              <button class="primary"
                on:click={() => doAddToDB('gallery')}
                disabled={registering}
                title={$t('done_save_gallery_title')}>
                {registering ? '…' : '🖼'} {$t('gen_view_in_gallery')}
              </button>
              <button class="primary"
                on:click={() => doAddToDB('lightbox')}
                disabled={registering}
                title={$t('done_save_lightbox_title')}>
                {registering ? '…' : '🔍'} {$t('view')}
              </button>
              <button
                on:click={() => doAddToDB('silent')}
                disabled={registering}
                title={$t('done_save_silent_title')}>
                {registering ? '…' : '➕'} {$t('done_save_only')}
              </button>
            </div>
          </div>

          <!-- Generate another / close -->
          <div class="action-row">
            <button on:click={doGenerateAnother}>🔄 {$t('done_generate_another')}</button>
            <button on:click={handleClose}>{$t('close')}</button>
          </div>
        </div>
      </div>
    {:else}
      <!-- ── Tab bar ─────────────────────────────────────────────────── -->
      <div class="tab-bar">
        <button class="tab-btn" class:active={tab === 'outpaint'} on:click={() => tab = 'outpaint'}>{$t('bfl_outpaint')}</button>
        <button class="tab-btn" class:active={tab === 'inpaint'}  on:click={() => tab = 'inpaint' }>{$t('bfl_inpaint')}</button>
        <button class="tab-btn" class:active={tab === 'ai-edit'}  on:click={() => tab = 'ai-edit' }>{$t('bfl_ai_edit')}</button>
        <button class="tab-btn" class:active={tab === 'generate'} on:click={() => tab = 'generate'}>{$t('bfl_generate')}</button>
      </div>

      <div class="modal-body two-col">
        <!-- ── Left: interactive area ──────────────────────────────── -->
        <div class="thumb-wrap">

          {#if tab === 'outpaint' && imageId}
            <!-- Outpaint visual preview with draggable handles -->
            <div class="op-preview">
              <div class="op-scene">
                <!-- Top border -->
                {#if opAddTopPx > 0}
                  <div class="op-border op-top"
                    style="height:{opAddTopPx}px; width:{opImgVisW + opAddLeftPx + opAddRightPx}px;"
                    on:mousedown={e => onOpHandleDown(e, 'top')}
                  >
                    <span class="op-label">{addTop}px</span>
                  </div>
                {/if}
                <!-- Middle row: left border + image + right border -->
                <div class="op-middle-row">
                  {#if opAddLeftPx > 0}
                    <div class="op-border op-left"
                      style="width:{opAddLeftPx}px; height:{opImgVisH}px;"
                      on:mousedown={e => onOpHandleDown(e, 'left')}
                    >
                      <span class="op-label op-label-v">{addLeft}px</span>
                    </div>
                  {/if}
                  <div style="position:relative; width:{opImgVisW}px; height:{opImgVisH}px; flex-shrink:0;">
                    <img
                      src={thumbnailUrl(imageId, 300)}
                      alt=""
                      bind:this={opImgEl}
                      on:load={onOpImgLoad}
                      style="width:{opImgVisW}px; height:{opImgVisH}px; object-fit:contain; display:block;"
                      draggable="false"
                      class="op-img"
                    />
                    <!-- Edge drag handles overlaid on image corners -->
                    <div class="op-edge-handle op-eh-top"    on:mousedown={e => onOpHandleDown(e, 'top')}></div>
                    <div class="op-edge-handle op-eh-bottom" on:mousedown={e => onOpHandleDown(e, 'bottom')}></div>
                    <div class="op-edge-handle op-eh-left"   on:mousedown={e => onOpHandleDown(e, 'left')}></div>
                    <div class="op-edge-handle op-eh-right"  on:mousedown={e => onOpHandleDown(e, 'right')}></div>
                  </div>
                  {#if opAddRightPx > 0}
                    <div class="op-border op-right"
                      style="width:{opAddRightPx}px; height:{opImgVisH}px;"
                      on:mousedown={e => onOpHandleDown(e, 'right')}
                    >
                      <span class="op-label op-label-v">{addRight}px</span>
                    </div>
                  {/if}
                </div>
                <!-- Bottom border -->
                {#if opAddBottomPx > 0}
                  <div class="op-border op-bottom"
                    style="height:{opAddBottomPx}px; width:{opImgVisW + opAddLeftPx + opAddRightPx}px;"
                    on:mousedown={e => onOpHandleDown(e, 'bottom')}
                  >
                    <span class="op-label">{addBottom}px</span>
                  </div>
                {/if}
              </div>
            </div>
            <!-- Zoom slider -->
            <div class="zoom-row">
              <span class="zoom-lbl">{$t('bfl_zoom')}</span>
              <input type="range" min="0.2" max="3" step="0.05" bind:value={opZoom} class="zoom-slider" />
              <span class="zoom-val">{opZoom.toFixed(1)}×</span>
            </div>
            <div class="drag-hint">{$t('bfl_drag_hint')}</div>

          {:else if tab === 'inpaint' && imageId}
            <!-- Inpaint canvas mask -->
            <div class="ip-canvas-wrap">
              <img
                src={thumbnailUrl(imageId, 300)}
                alt={imageFilename}
                bind:this={ipImgEl}
                on:load={onIpImgLoad}
                class="ip-img"
                draggable="false"
              />
              <!-- svelte-ignore a11y-click-events-have-key-events -->
              <canvas
                bind:this={ipCanvasEl}
                class="ip-canvas"
                on:mousedown={onIpMouseDown}
              ></canvas>
            </div>
            <div class="drag-hint">{$t('bfl_mask_hint')}</div>

          {:else if imageId}
            <img src={thumbnailUrl(imageId, 200)} alt={imageFilename} class="thumb" />
            {#if tab === 'generate'}
              <div class="ref-hint">
                {genIncludeImage ? $t('bfl_gen_hint_include') : $t('bfl_gen_hint')}
              </div>
            {/if}
          {/if}
        </div>

        <!-- ── Right: tab controls ────────────────────────────────── -->
        <div class="controls">

          {#if tab === 'outpaint'}
            <!-- ── Outpaint ── -->
            <div class="row">
              <span class="lbl">{$t('bfl_add_top')}</span>
              <input type="number" bind:value={addTop}    min="0" max="2048" step="16" class="num-in" />
              <span class="lbl ml">{$t('bfl_add_bottom')}</span>
              <input type="number" bind:value={addBottom} min="0" max="2048" step="16" class="num-in" />
            </div>
            <div class="row">
              <span class="lbl">{$t('bfl_add_left')}</span>
              <input type="number" bind:value={addLeft}   min="0" max="2048" step="16" class="num-in" />
              <span class="lbl ml">{$t('bfl_add_right')}</span>
              <input type="number" bind:value={addRight}  min="0" max="2048" step="16" class="num-in" />
            </div>
            <div class="row col">
              <span class="lbl">{$t('bfl_prompt_optional')}</span>
              <textarea bind:value={outpaintPrompt} rows="2" placeholder="Leave blank for auto-prompt…"></textarea>
            </div>

          {:else if tab === 'inpaint'}
            <!-- ── Inpaint ── -->
            <div class="row">
              <span class="lbl">{$t('bfl_mask_x')}</span>
              <input type="number" bind:value={maskX} min="0" max="99999" class="num-in" on:change={drawIpCanvas}/>
              <span class="lbl ml">{$t('bfl_mask_y')}</span>
              <input type="number" bind:value={maskY} min="0" max="99999" class="num-in" on:change={drawIpCanvas}/>
            </div>
            <div class="row">
              <span class="lbl">{$t('bfl_mask_w')}</span>
              <input type="number" bind:value={maskW} min="0" max="99999" class="num-in" on:change={drawIpCanvas}/>
              <span class="lbl ml">{$t('bfl_mask_h')}</span>
              <input type="number" bind:value={maskH} min="0" max="99999" class="num-in" on:change={drawIpCanvas}/>
            </div>
            <div class="row col">
              <span class="lbl">{$t('bfl_inpaint_prompt')} *</span>
              <textarea bind:value={inpaintPrompt} rows="2" placeholder={$t('bfl_inpaint_prompt')}></textarea>
            </div>

          {:else if tab === 'ai-edit'}
            <!-- ── AI Edit (Kontext / FLUX.2) ── -->
            <div class="row col">
              <span class="lbl">{$t('bfl_edit_prompt')} *</span>
              <textarea bind:value={editPrompt} rows="3" placeholder={$t('bfl_edit_prompt')}></textarea>
            </div>
            <div class="row">
              <span class="lbl">{$t('bfl_model')}</span>
              <select bind:value={editModel}>
                {#each EDIT_MODELS as m}
                  <option value={m}>{m}</option>
                {/each}
              </select>
            </div>
            <div class="row">
              <span class="lbl">{$t('bfl_aspect_ratio')}</span>
              <select bind:value={editAspect}>
                {#each ASPECT_RATIOS as ar}
                  <option value={ar}>{ar === '' ? 'auto (match input)' : ar}</option>
                {/each}
              </select>
              <span class="lbl ml">{$t('bfl_seed')}</span>
              <input type="number" bind:value={editSeed} min="0" placeholder="random" class="num-in wide" />
            </div>

          {:else}
            <!-- ── Generate ── -->
            <div class="row col">
              <span class="lbl">{$t('bfl_gen_prompt')} *</span>
              <textarea bind:value={genPrompt} rows="3" placeholder={$t('bfl_gen_prompt')}></textarea>
            </div>
            <div class="row">
              <span class="lbl">{$t('bfl_model')}</span>
              <select bind:value={genModel}>
                <optgroup label="FLUX.1">
                  {#each GEN_MODELS.filter(m => m.group === 'FLUX.1') as m}
                    <option value={m.value}>{m.label}</option>
                  {/each}
                </optgroup>
                <optgroup label="FLUX.2">
                  {#each GEN_MODELS.filter(m => m.group === 'FLUX.2') as m}
                    <option value={m.value}>{m.label}</option>
                  {/each}
                </optgroup>
              </select>
            </div>
            {#if genIsFlux2}
              <!-- FLUX.2: width + height in pixels -->
              <div class="row">
                <span class="lbl">{$t('bfl_width')}</span>
                <input type="number" bind:value={genW} min="64" max="2048" step="16" class="num-in wide" />
                <span class="lbl ml">{$t('bfl_height')}</span>
                <input type="number" bind:value={genH} min="64" max="2048" step="16" class="num-in wide" />
              </div>
              {#if genIsFlex}
                <!-- FLUX.2 Flex: steps + guidance -->
                <div class="row">
                  <span class="lbl">{$t('bfl_steps')}</span>
                  <input type="number" bind:value={genSteps} min="1" max="50" class="num-in wide" />
                  <span class="lbl ml">{$t('bfl_guidance')}</span>
                  <input type="number" bind:value={genGuidance} min="1.5" max="10" step="0.5" class="num-in wide" />
                </div>
              {/if}
            {:else}
              <!-- FLUX.1 Kontext / flux-pro*: aspect ratio -->
              <div class="row">
                <span class="lbl">{$t('bfl_aspect_ratio')}</span>
                <select bind:value={genAspect}>
                  {#each ASPECT_RATIOS.filter(a => a) as ar}
                    <option value={ar}>{ar}</option>
                  {/each}
                </select>
              </div>
            {/if}
            <div class="row">
              <span class="lbl">{$t('bfl_seed')}</span>
              <input type="number" bind:value={genSeed} min="0" placeholder="random" class="num-in wide" />
            </div>
            <!-- Include source image as reference -->
            <div class="row">
              <label class="checkbox-label">
                <input type="checkbox" bind:checked={genIncludeImage} />
                {$t('bfl_include_ref_image')}
              </label>
            </div>
            <div class="row col">
              <span class="lbl">{$t('bfl_output_folder')}</span>
              <input type="text" bind:value={genFolder} placeholder="default: data_dir/generated/" style="width:100%" />
            </div>
            <div class="row">
              <span class="lbl">{$t('bfl_filename_prefix')}</span>
              <input type="text" bind:value={genPrefix} style="width:120px" />
            </div>
          {/if}

          <!-- ── Shared: Save as (not shown on generate tab) ── -->
          {#if tab !== 'generate'}
            <div class="row">
              <span class="lbl">{$t('adj_save_as')}</span>
              <label class="radio"><input type="radio" bind:group={saveAs} value="replace" /> {$t('adj_replace_orig')}</label>
              <label class="radio"><input type="radio" bind:group={saveAs} value="new_file" /> {$t('adj_new_file')}</label>
            </div>
            {#if saveAs === 'new_file'}
              <div class="row">
                <span class="lbl">{$t('adj_suffix')}</span>
                <input type="text" bind:value={suffixOverride} placeholder={suffix} style="width:140px" />
              </div>
            {/if}
          {/if}

          {#if error}
            <div class="error">{error}</div>
          {/if}

          {#if applying}
            <div class="progress-label">{$t('bfl_applying')}</div>
            <div class="progress-wrap"><div class="progress-bar"></div></div>
          {/if}

          <div class="action-row">
            <button class="primary" on:click={doApply} disabled={!canApply || applying}>
              {applying ? $t('bfl_applying') : tab === 'generate' ? $t('bfl_generate') : $t('apply')}
            </button>
            <button on:click={handleClose} disabled={applying}>{$t('cancel')}</button>
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.75);
    z-index: 3000;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .modal {
    background: #1a1a28;
    border-radius: 10px;
    width: min(96vw, 720px);
    max-height: 92vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 20px 60px rgba(0,0,0,0.7);
    overflow: hidden;
  }
  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid #2a2a3a;
    flex-shrink: 0;
  }
  .title { font-size: 13px; font-weight: 600; color: #c0c8e0; }
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

  .tab-bar {
    display: flex;
    gap: 2px;
    padding: 8px 14px 0;
    border-bottom: 1px solid #2a2a3a;
    flex-shrink: 0;
  }
  .tab-btn {
    padding: 5px 12px;
    font-size: 11px;
    border-radius: 4px 4px 0 0;
    background: #2a2a42;
    color: #8090b8;
  }
  .tab-btn.active { background: #364070; color: #a0c4ff; }

  .modal-body {
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    overflow-y: auto;
    max-height: 76vh;
  }
  .modal-body.two-col {
    flex-direction: row;
    gap: 14px;
    align-items: flex-start;
  }

  /* ── Left panel ── */
  .thumb-wrap {
    flex-shrink: 0;
    width: 220px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: center;
  }
  .thumb { width: 200px; height: auto; border-radius: 4px; display: block; }
  .ref-hint { font-size: 9px; color: #505070; line-height: 1.4; text-align: center; }

  /* ── Outpaint preview ── */
  .op-preview {
    width: 100%;
    max-height: 320px;
    overflow: auto;
    background: #0c0c18;
    border-radius: 4px;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 8px;
  }
  .op-scene {
    position: relative;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
  }
  .op-img {
    display: block;
    flex-shrink: 0;
  }
  .op-border {
    background: rgba(74,158,255,0.3);
    border: 1px dashed rgba(74,158,255,0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 4px;
    min-height: 4px;
    flex-shrink: 0;
  }
  .op-top, .op-bottom { cursor: ns-resize; align-self: stretch; }
  .op-left, .op-right { cursor: ew-resize; }
  .op-middle-row {
    display: flex;
    align-items: stretch;
    flex-shrink: 0;
  }
  .op-label {
    font-size: 9px;
    color: #80c8ff;
    pointer-events: none;
    white-space: nowrap;
  }
  .op-label-v { writing-mode: vertical-rl; }

  /* Thin drag handles at the image edges (invisible until hovered) */
  .op-edge-handle {
    position: absolute;
    opacity: 0;
    z-index: 10;
    transition: opacity 0.1s;
  }
  .op-eh-top    { top: 0;    left: 0; right: 0;  height: 8px; cursor: n-resize; }
  .op-eh-bottom { bottom: 0; left: 0; right: 0;  height: 8px; cursor: s-resize; }
  .op-eh-left   { top: 0;    left: 0; bottom: 0; width:  8px; cursor: w-resize; }
  .op-eh-right  { top: 0;   right: 0; bottom: 0; width:  8px; cursor: e-resize; }
  .op-edge-handle:hover { opacity: 0.7; background: rgba(74,158,255,0.45); }

  .zoom-row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
  }
  .zoom-lbl { font-size: 10px; color: #6070a0; }
  .zoom-slider { flex: 1; }
  .zoom-val { font-size: 10px; color: #6070a0; min-width: 28px; text-align: right; }

  .drag-hint {
    font-size: 9px;
    color: #505070;
    text-align: center;
    line-height: 1.4;
  }

  /* ── Inpaint canvas ── */
  .ip-canvas-wrap {
    position: relative;
    display: inline-block;
    line-height: 0;
  }
  .ip-img {
    display: block;
    max-width: 200px;
    max-height: 280px;
    border-radius: 4px;
    user-select: none;
    -webkit-user-drag: none;
  }
  .ip-canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    cursor: crosshair;
    touch-action: none;
  }

  /* ── Right controls ── */
  .controls { flex: 1; display: flex; flex-direction: column; gap: 8px; min-width: 0; }

  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .row.col { flex-direction: column; align-items: flex-start; }
  .lbl { font-size: 11px; color: #8090b8; min-width: 52px; flex-shrink: 0; }
  .lbl.ml { margin-left: 4px; }

  .num-in { width: 60px; }
  .num-in.wide { width: 80px; }

  textarea {
    width: 100%;
    background: #1e1e2e;
    border: 1px solid #3a3a5a;
    color: #e0e0e0;
    padding: 5px 7px;
    border-radius: 4px;
    font-size: 12px;
    resize: vertical;
    min-height: 48px;
    box-sizing: border-box;
  }
  select {
    background: #1e1e2e;
    border: 1px solid #3a3a5a;
    color: #e0e0e0;
    padding: 4px 6px;
    border-radius: 4px;
    font-size: 12px;
  }
  input[type="text"], input[type="number"] {
    background: #1e1e2e;
    border: 1px solid #3a3a5a;
    color: #e0e0e0;
    padding: 4px 6px;
    border-radius: 4px;
    font-size: 12px;
  }
  .radio { display: flex; align-items: center; gap: 4px; font-size: 12px; color: #c0c8e0; }
  .checkbox-label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #c0c8e0; cursor: pointer; }

  .error {
    color: #ff8080;
    font-size: 11px;
    background: #3a1a1a;
    padding: 6px 8px;
    border-radius: 4px;
  }

  .progress-wrap { height: 4px; background: #2a2a42; border-radius: 2px; overflow: hidden; }
  .progress-bar  {
    height: 100%;
    background: linear-gradient(90deg, #4a9eff 0%, #9060ff 100%);
    width: 100%;
    animation: indeterminate 1.4s ease-in-out infinite;
  }
  @keyframes indeterminate {
    0%   { transform: translateX(-100%); }
    100% { transform: translateX(200%); }
  }
  .progress-label { font-size: 11px; color: #7090b0; }

  .action-row { display: flex; gap: 8px; margin-top: 4px; }
  .action-row button { font-size: 12px; padding: 5px 14px; border-radius: 4px; }

  .done-panel { display: flex; flex-direction: column; gap: 10px; align-items: flex-start; width: 100%; }
  .done-title  { font-size: 13px; color: #80e080; font-weight: 600; }
  .result-thumb {
    max-width: 100%;
    max-height: 320px;
    border-radius: 6px;
    border: 1px solid #2a2a3a;
    object-fit: contain;
    align-self: center;
  }
  .preview-loading {
    padding: 24px;
    color: #6070a0;
    font-size: 12px;
    align-self: center;
    animation: pulse 1s ease-in-out infinite alternate;
  }
  @keyframes pulse { from { opacity: 0.4; } to { opacity: 1; } }
  .result-path {
    font-family: monospace;
    font-size: 10px;
    color: #9090b0;
    word-break: break-all;
    width: 100%;
  }
  .result-dim { font-size: 11px; color: #6080a0; }
  .action-group {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px;
    background: #12121e;
    border: 1px solid #2a2a3a;
    border-radius: 6px;
  }
  .action-group-label { font-size: 10px; color: #5060a0; text-transform: uppercase; letter-spacing: 0.05em; }

  button.primary {
    background: #364070;
    color: #a0c4ff;
    border: 1px solid #4a5a90;
    padding: 5px 14px;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
  }
  button.primary:hover:not(:disabled) { background: #4a5a90; }
  button.primary:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
