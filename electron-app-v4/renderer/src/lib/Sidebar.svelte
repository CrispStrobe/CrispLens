<script>
  import { sidebarView, sidebarCollapsed, navCollapsed, importCollapsed, statsCollapsed, allPeople, allTags, allAlbums, stats, t, filters, showLegalModal } from '../stores.js';
  import { fetchStats, fetchPeople, fetchTags } from '../api.js';

  $: navItems = [
    { id: 'all',      icon: '📷', label: $t('tab_browse') },
    { id: 'albums',   icon: '📚', label: $t('tab_albums') },
    { id: 'events',   icon: '🗓', label: $t('tab_events') },
    { id: 'people',   icon: '👤', label: $t('tab_people') },
    { id: 'tags',     icon: '🏷', label: $t('tab_tags') },
    { id: 'creators', icon: '✍️', label: $t('tab_creators') },
    { id: 'dates',    icon: '📅', label: $t('tab_timeline') },
    { id: 'folders',  icon: '📁', label: $t('tab_folders') },
  ];

  $: workItems = [
    { id: 'process',    icon: '⚙', label: $t('tab_batch') },
    { id: 'batchjobs',  icon: '📋', label: $t('tab_batchjobs') },
    { id: 'identify',      icon: '🔍', label: $t('tab_identify') },
    { id: 'generate',      icon: '✨', label: $t('tab_generate') },
    { id: 'faceclusters',  icon: '🫂', label: $t('tab_faceclusters') },
    { id: 'filesystem',    icon: '💾', label: $t('tab_filesystem') },
    { id: 'watchfolders',  icon: '📡', label: $t('tab_watchfolders') },
    { id: 'duplicates',    icon: '🔁', label: $t('tab_duplicates') },
    { id: 'clouddrives',   icon: '☁️', label: $t('cloud_drives') },
    { id: 'train',      icon: '🎓', label: $t('tab_train') },
  ];

  $: toolItems = [
    { id: 'settings',   icon: '⚙', label: $t('tab_settings') },
  ];

  $: browseItem = navItems[0];
  $: otherNavItems = navItems.slice(1);
  $: primaryWorkItems = workItems.slice(0, 1);
  $: secondaryWorkItems = workItems.slice(1);

  async function refreshStats() {
    try { stats.set(await fetchStats()); } catch {}
    try { allPeople.set(await fetchPeople()); } catch {}
    try { allTags.set(await fetchTags()); } catch {}
  }

  function handleNavClick(id) {
    if (id === 'all') {
      filters.set({
        person: '', tag: '', scene: '', folder: '', path: '',
        dateFrom: '', dateTo: '', creator: '',
        searchFields: 'filename,path,description'
      });
    }
    sidebarView.set(id);
  }
</script>

<aside class="sidebar" class:collapsed={$sidebarCollapsed}>
  <!-- NAVIGATION SECTION -->
  <div class="section-label">{$sidebarCollapsed ? '' : $t('tab_browse')}</div>
  
  <button
    class="nav-item"
    class:active={$sidebarView === browseItem.id}
    on:click={() => handleNavClick(browseItem.id)}
    title={$sidebarCollapsed ? browseItem.label : ''}
  >
    <span class="icon">{browseItem.icon}</span>
    {#if !$sidebarCollapsed}<span class="label">{browseItem.label}</span>{/if}
  </button>

  {#if !$sidebarCollapsed}
    <div class="section-label-collapsable" on:click={() => navCollapsed.update(v => !v)}>
      <span>{$t('filter_options')}</span>
      <span class="chevron">{$navCollapsed ? '▸' : '▾'}</span>
    </div>
  {/if}

  {#if !$navCollapsed || $sidebarCollapsed}
    {#each otherNavItems as item}
      <button
        class="nav-item"
        class:active={$sidebarView === item.id}
        on:click={() => handleNavClick(item.id)}
        title={$sidebarCollapsed ? item.label : ''}
      >
        <span class="icon">{item.icon}</span>
        {#if !$sidebarCollapsed}
          <span class="label">{item.label}</span>
          {#if item.id === 'albums' && $allAlbums.length}
            <span class="badge">{$allAlbums.length}</span>
          {/if}
          {#if item.id === 'people' && $allPeople.length}
            <span class="badge">{$allPeople.length}</span>
          {/if}
          {#if item.id === 'tags' && $allTags.length}
            <span class="badge">{$allTags.length}</span>
          {/if}
        {/if}
      </button>
    {/each}
  {/if}

  <div class="divider"></div>

  <!-- IMPORT / TOOLS SECTION -->
  {#if !$sidebarCollapsed}<div class="section-label">{$t('tab_ingest')}</div>{/if}
  
  {#each primaryWorkItems as item}
    <button
      class="nav-item"
      class:active={$sidebarView === item.id}
      on:click={() => sidebarView.set(item.id)}
      title={$sidebarCollapsed ? item.label : ''}
    >
      <span class="icon">{item.icon}</span>
      {#if !$sidebarCollapsed}<span class="label">{item.label}</span>{/if}
    </button>
  {/each}

  {#if !$sidebarCollapsed}
    <div class="section-label-collapsable" on:click={() => importCollapsed.update(v => !v)}>
      <span>{$t('import_options')}</span>
      <span class="chevron">{$importCollapsed ? '▸' : '▾'}</span>
    </div>
  {/if}

  {#if !$importCollapsed || $sidebarCollapsed}
    {#each secondaryWorkItems as item}
      <button
        class="nav-item"
        class:active={$sidebarView === item.id}
        on:click={() => sidebarView.set(item.id)}
        title={$sidebarCollapsed ? item.label : ''}
      >
        <span class="icon">{item.icon}</span>
        {#if !$sidebarCollapsed}<span class="label">{item.label}</span>{/if}
      </button>
    {/each}
  {/if}

  <div class="divider"></div>

  <!-- SETTINGS -->
  {#if !$sidebarCollapsed}<div class="section-label">{$t('tab_settings')}</div>{/if}
  {#each toolItems as item}
    <button
      class="nav-item"
      class:active={$sidebarView === item.id}
      on:click={() => sidebarView.set(item.id)}
      title={$sidebarCollapsed ? item.label : ''}
    >
      <span class="icon">{item.icon}</span>
      {#if !$sidebarCollapsed}<span class="label">{item.label}</span>{/if}
    </button>
  {/each}

  <!-- STATS SECTION -->
  {#if !$sidebarCollapsed}
    <div class="divider"></div>
    <div class="stat-block">
      <div class="stat-header" on:click={() => statsCollapsed.update(v => !v)} style="cursor: pointer;">
        <span class="section-label">
          {$t('stats_overview')} 
          <small>({$stats.total_images ?? 0}|{$stats.total_people ?? 0}|{$stats.total_faces ?? 0})</small>
        </span>
        <span class="chevron">{$statsCollapsed ? '▸' : '▾'}</span>
      </div>
      
      {#if !$statsCollapsed}
        <div class="stat-content">
          <div class="stat"><span>{$stats.total_images ?? '—'}</span> {$t('stats_total_images')}</div>
          <div class="stat"><span>{$stats.total_people ?? '—'}</span> {$t('stats_total_people')}</div>
          <div class="stat"><span>{$stats.total_faces ?? '—'}</span> {$t('stats_total_faces')}</div>
          <button class="refresh-mini" on:click|stopPropagation={refreshStats} title={$t('refresh')}>{$t('refresh')} 🔄</button>
        </div>
      {/if}
    </div>
  {/if}

  <button
    class="nav-item legal-nav-item"
    on:click={() => showLegalModal.set(true)}
    title={$sidebarCollapsed ? $t('tab_about') : ''}
  >
    <span class="icon">ℹ️</span>
    {#if !$sidebarCollapsed}<span class="label">{$t('tab_about')}</span>{/if}
  </button>

  <!-- Collapse toggle button at the bottom -->
  <button
    class="collapse-btn"
    on:click={() => sidebarCollapsed.update(v => !v)}
    title={$sidebarCollapsed ? $t('sidebar_expand') : $t('sidebar_collapse')}
  >
    {$sidebarCollapsed ? '›' : '‹'}
  </button>
</aside>

<style>
  .sidebar {
    width: 180px;
    min-width: 180px;
    background: #16161f;
    border-right: 1px solid #2a2a3a;
    padding: 8px 0;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    overflow-x: hidden;
    user-select: none;
    transition: width 0.18s ease, min-width 0.18s ease;
    flex-shrink: 0;
  }
  .sidebar.collapsed {
    width: 44px;
    min-width: 44px;
  }
  .section-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #505070;
    padding: 8px 12px 4px;
    white-space: nowrap;
    overflow: hidden;
  }
  .section-label small {
    text-transform: none;
    letter-spacing: normal;
    opacity: 0.7;
    margin-left: 4px;
  }
  .section-label-collapsable {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #505070;
    padding: 8px 12px 4px;
    white-space: nowrap;
    overflow: hidden;
    display: flex;
    justify-content: space-between;
    align-items: center;
    cursor: pointer;
  }
  .section-label-collapsable:hover { color: #8080a0; }
  .chevron { font-size: 8px; opacity: 0.6; }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 14px;
    background: transparent;
    border-radius: 0;
    font-size: 12.5px;
    color: #b0b0c8;
    text-align: left;
    border: none;
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
    white-space: nowrap;
    overflow: hidden;
  }
  .nav-item:hover { background: #22223a; color: #e0e0f0; }
  .nav-item.active { background: #282845; color: #a0c4ff; font-weight: 600; }
  .legal-nav-item { margin-top: auto; border-top: 1px solid #2a2a3a; padding: 10px 14px; color: #6070a0; }
  .legal-nav-item:hover { color: #a0b0d0; }
  .icon { font-size: 14px; flex-shrink: 0; }
  .label { flex: 1; }
  .badge {
    background: #2e2e50;
    color: #8090b8;
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 8px;
    min-width: 20px;
    text-align: center;
  }
  .divider {
    border-top: 1px solid #2a2a3a;
    margin: 6px 10px;
  }
  .stat-block {
    padding: 4px 14px;
  }
  .stat-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
  .stat-header .section-label { padding: 0; flex: 1; }
  .stat-content {
    margin-top: 4px;
    padding-left: 4px;
  }
  .refresh-mini { 
    background: transparent; 
    border: 1px solid #2a2a3a;
    color: #505070;
    margin-top: 6px;
    padding: 2px 6px; 
    font-size: 9px; 
    border-radius: 4px;
    cursor: pointer;
  }
  .refresh-mini:hover { color: #8090b8; border-color: #404060; background: #1e1e2e; }
  .stat {
    font-size: 11px;
    color: #505070;
    padding: 2px 0;
  }
  .stat span { color: #8090b8; font-weight: 600; }

  /* Collapse toggle — always at the bottom */
  .collapse-btn {
    width: 100%;
    background: transparent;
    border: none;
    border-top: 1px solid #2a2a3a;
    color: #404060;
    font-size: 16px;
    padding: 6px 0;
    cursor: pointer;
    text-align: center;
    transition: color 0.12s, background 0.12s;
    flex-shrink: 0;
  }
  .collapse-btn:hover { color: #a0b0d0; background: #1e1e2e; }
</style>
