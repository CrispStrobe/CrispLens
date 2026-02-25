<script>
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { t, allAlbums, currentUser } from '../stores.js';

  export let x = 0;
  export let y = 0;
  export let item = null;

  const dispatch = createEventDispatcher();

  let showAlbumSubmenu = false;

  // Parse people in this image
  $: people = item?.people_names
    ? item.people_names.split(',').map(n => n.trim()).filter(Boolean)
    : [];

  // Delete is allowed for admin/mediamanager, or if the user owns the image (or it has no owner)
  $: canDelete = $currentUser?.role === 'admin'
    || $currentUser?.role === 'mediamanager'
    || item?.owner_id == null
    || item?.owner_id === $currentUser?.id;

  function close() { dispatch('close'); }

  function handleAction(action, extra = {}) {
    dispatch('action', { action, item, ...extra });
    close();
  }

  function onWindowClick() { close(); }
  function onKey(e) { if (e.key === 'Escape') close(); }

  onMount(() => {
    window.addEventListener('click', onWindowClick);
    window.addEventListener('keydown', onKey);
  });
  onDestroy(() => {
    window.removeEventListener('click', onWindowClick);
    window.removeEventListener('keydown', onKey);
  });
</script>

<!-- svelte-ignore a11y-click-events-have-key-events -->
<div class="context-menu" style="top: {y}px; left: {x}px" on:click|stopPropagation>
  <button on:click={() => handleAction('view')}>👁 {$t('view')}</button>
  <button on:click={() => handleAction('open')}>🖼 {$t('view')} (External)</button>
  <button on:click={() => handleAction('open-folder')}>📂 {$t('tab_folders')} (External)</button>
  <button on:click={() => handleAction('browse-folder')}>🔍 {$t('tab_folders')} (Internal)</button>

  <!-- Add to Album submenu -->
  <div class="divider"></div>
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <div
    class="submenu-trigger"
    on:mouseenter={() => showAlbumSubmenu = true}
    on:mouseleave={() => showAlbumSubmenu = false}
  >
    <button class="submenu-btn">📚 Add to Album ▶</button>
    {#if showAlbumSubmenu}
      <div class="submenu">
        {#if $allAlbums.length === 0}
          <div class="no-items">No albums — create one first</div>
        {:else}
          {#each $allAlbums as album}
            <button on:click={() => handleAction('add-to-album', { albumId: album.id, albumName: album.name })}>
              {album.name} <span class="dim">({album.image_count})</span>
            </button>
          {/each}
        {/if}
        <div class="divider"></div>
        <button on:click={() => handleAction('new-album-with-image')}>+ New album…</button>
      </div>
    {/if}
  </div>

  <!-- People in this image -->
  {#if people.length > 0}
    <div class="divider"></div>
    <div class="section-label">People in this image</div>
    {#each people as person}
      <button on:click={() => handleAction('show-person', { person })}>
        🔍 All photos of <strong>{person}</strong>
      </button>
    {/each}
  {/if}

  <div class="divider"></div>
  <button on:click={() => handleAction('crop')}>✂ Crop image</button>
  <button on:click={() => handleAction('convert')}>🔁 Convert / Export</button>
  <div class="divider"></div>
  <button on:click={() => handleAction('download')}>⬇ Download file</button>
  <button on:click={() => handleAction('copy-path')}>📋 Copy file path</button>
  <div class="divider"></div>
  {#if canDelete}
    <button class="danger" on:click={() => handleAction('delete')}>🗑 {$t('delete')}</button>
  {:else}
    <button class="disabled" title="You don't own this image" disabled>🗑 {$t('delete')} (not yours)</button>
  {/if}
</div>

<style>
  .context-menu {
    position: fixed;
    background: #2a2a42;
    border: 1px solid #4a4a6a;
    border-radius: 8px;
    padding: 4px;
    min-width: 200px;
    box-shadow: 0 10px 25px rgba(0,0,0,0.5);
    z-index: 2000;
    display: flex;
    flex-direction: column;
  }
  button {
    background: transparent;
    border: none;
    color: #e0e0e0;
    text-align: left;
    padding: 7px 12px;
    font-size: 12px;
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
  }
  button:hover { background: #3a3a5a; color: #a0c4ff; }
  button.danger:hover { background: #5a2a2a; color: #ff8a8a; }
  button.disabled { color: #404050; cursor: not-allowed; opacity: 0.5; }
  .divider { height: 1px; background: #3a3a5a; margin: 4px; }

  .section-label {
    padding: 4px 12px 2px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #505070;
  }

  .submenu-trigger {
    position: relative;
  }
  .submenu-btn {
    width: 100%;
    justify-content: space-between;
  }
  .submenu-btn:hover { background: #3a3a5a; color: #a0c4ff; }

  .submenu {
    position: absolute;
    left: 100%;
    top: 0;
    background: #2a2a42;
    border: 1px solid #4a4a6a;
    border-radius: 8px;
    padding: 4px;
    min-width: 180px;
    max-height: 280px;
    overflow-y: auto;
    box-shadow: 0 10px 25px rgba(0,0,0,0.5);
    z-index: 2001;
    display: flex;
    flex-direction: column;
  }

  .no-items {
    padding: 8px 12px;
    font-size: 11px;
    color: #505070;
  }

  .dim {
    color: #505070;
    font-size: 10px;
    margin-left: auto;
  }
</style>
