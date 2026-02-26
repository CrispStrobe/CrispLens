<script>
  /**
   * ServerDirPicker.svelte — modal overlay for picking a server-side directory.
   * Usage:
   *   <ServerDirPicker bind:open on:select={e => myPath = e.detail} />
   */
  import { createEventDispatcher } from 'svelte';
  import { browseFilesystem } from '../api.js';

  export let open = false;
  export let title = 'Pick a server folder';
  // If set, the picker starts at this path instead of the server default
  export let startPath = '';

  const dispatch = createEventDispatcher();

  let currentPath = '';
  let entries = [];
  let parentPath = null;
  let loading = false;
  let error = '';

  // Load root when opened for the first time; start from startPath if provided
  $: if (open && currentPath === '' && !loading) browse(startPath || '');

  async function browse(path) {
    loading = true;
    error = '';
    try {
      const data = await browseFilesystem(path ?? '');
      currentPath = data.path;
      parentPath  = data.parent;
      entries     = data.entries.filter(e => e.is_dir);
    } catch (e) {
      error = e.message;
      console.error('[ServerDirPicker] browse error for', path, ':', e.message);
    } finally {
      loading = false;
    }
  }

  function select() {
    dispatch('select', currentPath);
    close();
  }

  function close() {
    open = false;
    // Reset so next open starts fresh
    currentPath = '';
    entries = [];
    parentPath = null;
    error = '';
  }
</script>

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="sdp-overlay" on:click|self={close}>
    <div class="sdp-modal">
      <div class="sdp-header">
        <span class="sdp-title">{title}</span>
        <button class="sdp-close" on:click={close}>✕</button>
      </div>

      <div class="sdp-nav">
        <button class="sdp-up" on:click={() => browse(parentPath)} disabled={!parentPath || loading}>↑</button>
        <span class="sdp-path">{currentPath || '…'}</span>
      </div>

      <div class="sdp-list">
        {#if error}
          <div class="sdp-error">{error}</div>
        {:else if loading}
          <div class="sdp-loading">Loading…</div>
        {:else if entries.length === 0}
          <div class="sdp-empty">No subdirectories</div>
        {:else}
          {#each entries as entry}
            <button class="sdp-entry" on:click={() => browse(entry.path)}
              title={entry.is_symlink ? `symlink → ${entry.name}` : entry.name}>
              {entry.is_symlink ? '🔗' : '📁'} {entry.name}{entry.is_symlink ? ' ⇢' : ''}
            </button>
          {/each}
        {/if}
      </div>

      <div class="sdp-footer">
        <span class="sdp-sel">{currentPath}</span>
        <button class="primary" on:click={select} disabled={!currentPath}>
          Select this folder
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .sdp-overlay {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center;
    z-index: 1000;
  }
  .sdp-modal {
    background: #1a1a2e; border: 1px solid #3a3a5a; border-radius: 8px;
    width: 520px; max-height: 70vh;
    display: flex; flex-direction: column;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  }
  .sdp-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px; border-bottom: 1px solid #2a2a42;
  }
  .sdp-title { font-size: 13px; font-weight: 600; color: #c0d0f0; }
  .sdp-close { background: none; padding: 2px 6px; font-size: 13px; color: #8090b0; }
  .sdp-nav {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 14px; background: #141428; border-bottom: 1px solid #2a2a42;
  }
  .sdp-up { padding: 3px 8px; font-size: 13px; }
  .sdp-path { font-size: 11px; font-family: monospace; color: #7090c0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sdp-list {
    flex: 1; overflow-y: auto; padding: 6px;
    display: flex; flex-direction: column; gap: 1px;
    min-height: 200px;
  }
  .sdp-entry {
    text-align: left; padding: 6px 10px; border-radius: 4px;
    font-size: 12px; color: #c0d0f0; background: transparent;
    width: 100%;
  }
  .sdp-entry:hover { background: #2a2a42; }
  .sdp-error { padding: 10px; color: #e08080; font-size: 12px; }
  .sdp-loading, .sdp-empty { padding: 10px; color: #6070a0; font-size: 12px; }
  .sdp-footer {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 14px; border-top: 1px solid #2a2a42;
  }
  .sdp-sel { flex: 1; font-size: 11px; font-family: monospace; color: #8090b0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
