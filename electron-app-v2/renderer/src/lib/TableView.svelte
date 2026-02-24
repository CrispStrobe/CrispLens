<script>
  import { galleryImages, selectedId, t, selectedItems, lastClickedId, filters, sidebarView, allAlbums } from '../stores.js';
  import { thumbnailUrl, openInOs, openFolderInOs, deleteImage, addToAlbum, createAlbum, fetchAlbums } from '../api.js';
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
    }
  }
</script>

<div class="table-container">
  <table>
    <thead>
      <tr>
        <th class="thumb">Preview</th>
        <th>{$t('person_name')}</th>
        <th>{$t('search_by_date')}</th>
        <th>{$t('camera_model')}</th>
        <th>{$t('details')} / {$t('tags')}</th>
        <th>Paths</th>
      </tr>
    </thead>
    <tbody>
      {#each $galleryImages as img}
        {@const lp = img.local_path || ''}
        {@const origName = lp
          ? lp.replace(/\\/g, '/').split('/').pop()
          : (img.filename ?? img.filepath?.split('/').pop() ?? '')}
        {@const isFullPath = lp.includes('/') || lp.includes('\\')}
        <tr
          class:selected={$selectedItems.has(img.id)}
          on:click={(e) => handleSelect(e, img)}
          on:dblclick={() => openLightbox(img.id)}
          on:contextmenu={(e) => onContextMenu(e, img)}
        >
          <td class="thumb">
            <img src={thumbnailUrl(img.id, 60)} alt={img.filename} loading="lazy" />
          </td>
          <td class="people">
            {img.people_names || '-'}
          </td>
          <td class="date">
            <div title="Taken">{img.taken_at || '-'}</div>
            <div class="sub-date" title="Created">{img.created_at || '-'}</div>
          </td>
          <td class="camera">
            {img.camera_model || '-'}
          </td>
          <td class="tags">
            <div class="desc">{img.ai_description || ''}</div>
            <div class="tag-chips">
              {#each (img.ai_tags_list || []) as tag}
                <span class="chip">{tag}</span>
              {/each}
            </div>
          </td>
          <td class="path">
            <div class="path-filename" title={origName}>{origName}</div>
            {#if isFullPath}
              <div class="path-origin" title={lp}>{lp}</div>
            {/if}
            <div class="path-vps" title={img.filepath}>→ {img.filepath}</div>
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
  .table-container { flex: 1; overflow: auto; background: #121218; padding: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; color: #c0c8e0; }
  th { text-align: left; padding: 8px; border-bottom: 2px solid #2a2a3a; color: #8090b8; text-transform: uppercase; font-size: 10px; }
  td { padding: 8px; border-bottom: 1px solid #1e1e2e; vertical-align: middle; }
  tr { cursor: pointer; transition: background 0.15s; border-left: 3px solid transparent; }
  tr:hover { background: #1e1e2e; }
  tr.selected { background: #222a45; border-left-color: #a0c4ff; }
  .thumb { width: 70px; }
  .thumb img { width: 60px; height: 60px; object-fit: cover; border-radius: 4px; display: block; background: #1a1a28; }
  .people { font-weight: 600; color: #a0c4ff; }
  .date { color: #8090b8; white-space: nowrap; font-size: 11px; }
  .sub-date { font-size: 9px; color: #505070; margin-top: 2px; }
  .camera { color: #7080a0; font-size: 11px; }
  .desc { font-size: 11px; color: #e0e0e0; margin-bottom: 4px; max-width: 400px; overflow: hidden; text-overflow: ellipsis; }
  .tag-chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip { background: #252545; color: #8090b8; font-size: 9px; padding: 1px 5px; border-radius: 8px; }
  .path { color: #505070; font-size: 10px; }
  .path-filename {
    font-size: 12px; font-weight: 600; color: #a0b0cc;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 320px;
  }
  .path-origin {
    font-size: 10px; color: #607090; margin-top: 2px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 320px;
  }
  .path-vps {
    font-size: 9px; color: #3a3a58; margin-top: 1px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 320px;
  }
</style>
