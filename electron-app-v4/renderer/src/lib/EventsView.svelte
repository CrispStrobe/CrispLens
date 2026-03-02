<script>
  import { onMount } from 'svelte';
  import { filters, sidebarView, t } from '../stores.js';
  import { fetchEvents, thumbnailUrl } from '../api.js';

  // Logarithmic gap steps (hours): 1h to 6d
  const GAP_STEPS = [1, 2, 4, 8, 12, 24, 48, 72, 144];
  let gapIdx = 2;   // default: 4h
  $: gapHours = GAP_STEPS[gapIdx];
  $: gapLabel = formatGap(gapHours);

  let events = [];
  let loading = false;

  // localStorage event titles (keyed by event_id hash)
  let titles = {};

  onMount(() => {
    try { titles = JSON.parse(localStorage.getItem('event_titles') || '{}'); } catch {}
    load();
  });

  async function load() {
    loading = true;
    events = [];
    try {
      events = await fetchEvents(gapHours, 200);
    } catch (e) {
      console.error('fetchEvents error:', e);
    } finally {
      loading = false;
    }
  }

  function formatGap(h) {
    if (h < 24) return `${h}h`;
    return `${h / 24}d`;
  }

  function formatDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch { return iso; }
  }

  function openEvent(ev) {
    // Switch gallery to date range of this event
    filters.update(f => ({
      ...f,
      person: '', tag: '', scene: '', folder: '', path: '',
      dateFrom: ev.start?.slice(0, 10) ?? '',
      dateTo:   ev.end?.slice(0, 10)   ?? '',
    }));
    sidebarView.set('all');
  }

  function saveTitle(evId, val) {
    titles = { ...titles, [evId]: val };
    localStorage.setItem('event_titles', JSON.stringify(titles));
  }
</script>

<div class="events-view">
  <!-- Controls -->
  <div class="header">
    <div class="header-left">
      <h2>{$t('events')}</h2>
      {#if !loading}
        <span class="sub">{events.length} {events.length !== 1 ? $t('events') : $t('event_singular')}</span>
      {/if}
    </div>
    <div class="controls">
      <label>
        {$t('time_gap')}
        <input
          type="range"
          min="0" max={GAP_STEPS.length - 1} step="1"
          bind:value={gapIdx}
          style="width:140px;"
          on:change={load}
        />
        <span class="gap-badge">{gapLabel}</span>
      </label>
      <button on:click={load} title={$t('refresh')}>🔄</button>
    </div>
  </div>

  {#if loading}
    <div class="loading">{$t('grouping_by_time')}</div>
  {:else if events.length === 0}
    <div class="empty">
      <p>{$t('no_events_found')}</p>
    </div>
  {:else}
    <div class="events-list">
      {#each events as ev (ev.event_id)}
        <div class="event-card">
          <!-- Cover -->
          <div class="cover">
            {#if ev.cover_image_id}
              <img src={thumbnailUrl(ev.cover_image_id, 160)} alt="event cover" />
            {:else}
              <div class="cover-placeholder">📷</div>
            {/if}
          </div>

          <!-- Info -->
          <div class="event-info">
            <div class="event-title-row">
              <input
                class="event-title"
                type="text"
                placeholder={$t('event_name_placeholder')}
                value={titles[ev.event_id] ?? ''}
                on:input={e => saveTitle(ev.event_id, e.target.value)}
              />
            </div>
            <div class="event-meta">
              <span class="date">{formatDate(ev.start)}</span>
              {#if ev.start?.slice(0,10) !== ev.end?.slice(0,10)}
                <span class="date-sep">–</span>
                <span class="date">{formatDate(ev.end)}</span>
              {/if}
              <span class="count-chip">{ev.count} {ev.count !== 1 ? $t('photos') : $t('photo')}</span>
            </div>

            <!-- Thumb strip (up to 12 preview images) -->
            <div class="thumb-strip">
              {#each ev.images as img}
                <div class="strip-thumb">
                  <img src={thumbnailUrl(img.id, 56)} alt={img.filename} loading="lazy" />
                  {#if img.face_count > 0}
                    <span class="mini-badge">{img.face_count}</span>
                  {/if}
                </div>
              {/each}
              {#if ev.count > ev.images.length}
                <div class="more-chip">+{ev.count - ev.images.length}</div>
              {/if}
            </div>

            <button class="open-btn primary" on:click={() => openEvent(ev)}>
              {$t('open_event')}
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .events-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    border-bottom: 1px solid #2a2a3a;
    flex-shrink: 0;
    gap: 12px;
    flex-wrap: wrap;
  }
  .header-left { display: flex; align-items: baseline; gap: 8px; }
  .header-left h2 { font-size: 15px; font-weight: 600; color: #c0c8e0; margin: 0; }
  .sub { font-size: 11px; color: #505070; }

  .controls {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .controls label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: #8090b8;
  }
  .gap-badge {
    background: #2e2e50;
    color: #8090b8;
    font-size: 11px;
    padding: 2px 7px;
    border-radius: 8px;
    font-weight: 600;
    min-width: 32px;
    text-align: center;
  }

  .loading, .empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #505070;
    font-size: 13px;
  }

  .events-list {
    flex: 1;
    overflow-y: auto;
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .event-card {
    background: #1a1a2a;
    border: 1px solid #2a2a3a;
    border-radius: 8px;
    padding: 12px;
    display: flex;
    gap: 14px;
    align-items: flex-start;
  }
  .event-card:hover { border-color: #3a3a5a; }

  .cover {
    width: 120px;
    height: 90px;
    border-radius: 6px;
    overflow: hidden;
    background: #111120;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .cover img { width: 100%; height: 100%; object-fit: cover; }
  .cover-placeholder { font-size: 32px; opacity: 0.3; }

  .event-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }

  .event-title-row { display: flex; align-items: center; gap: 8px; }
  .event-title {
    font-size: 13px;
    font-weight: 500;
    background: transparent;
    border: none;
    border-bottom: 1px solid transparent;
    color: #c0c8e0;
    padding: 2px 0;
    width: 100%;
  }
  .event-title:focus {
    border-bottom-color: #6080c0;
    background: transparent;
    outline: none;
  }
  .event-title::placeholder { color: #404060; font-style: italic; }

  .event-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .date { font-size: 11px; color: #8090b8; }
  .date-sep { color: #404060; font-size: 10px; }
  .count-chip {
    background: #2e2e50;
    color: #7080b0;
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 8px;
  }

  .thumb-strip {
    display: flex;
    gap: 4px;
    align-items: center;
    flex-wrap: nowrap;
    overflow: hidden;
  }
  .strip-thumb {
    position: relative;
    width: 48px;
    height: 48px;
    border-radius: 4px;
    overflow: hidden;
    background: #111120;
    flex-shrink: 0;
  }
  .strip-thumb img { width: 100%; height: 100%; object-fit: cover; }
  .mini-badge {
    position: absolute;
    top: 2px;
    right: 2px;
    background: rgba(80,120,200,0.85);
    color: white;
    font-size: 8px;
    padding: 0 3px;
    border-radius: 4px;
    pointer-events: none;
  }
  .more-chip {
    font-size: 11px;
    color: #606080;
    padding: 0 4px;
    flex-shrink: 0;
  }

  .open-btn { font-size: 11px; padding: 4px 10px; border-radius: 4px; align-self: flex-start; margin-top: 2px; }
</style>
