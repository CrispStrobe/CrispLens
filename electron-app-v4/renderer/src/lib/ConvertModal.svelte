<script>
  /**
   * ConvertModal — format conversion + resize.
   * Props: imageIds (number[])
   * Events: close, converted (detail: { results })
   */
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { t } from '../stores.js';
  import { fetchEditFormats, convertImages, convertBatch, downloadImage, outpaintImage } from '../api.js';

  export let imageIds = [];

  const dispatch = createEventDispatcher();

  let formats = [];
  let selectedFormat = 'jpeg';
  let quality = 85;
  let resizeMode = 'none';
  let maxWidth = 1920;
  let maxHeight = 1080;
  let saveAs = 'new_file';
  let suffix = '_converted';
  let outputFolder = '';

  let saving = false;
  let progress = 0;
  let progressTotal = 0;
  let error = '';
  let done = false;
  let results = [];
  let _sse = null;

  // Outpaint state
  let addTop    = 256;
  let addBottom = 256;
  let addLeft   = 256;
  let addRight  = 256;
  let outpaintPrompt = '';

  $: currentFormat = formats.find(f => f.id === selectedFormat);
  $: isBatch = imageIds.length > 1;

  onMount(async () => {
    window.addEventListener('keydown', onKey);
    try {
      formats = await fetchEditFormats();
      if (formats.length > 0) selectedFormat = formats[0].id;
    } catch (e) {
      error = e.message;
    }
  });
  onDestroy(() => {
    window.removeEventListener('keydown', onKey);
    _sse?.close();
  });

  function onKey(e) {
    if (e.key === 'Escape') handleClose();
  }

  async function doConvert() {
    saving = true;
    error = '';
    done = false;
    results = [];
    progress = 0;
    progressTotal = imageIds.length;

    // Outpaint is a separate BFL endpoint, not a standard convert
    if (resizeMode === 'outpaint') {
      try {
        const r = await outpaintImage({
          image_id:   imageIds[0],
          add_top:    addTop,
          add_bottom: addBottom,
          add_left:   addLeft,
          add_right:  addRight,
          prompt:     outpaintPrompt,
          save_as:    saveAs,
          suffix,
        });
        results = [{ ok: true, filepath: r.filepath, new_image_id: r.new_image_id }];
        done = true;
      } catch (e) {
        error = e.message;
      } finally {
        saving = false;
      }
      return;
    }

    const params = {
      image_ids: imageIds,
      output_format: selectedFormat,
      quality,
      resize_mode: resizeMode,
      max_width: resizeMode !== 'none' ? maxWidth : null,
      max_height: resizeMode !== 'none' ? maxHeight : null,
      save_as: saveAs,
      output_folder: saveAs === 'output_folder' ? outputFolder : null,
      suffix,
    };

    try {
      if (isBatch) {
        await new Promise((resolve) => {
          _sse = convertBatch(params, (data) => {
            if (data.done) {
              done = true;
              resolve();
            } else {
              progress = data.index ?? progress;
              results = [...results, data];
            }
          });
        });
      } else {
        const result = await convertImages(params);
        results = result.results || [];
        done = true;
      }
    } catch (e) {
      error = e.message;
    } finally {
      saving = false;
      _sse = null;
    }
  }

  function handleClose() {
    _sse?.close();
    if (done) dispatch('converted', { results });
    else dispatch('close');
  }
</script>

<!-- svelte-ignore a11y-click-events-have-key-events -->
<div class="modal-overlay" on:click|self={handleClose}>
  <div class="modal">
    <div class="modal-header">
      <span class="title">
        {$t('ctx_convert_export')}{imageIds.length > 1 ? ` (${imageIds.length})` : ''}
      </span>
      <button on:click={handleClose}>✕</button>
    </div>

    <div class="modal-body">
      {#if done}
        <div class="done-panel">
          <div class="done-title">
            {$t('conv_done')} — {results.filter(r => r.ok).length} / {results.length}
          </div>
          <div class="results-list">
            {#each results as r}
              {#if r.ok}
                <div class="result-row ok">
                  <span class="result-icon">✓</span>
                  <span class="result-path" title={r.filepath}>{r.filepath}</span>
                  {#if r.new_image_id}
                    <button class="dl-btn" on:click={() => downloadImage(r.new_image_id, r.filepath?.split('/').pop())}>⬇</button>
                  {/if}
                </div>
              {:else}
                <div class="result-row err">
                  <span class="result-icon">⚠</span>
                  <span class="result-path">ID {r.image_id}: {r.error}</span>
                </div>
              {/if}
            {/each}
          </div>
          <button class="primary" on:click={handleClose}>{$t('close')}</button>
        </div>
      {:else}
        <!-- Format + Quality (hidden when outpaint selected) -->
        {#if resizeMode !== 'outpaint'}
          <div class="row">
            <span class="lbl">{$t('conv_format')}</span>
            <div class="fmt-btns">
              {#each formats as f}
                <button
                  class="fmt-btn"
                  class:active={selectedFormat === f.id}
                  on:click={() => selectedFormat = f.id}
                >{f.label}</button>
              {/each}
            </div>
          </div>
          {#if currentFormat?.quality_option}
            <div class="row">
              <span class="lbl">{$t('conv_quality')}</span>
              <input type="range" min="50" max="100" step="1" bind:value={quality} />
              <span class="val">{quality}%</span>
            </div>
          {/if}
        {/if}

        <!-- Resize mode -->
        <div class="row">
          <span class="lbl">{$t('conv_resize')}</span>
          <select bind:value={resizeMode}>
            <option value="none">{$t('conv_no_resize')}</option>
            <option value="fit">{$t('conv_fit')}</option>
            <option value="exact">{$t('conv_exact')}</option>
            <option value="outpaint" disabled={isBatch}>{$t('conv_resize_outpaint')}{isBatch ? ' (single only)' : ''}</option>
          </select>
        </div>

        {#if resizeMode === 'outpaint'}
          <div class="row">
            <span class="lbl">{$t('bfl_add_top')}</span>
            <input type="number" bind:value={addTop}    min="0" max="2048" step="16" style="width:70px" />
            <span class="lbl" style="margin-left:6px">{$t('bfl_add_bottom')}</span>
            <input type="number" bind:value={addBottom} min="0" max="2048" step="16" style="width:70px" />
          </div>
          <div class="row">
            <span class="lbl">{$t('bfl_add_left')}</span>
            <input type="number" bind:value={addLeft}   min="0" max="2048" step="16" style="width:70px" />
            <span class="lbl" style="margin-left:6px">{$t('bfl_add_right')}</span>
            <input type="number" bind:value={addRight}  min="0" max="2048" step="16" style="width:70px" />
          </div>
          <div class="row">
            <span class="lbl">{$t('bfl_prompt_optional')}</span>
            <input type="text" bind:value={outpaintPrompt} placeholder="auto" style="flex:1" />
          </div>
        {:else if resizeMode !== 'none'}
          <div class="row">
            <span class="lbl">{$t('conv_max_size')}</span>
            <input type="number" bind:value={maxWidth}  min="1" max="10000" style="width:72px" />
            <span class="val">×</span>
            <input type="number" bind:value={maxHeight} min="1" max="10000" style="width:72px" />
            <span class="val">px</span>
          </div>
        {/if}

        <!-- Save as -->
        <div class="row">
          <span class="lbl">{$t('conv_save_as')}</span>
          <label class="radio"><input type="radio" bind:group={saveAs} value="replace"       /> {$t('conv_replace_orig')}</label>
          <label class="radio"><input type="radio" bind:group={saveAs} value="new_file"      /> {$t('conv_new_file')}</label>
          <label class="radio"><input type="radio" bind:group={saveAs} value="output_folder" /> {$t('conv_output_folder')}</label>
        </div>

        {#if saveAs === 'new_file'}
          <div class="row">
            <span class="lbl">{$t('conv_suffix')}</span>
            <input type="text" bind:value={suffix} style="width:140px" />
          </div>
        {/if}

        {#if saveAs === 'output_folder'}
          <div class="row">
            <span class="lbl">{$t('conv_folder')}</span>
            <input type="text" bind:value={outputFolder} placeholder="/path/to/output" style="flex:1" />
          </div>
        {/if}

        {#if error}
          <div class="error">{error}</div>
        {/if}

        <!-- Batch progress bar -->
        {#if saving && isBatch}
          <div class="progress-wrap">
            <div class="progress-bar" style="width:{progressTotal ? Math.round(progress/progressTotal*100) : 0}%"></div>
          </div>
          <div class="progress-label">{progress} / {progressTotal}</div>
        {/if}

        <div class="action-row">
          <button class="primary" on:click={doConvert} disabled={saving}>
            {saving ? $t('conv_converting') : isBatch ? `${$t('conv_convert')} ${imageIds.length}` : $t('conv_convert')}
          </button>
          <button on:click={handleClose}>{$t('cancel')}</button>
        </div>
      {/if}
    </div>
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
    width: min(90vw, 520px);
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
  .title { font-size: 14px; font-weight: 600; color: #c0c8e0; }

  .modal-body {
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .lbl { font-size: 11px; color: #8090b8; min-width: 64px; flex-shrink: 0; }
  .val { font-size: 11px; color: #506080; }
  .radio { display: flex; align-items: center; gap: 4px; font-size: 12px; color: #c0c8e0; }

  .fmt-btns { display: flex; gap: 4px; flex-wrap: wrap; }
  .fmt-btn {
    font-size: 11px; padding: 3px 9px; border-radius: 4px;
    background: #2a2a42; color: #8090b8;
  }
  .fmt-btn.active { background: #364070; color: #a0c4ff; }

  input[type="range"] { flex: 1; min-width: 80px; max-width: 180px; }
  select {
    background: #1e1e2e; border: 1px solid #3a3a5a; color: #e0e0e0;
    padding: 4px 6px; border-radius: 4px; font-size: 12px;
  }

  .error { color: #ff8080; font-size: 11px; background: #3a1a1a; padding: 6px 8px; border-radius: 4px; }

  .progress-wrap { height: 6px; background: #2a2a42; border-radius: 3px; overflow: hidden; }
  .progress-bar  { height: 100%; background: #4a9eff; transition: width 0.2s; }
  .progress-label { font-size: 11px; color: #506080; text-align: center; }

  .action-row { display: flex; gap: 8px; margin-top: 4px; }
  .action-row button { font-size: 12px; padding: 5px 14px; border-radius: 4px; }

  .done-panel { display: flex; flex-direction: column; gap: 10px; }
  .done-title  { font-size: 13px; color: #a0c4ff; }
  .results-list { display: flex; flex-direction: column; gap: 3px; max-height: 200px; overflow-y: auto; }
  .result-row {
    display: flex; align-items: center; gap: 6px;
    font-size: 11px; padding: 4px 8px; border-radius: 4px;
  }
  .result-row.ok  { background: #1a2a1a; color: #80c080; }
  .result-row.err { background: #2a1a1a; color: #ff8080; }
  .result-icon { flex-shrink: 0; font-size: 12px; }
  .result-path {
    flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: monospace; font-size: 10px;
  }
  .dl-btn {
    flex-shrink: 0;
    background: #1e3a1e; color: #60c060;
    border: 1px solid #2a4a2a;
    padding: 2px 6px; border-radius: 4px; font-size: 11px;
  }
  .dl-btn:hover { background: #2a4a2a; }
</style>
