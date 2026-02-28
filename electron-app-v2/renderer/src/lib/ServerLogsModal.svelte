<script>
  import { t } from '../stores.js';
  import { fetchServerLogs, fetchServerLogsJson } from '../api.js';
  import { createEventDispatcher, onMount, tick } from 'svelte';

  export let show = false;

  const dispatch = createEventDispatcher();

  let lines     = [];
  let logPath   = '';
  let loading   = false;
  let error     = '';
  let lineCount = 50;
  let followLog = true;
  let logEl;
  let transport = 'sse'; // 'sse' or 'json'

  $: if (lines && followLog && logEl) tick().then(() => {
    logEl.scrollTop = logEl.scrollHeight;
  });

  async function load() {
    loading = true;
    error   = '';
    lines   = [];
    try {
      if (transport === 'sse') {
        const resp = await fetchServerLogs(lineCount);
        if (!resp.ok) { error = `HTTP ${resp.status}`; return; }
        const reader = resp.body.getReader();
        const dec    = new TextDecoder();
        let   buf    = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split('\n\n');
          buf = parts.pop();
          for (const p of parts) {
            if (!p.startsWith('data: ')) continue;
            const data = p.slice(6);
            if (data.startsWith('[PATH]')) logPath = data.slice(6).trim();
            else if (data === '[DONE]') { /* end */ }
            else if (data.startsWith('[ERROR]')) error = data.slice(7);
            else lines = [...lines, data];
          }
        }
      } else {
        const data = await fetchServerLogsJson(lineCount);
        if (data.error) error = data.error;
        else {
          lines = data.lines || [];
          logPath = data.path || '';
        }
      }
    } catch (e) {
      error = e.message || String(e);
    } finally {
      loading = false;
    }
  }

  function close() {
    show = false;
    dispatch('close');
  }

  // Load when shown
  $: if (show === true) load();

  function handleKey(e) {
    if (e.key === 'Escape') close();
  }
</script>

<svelte:window on:keydown={handleKey} />

{#if show}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <div class="modal-overlay" on:click|self={close}>
    <div class="modal-box">
      <div class="modal-header">
        <div class="header-left">
          <h3>📋 {$t('admin_logs_title')}</h3>
          {#if logPath}<div class="log-path" title={logPath}>{logPath}</div>{/if}
        </div>
        <div class="header-right">
          <label class="follow-toggle" style="margin-right:8px;">
            <select bind:value={transport} on:change={load} style="margin:0;padding:2px 4px;font-size:10px;">
              <option value="sse">Method 1 (SSE)</option>
              <option value="json">Method 2 (JSON)</option>
            </select>
          </label>
          <label class="follow-toggle">
            <input type="checkbox" bind:checked={followLog} />
            {$t('logs_follow')}
          </label>
          <select bind:value={lineCount} on:change={load}>
            <option value={100}>100</option>
            <option value={300}>300</option>
            <option value={500}>500</option>
            <option value={1000}>1000</option>
          </select>
          <button on:click={load} disabled={loading}>
            {loading ? '…' : '🔄 ' + $t('logs_refresh')}
          </button>
          <button class="close-btn" on:click={close}>✕</button>
        </div>
      </div>

      {#if error}
        <div class="error-msg">
          <strong>⚠ {error}</strong>
          {#if !lines.length}
            <div style="margin-top:6px;font-size:10px;opacity:0.8;">
              Tip: check that FACE_REC_DATA_DIR is set in the service environment,
              or set the log path explicitly in config.yaml → logging.file
            </div>
          {/if}
        </div>
      {/if}

      <div class="log-box" bind:this={logEl}>
        {#if loading}
          <div class="loading-hint">{$t('loading')}</div>
        {:else if !lines.length && !error}
          <div class="loading-hint" style="color:#806040;">No log lines found.</div>
        {:else}
          {#each lines as line}
            <div
              class="log-line"
              class:error={line.includes('ERROR') || line.includes('CRITICAL')}
              class:warn={line.includes('WARNING')}
              class:info={line.includes(' INFO ')}
            >{line}</div>
          {/each}
        {/if}
      </div>

      <div class="footer-row">
        <span class="line-count">{lines.length} {$t('logs_refresh') === 'Refresh' ? 'lines' : 'Zeilen'}</span>
        <button on:click={close}>{$t('close')}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-overlay {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center;
    z-index: 2000;
  }
  .modal-box {
    background: #1a1a28;
    border: 1px solid #2a2a3a;
    border-radius: 10px;
    padding: 20px 24px;
    width: min(98vw, 900px);
    height: 80vh;
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-shadow: 0 8px 40px rgba(0,0,0,0.5);
  }
  .modal-header {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 12px;
  }
  .header-left { display: flex; flex-direction: column; gap: 2px; }
  .header-left h3 { margin: 0; font-size: 15px; color: #c0c8e0; font-weight: 600; }
  .log-path { font-size: 10px; color: #505070; font-family: monospace; }

  .header-right {
    display: flex; align-items: center; gap: 8px; flex-shrink: 0;
  }
  .follow-toggle { display: flex; align-items: center; gap: 4px; font-size: 11px; color: #7080a0; cursor: pointer; }
  .follow-toggle input { cursor: pointer; }

  select {
    background: #1e1e2e; border: 1px solid #3a3a5a;
    color: #9090b0; padding: 4px 6px; border-radius: 4px;
    font-size: 11px;
  }

  button {
    background: #2a2a42; color: #8090b8;
    border: 1px solid #3a3a5a; padding: 5px 10px;
    border-radius: 5px; font-size: 11px; cursor: pointer;
    white-space: nowrap;
  }
  button:hover:not(:disabled) { background: #3a3a5a; color: #a0c4ff; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  .close-btn { padding: 4px 8px; font-size: 14px; color: #505070; }

  .log-box {
    flex: 1;
    overflow-y: auto;
    background: #0e0e18;
    border: 1px solid #2a2a3a;
    border-radius: 6px;
    padding: 10px 12px;
    font-family: 'Courier New', monospace;
    font-size: 11px;
    line-height: 1.55;
    color: #c0c8c0;
  }
  .log-line { white-space: pre-wrap; word-break: break-all; }
  .log-line.error  { color: #e07070; }
  .log-line.warn   { color: #d0a040; }
  .log-line.info   { color: #80b0d0; }
  .loading-hint { color: #505070; font-style: italic; }

  .footer-row {
    display: flex; align-items: center; justify-content: space-between;
  }
  .line-count { font-size: 10px; color: #404060; }

  .error-msg {
    font-size: 12px; color: #e07070;
    background: #2a1010; border: 1px solid #5a2020;
    padding: 8px 10px; border-radius: 4px;
  }
</style>
