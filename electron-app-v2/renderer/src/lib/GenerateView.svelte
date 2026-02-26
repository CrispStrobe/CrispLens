<script>
  import { t, sidebarView } from '../stores.js';
  import { generateImage, thumbnailUrl } from '../api.js';

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

  let loading  = false;
  let result   = null;  // { ok, new_image_id, filepath, width, height }
  let errorMsg = '';

  async function doGenerate() {
    if (!prompt.trim()) return;
    loading  = true;
    errorMsg = '';
    result   = null;
    try {
      result = await generateImage({
        prompt,
        model,
        aspect_ratio:    aspect,
        seed:            seed ? parseInt(seed, 10) : null,
        output_folder:   folder,
        filename_prefix: prefix,
      });
    } catch (e) {
      errorMsg = e.message || String(e);
    } finally {
      loading = false;
    }
  }

  function viewInGallery() {
    sidebarView.set('all');
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
        {#if result.new_image_id}
          <img
            src={thumbnailUrl(result.new_image_id, 400)}
            alt="Generated"
            class="result-thumb"
          />
        {/if}
        <div class="result-path">{result.filepath}</div>
        {#if result.width}
          <div class="result-dim">{result.width} × {result.height} px</div>
        {/if}
        <div class="result-actions">
          <button class="primary" on:click={viewInGallery}>{$t('gen_view_in_gallery')}</button>
          <button on:click={() => { result = null; prompt = ''; }}>+ {$t('gen_image_title')}</button>
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
    margin-top: 4px;
  }

  button.primary {
    background: #364070;
    color: #a0c4ff;
    border: 1px solid #4a5a90;
    padding: 8px 20px;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    font-weight: 500;
  }
  button.primary:hover:not(:disabled) { background: #4a5a90; }
  button.primary:disabled { opacity: 0.5; cursor: not-allowed; }

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
    gap: 8px;
  }
  .result-title {
    font-size: 14px;
    color: #80e080;
    font-weight: 600;
    margin: 0;
  }
  .result-thumb {
    max-width: 100%;
    border-radius: 6px;
    border: 1px solid #2a2a3a;
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
  .result-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
</style>
