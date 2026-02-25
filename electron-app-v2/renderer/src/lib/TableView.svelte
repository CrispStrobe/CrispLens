<script>
  import { galleryImages, selectedId, t, selectedItems, lastClickedId, filters, sidebarView, allAlbums } from '../stores.js';
  import { thumbnailUrl, openInOs, openFolderInOs, deleteImage, downloadImage, addToAlbum, createAlbum, fetchAlbums } from '../api.js';
  import ContextMenu from './ContextMenu.svelte';

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

  // ── Collapsed / expanded rows ──────────────────────────────────────────────
  // Use a plain object keyed by id — reassigning triggers Svelte reactivity
  let expandedRows = {};
  let expandAll = false;

  function toggleRow(id, e) {
    e.stopPropagation();
    if (expandedRows[id]) {
      const { [id]: _, ...rest } = expandedRows;
      expandedRows = rest;
    } else {
      expandedRows = { ...expandedRows, [id]: true };
    }
  }

  function toggleExpandAll() {
    expandAll = !expandAll;
    expandedRows = {};
  }

  // ── Tag click → filter ─────────────────────────────────────────────────────
  function filterByTag(tag, e) {
    e.stopPropagation();
    filters.update(f => ({ ...f, tag, person: '', scene: '', folder: '', path: '', dateFrom: '', dateTo: '' }));
    sidebarView.set('all');
  }

  // ── Context menu ───────────────────────────────────────────────────────────
  let menuPos = { x: 0, y: 0 };
  let menuShow = false;
  let menuImg = null;

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
      const res = await openInOs(item.id).catch(() => null);
      if (res && !res.ok && res.headless) {
        alert(`Server path (headless — use Download to get the file):\n${res.path}`);
      }
    } else if (action === 'open-folder') {
      const res = await openFolderInOs(item.id).catch(() => null);
      if (res && !res.ok && res.headless) {
        await navigator.clipboard.writeText(res.path).catch(() => {});
        alert(`Server folder (copied to clipboard):\n${res.path}`);
      }
    } else if (action === 'download') {
      downloadImage(item.id, item.filename);
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
    }
  }
</script>

<div class="table-container">
  <div class="table-toolbar">
    <button class="expand-all-btn" on:click={toggleExpandAll}>
      {expandAll ? '⊟ Collapse All' : '⊞ Expand All'}
    </button>
  </div>
  <table>
    <thead>
      <tr>
        <th class="col-thumb">Preview</th>
        <th>{$t('person_name')}</th>
        <th class="col-date">{$t('search_by_date')}</th>
        <th class="col-detail">{$t('details')} / {$t('tags')}</th>
        <th>Path</th>
        <th class="col-toggle"></th>
      </tr>
    </thead>
    <tbody>
      {#each $galleryImages as img (img.id)}
        {@const originPath = img.origin_path ?? img.local_path ?? ''}
        {@const serverPath = img.server_path ?? img.filepath ?? ''}
        {@const originDiffers = originPath && originPath !== serverPath}
        {@const displayPath = originPath || serverPath}
        <!-- Inline reference to expandAll and expandedRows so Svelte tracks them -->
        {@const rowExpanded = expandAll || !!expandedRows[img.id]}
        <tr
          class:selected={$selectedItems.has(img.id)}
          class:expanded={rowExpanded}
          on:click={(e) => handleSelect(e, img)}
          on:dblclick={() => openLightbox(img.id)}
          on:contextmenu={(e) => onContextMenu(e, img)}
        >
          <td class="col-thumb">
            <img src={thumbnailUrl(img.id, 60)} alt={img.filename} loading="lazy" />
          </td>
          <td class="people">
            {img.people_names || '-'}
            {#if rowExpanded}
              <div class="camera-sub">{img.camera_model || ''}</div>
            {/if}
          </td>
          {#if rowExpanded}
            <td class="date">
              <div title="Taken">{img.taken_at || '-'}</div>
              <div class="sub-date" title="Created">{img.created_at || '-'}</div>
            </td>
            <td class="col-detail tags">
              <div class="desc">{img.ai_description || ''}</div>
              <div class="tag-chips">
                {#each (img.ai_tags_list || []) as tag}
                  <span class="chip" on:click={(e) => filterByTag(tag, e)} title="Filter by: {tag}">{tag}</span>
                {/each}
              </div>
            </td>
          {:else}
            <td class="date collapsed-date">
              {img.taken_at ? img.taken_at.slice(0, 10) : '-'}
            </td>
            <td class="col-detail tags">
              <div class="tag-chips">
                {#each (img.ai_tags_list || []).slice(0, 4) as tag}
                  <span class="chip" on:click={(e) => filterByTag(tag, e)} title="Filter by: {tag}">{tag}</span>
                {/each}
                {#if (img.ai_tags_list || []).length > 4}
                  <span class="chip chip-more">+{(img.ai_tags_list || []).length - 4}</span>
                {/if}
              </div>
            </td>
          {/if}
          <td class="path">
            <div class="path-origin" title={displayPath}>{displayPath}</div>
            {#if rowExpanded && originDiffers}
              <div class="path-vps" title={serverPath}>
                <span class="path-label">server</span>{serverPath}
              </div>
            {/if}
          </td>
          <td class="col-toggle">
            <button class="expand-btn" on:click={(e) => toggleRow(img.id, e)} title={rowExpanded ? 'Collapse row' : 'Expand row'}>
              {rowExpanded ? '▲' : '▼'}
            </button>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>

  {#if menuShow}
    <ContextMenu
      x={menuPos.x} y={menuPos.y} item={menuImg}
      on:close={() => menuShow = false}
      on:action={handleMenuAction}
    />
  {/if}
</div>

<style>
  .table-container { flex: 1; overflow: auto; background: #121218; padding: 10px; display: flex; flex-direction: column; }

  .table-toolbar {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 6px;
    flex-shrink: 0;
  }
  .expand-all-btn {
    font-size: 11px;
    padding: 3px 10px;
    border-radius: 10px;
    background: #1e1e32;
    color: #7080a0;
    border: 1px solid #2a2a42;
  }
  .expand-all-btn:hover { background: #2a2a42; color: #a0c4ff; }

  table { width: 100%; border-collapse: collapse; font-size: 12px; color: #c0c8e0; }
  th { text-align: left; padding: 8px; border-bottom: 2px solid #2a2a3a; color: #8090b8; text-transform: uppercase; font-size: 10px; }
  td { padding: 6px 8px; border-bottom: 1px solid #1e1e2e; vertical-align: middle; }
  tr { cursor: pointer; transition: background 0.15s; border-left: 3px solid transparent; }
  tr:hover { background: #1e1e2e; }
  tr.selected { background: #222a45; border-left-color: #a0c4ff; }

  .col-thumb { width: 70px; }
  .col-thumb img { width: 60px; height: 60px; object-fit: cover; border-radius: 4px; display: block; background: #1a1a28; }

  .people { font-weight: 600; color: #a0c4ff; min-width: 80px; }
  .camera-sub { font-size: 9px; color: #505070; font-weight: 400; margin-top: 2px; }

  .col-date { min-width: 90px; }
  .date { color: #8090b8; white-space: nowrap; font-size: 11px; }
  .collapsed-date { font-size: 10px; color: #505070; }
  .sub-date { font-size: 9px; color: #505070; margin-top: 2px; }

  .col-detail { min-width: 160px; }
  .tags {}
  .desc { font-size: 11px; color: #e0e0e0; margin-bottom: 4px; max-width: 400px; overflow: hidden; text-overflow: ellipsis; }
  .tag-chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip {
    background: #252545; color: #8090b8; font-size: 9px; padding: 1px 5px; border-radius: 8px;
    cursor: pointer; transition: background 0.1s, color 0.1s; user-select: none;
  }
  .chip:hover { background: #3a3a6a; color: #a0c4ff; }
  .chip-more { background: #1e1e38; color: #4a5070; cursor: default; }
  .chip-more:hover { background: #1e1e38; color: #4a5070; }

  .path { color: #607090; font-size: 10px; max-width: 340px; }
  .path-origin {
    font-size: 11px; color: #6070a0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 340px;
  }
  .path-vps {
    font-size: 9px; color: #3a3a58; margin-top: 1px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 340px;
  }
  .path-label {
    font-size: 8px; color: #3a3a58; text-transform: uppercase;
    margin-right: 4px; letter-spacing: 0.5px;
  }

  .col-toggle { width: 28px; }
  .expand-btn {
    background: transparent; border: none; color: #3a3a58;
    font-size: 9px; padding: 2px 4px; cursor: pointer; border-radius: 4px;
  }
  .expand-btn:hover { color: #7080a0; background: #1e1e2e; }
</style>
