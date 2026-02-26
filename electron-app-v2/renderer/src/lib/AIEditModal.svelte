<script>
  /**
   * AIEditModal — BFL AI image editing + generation.
   * Props: imageId (number), imageFilename (string)
   * Events: close, edited (detail: { new_image_id, filepath })
   */
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { t } from '../stores.js';
  import { thumbnailUrl, downloadImage, outpaintImage, inpaintImage, aiEditImage, generateImage } from '../api.js';

  export let imageId     = null;
  export let imageFilename = '';

  const dispatch = createEventDispatcher();

  let tab = 'outpaint'; // 'outpaint' | 'inpaint' | 'ai-edit' | 'generate'

  // Outpaint state
  let addTop    = 256;
  let addBottom = 256;
  let addLeft   = 256;
  let addRight  = 256;
  let outpaintPrompt = '';

  // Inpaint state
  let maskX = 0;
  let maskY = 0;
  let maskW = 0;
  let maskH = 0;
  let inpaintPrompt = '';

  // AI Edit state (Kontext default)
  let editPrompt  = '';
  let editModel   = 'flux-kontext-pro';
  let editAspect  = '';   // empty = auto (match input image)
  let editSeed    = '';
  const EDIT_MODELS = [
    'flux-kontext-pro',
    'flux-2-pro', 'flux-2-max', 'flux-2-flex', 'flux-2-klein-4b',
  ];
  const ASPECT_RATIOS = ['', '1:1', '16:9', '4:3', '3:4', '9:16', '2:3', '3:2', '21:9'];

  // Generate state
  let genPrompt  = '';
  let genAspect  = '1:1';
  let genSeed    = '';
  let genFolder  = '';
  let genPrefix  = 'generated';

  // Shared state
  let saveAs = 'new_file';
  $: suffix = tab === 'outpaint' ? '_outpainted'
            : tab === 'inpaint'  ? '_inpainted'
            : '_edited';
  let suffixOverride = '';
  $: effectiveSuffix = suffixOverride || suffix;

  let applying = false;
  let error    = '';
  let done     = false;
  let result   = null;  // { new_image_id?, filepath, width, height }

  function onKey(e) { if (e.key === 'Escape') handleClose(); }
  onMount(() => window.addEventListener('keydown', onKey));
  onDestroy(() => window.removeEventListener('keydown', onKey));

  // Reset suffix override when tab changes
  $: tab, (suffixOverride = '');

  function handleClose() {
    if (done) dispatch('edited', result);
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
        // generate
        r = await generateImage({
          prompt:          genPrompt,
          aspect_ratio:    genAspect,
          seed:            genSeed ? parseInt(genSeed, 10) : null,
          output_folder:   genFolder,
          filename_prefix: genPrefix,
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
    return genPrompt.trim().length > 0;   // generate
  })();

  // Mask overlay geometry (relative to thumbnail display)
  let thumbDispW = 200;
  let thumbDispH = 200;
  let thumbNatW  = 1;
  let thumbNatH  = 1;

  function onThumbLoad(e) {
    thumbNatW  = e.target.naturalWidth  || 1;
    thumbNatH  = e.target.naturalHeight || 1;
    thumbDispW = e.target.offsetWidth   || 200;
    thumbDispH = e.target.offsetHeight  || 200;
  }

  $: scaleX        = thumbDispW / thumbNatW;
  $: scaleY        = thumbDispH / thumbNatH;
  $: overlayLeft   = maskX * scaleX;
  $: overlayTop    = maskY * scaleY;
  $: overlayWidth  = maskW * scaleX;
  $: overlayHeight = maskH * scaleY;
</script>

<!-- svelte-ignore a11y-click-events-have-key-events -->
<div class="modal-overlay" on:click|self={handleClose}>
  <div class="modal">
    <div class="modal-header">
      <span class="title">🤖 {$t('bfl_ai_edit')} — {imageFilename}</span>
      <button on:click={handleClose}>✕</button>
    </div>

    {#if done && result}
      <!-- ── Done panel ─────────────────────────────────────────────────── -->
      <div class="modal-body">
        <div class="done-panel">
          <div class="done-title">{$t('bfl_done')}</div>
          <div class="result-path">{result.filepath}</div>
          {#if result.width}
            <div class="result-dim">{result.width} × {result.height} px</div>
          {/if}
          <div class="action-row">
            {#if result.new_image_id}
              <button class="primary"
                on:click={() => downloadImage(result.new_image_id, result.filepath?.split('/').pop())}>
                ⬇ {$t('download')}
              </button>
            {/if}
            <button class="primary" on:click={handleClose}>{$t('close')}</button>
          </div>
        </div>
      </div>
    {:else}
      <!-- ── Tab bar ────────────────────────────────────────────────────── -->
      <div class="tab-bar">
        <button class="tab-btn" class:active={tab === 'outpaint'} on:click={() => tab = 'outpaint'}>{$t('bfl_outpaint')}</button>
        <button class="tab-btn" class:active={tab === 'inpaint'}  on:click={() => tab = 'inpaint' }>{$t('bfl_inpaint')}</button>
        <button class="tab-btn" class:active={tab === 'ai-edit'}  on:click={() => tab = 'ai-edit' }>{$t('bfl_ai_edit')}</button>
        <button class="tab-btn" class:active={tab === 'generate'} on:click={() => tab = 'generate'}>{$t('bfl_generate')}</button>
      </div>

      <div class="modal-body two-col">
        <!-- ── Left: thumbnail ──────────────────────────────────────────── -->
        <div class="thumb-wrap">
          {#if tab === 'inpaint'}
            <div class="thumb-container">
              <img
                src={thumbnailUrl(imageId, 200)}
                alt={imageFilename}
                class="thumb"
                on:load={onThumbLoad}
              />
              {#if maskW > 0 && maskH > 0}
                <div class="mask-overlay"
                  style="left:{overlayLeft}px; top:{overlayTop}px; width:{overlayWidth}px; height:{overlayHeight}px;"
                ></div>
              {/if}
            </div>
          {:else}
            <img src={thumbnailUrl(imageId, 200)} alt={imageFilename} class="thumb" />
            {#if tab === 'generate'}
              <div class="ref-hint">{$t('bfl_gen_hint')}</div>
            {/if}
          {/if}
        </div>

        <!-- ── Right: tab controls ──────────────────────────────────────── -->
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
              <input type="number" bind:value={maskX} min="0" max="99999" class="num-in" />
              <span class="lbl ml">{$t('bfl_mask_y')}</span>
              <input type="number" bind:value={maskY} min="0" max="99999" class="num-in" />
            </div>
            <div class="row">
              <span class="lbl">{$t('bfl_mask_w')}</span>
              <input type="number" bind:value={maskW} min="0" max="99999" class="num-in" />
              <span class="lbl ml">{$t('bfl_mask_h')}</span>
              <input type="number" bind:value={maskH} min="0" max="99999" class="num-in" />
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
              <span class="lbl ml">Seed</span>
              <input type="number" bind:value={editSeed} min="0" placeholder="random" class="num-in wide" />
            </div>

          {:else}
            <!-- ── Generate ── -->
            <div class="row col">
              <span class="lbl">{$t('bfl_gen_prompt')} *</span>
              <textarea bind:value={genPrompt} rows="3" placeholder={$t('bfl_gen_prompt')}></textarea>
            </div>
            <div class="row">
              <span class="lbl">{$t('bfl_aspect_ratio')}</span>
              <select bind:value={genAspect}>
                {#each ASPECT_RATIOS.filter(a => a) as ar}
                  <option value={ar}>{ar}</option>
                {/each}
              </select>
              <span class="lbl ml">Seed</span>
              <input type="number" bind:value={genSeed} min="0" placeholder="random" class="num-in wide" />
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
    width: min(94vw, 640px);
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
    max-height: 70vh;
  }
  .modal-body.two-col {
    flex-direction: row;
    gap: 14px;
    align-items: flex-start;
  }

  .thumb-wrap { flex-shrink: 0; width: 160px; display: flex; flex-direction: column; gap: 6px; }
  .thumb-container { position: relative; display: inline-block; }
  .thumb { width: 160px; height: auto; border-radius: 4px; display: block; }
  .ref-hint { font-size: 9px; color: #505070; line-height: 1.4; text-align: center; }
  .mask-overlay {
    position: absolute;
    background: rgba(255, 120, 40, 0.45);
    border: 1.5px dashed #ff9a50;
    pointer-events: none;
  }

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

  .done-panel { display: flex; flex-direction: column; gap: 8px; }
  .done-title  { font-size: 13px; color: #80e080; font-weight: 600; }
  .result-path {
    font-family: monospace;
    font-size: 10px;
    color: #9090b0;
    word-break: break-all;
  }
  .result-dim { font-size: 11px; color: #6080a0; }

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
