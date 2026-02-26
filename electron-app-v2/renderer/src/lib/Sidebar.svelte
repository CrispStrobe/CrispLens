<script>
  import { sidebarView, sidebarCollapsed, allPeople, allTags, allAlbums, stats, t } from '../stores.js';
  import { fetchStats, fetchPeople, fetchTags } from '../api.js';

  $: navItems = [
    { id: 'all',      icon: '📷', label: $t('tab_browse') },
    { id: 'albums',   icon: '📚', label: 'Albums' },
    { id: 'events',   icon: '🗓', label: 'Events' },
    { id: 'people',   icon: '👤', label: $t('tab_people') },
    { id: 'tags',     icon: '🏷', label: $t('tab_tags') },
    { id: 'dates',    icon: '📅', label: $t('tab_timeline') },
    { id: 'folders',  icon: '📁', label: $t('tab_folders') },
  ];
  $: workItems = [
    { id: 'identify',      icon: '🔍', label: 'Identify' },
    { id: 'generate',      icon: '✨', label: $t('tab_generate') },
    { id: 'faceclusters',  icon: '🫂', label: 'Face Clusters' },
    { id: 'filesystem',    icon: '💾', label: 'Filesystem' },
    { id: 'watchfolders',  icon: '📡', label: 'Watch Folders' },
    { id: 'duplicates',    icon: '🔁', label: 'Duplicates' },
    { id: 'clouddrives',   icon: '☁️', label: $t('cloud_drives') },
  ];
  $: toolItems = [
    { id: 'process',  icon: '⚙', label: $t('tab_batch') },
    { id: 'train',    icon: '🎓', label: $t('tab_train') },
    { id: 'settings', icon: '⚙', label: $t('tab_settings') },
  ];

  async function refreshStats() {
    try { stats.set(await fetchStats()); } catch {}
    try { allPeople.set(await fetchPeople()); } catch {}
    try { allTags.set(await fetchTags()); } catch {}
  }
</script>

<aside class="sidebar" class:collapsed={$sidebarCollapsed}>
  <div class="section-label">{$sidebarCollapsed ? '' : $t('tab_browse')}</div>
  {#each navItems as item}
    <button
      class="nav-item"
      class:active={$sidebarView === item.id}
      on:click={() => sidebarView.set(item.id)}
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

  <div class="divider"></div>
  {#if !$sidebarCollapsed}<div class="section-label">Ingest</div>{/if}

  {#each workItems as item}
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

  <div class="divider"></div>
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

  {#if !$sidebarCollapsed}
    <div class="divider"></div>
    <div class="stat-block">
      <div class="stat-header">
        <span class="section-label">{$t('stats_overview')}</span>
        <button class="refresh-mini" on:click={refreshStats} title={$t('refresh')}>🔄</button>
      </div>
      <div class="stat"><span>{$stats.total_images ?? '—'}</span> {$t('stats_total_images')}</div>
      <div class="stat"><span>{$stats.total_people ?? '—'}</span> {$t('stats_total_people')}</div>
      <div class="stat"><span>{$stats.total_faces ?? '—'}</span> {$t('stats_total_faces')}</div>
    </div>
  {/if}

  <!-- Collapse toggle button at the bottom -->
  <button
    class="collapse-btn"
    on:click={() => sidebarCollapsed.update(v => !v)}
    title={$sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
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
  .stat-header .section-label { padding: 0; }
  .refresh-mini { background: transparent; padding: 2px; font-size: 10px; opacity: 0.5; }
  .refresh-mini:hover { opacity: 1; background: #2a2a42; }
  .stat {
    font-size: 11px;
    color: #505070;
    padding: 2px 0;
  }
  .stat span { color: #8090b8; font-weight: 600; }

  /* Collapse toggle — always at the bottom */
  .collapse-btn {
    margin-top: auto;
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
