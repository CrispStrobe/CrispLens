<script>
  import { selectedItems, galleryImages, allAlbums, t } from '../stores.js';
  import { deleteImage, processSingle, addToAlbum, createAlbum, fetchAlbums } from '../api.js';
  import BatchEditModal from './BatchEditModal.svelte';
  import ConvertModal from './ConvertModal.svelte';

  $: count = $selectedItems.size;

  let showEditModal = false;
  let showConvertModal = false;
  let isProcessing = false;
  let progressIdx = 0;
  let showAlbumDropdown = false;

  function clearSelection() {
    selectedItems.set(new Set());
  }

  async function batchDelete() {
    if (!confirm(`Delete ${count} images?`)) return;
    isProcessing = true;
    progressIdx = 0;
    for (const id of $selectedItems) {
      await deleteImage(id);
      progressIdx++;
    }
    location.reload();
  }

  async function batchRescan() {
    isProcessing = true;
    progressIdx = 0;
    for (const id of $selectedItems) {
      const img = $galleryImages.find(i => i.id === id);
      if (img) await processSingle(img.filepath, true);
      progressIdx++;
    }
    location.reload();
  }

  async function addToAlbumAction(albumId) {
    const imageIds = Array.from($selectedItems);
    await addToAlbum(albumId, imageIds);
    showAlbumDropdown = false;
    allAlbums.set(await fetchAlbums());
  }

  async function createAndAdd() {
    const name = prompt('New album name:');
    if (!name?.trim()) return;
    try {
      const album = await createAlbum(name.trim());
      await addToAlbumAction(album.id);
    } catch (e) {
      alert(e.message);
    }
  }

  function handleWindowClick() {
    showAlbumDropdown = false;
  }
</script>

<svelte:window on:click={handleWindowClick} />

{#if count > 0}
  <div class="selection-toolbar">
    {#if isProcessing}
      <span class="count">Processing {progressIdx} / {count}...</span>
    {:else}
      <span class="count">{count} {$t('selection')}</span>
      <button on:click={() => showEditModal = true}>✏️ {$t('edit')}</button>
      <button on:click={batchRescan}>🔄 Rescan</button>
      <button on:click={() => showConvertModal = true}>🔁 Convert</button>

      <!-- Add to Album button + dropdown -->
      <div class="album-wrap" on:click|stopPropagation>
        <button on:click={() => showAlbumDropdown = !showAlbumDropdown}>📚 Album ▾</button>
        {#if showAlbumDropdown}
          <div class="album-dropdown">
            {#if $allAlbums.length === 0}
              <div class="no-albums">No albums yet</div>
            {:else}
              {#each $allAlbums as album}
                <button class="album-opt" on:click={() => addToAlbumAction(album.id)}>
                  {album.name} <span class="dim">({album.image_count})</span>
                </button>
              {/each}
            {/if}
            <div class="dropdown-divider"></div>
            <button class="album-opt new-album" on:click={createAndAdd}>+ New album…</button>
          </div>
        {/if}
      </div>

      <button class="danger" on:click={batchDelete}>🗑 {$t('delete')}</button>
      <button on:click={clearSelection} title={$t('cancel')}>✕</button>
    {/if}
  </div>
{/if}

{#if showEditModal}
  <BatchEditModal
    on:close={() => showEditModal = false}
    on:saved={() => location.reload()}
  />
{/if}

{#if showConvertModal}
  <ConvertModal
    imageIds={Array.from($selectedItems)}
    on:close={() => showConvertModal = false}
    on:converted={() => showConvertModal = false}
  />
{/if}

<style>
  .selection-toolbar {
    position: fixed;
    bottom: 40px;
    left: 50%;
    transform: translateX(-50%);
    background: #2a2a42;
    border: 1px solid #4a4a6a;
    padding: 8px 16px;
    border-radius: 24px;
    display: flex;
    align-items: center;
    gap: 12px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    z-index: 100;
  }
  .count { font-size: 13px; font-weight: 600; color: #a0c4ff; margin-right: 8px; }
  button { padding: 5px 12px; border-radius: 16px; }

  .album-wrap {
    position: relative;
  }

  .album-dropdown {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 50%;
    transform: translateX(-50%);
    background: #2a2a42;
    border: 1px solid #4a4a6a;
    border-radius: 8px;
    padding: 4px;
    min-width: 180px;
    max-height: 260px;
    overflow-y: auto;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .album-opt {
    background: transparent;
    border: none;
    color: #e0e0e0;
    text-align: left;
    padding: 6px 10px;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .album-opt:hover { background: #3a3a5a; color: #a0c4ff; }
  .album-opt.new-album { color: #8090b8; font-style: italic; }

  .no-albums {
    padding: 8px 10px;
    font-size: 11px;
    color: #505070;
  }

  .dropdown-divider {
    height: 1px;
    background: #3a3a5a;
    margin: 2px 4px;
  }

  .dim { color: #505070; font-size: 10px; }
</style>
