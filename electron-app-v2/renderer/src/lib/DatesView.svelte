<script>
  import { onMount } from 'svelte';
  import { fetchDatesStats } from '../api.js';
  import { sidebarView, filters, t } from '../stores.js';

  let months = [];
  let loading = true;

  onMount(async () => {
    try {
      months = await fetchDatesStats();
    } catch (e) {
      console.error(e);
    } finally {
      loading = false;
    }
  });

  function selectMonth(month) {
    const from = month + '-01';
    // Find last day of month
    const [y, m] = month.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const to = `${month}-${lastDay}`;
    
    filters.update(f => ({ ...f, dateFrom: from, dateTo: to }));
    sidebarView.set('all');
  }
</script>

<div class="dates-view">
  <h2>📅 {$t('tab_timeline')} ({months.length} {$t('of')})</h2>

  {#if loading}
    <div class="loading">{$t('loading')}</div>
  {:else if months.length === 0}
    <div class="empty">{$t('no_results_found')}</div>
  {:else}
    <div class="date-grid">
      {#each months as m}
        <button class="date-card" on:click={() => selectMonth(m.month)}>
          <span class="month-name">{m.month}</span>
          <span class="count">{m.count}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .dates-view { flex: 1; overflow-y: auto; padding: 20px; }
  h2 { font-size: 1.1rem; color: #c0c8e0; margin-bottom: 20px; }
  .date-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; }
  .date-card {
    background: #1a1a28;
    border: 1px solid #2a2a3a;
    border-radius: 6px;
    padding: 15px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    transition: all 0.15s;
    cursor: pointer;
    color: #e0e0e0;
  }
  .date-card:hover { border-color: #6080c0; background: #22223a; transform: translateY(-2px); }
  .month-name { color: #c0c8e0; font-size: 14px; font-weight: 600; }
  .count { color: #8090b8; font-size: 11px; }
  .loading, .empty { color: #404060; padding: 40px; text-align: center; }
</style>
