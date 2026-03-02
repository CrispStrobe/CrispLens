<script>
  import { onMount } from 'svelte';
  import { fetchTagsStats } from '../api.js';
  import { sidebarView, filters, t } from '../stores.js';

  let tags = [];
  let loading = true;

  onMount(async () => {
    try {
      tags = await fetchTagsStats();
    } catch (e) {
      console.error(e);
    } finally {
      loading = false;
    }
  });

  function selectTag(tagName) {
    filters.update(f => ({ ...f, tag: tagName }));
    sidebarView.set('all');
  }
</script>

<div class="tags-view">
  <h2>🏷 {$t('tab_tags')} ({tags.length})</h2>

  {#if loading}
    <div class="loading">{$t('loading')}</div>
  {:else if tags.length === 0}
    <div class="empty">{$t('no_results_found')}</div>
  {:else}
    <div class="tag-grid">
      {#each tags as tag}
        <button class="tag-card" on:click={() => selectTag(tag.name)}>
          <span class="tag-name">{tag.name}</span>
          <span class="tag-count">{tag.count}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .tags-view { flex: 1; overflow-y: auto; padding: 20px; }
  h2 { font-size: 1.1rem; color: #c0c8e0; margin-bottom: 20px; }
  .tag-grid { display: flex; flex-wrap: wrap; gap: 10px; }
  .tag-card {
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
  .tag-card:hover { border-color: #6080c0; background: #22223a; transform: translateY(-2px); }
  .tag-name { color: #c0c8e0; font-size: 13px; font-weight: 500; }
  .tag-count { background: #2e2e50; color: #8090b8; font-size: 11px; padding: 1px 6px; border-radius: 8px; }
  .loading, .empty { color: #404060; padding: 40px; text-align: center; }
</style>
