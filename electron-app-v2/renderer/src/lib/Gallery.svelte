<script>
  import { galleryImages, selectedId, thumbSize, galleryLoading, t, selectedItems, lastClickedId, filters, sidebarView, allAlbums, starRatings, colorFlags } from '../stores.js';
  import { thumbnailUrl, previewUrl, openInOs, openFolderInOs, deleteImage, addToAlbum, createAlbum, fetchAlbums } from '../api.js';
  import { onMount, onDestroy } from 'svelte';
  import ContextMenu from './ContextMenu.svelte';
  import CropModal from './CropModal.svelte';
  import ConvertModal from './ConvertModal.svelte';

  // Virtual scroll: only render items in/near viewport
  let containerEl;
  let containerHeight = 600;
  let scrollTop = 0;

  // Compute grid columns from thumb size
  $: columns = Math.max(2, Math.floor((containerEl?.clientWidth ?? 800) / ($thumbSize + 8)));
  $: rowHeight = $thumbSize + 8;

  // Row slices
  $: rows = chunkArray($galleryImages, columns);
  $: totalHeight = rows.length * rowHeight;

  // Visible row range with overscan
  $: firstRow = Math.max(0, Math.floor(scrollTop / rowHeight) - 2);
  $: lastRow  = Math.min(rows.length, Math.ceil((scrollTop + containerHeight) / rowHeight) + 2);
  $: visibleRows = rows.slice(firstRow, lastRow);

  function chunkArray(arr, size) {
    const result = [];
    for (let i = 0; i < arr.length; i += size) {
      result.push(arr.slice(i, i + size));
    }
    return result;
  }

  function onScroll(e) {
    scrollTop = e.target.scrollTop;
  }

  function onResize() {
    if (containerEl) containerHeight = containerEl.clientHeight;
    // force recompute
    columns = Math.max(2, Math.floor(containerEl.clientWidth / ($thumbSize + 8)));
  }

  let resizeObserver;
  onMount(() => {
    resizeObserver = new ResizeObserver(onResize);
    if (containerEl) resizeObserver.observe(containerEl);
    onResize();
  });
  onDestroy(() => resizeObserver?.disconnect());

  function openLightbox(id) {
    selectedId.set(id);
  }

  function handleSelect(e, img) {
    const id = img.id;
    const isMulti = e.metaKey || e.ctrlKey;
    const isShift = e.shiftKey;

    selectedItems.update(set => {
      const newSet = new Set(set);
      
      if (isShift && $lastClickedId !== null) {
        const ids = $galleryImages.map(i => i.id);
        const start = ids.indexOf($lastClickedId);
        const end = ids.indexOf(id);
        const [low, high] = [Math.min(start, end), Math.max(start, end)];
        for (let i = low; i <= high; i++) newSet.add(ids[i]);
      } else if (isMulti) {
        if (newSet.has(id)) newSet.delete(id);
        else newSet.add(id);
      } else {
        newSet.clear();
        newSet.add(id);
      }
      return newSet;
    });
    
    lastClickedId.set(id);
  }

  let menuPos = { x: 0, y: 0 };
  let menuShow = false;
  let menuImg = null;

  let cropItem = null;
  let convertIds = [];

  function onContextMenu(e, img) {
    e.preventDefault();
    menuPos = { x: e.clientX, y: e.clientY };
    menuImg = img;
    menuShow = true;
  }

  async function handleMenuAction(e) {
    const { action, item, albumId, person } = e.detail;
    if (action === 'view') {
      openLightbox(item.id);
    } else if (action === 'open') {
      await openInOs(item.id);
    } else if (action === 'open-folder') {
      await openFolderInOs(item.id);
    } else if (action === 'browse-folder') {
      const dir = item.filepath.substring(0, item.filepath.lastIndexOf('/'));
      filters.set({ person: '', tag: '', scene: '', path: '', dateFrom: '', dateTo: '', folder: dir });
      sidebarView.set('all');
    } else if (action === 'delete') {
      if (confirm(`Delete ${item.filename}?`)) {
        await deleteImage(item.id);
        galleryImages.update(list => list.filter(i => i.id !== item.id));
      }
    } else if (action === 'add-to-album') {
      await addToAlbum(albumId, [item.id]);
      allAlbums.set(await fetchAlbums());
    } else if (action === 'new-album-with-image') {
      const name = prompt('New album name:');
      if (name?.trim()) {
        try {
          const album = await createAlbum(name.trim());
          await addToAlbum(album.id, [item.id]);
          allAlbums.set(await fetchAlbums());
        } catch (err) { alert(err.message); }
      }
    } else if (action === 'show-person') {
      filters.update(f => ({ ...f, person, tag: '', scene: '', folder: '', path: '', dateFrom: '', dateTo: '' }));
      sidebarView.set('all');
    } else if (action === 'copy-path') {
      navigator.clipboard.writeText(item.filepath).catch(() => {});
    } else if (action === 'crop') {
      cropItem = item;
    } else if (action === 'convert') {
      convertIds = [item.id];
    }
  }

  function handleKey(e) {
    if ($selectedId) return; // Lightbox handles its own keys
    const items = $galleryImages;
    if (items.length === 0) return;

    let currentIdx = -1;
    if ($lastClickedId) {
      currentIdx = items.findIndex(i => i.id === $lastClickedId);
    }

    let nextIdx = currentIdx;

    if (e.key === 'ArrowRight') nextIdx = Math.min(items.length - 1, currentIdx + 1);
    else if (e.key === 'ArrowLeft') nextIdx = Math.max(0, currentIdx - 1);
    else if (e.key === 'ArrowDown') nextIdx = Math.min(items.length - 1, currentIdx + columns);
    else if (e.key === 'ArrowUp') nextIdx = Math.max(0, currentIdx - columns);
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = items.length - 1;
    else if (e.key === 'PageDown') nextIdx = Math.min(items.length - 1, currentIdx + columns * 5);
    else if (e.key === 'PageUp') nextIdx = Math.max(0, currentIdx - columns * 5);
    else if (e.key === 'Enter' && currentIdx !== -1) openLightbox(items[currentIdx].id);
    else if (e.key === 'Escape') selectedItems.set(new Set());
    else return;

    if (nextIdx !== currentIdx) {
      e.preventDefault();
      const nextId = items[nextIdx].id;
      selectedItems.set(new Set([nextId]));
      lastClickedId.set(nextId);
      
      // Scroll into view logic could be added here if needed, 
      // but virtual scroll handles rendering already.
    }
  }

  onMount(() => {
    window.addEventListener('keydown', handleKey);
  });
  onDestroy(() => {
    window.removeEventListener('keydown', handleKey);
  });
</script>

<div
  class="gallery-container"
  bind:this={containerEl}
  on:scroll={onScroll}
>
  {#if $galleryLoading && $galleryImages.length === 0}
    <div class="empty">{$t('loading')}…</div>
  {:else if $galleryImages.length === 0}
    <div class="empty">{$t('no_results_found')}</div>
  {:else}
    <!-- Virtual scroll spacer -->
    <div style="height:{totalHeight}px; position:relative;">
      <div style="position:absolute; top:{firstRow * rowHeight}px; width:100%;">
        {#each visibleRows as row, ri}
          <div class="thumb-row" style="--size:{$thumbSize}px; --gap:8px;">
            {#each row as img}
              {@const rating = $starRatings[img.id] ?? img.star_rating ?? 0}
              {@const flag = $colorFlags[img.id] !== undefined ? $colorFlags[img.id] : img.color_flag}
              <button
                class="thumb-cell"
                class:selected={$selectedItems.has(img.id)}
                on:click={(e) => handleSelect(e, img)}
                on:dblclick={() => openLightbox(img.id)}
                on:contextmenu={(e) => onContextMenu(e, img)}
                title={img.filename}
              >
                <img
                  src={thumbnailUrl(img.id, $thumbSize)}
                  alt={img.filename}
                  loading="lazy"
                  width={$thumbSize}
                  height={$thumbSize}
                />
                {#if img.face_count > 0}
                  <span class="face-badge">{img.face_count}</span>
                {/if}
                {#if img.people_names}
                  <span class="people-label">{img.people_names.split(',').slice(0,2).join(', ')}</span>
                {/if}
                <!-- Star rating overlay (bottom-right) -->
                {#if rating > 0}
                  <span class="star-overlay">{'★'.repeat(rating)}</span>
                {/if}
                <!-- Color flag dot (top-left) -->
                {#if flag}
                  <span class="flag-dot" class:flag-pick={flag === 'pick'} class:flag-delete={flag === 'delete'}></span>
                {/if}
              </button>
            {/each}
          </div>
        {/each}
      </div>
    </div>
  {/if}

  {#if menuShow}
    <ContextMenu
      x={menuPos.x} y={menuPos.y} item={menuImg}
      on:close={() => menuShow = false}
      on:action={handleMenuAction}
    />
  {/if}
</div>

{#if cropItem}
  <CropModal
    imageId={cropItem.id}
    imageUrl={previewUrl(cropItem.id)}
    on:close={() => cropItem = null}
    on:cropped={() => { cropItem = null; galleryImages.update(list => [...list]); }}
  />
{/if}

{#if convertIds.length > 0}
  <ConvertModal
    imageIds={convertIds}
    on:close={() => convertIds = []}
    on:converted={() => convertIds = []}
  />
{/if}

<style>
  .gallery-container {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 8px;
    background: #121218;
  }
  .empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 60vh;
    color: #404060;
    font-size: 1.1rem;
    text-align: center;
    line-height: 1.6;
  }
  .thumb-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap);
    margin-bottom: var(--gap);
  }
  .thumb-cell {
    position: relative;
    width: var(--size);
    height: var(--size);
    overflow: hidden;
    border-radius: 4px;
    padding: 0;
    background: #1e1e2e;
    border: 2px solid transparent;
    transition: border-color 0.15s;
    cursor: pointer;
    flex-shrink: 0;
  }
  .thumb-cell:hover { border-color: #6080c0; }
  .thumb-cell.selected { border-color: #a0c4ff; border-width: 3px; box-shadow: 0 0 10px rgba(160, 196, 255, 0.4); }
  .thumb-cell img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .face-badge {
    position: absolute;
    top: 4px;
    right: 4px;
    background: rgba(80, 120, 200, 0.85);
    color: white;
    font-size: 10px;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 8px;
    pointer-events: none;
  }
  .people-label {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    background: linear-gradient(transparent, rgba(0,0,0,0.7));
    color: #ccc;
    font-size: 10px;
    padding: 4px 5px 3px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    pointer-events: none;
  }
  .star-overlay {
    position: absolute;
    bottom: 18px;
    right: 4px;
    color: #f0c040;
    font-size: 10px;
    letter-spacing: -1px;
    pointer-events: none;
    text-shadow: 0 1px 2px rgba(0,0,0,0.8);
  }
  .flag-dot {
    position: absolute;
    top: 5px;
    left: 5px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    pointer-events: none;
    box-shadow: 0 0 3px rgba(0,0,0,0.6);
  }
  .flag-dot.flag-pick   { background: #40c060; }
  .flag-dot.flag-delete { background: #e04040; }
</style>
