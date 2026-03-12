<script>
  import { filters, sortBy, thumbSize, galleryImages, galleryLoading, activeFilterCount, sidebarView, galleryMode, t, currentUser, galleryRefreshTick, clipboard } from '../stores.js';
  import { fetchImages, copyFilesystem, moveFilesystem } from '../api.js';
  import { onMount, onDestroy } from 'svelte';

  let searchQuery = '';
  let pathQuery = '';
  let creatorQuery = '';
  let showSearchOpts = false;

  $: searchFieldsArr = ($filters.searchFields || 'filename,path,description').split(',');
  function toggleSearchField(f) {
    filters.update(cur => {
      let arr = (cur.searchFields || '').split(',').filter(Boolean);
      if (arr.includes(f)) arr = arr.filter(x => x !== f);
      else arr.push(f);
      return { ...cur, searchFields: arr.join(',') };
    });
  }

  $: sortOptions = [
    { value: 'newest',          label: $t('sort_newest') },
    { value: 'oldest',          label: $t('sort_oldest') },
    { value: 'date_taken_desc', label: $t('sort_date_taken_desc') },
    { value: 'date_taken_asc',  label: $t('sort_date_taken_asc') },
    { value: 'most_faces',      label: $t('sort_most_faces') },
    { value: 'filename_az',     label: $t('sort_filename_az') },
  ];

  async function loadGallery() {
    const f = $filters;
    const s = $sortBy;
    galleryLoading.set(true);
    try {
      const images = await fetchImages({
        person:   f.person,
        tag:      f.tag,
        scene:    f.scene,
        folder:   f.folder,
        path:     f.path,
        dateFrom: f.dateFrom,
        dateTo:   f.dateTo,
        creator:  f.creator,
        search_fields: f.searchFields,
        sort:     s,
        limit:    500,
      });
      galleryImages.set(images);
    } catch (e) {
      console.warn('Gallery load failed (stale cache kept):', e);
    } finally {
      galleryLoading.set(false);
    }
  }

  // Debounce helper — resets timer on every call, fires after delay
  let loadTimer;
  function scheduleLoad(delay = 150) {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(loadGallery, delay);
  }

  // Update filter stores; subscriptions below handle the reload
  function onSearch()     { filters.update(f => ({ ...f, person: searchQuery })); }
  function onPathSearch() { filters.update(f => ({ ...f, path:   pathQuery   })); }
  function onCreatorSearch() { filters.update(f => ({ ...f, creator: creatorQuery })); }

  function clearFilters() {
    searchQuery = '';
    pathQuery   = '';
    creatorQuery = '';
    filters.set({ person: '', tag: '', scene: '', folder: '', path: '', dateFrom: '', dateTo: '', creator: '', searchFields: 'filename,path,description' });
  }

  async function handlePaste() {
    if (!$clipboard) return;
    const { mode, items } = $clipboard;
    const destDir = prompt('Paste to directory (server path):');
    if (!destDir) return;

    try {
      const paths = items.map(it => it.path || it.server_path);
      let res;
      if (mode === 'copy') {
        res = await copyFilesystem(paths, destDir);
      } else {
        res = await moveFilesystem(paths, destDir);
      }
      
      const successCount = res.results.filter(r => r.ok).length;
      alert(`${mode === 'copy' ? 'Copied' : 'Moved'} ${successCount} of ${paths.length} items.`);
      if (mode === 'move') {
        clipboard.set(null);
        galleryRefreshTick.update(n => n + 1);
      }
    } catch (e) {
      alert('Paste failed: ' + e.message);
    }
  }

  let unsubFilters, unsubSort, unsubUser, unsubTick;

  onMount(() => {
    // Single authoritative initial load (may fail with 401 if not yet logged in — that's fine)
    loadGallery();

    let fFirst = true;
    unsubFilters = filters.subscribe(() => {
      if (fFirst) { fFirst = false; return; }
      scheduleLoad(150);   // debounce for fast typing
    });

    let sFirst = true;
    unsubSort = sortBy.subscribe(() => {
      if (sFirst) { sFirst = false; return; }
      scheduleLoad(0);     // sort change is immediate
    });

    let uFirst = true;
    unsubUser = currentUser.subscribe(u => {
      if (uFirst) { uFirst = false; return; }
      if (u) scheduleLoad(200);   // logged in → reload with auth cookie
      else galleryImages.set([]);  // logged out → clear
    });

    let tFirst = true;
    unsubTick = galleryRefreshTick.subscribe(() => {
      if (tFirst) { tFirst = false; return; }
      scheduleLoad(300);
    });
  });

  onDestroy(() => {
    unsubFilters?.();
    unsubSort?.();
    unsubUser?.();
    unsubTick?.();
    clearTimeout(loadTimer);
  });
</script>

<header class="toolbar">
  <div class="brand">📷</div>

  <button on:click={loadGallery} title={$t('refresh')}>🔄</button>

  <!-- Person Search -->
  <input
    class="search"
    type="search"
    placeholder="{$t('tab_people')}…"
    bind:value={searchQuery}
    on:input={onSearch}
    list="people-list"
  />

  <!-- Creator Search -->
  <input
    class="search creator-filter"
    type="search"
    placeholder="{$t('tab_creators')}…"
    bind:value={creatorQuery}
    on:input={onCreatorSearch}
  />

  <!-- Path / Text Search -->
  <div class="search-wrap">
    <input
      class="search path-filter"
      type="search"
      placeholder="{$t('tab_search')}…"
      bind:value={pathQuery}
      on:input={onPathSearch}
    />
    <button class="search-opts-btn" on:click={() => showSearchOpts = !showSearchOpts} title="Search Options">
      {showSearchOpts ? '▴' : '▾'}
    </button>
    {#if showSearchOpts}
      <div class="search-opts-dropdown">
        <div class="opt-label">Search in:</div>
        <label><input type="checkbox" checked={searchFieldsArr.includes('filename')} on:change={() => toggleSearchField('filename')} /> Filename</label>
        <label><input type="checkbox" checked={searchFieldsArr.includes('path')} on:change={() => toggleSearchField('path')} /> Path</label>
        <label><input type="checkbox" checked={searchFieldsArr.includes('description')} on:change={() => toggleSearchField('description')} /> AI Description</label>
        <label><input type="checkbox" checked={searchFieldsArr.includes('creator')} on:change={() => toggleSearchField('creator')} /> Creator</label>
        <label><input type="checkbox" checked={searchFieldsArr.includes('copyright')} on:change={() => toggleSearchField('copyright')} /> Copyright</label>
      </div>
    {/if}
  </div>

  <div class="mode-switch" title="View mode">
    <button class:active={$galleryMode === 'grid'} on:click={() => galleryMode.set('grid')} title="Grid view">⊞</button>
    <button class:active={$galleryMode === 'table'} on:click={() => galleryMode.set('table')} title="List view">☰</button>
  </div>

  {#if $clipboard}
    <button class="primary" on:click={handlePaste}>📋 Paste ({$clipboard.items.length})</button>
  {/if}

  <!-- Sort -->
  <select bind:value={$sortBy}>
    {#each sortOptions as opt}
      <option value={opt.value}>{opt.label}</option>
    {/each}
  </select>

  <!-- Clear filters -->
  {#if $activeFilterCount > 0}
    <button on:click={clearFilters}>Clear ({$activeFilterCount})</button>
  {/if}

  <!-- Thumb size slider — only functional in grid mode -->
  <label class="size-label" class:disabled={$galleryMode !== 'grid'} title={$galleryMode !== 'grid' ? 'Thumbnail size (grid mode only)' : 'Thumbnail size'}>
    <span class="size-lbl">Size</span>
    <input
      type="range" min="100" max="400" step="10"
      bind:value={$thumbSize}
      disabled={$galleryMode !== 'grid'}
    />
  </label>

  <!-- Loading indicator -->
  {#if $galleryLoading}
    <span class="loading-dot">●</span>
  {/if}
</header>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: #16161f;
    border-bottom: 1px solid #2a2a3a;
    min-height: 42px;
  }
  .brand { font-size: 18px; flex-shrink: 0; }
  .search {
    flex: 1;
    max-width: 160px;
    padding: 5px 10px;
    border-radius: 16px;
  }
  .creator-filter {
    max-width: 120px;
    background: #1a2a1a;
    border-color: #2a4a2a;
  }
  .path-filter {
    max-width: 180px;
    background: #1a1a2a;
    border-color: #2a2a4a;
    border-radius: 16px 0 0 16px;
  }
  .search-wrap { display: flex; align-items: center; position: relative; }
  .search-opts-btn {
    background: #1a1a2a;
    border: 1px solid #2a2a4a;
    border-left: none;
    border-radius: 0 16px 16px 0;
    padding: 4px 8px;
    color: #6080a0;
    font-size: 10px;
    height: 27px;
    cursor: pointer;
  }
  .search-opts-btn:hover { background: #2a2a42; color: #a0c4ff; }
  .search-opts-dropdown {
    position: absolute;
    top: 100%;
    right: 0;
    background: #1a1a2e;
    border: 1px solid #3a3a5a;
    border-radius: 8px;
    padding: 10px;
    z-index: 100;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 140px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    margin-top: 4px;
  }
  .search-opts-dropdown label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: #b0b8d0;
    cursor: pointer;
  }
  .search-opts-dropdown .opt-label { font-size: 10px; color: #506080; text-transform: uppercase; font-weight: bold; margin-bottom: 2px; }

  .mode-switch {
    display: flex;
    background: #2a2a42;
    border-radius: 4px;
    overflow: hidden;
  }
  .mode-switch button {
    background: transparent;
    padding: 4px 10px;
    border-radius: 0;
    font-size: 16px;
    color: #8090b8;
  }
  .mode-switch button.active {
    background: #4a6fa5;
    color: white;
  }
  select { padding: 4px 8px; }
  .size-label {
    display: flex;
    align-items: center;
    gap: 4px;
    transition: opacity 0.2s;
  }
  .size-lbl {
    font-size: 10px;
    color: #505070;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    flex-shrink: 0;
  }
  .size-label.disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }
  .size-label input[type=range] {
    width: 80px;
    padding: 0;
    border: none;
    background: transparent;
    cursor: pointer;
    accent-color: #6080c0;
  }
  .size-label.disabled input[type=range] {
    cursor: not-allowed;
  }
  .loading-dot {
    color: #6080c0;
    animation: pulse 0.8s infinite alternate;
    font-size: 10px;
  }
  @keyframes pulse { from { opacity: 0.3; } to { opacity: 1; } }
</style>
