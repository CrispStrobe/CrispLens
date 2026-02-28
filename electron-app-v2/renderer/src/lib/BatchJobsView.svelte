<script>
  import { onMount, onDestroy } from 'svelte';
  import { t } from '../stores.js';
  import {
    listBatchJobs, getBatchJob, deleteBatchJob, cancelBatchJob,
    fetchBatchJobLogs, startBatchJob,
  } from '../api.js';

  // ── State ──────────────────────────────────────────────────────────────────
  let jobs = [];
  let loading = true;
  let pollInterval = null;

  // Per-job live progress override while SSE is active
  let liveProgress = {};  // { [job_id]: jobData }
  let activeSSE = {};     // { [job_id]: { close() } }

  // Logs modal
  let logsJob = null;
  let logsEntries = [];
  let logsTotal = 0;
  let logsOffset = 0;
  let logsLimit = 100;
  let logsLoading = false;

  // Error feedback
  let actionError = '';

  // ── Load & poll ────────────────────────────────────────────────────────────
  async function loadJobs() {
    try {
      jobs = await listBatchJobs();
    } catch (e) {
      actionError = e.message;
    } finally {
      loading = false;
    }
  }

  function hasRunning(jobs) {
    return jobs.some(j => j.status === 'running' || j.status === 'pending');
  }

  onMount(() => {
    loadJobs();
    pollInterval = setInterval(() => {
      if (hasRunning(jobs)) loadJobs();
    }, 5000);
  });

  onDestroy(() => {
    clearInterval(pollInterval);
    Object.values(activeSSE).forEach(s => s.close());
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  function statusLabel(status) {
    const map = {
      pending:   $t('bj_status_pending'),
      running:   $t('bj_status_running'),
      paused:    $t('bj_status_paused'),
      cancelled: $t('bj_status_cancelled'),
      done:      $t('bj_status_done'),
      error:     $t('bj_status_error'),
    };
    return map[status] || status;
  }

  function statusClass(status) {
    const map = {
      pending:   'st-pending',
      running:   'st-running',
      paused:    'st-paused',
      cancelled: 'st-cancelled',
      done:      'st-done',
      error:     'st-error',
    };
    return map[status] || '';
  }

  function pct(job) {
    if (!job.total_count) return 0;
    return Math.round((job.done_count + job.error_count) / job.total_count * 100);
  }

  function effectiveJob(job) {
    return liveProgress[job.id] || job;
  }

  function fmt(dateStr) {
    if (!dateStr) return '—';
    try {
      return new Date(dateStr + 'Z').toLocaleString();
    } catch {
      return dateStr;
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  async function startJob(job) {
    actionError = '';
    if (activeSSE[job.id]) return;  // already streaming

    const sse = startBatchJob(job.id, data => {
      liveProgress = { ...liveProgress, [job.id]: data };
      if (['done', 'cancelled', 'error'].includes(data.status)) {
        sse.close();
        delete activeSSE[job.id];
        activeSSE = { ...activeSSE };
        loadJobs();
      }
    });
    activeSSE = { ...activeSSE, [job.id]: sse };

    // Optimistically mark as running in the list
    jobs = jobs.map(j => j.id === job.id ? { ...j, status: 'running' } : j);
  }

  async function cancelJob(job) {
    if (!confirm($t('bj_cancel_confirm'))) return;
    actionError = '';
    try {
      await cancelBatchJob(job.id);
      activeSSE[job.id]?.close();
      delete activeSSE[job.id];
      activeSSE = { ...activeSSE };
      await loadJobs();
    } catch (e) {
      actionError = e.message;
    }
  }

  async function deleteJob(job) {
    if (!confirm($t('bj_delete_confirm'))) return;
    actionError = '';
    try {
      await deleteBatchJob(job.id);
      jobs = jobs.filter(j => j.id !== job.id);
      delete liveProgress[job.id];
      liveProgress = { ...liveProgress };
    } catch (e) {
      actionError = e.message;
    }
  }

  async function openLogs(job) {
    logsJob = job;
    logsEntries = [];
    logsOffset = 0;
    logsTotal = 0;
    await loadLogs();
  }

  function closeLogs() { logsJob = null; }

  async function loadLogs() {
    if (!logsJob) return;
    logsLoading = true;
    try {
      const res = await fetchBatchJobLogs(logsJob.id, { limit: logsLimit, offset: logsOffset });
      logsEntries = res.entries;
      logsTotal   = res.total;
    } catch (e) {
      actionError = e.message;
    } finally {
      logsLoading = false;
    }
  }

  function downloadLogs() {
    if (!logsEntries.length) return;
    const rows = [['filepath', 'status', 'error_msg', 'processed_at']];
    logsEntries.forEach(e => rows.push([e.filepath, e.status, e.error_msg || '', e.processed_at || '']));
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), {
      href: url,
      download: `batch_job_${logsJob.id}_errors.csv`,
    });
    a.click();
    URL.revokeObjectURL(url);
  }
</script>

<div class="bj-view">
  <div class="bj-header">
    <h2>{$t('bj_title')}</h2>
    {#if actionError}
      <span class="action-error">{actionError}</span>
    {/if}
  </div>

  {#if loading}
    <div class="bj-empty">{$t('loading') || 'Loading…'}</div>
  {:else if jobs.length === 0}
    <div class="bj-empty">
      <p>{$t('bj_no_jobs')}</p>
      <p class="hint">{$t('bj_no_jobs_hint')}</p>
    </div>
  {:else}
    <div class="bj-table-wrap">
      <table class="bj-table">
        <thead>
          <tr>
            <th>{$t('bj_name')}</th>
            <th>{$t('bj_source')}</th>
            <th>Status</th>
            <th>{$t('bj_progress')}</th>
            <th>{$t('bj_errors')}</th>
            <th>{$t('bj_created')}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each jobs as job (job.id)}
            {@const ej = effectiveJob(job)}
            <tr class="bj-row" class:is-running={ej.status === 'running'}>
              <td class="col-name">
                {ej.name || '—'}
                {#if ej.username}<span class="owner-hint">({ej.username})</span>{/if}
              </td>
              <td class="col-source" title={ej.source_path}>{ej.source_path?.split('/').pop() ?? '—'}</td>
              <td>
                <span class="status-badge {statusClass(ej.status)}">{statusLabel(ej.status)}</span>
              </td>
              <td class="col-progress">
                <div class="prog-bar-wrap">
                  <div class="prog-bar" style="width:{pct(ej)}%"></div>
                </div>
                <span class="prog-label">{ej.done_count}/{ej.total_count}</span>
              </td>
              <td class="col-errors">
                {#if ej.error_count > 0}
                  <span class="err-count">{ej.error_count}</span>
                {:else}—{/if}
              </td>
              <td class="col-created">{fmt(ej.created_at)}</td>
              <td class="col-actions">
                {#if ej.status === 'pending' || ej.status === 'paused'}
                  <button class="act-btn start" on:click={() => startJob(job)}>
                    {ej.status === 'paused' ? $t('bj_resume') : $t('bj_start')}
                  </button>
                {/if}
                {#if ej.status === 'running'}
                  <button class="act-btn cancel" on:click={() => cancelJob(job)}>{$t('bj_cancel')}</button>
                {/if}
                {#if ej.status !== 'running'}
                  <button class="act-btn logs" on:click={() => openLogs(job)}>{$t('bj_view_logs')}</button>
                  <button class="act-btn delete" on:click={() => deleteJob(job)}>{$t('bj_delete')}</button>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<!-- Logs modal -->
{#if logsJob}
  <div class="modal-overlay" on:click|self={closeLogs} role="dialog" aria-modal="true">
    <div class="modal-box">
      <div class="modal-header">
        <h3>{$t('bj_logs_title')} — {logsJob.name || logsJob.id}</h3>
        <div class="modal-hdr-actions">
          <button class="act-btn logs" on:click={downloadLogs} disabled={!logsEntries.length}>
            {$t('bj_logs_save')}
          </button>
          <button class="close-btn" on:click={closeLogs}>✕</button>
        </div>
      </div>

      {#if logsLoading}
        <div class="logs-empty">{$t('loading') || 'Loading…'}</div>
      {:else if logsEntries.length === 0}
        <div class="logs-empty">{$t('bj_logs_empty')}</div>
      {:else}
        <div class="logs-list">
          {#each logsEntries as entry}
            <div class="log-row">
              <span class="log-path" title={entry.filepath}>{entry.filepath.split('/').pop()}</span>
              <span class="log-msg">{entry.error_msg || entry.skip_reason || '—'}</span>
              <span class="log-time">{fmt(entry.processed_at)}</span>
            </div>
          {/each}
        </div>
        {#if logsTotal > logsLimit}
          <div class="logs-pagination">
            {logsOffset + 1}–{Math.min(logsOffset + logsLimit, logsTotal)} / {logsTotal}
            {#if logsOffset > 0}
              <button on:click={() => { logsOffset = Math.max(0, logsOffset - logsLimit); loadLogs(); }}>←</button>
            {/if}
            {#if logsOffset + logsLimit < logsTotal}
              <button on:click={() => { logsOffset += logsLimit; loadLogs(); }}>→</button>
            {/if}
          </div>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .bj-view {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .bj-header {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
  }
  h2 { font-size: 1rem; color: #c0c8e0; margin: 0; }
  .action-error { font-size: 11px; color: #c05050; }

  .bj-empty {
    text-align: center;
    color: #6070a0;
    padding: 40px 20px;
    font-size: 13px;
  }
  .bj-empty .hint { font-size: 11px; color: #404060; margin-top: 6px; }

  .bj-table-wrap { overflow-x: auto; }
  .bj-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    color: #b0b8d0;
  }
  .bj-table th {
    text-align: left;
    padding: 6px 10px;
    border-bottom: 1px solid #2a2a3a;
    color: #6070a0;
    font-weight: 500;
    white-space: nowrap;
  }
  .bj-table td { padding: 7px 10px; border-bottom: 1px solid #1a1a2a; vertical-align: middle; }
  .bj-row:hover td { background: #181826; }
  .bj-row.is-running td { background: #121830; }

  .col-name { max-width: 160px; }
  .col-source { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #606888; }
  .col-created { white-space: nowrap; color: #606888; font-size: 11px; }
  .col-actions { white-space: nowrap; }
  .owner-hint { font-size: 10px; color: #506070; margin-left: 4px; }

  /* Status badges */
  .status-badge {
    font-size: 10px;
    padding: 2px 7px;
    border-radius: 10px;
    white-space: nowrap;
  }
  .st-pending   { background: #252540; color: #606090; }
  .st-running   { background: #1e2e50; color: #6090d0; }
  .st-paused    { background: #2a2a20; color: #a0a050; }
  .st-cancelled { background: #2a2020; color: #907070; }
  .st-done      { background: #1a3a1a; color: #50b050; }
  .st-error     { background: #3a1a1a; color: #c05050; }

  /* Progress */
  .col-progress { display: flex; flex-direction: column; gap: 2px; min-width: 100px; }
  .prog-bar-wrap { height: 4px; background: #1e1e2e; border-radius: 2px; overflow: hidden; }
  .prog-bar { height: 100%; background: #3060a0; border-radius: 2px; transition: width 0.5s; }
  .prog-label { font-size: 10px; color: #606880; }

  .col-errors .err-count { color: #c05050; }

  /* Action buttons */
  .act-btn {
    font-size: 10px;
    padding: 3px 8px;
    border-radius: 4px;
    cursor: pointer;
    margin-right: 4px;
    border: 1px solid;
  }
  .act-btn.start  { background: #1e3a1e; border-color: #3a6a3a; color: #70c070; }
  .act-btn.cancel { background: #3a1e1e; border-color: #6a3a3a; color: #d07070; }
  .act-btn.delete { background: #2a1a1a; border-color: #5a2828; color: #c06060; }
  .act-btn.logs   { background: #1e1e3a; border-color: #3a3a6a; color: #7090c0; }
  .act-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  /* Modal */
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
  }
  .modal-box {
    background: #1a1a2e;
    border: 1px solid #3a3a5a;
    border-radius: 10px;
    padding: 20px;
    width: min(720px, 90vw);
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
  }
  .modal-header h3 { font-size: 13px; color: #c0c8e0; margin: 0; }
  .modal-hdr-actions { display: flex; align-items: center; gap: 8px; }
  .close-btn {
    background: none;
    border: none;
    color: #6070a0;
    font-size: 14px;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .close-btn:hover { color: #c05050; }

  .logs-empty { color: #606080; font-size: 12px; text-align: center; padding: 20px; }
  .logs-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    overflow-y: auto;
    flex: 1;
  }
  .log-row {
    display: grid;
    grid-template-columns: 1fr 2fr auto;
    gap: 8px;
    padding: 5px 8px;
    background: #12121e;
    border-radius: 4px;
    font-size: 11px;
    align-items: start;
  }
  .log-path { color: #8090b0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .log-msg  { color: #c07070; word-break: break-word; }
  .log-time { color: #404060; white-space: nowrap; font-size: 10px; }

  .logs-pagination {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: #606080;
    flex-shrink: 0;
  }
  .logs-pagination button {
    padding: 2px 8px;
    font-size: 11px;
    background: #1e1e3a;
    border: 1px solid #3a3a5a;
    color: #8090c0;
    border-radius: 4px;
    cursor: pointer;
  }
</style>
