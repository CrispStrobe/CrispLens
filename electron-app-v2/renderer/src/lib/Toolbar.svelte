<script>
  import { filters, sortBy, thumbSize, galleryImages, galleryLoading, activeFilterCount, sidebarView, galleryMode, t, currentUser, galleryRefreshTick } from '../stores.js';
  import { fetchImages } from '../api.js';
  import { onMount, onDestroy } from 'svelte';

  let searchQuery = '';
  let pathQuery = '';

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

  function clearFilters() {
    searchQuery = '';
    pathQuery   = '';
    filters.set({ person: '', tag: '', scene: '', folder: '', path: '', dateFrom: '', dateTo: '' });
  }

  let unsubFilters, unsubSort, unsubUser, unsubTick;

  onMount(() => {
    // Single authoritative initial load (may fail with 401 if not yet logged in — that's fine)
    loadGallery();

    // Subscribe AFTER the initial load to avoid a duplicate immediate call.
    // Svelte store.subscribe fires synchronously with the current value —
    // skip that first emission with the `first` flag.
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

    // Reload gallery when the user logs in (currentUser goes from null → object)
    let uFirst = true;
    unsubUser = currentUser.subscribe(u => {
      if (uFirst) { uFirst = false; return; }
      if (u) scheduleLoad(200);   // logged in → reload with auth cookie
      else galleryImages.set([]);  // logged out → clear
    });

    // Reload gallery when an upload/ingest completes
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

  <!-- Search -->
  <input
    class="search"
    type="search"
    placeholder="{$t('search_name')}"
    bind:value={searchQuery}
    on:input={onSearch}
    list="people-list"
  />

  <input
    class="search path-filter"
    type="search"
    placeholder="Path / Filename…"
    bind:value={pathQuery}
    on:input={onPathSearch}
  />

  <div class="mode-switch">
    <button class:active={$galleryMode === 'grid'} on:click={() => galleryMode.set('grid')}>⊞</button>
    <button class:active={$galleryMode === 'table'} on:click={() => galleryMode.set('table')}>≡</button>
  </div>

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

  <!-- Thumb size slider -->
  <label class="size-label">
    <span>⊞</span>
    <input
      type="range" min="100" max="400" step="10"
      bind:value={$thumbSize}
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
    max-width: 240px;
    padding: 5px 10px;
    border-radius: 16px;
  }
  .path-filter {
    max-width: 180px;
    background: #1a1a2a;
    border-color: #2a2a4a;
  }
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
    gap: 6px;
    color: #7080a0;
    font-size: 16px;
  }
  .size-label input[type=range] {
    width: 90px;
    padding: 0;
    border: none;
    background: transparent;
    cursor: pointer;
    accent-color: #6080c0;
  }
  .loading-dot {
    color: #6080c0;
    animation: pulse 0.8s infinite alternate;
    font-size: 10px;
  }
  @keyframes pulse { from { opacity: 0.3; } to { opacity: 1; } }
</style>
