<script>
  import { onMount } from 'svelte';
  import { fetchCreatorsStats } from '../api.js';
  import { sidebarView, filters, t } from '../stores.js';

  let creators = [];
  let loading = true;

  onMount(async () => {
    try {
      creators = await fetchCreatorsStats();
    } catch (e) {
      console.error(e);
    } finally {
      loading = false;
    }
  });

  function selectCreator(name) {
    filters.update(f => ({ ...f, creator: name, person: '', tag: '', scene: '', folder: '', path: '', dateFrom: '', dateTo: '' }));
    sidebarView.set('all');
  }
</script>

<div class="creators-view">
  <h2>✍️ {$t('tab_creators')} ({creators.length})</h2>

  {#if loading}
    <div class="loading">{$t('loading')}</div>
  {:else if creators.length === 0}
    <div class="empty">{$t('no_results_found')}</div>
  {:else}
    <div class="creator-grid">
      {#each creators as c}
        <button class="creator-card" on:click={() => selectCreator(c.name)}>
          <span class="creator-name">{c.name}</span>
          <span class="creator-count">{c.count}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .creators-view { flex: 1; overflow-y: auto; padding: 20px; }
  h2 { font-size: 1.1rem; color: #c0c8e0; margin-bottom: 20px; }
  .creator-grid { display: flex; flex-wrap: wrap; gap: 10px; }
  .creator-card {
    background: #1a1a28;
    border: 1px solid #2a2a3a;
    border-radius: 6px;
    padding: 10px 15px;
    display: flex;
    align-items: center;
    gap: 10px;
    transition: all 0.15s;
    cursor: pointer;
    color: #e0e0e0;
  }
  .creator-card:hover { border-color: #6080c0; background: #22223a; transform: translateY(-2px); }
  .creator-name { color: #c0c8e0; font-size: 13px; font-weight: 500; }
  .creator-count { background: #2e2e50; color: #8090b8; font-size: 11px; padding: 1px 6px; border-radius: 8px; }
  .loading, .empty { color: #404060; padding: 40px; text-align: center; }
</style>
