<script>
  import { galleryImages, filters, sortBy, activeFilterCount, stats, t, backgroundTask, modelReady } from '../stores.js';

  $: imageCount = $galleryImages.length;
  $: sortLabel  = $sortBy.replace(/_/g, ' ');
  $: taskPct = $backgroundTask?.total
    ? Math.round($backgroundTask.done / $backgroundTask.total * 100)
    : 0;
</script>

<footer class="status-bar">
  {#if !$modelReady}
    <span class="model-loading">
      <span class="model-dot"></span>
      AI model loading…
    </span>
    <span class="sep">·</span>
  {/if}

  {#if $backgroundTask}
    <span class="bg-task">
      <span class="bg-task-dot"></span>
      {$backgroundTask.label}
      {#if $backgroundTask.total > 0}
        — {$backgroundTask.done}/{$backgroundTask.total} ({taskPct}%)
      {/if}
    </span>
    <span class="sep">·</span>
  {/if}

  <span>{imageCount} {$t('stats_total_images')}</span>

  {#if $stats.total_people}
    <span class="sep">·</span>
    <span>{$stats.total_people} {$t('stats_total_people')}</span>
  {/if}

  {#if $activeFilterCount > 0}
    <span class="sep">·</span>
    <span class="filter-active">{$activeFilterCount} {$t('filter_options')}</span>
    {#if $filters.person}
      <span class="filter-chip">👤 {$filters.person}</span>
    {/if}
    {#if $filters.tag}
      <span class="filter-chip">🏷 {$filters.tag}</span>
    {/if}
    {#if $filters.scene}
      <span class="filter-chip">🎬 {$filters.scene}</span>
    {/if}
  {/if}

  <span class="sep">·</span>
  <span class="sort-label">{$t('sort_by')}: {sortLabel}</span>
</footer>

<style>
  .status-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 12px;
    background: #16161f;
    border-top: 1px solid #2a2a3a;
    font-size: 11px;
    color: #606080;
    min-height: 24px;
    flex-shrink: 0;
  }
  .sep { color: #303050; }
  .filter-active { color: #a0c4ff; }
  .filter-chip {
    background: #252540;
    color: #9090c0;
    padding: 1px 6px;
    border-radius: 8px;
    font-size: 10px;
  }
  .sort-label { color: #505070; margin-left: auto; }

  .bg-task {
    display: flex;
    align-items: center;
    gap: 5px;
    color: #a0c4ff;
    font-size: 11px;
  }
  .bg-task-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #4a9eff;
    animation: blink 1s ease-in-out infinite alternate;
    flex-shrink: 0;
  }
  @keyframes blink { from { opacity: 0.3; } to { opacity: 1; } }

  .model-loading {
    display: flex;
    align-items: center;
    gap: 5px;
    color: #a08040;
    font-size: 11px;
  }
  .model-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #c0a040;
    animation: blink 0.8s ease-in-out infinite alternate;
    flex-shrink: 0;
  }
</style>
