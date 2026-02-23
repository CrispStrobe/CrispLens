<script>
  import { onMount } from 'svelte';
  import { fetchFoldersStats } from '../api.js';
  import { sidebarView, filters, t } from '../stores.js';

  let folders = [];
  let loading = true;

  onMount(async () => {
    try {
      folders = await fetchFoldersStats();
    } catch (e) {
      console.error(e);
    } finally {
      loading = false;
    }
  });

  function selectFolder(folderPath) {
    filters.set({ person: '', tag: '', scene: '', path: '', dateFrom: '', dateTo: '', folder: folderPath });
    sidebarView.set('all');
  }
</script>

<div class="folders-view">
  <h2>📁 {$t('tab_folders')} ({folders.length})</h2>

  {#if loading}
    <div class="loading">{$t('loading')}</div>
  {:else if folders.length === 0}
    <div class="empty">{$t('no_results_found')}</div>
  {:else}
    <div class="folder-list">
      {#each folders as f}
        <button class="folder-row" on:click={() => selectFolder(f.name)}>
          <span class="icon">📁</span>
          <span class="name">{f.name}</span>
          <span class="count">{f.count} {$t('stats_total_images')}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .folders-view { flex: 1; overflow-y: auto; padding: 20px; }
  h2 { font-size: 1.1rem; color: #c0c8e0; margin-bottom: 20px; }
  .folder-list { display: flex; flex-direction: column; gap: 4px; }
  .folder-row {
    background: #1a1a28;
    border: 1px solid #2a2a3a;
    border-radius: 6px;
    padding: 10px 15px;
    display: flex;
    align-items: center;
    gap: 12px;
    transition: all 0.15s;
    cursor: pointer;
    text-align: left;
    color: #e0e0e0;
  }
  .folder-row:hover { border-color: #6080c0; background: #22223a; }
  .icon { font-size: 16px; }
  .name { flex: 1; font-size: 13px; color: #c0c8e0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .count { background: #2e2e50; color: #8090b8; font-size: 11px; padding: 1px 6px; border-radius: 8px; }
  .loading, .empty { color: #404060; padding: 40px; text-align: center; }
</style>
