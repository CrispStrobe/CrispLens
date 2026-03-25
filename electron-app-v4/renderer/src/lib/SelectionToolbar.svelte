<script>
  import { selectedItems, galleryImages, allAlbums, t, currentUser } from '../stores.js';
  import { deleteImage, processSingle, addToAlbum, createAlbum, fetchAlbums, downloadImage } from '../api.js';
  import BatchEditModal from './BatchEditModal.svelte';
  import ConvertModal from './ConvertModal.svelte';
  import ArchiveMetadataModal from './ArchiveMetadataModal.svelte';

  $: count = $selectedItems.size;
  // Allow delete only for admin/mediamanager, or if all selected images are owned by current user
  $: canDelete = $currentUser?.role === 'admin'
    || $currentUser?.role === 'mediamanager'
    || [...$selectedItems].every(id => {
        const img = $galleryImages.find(i => i.id === id);
        return !img || img.owner_id == null || img.owner_id === $currentUser?.id
            || img.visibility === 'shared';
      });

  let showEditModal = false;
  let showConvertModal = false;
  let showArchiveModal = false;
  let archiveModalMode = 'bildarchiv';  // 'bildarchiv' | 'bildauswahl' | 'rename'
  let showBildauswahlDropdown = false;
  let isProcessing = false;
  let progressIdx = 0;
  let showAlbumDropdown = false;
  let showRescanDropdown = false;
  let archiveMsg = '';

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

  async function batchRescan(mode = 'both') {
    showRescanDropdown = false;
    isProcessing = true;
    progressIdx = 0;
    const skipFaces = mode === 'vlm';
    const skipVlm   = mode === 'faces';
    for (const id of $selectedItems) {
      const img = $galleryImages.find(i => i.id === id);
      if (img) await processSingle(img.filepath, true, skipFaces, skipVlm);
      progressIdx++;
    }
    location.reload();
  }

  async function batchDownload() {
    const ids = Array.from($selectedItems);
    for (let i = 0; i < ids.length; i++) {
      const img = $galleryImages.find(x => x.id === ids[i]);
      downloadImage(ids[i], img?.filename);
      // Small delay between downloads to avoid browser popup blocking
      if (i < ids.length - 1) await new Promise(r => setTimeout(r, 300));
    }
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
    showRescanDropdown = false;
    showBildauswahlDropdown = false;
  }

  function openArchiveModal(mode) {
    console.log('[SelectionToolbar] openArchiveModal:', mode, 'ids:', $selectedItems.size);
    archiveModalMode = mode;
    showArchiveModal = true;
    showBildauswahlDropdown = false;
  }
</script>

<svelte:window on:click={handleWindowClick} />

{#if count > 0}
  <div class="selection-toolbar">
    {#if isProcessing}
      <span class="count">Processing {progressIdx} / {count}…</span>
    {:else}
      <span class="count">{count} {$t('selection')}</span>

      <button on:click={() => showEditModal = true}>✏️ {$t('edit')}</button>

      <!-- Rescan with dropdown for mode -->
      <div class="dropdown-wrap" on:click|stopPropagation>
        <button class="rescan-btn" on:click={() => batchRescan('both')} title="Re-detect faces + run VLM">🔄 Rescan</button>
        <button class="dropdown-arrow" on:click={() => showRescanDropdown = !showRescanDropdown}>▾</button>
        {#if showRescanDropdown}
          <div class="dropdown-menu">
            <button class="dropdown-opt" on:click={() => batchRescan('both')}>🔄 Faces + VLM</button>
            <button class="dropdown-opt" on:click={() => batchRescan('faces')}>👤 Faces only</button>
            <button class="dropdown-opt" on:click={() => batchRescan('vlm')}>🤖 VLM only</button>
          </div>
        {/if}
      </div>

      <button on:click={batchDownload} title="Download selected images">⬇ Download</button>

      <button on:click={() => showConvertModal = true}>🔁 Convert</button>

      <!-- Add to Album button + dropdown -->
      <div class="dropdown-wrap" on:click|stopPropagation>
        <button on:click={() => showAlbumDropdown = !showAlbumDropdown}>📚 Album ▾</button>
        {#if showAlbumDropdown}
          <div class="dropdown-menu album-dropdown">
            {#if $allAlbums.length === 0}
              <div class="no-albums">No albums yet</div>
            {:else}
              {#each $allAlbums as album (album.id)}
                <button class="dropdown-opt" on:click={() => addToAlbumAction(album.id)}>
                  {album.name} <span class="dim">({album.image_count})</span>
                </button>
              {/each}
            {/if}
            <div class="dropdown-divider"></div>
            <button class="dropdown-opt new-album" on:click={createAndAdd}>+ New album…</button>
          </div>
        {/if}
      </div>

      <!-- Als Unterauswahl ablegen + Bildarchiv -->
      <div class="dropdown-wrap" on:click|stopPropagation>
        <button class="bildauswahl-btn" on:click={() => openArchiveModal('bildauswahl')} title="Als Unterauswahl ablegen (Bildauswahl)">
          📂 Unterauswahl
        </button>
        <button class="dropdown-arrow bildauswahl-arr" on:click={() => showBildauswahlDropdown = !showBildauswahlDropdown}>▾</button>
        {#if showBildauswahlDropdown}
          <div class="dropdown-menu">
            <button class="dropdown-opt" on:click={() => openArchiveModal('bildauswahl')}>📂 Als Unterauswahl ablegen…</button>
            <button class="dropdown-opt" on:click={() => openArchiveModal('bildarchiv')}>🗂 In Bildarchiv ablegen…</button>
            <div class="dropdown-divider"></div>
            <button class="dropdown-opt" on:click={() => openArchiveModal('rename')}>✏️ Umbenennen/Neu sortieren…</button>
          </div>
        {/if}
      </div>

      {#if archiveMsg}
        <span class="archive-msg">{archiveMsg}</span>
      {/if}

      {#if canDelete}
        <button class="danger" on:click={batchDelete}>🗑 {$t('delete')}</button>
      {:else}
        <button class="danger" disabled title="You can only delete images you own">🗑 {$t('delete')} (limited)</button>
      {/if}
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

{#if showArchiveModal}
  <ArchiveMetadataModal
    imageIds={Array.from($selectedItems)}
    mode={archiveModalMode}
    on:close={() => showArchiveModal = false}
    on:done={e => {
      showArchiveModal = false;
      const r = e.detail?.results;
      archiveMsg = `✓ ${r?.success_count ?? '?'} erledigt`;
      setTimeout(() => archiveMsg = '', 4000);
    }}
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
    gap: 8px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    z-index: 100;
  }
  .count { font-size: 13px; font-weight: 600; color: #a0c4ff; margin-right: 4px; }
  button { padding: 5px 12px; border-radius: 16px; }

  /* Generic dropdown wrapper */
  .dropdown-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }

  .rescan-btn {
    border-radius: 16px 0 0 16px;
    border-right: 1px solid #3a3a5a;
  }
  .dropdown-arrow {
    border-radius: 0 16px 16px 0;
    padding: 5px 8px;
    font-size: 10px;
    background: transparent;
  }
  .dropdown-arrow:hover { background: #2a3a5a; }

  .dropdown-menu {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 50%;
    transform: translateX(-50%);
    background: #2a2a42;
    border: 1px solid #4a4a6a;
    border-radius: 8px;
    padding: 4px;
    min-width: 160px;
    max-height: 260px;
    overflow-y: auto;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    display: flex;
    flex-direction: column;
    gap: 1px;
    z-index: 110;
  }

  .album-dropdown { min-width: 180px; }

  .dropdown-opt {
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
  .dropdown-opt:hover { background: #3a3a5a; color: #a0c4ff; }
  .dropdown-opt.new-album { color: #8090b8; font-style: italic; }

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

  .bildauswahl-btn {
    border-radius: 16px 0 0 16px;
    border-right: 1px solid #3a3a5a;
    background: #1e3020;
    color: #80d090;
  }
  .bildauswahl-btn:hover { background: #2a4030; color: #a0e0a0; }
  .bildauswahl-arr { border-radius: 0 16px 16px 0; }

  .archive-msg {
    font-size: 11px; color: #80d090; background: #0a2a1a;
    padding: 3px 8px; border-radius: 10px; border: 1px solid #2a6a3a;
  }
</style>
