<script>
  import { onMount } from 'svelte';
  import { allAlbums } from '../stores.js';
  import {
    fetchAlbums, createAlbum, updateAlbum, deleteAlbum,
    fetchAlbumImages, removeFromAlbum, thumbnailUrl,
  } from '../api.js';

  let selectedAlbum = null;
  let albumImages = [];
  let loading = false;
  let creating = false;
  let newName = '';
  let editingId = null;
  let editingName = '';
  let removeMode = false;
  let removePending = new Set();

  onMount(refreshAlbums);

  async function refreshAlbums() {
    const data = await fetchAlbums().catch(() => []);
    allAlbums.set(data);
    if (selectedAlbum) {
      const fresh = data.find(a => a.id === selectedAlbum.id);
      selectedAlbum = fresh ?? null;
      if (!fresh) albumImages = [];
    }
  }

  async function selectAlbum(album) {
    selectedAlbum = album;
    removeMode = false;
    removePending = new Set();
    loading = true;
    try {
      albumImages = await fetchAlbumImages(album.id);
    } catch {
      albumImages = [];
    } finally {
      loading = false;
    }
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    try {
      await createAlbum(newName.trim());
      newName = '';
      creating = false;
      await refreshAlbums();
    } catch (e) {
      alert(e.message);
    }
  }

  function handleCreateKey(e) {
    if (e.key === 'Enter') handleCreate();
    if (e.key === 'Escape') { creating = false; newName = ''; }
  }

  async function handleDelete(album) {
    if (!confirm(`Delete album "${album.name}"?\nImages will NOT be deleted.`)) return;
    await deleteAlbum(album.id);
    if (selectedAlbum?.id === album.id) { selectedAlbum = null; albumImages = []; }
    await refreshAlbums();
  }

  function startEdit(album) {
    editingId = album.id;
    editingName = album.name;
  }

  async function commitEdit(album) {
    if (!editingName.trim()) { editingId = null; return; }
    if (editingName.trim() !== album.name) {
      await updateAlbum(album.id, { name: editingName.trim() }).catch(e => alert(e.message));
      await refreshAlbums();
    }
    editingId = null;
  }

  function handleEditKey(e, album) {
    if (e.key === 'Enter') commitEdit(album);
    if (e.key === 'Escape') editingId = null;
  }

  function toggleRemove(imgId) {
    const s = new Set(removePending);
    s.has(imgId) ? s.delete(imgId) : s.add(imgId);
    removePending = s;
  }

  async function confirmRemove() {
    if (!removePending.size || !selectedAlbum) return;
    await removeFromAlbum(selectedAlbum.id, Array.from(removePending));
    removePending = new Set();
    removeMode = false;
    albumImages = await fetchAlbumImages(selectedAlbum.id).catch(() => []);
    await refreshAlbums();
  }
</script>

<div class="albums-view">
  <!-- Left: album list -->
  <aside class="left-panel">
    <div class="panel-header">
      <span class="title">Albums <span class="count-badge">{$allAlbums.length}</span></span>
      <button class="primary sm" on:click={() => { creating = true; newName = ''; }}>+ New</button>
    </div>

    {#if creating}
      <!-- svelte-ignore a11y-autofocus -->
      <div class="create-row">
        <input
          bind:value={newName}
          placeholder="Album name…"
          on:keydown={handleCreateKey}
          autofocus
        />
        <button class="primary sm" on:click={handleCreate}>✓</button>
        <button class="sm" on:click={() => { creating = false; newName = ''; }}>✕</button>
      </div>
    {/if}

    <div class="album-list">
      {#each $allAlbums as album (album.id)}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <div
          class="album-item"
          class:active={selectedAlbum?.id === album.id}
          on:click={() => selectAlbum(album)}
        >
          <div class="cover">
            {#if album.cover_image_id}
              <img src={thumbnailUrl(album.cover_image_id, 56)} alt="" />
            {:else}
              <span class="placeholder">📚</span>
            {/if}
          </div>
          <div class="info">
            {#if editingId === album.id}
              <!-- svelte-ignore a11y-autofocus -->
              <input
                class="edit-name"
                bind:value={editingName}
                on:keydown={e => handleEditKey(e, album)}
                on:blur={() => commitEdit(album)}
                on:click|stopPropagation
                autofocus
              />
            {:else}
              <span class="name">{album.name}</span>
            {/if}
            <span class="sub">{album.image_count} photo{album.image_count !== 1 ? 's' : ''}</span>
          </div>
          <!-- svelte-ignore a11y-click-events-have-key-events -->
          <div class="item-actions" on:click|stopPropagation>
            <button class="icon-btn" title="Rename" on:click={() => startEdit(album)}>✏</button>
            <button class="icon-btn danger" title="Delete album" on:click={() => handleDelete(album)}>🗑</button>
          </div>
        </div>
      {/each}

      {#if $allAlbums.length === 0 && !creating}
        <div class="empty-hint">No albums yet.<br/>Click "+ New" to create one.</div>
      {/if}
    </div>
  </aside>

  <!-- Right: images in selected album -->
  <div class="right-panel">
    {#if selectedAlbum}
      <div class="panel-header">
        <div>
          <span class="title">{selectedAlbum.name}</span>
          <span class="sub">{selectedAlbum.image_count} photo{selectedAlbum.image_count !== 1 ? 's' : ''}</span>
        </div>
        <div class="right-actions">
          {#if removeMode}
            <span class="remove-hint">{removePending.size} selected</span>
            <button class="danger sm" on:click={confirmRemove} disabled={!removePending.size}>Remove selected</button>
            <button class="sm" on:click={() => { removeMode = false; removePending = new Set(); }}>Cancel</button>
          {:else}
            <button class="sm" on:click={() => removeMode = true} disabled={albumImages.length === 0}>Remove photos…</button>
          {/if}
        </div>
      </div>

      {#if loading}
        <div class="loading">Loading…</div>
      {:else if albumImages.length === 0}
        <div class="empty">
          <p>This album is empty.</p>
          <p>Select images in the gallery and use <strong>Add to Album</strong> in the action toolbar.</p>
        </div>
      {:else}
        <div class="image-grid">
          {#each albumImages as img (img.id)}
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <div
              class="thumb"
              class:selected={removePending.has(img.id)}
              on:click={() => removeMode && toggleRemove(img.id)}
              title={img.filename}
            >
              <img src={thumbnailUrl(img.id, 180)} alt={img.filename} />
              {#if removeMode}
                <div class="check-overlay">{removePending.has(img.id) ? '✓' : ''}</div>
              {/if}
              {#if img.people_names}
                <div class="people-chip">{img.people_names}</div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    {:else}
      <div class="no-selection">
        <span>📚</span>
        <p>Select an album to view its photos</p>
      </div>
    {/if}
  </div>
</div>

<style>
  .albums-view {
    display: flex;
    height: 100%;
    overflow: hidden;
  }

  /* ── Left panel ─────────────────────────────────────────────── */
  .left-panel {
    width: 240px;
    min-width: 200px;
    border-right: 1px solid #2a2a3a;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-bottom: 1px solid #2a2a3a;
    flex-shrink: 0;
  }
  .panel-header .title { font-weight: 600; font-size: 13px; color: #c0c8e0; }
  .panel-header .sub { font-size: 11px; color: #606080; margin-left: 8px; }
  .count-badge {
    background: #2e2e50;
    color: #8090b8;
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 8px;
    margin-left: 4px;
  }

  .create-row {
    display: flex;
    gap: 4px;
    padding: 6px 8px;
    border-bottom: 1px solid #2a2a3a;
    flex-shrink: 0;
  }
  .create-row input { flex: 1; }

  .album-list {
    flex: 1;
    overflow-y: auto;
    padding: 4px 0;
  }

  .album-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    cursor: pointer;
    transition: background 0.1s;
    border-radius: 0;
  }
  .album-item:hover { background: #1e1e2e; }
  .album-item.active { background: #202038; }

  .cover {
    width: 40px;
    height: 40px;
    border-radius: 4px;
    overflow: hidden;
    background: #1e1e2e;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .cover img { width: 100%; height: 100%; object-fit: cover; }
  .placeholder { font-size: 18px; }

  .info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .name {
    font-size: 12.5px;
    color: #d0d0e8;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sub { font-size: 10px; color: #505070; }

  .edit-name {
    width: 100%;
    font-size: 12px;
    padding: 2px 4px;
  }

  .item-actions {
    display: none;
    gap: 2px;
    flex-shrink: 0;
  }
  .album-item:hover .item-actions { display: flex; }

  .icon-btn {
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 3px 5px;
    font-size: 11px;
    border-radius: 3px;
    color: #8090b8;
    opacity: 0.7;
  }
  .icon-btn:hover { background: #2a2a42; opacity: 1; }
  .icon-btn.danger:hover { background: #4a1a1a; color: #ff8080; }

  .empty-hint {
    padding: 24px 16px;
    color: #505070;
    font-size: 12px;
    text-align: center;
    line-height: 1.6;
  }

  /* ── Right panel ────────────────────────────────────────────── */
  .right-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .right-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .remove-hint { font-size: 11px; color: #8090b8; }

  .sm { font-size: 11px; padding: 3px 8px; border-radius: 4px; }

  .loading {
    padding: 40px;
    color: #505070;
    text-align: center;
  }

  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: #505070;
    font-size: 13px;
    gap: 8px;
    text-align: center;
    padding: 40px;
  }
  .empty p { margin: 0; }
  .empty strong { color: #8090b8; }

  .no-selection {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: #404060;
    gap: 12px;
  }
  .no-selection span { font-size: 48px; opacity: 0.3; }
  .no-selection p { font-size: 13px; margin: 0; }

  .image-grid {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-content: flex-start;
  }

  .thumb {
    position: relative;
    width: 180px;
    height: 180px;
    border-radius: 4px;
    overflow: hidden;
    background: #1a1a2a;
    cursor: default;
    flex-shrink: 0;
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .thumb.selected {
    outline: 2px solid #e05050;
  }

  .check-overlay {
    position: absolute;
    inset: 0;
    background: rgba(180, 30, 30, 0.35);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 28px;
    color: white;
    cursor: pointer;
  }

  .people-chip {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    background: rgba(0,0,0,0.65);
    color: #c0d0f0;
    font-size: 9px;
    padding: 2px 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
