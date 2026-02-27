<script>
  import { t, sidebarView, selectedId, galleryRefreshTick } from '../stores.js';
  import { generateImage, thumbnailUrl, bflPreviewUrl, registerBflFile, downloadBflFile } from '../api.js';

  const ASPECT_RATIOS = ['1:1', '16:9', '4:3', '3:4', '9:16', '2:3', '3:2', '21:9'];
  const GENERATE_MODELS = [
    { value: 'flux-kontext-pro', label: 'Flux Kontext Pro' },
    { value: 'flux-pro-1.1',     label: 'Flux Pro 1.1' },
    { value: 'flux-pro',         label: 'Flux Pro' },
    { value: 'flux-dev',         label: 'Flux Dev (experimental)' },
  ];

  let prompt  = '';
  let model   = 'flux-kontext-pro';
  let aspect  = '1:1';
  let seed    = '';
  let folder  = '';
  let prefix  = 'generated';

  let loading     = false;
  let result      = null;  // { ok, new_image_id, filepath, width, height }
  let errorMsg    = '';
  let registering = false;
  let previewBlob = null;  // object URL for raw preview when not registered

  // When result arrives without new_image_id, load a raw preview blob
  $: if (result && result.filepath && !result.new_image_id && !previewBlob) {
    loadPreviewBlob(result.filepath);
  }

  async function loadPreviewBlob(filepath) {
    try {
      const resp = await fetch(bflPreviewUrl(filepath), { credentials: 'include' });
      if (!resp.ok) return;
      const blob = await resp.blob();
      previewBlob = URL.createObjectURL(blob);
      console.log('[GenerateView] preview blob loaded for', filepath);
    } catch (e) {
      console.warn('[GenerateView] preview blob failed:', e);
    }
  }

  async function doGenerate() {
    if (!prompt.trim()) return;
    loading     = true;
    errorMsg    = '';
    result      = null;
    if (previewBlob) { URL.revokeObjectURL(previewBlob); previewBlob = null; }
    try {
      result = await generateImage({
        prompt,
        model,
        aspect_ratio:    aspect,
        seed:            seed ? parseInt(seed, 10) : null,
        output_folder:   folder,
        filename_prefix: prefix,
      });
      console.log('[GenerateView] generation done | new_image_id=%s | filepath=%s',
                  result?.new_image_id, result?.filepath);
    } catch (e) {
      errorMsg = e.message || String(e);
    } finally {
      loading = false;
    }
  }

  function doViewRaw() {
    if (!result?.filepath) return;
    window.open(bflPreviewUrl(result.filepath), '_blank');
  }

  function doDownload() {
    if (!result?.filepath) return;
    const filename = result.filepath.split('/').pop();
    downloadBflFile(result.filepath, filename);
  }

  async function ensureRegistered() {
    if (result.new_image_id) return result.new_image_id;
    registering = true;
    try {
      const reg = await registerBflFile(result.filepath);
      result = { ...result, new_image_id: reg.new_image_id, width: reg.width, height: reg.height };
      console.log('[GenerateView] registered | new_image_id=%s', reg.new_image_id);
      return reg.new_image_id;
    } finally {
      registering = false;
    }
  }

  async function doViewInGallery() {
    await ensureRegistered();
    galleryRefreshTick.update(n => n + 1);
    sidebarView.set('all');
    console.log('[GenerateView] navigate to gallery after register');
  }

  async function doViewInLightbox() {
    const id = await ensureRegistered();
    if (id) {
      galleryRefreshTick.update(n => n + 1);
      selectedId.set(id);
      console.log('[GenerateView] open lightbox for new_image_id=%s', id);
    }
  }

  async function doSilent() {
    await ensureRegistered();
    galleryRefreshTick.update(n => n + 1);
    console.log('[GenerateView] silent save done');
  }

  function doGenerateAnother() {
    if (previewBlob) { URL.revokeObjectURL(previewBlob); previewBlob = null; }
    result   = null;
    errorMsg = '';
  }
</script>

<div class="gen-view">
  <div class="gen-card">
    <h2 class="gen-title">✨ {$t('gen_image_title')}</h2>

    <div class="form">
      <label class="field-label">{$t('gen_prompt_label')} *</label>
      <textarea
        bind:value={prompt}
        rows="4"
        placeholder={$t('gen_prompt_placeholder')}
        class="prompt-input"
        disabled={loading}
      ></textarea>

      <div class="row">
        <div class="field">
          <label class="field-label">{$t('gen_model_label')}</label>
          <select bind:value={model} disabled={loading}>
            {#each GENERATE_MODELS as m}
              <option value={m.value}>{m.label}</option>
            {/each}
          </select>
        </div>
      </div>

      <div class="row">
        <div class="field">
          <label class="field-label">{$t('bfl_aspect_ratio')}</label>
          <select bind:value={aspect} disabled={loading}>
            {#each ASPECT_RATIOS as ar}
              <option value={ar}>{ar}</option>
            {/each}
          </select>
        </div>
        <div class="field">
          <label class="field-label">{$t('bfl_seed')}</label>
          <input type="number" bind:value={seed} min="0" placeholder="random" disabled={loading} style="width:100px" />
        </div>
      </div>

      <label class="field-label">{$t('gen_output_folder')}</label>
      <input
        type="text"
        bind:value={folder}
        placeholder="default: data_dir/generated/"
        disabled={loading}
        class="wide-input"
      />
      <div class="field-hint">{$t('gen_output_folder_hint')}</div>

      <div class="row">
        <div class="field">
          <label class="field-label">{$t('gen_filename_prefix')}</label>
          <input type="text" bind:value={prefix} disabled={loading} style="width:160px" />
        </div>
      </div>

      {#if errorMsg}
        <div class="error-msg">{errorMsg}</div>
      {/if}

      <div class="action-row">
        <button class="primary" on:click={doGenerate} disabled={loading || !prompt.trim()}>
          {loading ? $t('gen_generating') : '✨ ' + $t('gen_image_title')}
        </button>
      </div>

      {#if loading}
        <div class="progress-wrap"><div class="progress-bar"></div></div>
        <div class="progress-hint">{$t('gen_generating')}</div>
      {/if}
    </div>

    {#if result}
      <div class="result-section">
        <h3 class="result-title">✓ {$t('gen_result_title')}</h3>

        <!-- Thumbnail: registered image or raw blob preview -->
        {#if result.new_image_id}
          <img src={thumbnailUrl(result.new_image_id, 400)} alt="Generated" class="result-thumb" />
        {:else if previewBlob}
          <img src={previewBlob} alt="Generated (not saved)" class="result-thumb" />
        {/if}

        <div class="result-path">{result.filepath}</div>
        {#if result.width}
          <div class="result-dim">{result.width} × {result.height} px</div>
        {/if}

        <!-- Without DB group -->
        <div class="action-group">
          <div class="action-group-label">Ohne DB</div>
          <div class="action-row">
            <button on:click={doViewRaw}>🔍 Anzeigen</button>
            <button on:click={doDownload}>⬇ Download</button>
          </div>
        </div>

        <!-- Save to DB group -->
        <div class="action-group">
          <div class="action-group-label">In DB speichern</div>
          <div class="action-row">
            <button class="primary" on:click={doViewInGallery} disabled={registering}>
              🖼 {$t('gen_view_in_gallery')}
            </button>
            <button class="primary" on:click={doViewInLightbox} disabled={registering}>
              🔍 {$t('view')}
            </button>
            <button on:click={doSilent} disabled={registering}>
              {registering ? '…' : '💾 Nur speichern'}
            </button>
          </div>
        </div>

        <div class="action-row">
          <button on:click={doGenerateAnother}>+ {$t('gen_image_title')}</button>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .gen-view {
    flex: 1;
    overflow-y: auto;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 32px 16px;
    background: #121218;
  }

  .gen-card {
    width: min(100%, 560px);
    background: #1a1a28;
    border-radius: 10px;
    padding: 24px 28px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.4);
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .gen-title {
    font-size: 18px;
    font-weight: 600;
    color: #c0c8e0;
    margin: 0;
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .field-label {
    font-size: 11px;
    color: #6070a0;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
  }

  .field-hint {
    font-size: 10px;
    color: #404060;
    margin-top: -6px;
  }

  .prompt-input {
    width: 100%;
    background: #1e1e2e;
    border: 1px solid #3a3a5a;
    color: #e0e0e0;
    padding: 8px 10px;
    border-radius: 6px;
    font-size: 13px;
    resize: vertical;
    min-height: 80px;
    box-sizing: border-box;
    font-family: inherit;
  }
  .prompt-input:focus { border-color: #6080c0; outline: none; }

  .wide-input {
    width: 100%;
    background: #1e1e2e;
    border: 1px solid #3a3a5a;
    color: #e0e0e0;
    padding: 6px 8px;
    border-radius: 4px;
    font-size: 12px;
    box-sizing: border-box;
  }
  .wide-input:focus { border-color: #6080c0; outline: none; }

  .row {
    display: flex;
    gap: 16px;
    align-items: flex-end;
    flex-wrap: wrap;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  select {
    background: #1e1e2e;
    border: 1px solid #3a3a5a;
    color: #e0e0e0;
    padding: 5px 8px;
    border-radius: 4px;
    font-size: 12px;
  }
  select:focus { border-color: #6080c0; outline: none; }

  input[type="number"], input[type="text"] {
    background: #1e1e2e;
    border: 1px solid #3a3a5a;
    color: #e0e0e0;
    padding: 5px 8px;
    border-radius: 4px;
    font-size: 12px;
  }
  input:focus { border-color: #6080c0; outline: none; }

  .error-msg {
    font-size: 12px;
    color: #e07070;
    background: #2a1010;
    border: 1px solid #5a2020;
    padding: 8px 10px;
    border-radius: 4px;
  }

  .action-row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  button {
    background: #2a2a42;
    color: #8090b8;
    border: 1px solid #3a3a5a;
    padding: 7px 14px;
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
  }
  button:hover:not(:disabled) { background: #3a3a5a; color: #a0c4ff; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }

  button.primary {
    background: #364070;
    color: #a0c4ff;
    border: 1px solid #4a5a90;
    padding: 8px 20px;
    font-size: 13px;
    font-weight: 500;
  }
  button.primary:hover:not(:disabled) { background: #4a5a90; }

  .progress-wrap {
    height: 4px;
    background: #2a2a42;
    border-radius: 2px;
    overflow: hidden;
  }
  .progress-bar {
    height: 100%;
    background: linear-gradient(90deg, #4a9eff 0%, #9060ff 100%);
    width: 100%;
    animation: indeterminate 1.4s ease-in-out infinite;
  }
  @keyframes indeterminate {
    0%   { transform: translateX(-100%); }
    100% { transform: translateX(200%); }
  }
  .progress-hint {
    font-size: 11px;
    color: #6080a0;
    text-align: center;
  }

  /* ── Result ── */
  .result-section {
    border-top: 1px solid #2a2a3a;
    padding-top: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .result-title {
    font-size: 14px;
    color: #80e080;
    font-weight: 600;
    margin: 0;
  }
  .result-thumb {
    max-width: 100%;
    max-height: 320px;
    border-radius: 6px;
    border: 1px solid #2a2a3a;
    object-fit: contain;
    align-self: center;
  }
  .result-path {
    font-family: monospace;
    font-size: 11px;
    color: #9090b0;
    word-break: break-all;
  }
  .result-dim {
    font-size: 11px;
    color: #6080a0;
  }
  .action-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .action-group-label {
    font-size: 10px;
    color: #404060;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
  }
</style>
