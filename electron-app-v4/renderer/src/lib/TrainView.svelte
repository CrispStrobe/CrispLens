<script>
  import { trainPerson, trainFromFolder, fetchPeople } from '../api.js';
  import { allPeople, t } from '../stores.js';
  import ServerDirPicker from './ServerDirPicker.svelte';

  let serverPickerOpen = false;

  // ── Single person training ────────────────────────────────────────────────
  let personName = '';
  let imagePaths = '';  // comma- or newline-separated paths
  let trainResult = null;
  let trainLoading = false;
  let trainError = '';

  async function pickImages() {
    if (window.electronAPI?.openFileDialog) {
      const paths = await window.electronAPI.openFileDialog({ properties: ['openFile', 'multiSelections'] });
      if (paths?.length) imagePaths = paths.join('\n');
    }
  }

  async function doTrain() {
    if (!personName.trim()) { trainError = 'Person name required'; return; }
    const paths = imagePaths.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    if (!paths.length) { trainError = 'No image paths specified'; return; }

    trainLoading = true;
    trainError = '';
    trainResult = null;
    try {
      const r = await trainPerson(personName.trim(), paths);
      trainResult = r;
      // Refresh people list
      allPeople.set(await fetchPeople());
    } catch (e) {
      trainError = e.message;
    } finally {
      trainLoading = false;
    }
  }

  // ── Folder training ───────────────────────────────────────────────────────
  let folderPath = '';
  let folderResult = null;
  let folderLoading = false;
  let folderError = '';

  async function pickFolder() {
    if (window.electronAPI?.openFolderDialog) {
      const f = await window.electronAPI.openFolderDialog();
      if (f) folderPath = f;
    }
  }

  async function doFolderTrain() {
    if (!folderPath.trim()) { folderError = 'Folder path required'; return; }
    folderLoading = true;
    folderError = '';
    folderResult = null;
    try {
      const r = await trainFromFolder(folderPath.trim());
      folderResult = r;
      allPeople.set(await fetchPeople());
    } catch (e) {
      folderError = e.message;
    } finally {
      folderLoading = false;
    }
  }
</script>

<ServerDirPicker bind:open={serverPickerOpen} title="Select server training folder"
  on:select={e => folderPath = e.detail} />

<div class="train-view">
  <h2>{$t('tab_train')}</h2>

  <!-- Single person -->
  <section class="card">
    <h3>{$t('tab_train').split(' ')[1] || $t('tab_train')}</h3>
    <div class="field">
      <label>{$t('person_name')}</label>
      <input type="text" bind:value={personName} placeholder="{$t('person_name_placeholder')}" list="people-list" />
    </div>
    <div class="field">
      <label>{$t('training_images')} (Paths)</label>
      <textarea rows="4" bind:value={imagePaths} placeholder="/path/to/photo1.jpg&#10;/path/to/photo2.jpg"></textarea>
    </div>
    <div class="btn-row">
      <button on:click={pickImages}>{$t('browse_button')}…</button>
      <button class="primary" on:click={doTrain} disabled={trainLoading}>
        {trainLoading ? $t('training_in_progress') : $t('train_system')}
      </button>
    </div>
    {#if trainError}
      <div class="error-msg">✗ {trainError}</div>
    {/if}
    {#if trainResult}
      <div class="result-box">
        <div class={trainResult.ok ? 'ok-msg' : 'error-msg'}>{trainResult.message}</div>
        {#if trainResult.info}
          <pre>{JSON.stringify(trainResult.info, null, 2)}</pre>
        {/if}
      </div>
    {/if}
  </section>

  <!-- Folder training -->
  <section class="card">
    <h3>{$t('train_folder')}</h3>
    <p class="hint">
      {$t('train_folder_description')}
    </p>
    <div class="path-row">
      <input type="text" bind:value={folderPath} placeholder="{$t('folder_path')}" class="flex1" />
      {#if window.electronAPI?.openFolderDialog}
        <button on:click={pickFolder}>💻 Local…</button>
      {/if}
      <button on:click={() => serverPickerOpen = true}>📡 Server…</button>
    </div>
    <button class="primary" on:click={doFolderTrain} disabled={folderLoading || !folderPath.trim()}>
      {folderLoading ? $t('training_in_progress') : $t('train_system')}
    </button>
    {#if folderError}
      <div class="error-msg">✗ {folderError}</div>
    {/if}
    {#if folderResult}
      <div class="result-box">
        <div class="ok-msg">{$t('training_complete')} ({folderResult.people_count})</div>
        {#each Object.entries(folderResult.results) as [name, res]}
          <div class="person-row" class:err={!res.ok}>
            {res.ok ? '✓' : '✗'} <strong>{name}</strong>: {res.message}
          </div>
        {/each}
      </div>
    {/if}
  </section>
</div>

<style>
  .train-view {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  h2 { font-size: 1.1rem; color: #c0c8e0; margin-bottom: 4px; }
  h3 { font-size: 0.9rem; color: #9090b8; margin-bottom: 12px; }
  .card {
    background: #1a1a28;
    border: 1px solid #2a2a3a;
    border-radius: 8px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field label { font-size: 11px; color: #606080; text-transform: uppercase; letter-spacing: 0.06em; }
  .field input, .field textarea { width: 100%; }
  .hint { font-size: 11px; color: #505070; line-height: 1.6; }
  code { background: #202038; padding: 1px 4px; border-radius: 3px; font-size: 11px; color: #a0b8d0; }
  .btn-row, .path-row { display: flex; gap: 8px; }
  .flex1 { flex: 1; }
  .error-msg { color: #e08080; font-size: 12px; }
  .ok-msg { color: #80d080; font-size: 12px; }
  .result-box {
    background: #141422;
    border-radius: 6px;
    padding: 10px;
    font-size: 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .result-box pre {
    font-size: 10px;
    color: #7090b0;
    white-space: pre-wrap;
    overflow: auto;
    max-height: 200px;
  }
  .person-row { font-size: 11px; color: #7090b0; }
  .person-row.err { color: #d07070; }
  .person-row strong { color: #a0b8d0; }
</style>
