<script>
  import { t } from '../stores.js';
  import { streamServerUpdate } from '../api.js';
  import { createEventDispatcher, tick } from 'svelte';

  export let show      = false;
  export let fixDbPath = '';

  const dispatch = createEventDispatcher();

  let lines    = [];
  let running  = false;
  let done     = false;
  let error    = '';
  let logEl;
  let followLog = true;

  let pending = [];
  let batchTimer = null;

  $: if (lines && followLog && logEl) tick().then(() => { logEl.scrollTop = logEl.scrollHeight; });

  function addLine(line) {
    pending.push(line);
    if (!batchTimer) {
      batchTimer = setTimeout(() => {
        lines = [...lines, ...pending];
        pending = [];
        batchTimer = null;
      }, 100);
    }
  }

  function reset() { 
    lines = []; 
    pending = [];
    if (batchTimer) clearTimeout(batchTimer);
    batchTimer = null;
    running = false; 
    done = false; 
    error = ''; 
  }

  function close() {
    if (running) return;
    show = false;
    reset();
    dispatch('close');
  }

  async function doUpdate() {
    if (running) return;
    running = true;
    lines   = [];
    pending = [];
    done    = false;
    error   = '';

    try {
      const resp = await streamServerUpdate(fixDbPath.trim());
      if (!resp.ok) {
        try {
          const json = await resp.json();
          error = `[HTTP ${resp.status}] ${json.detail || JSON.stringify(json)}`;
        } catch {
          error = `[HTTP ${resp.status}] ${await resp.text().catch(() => resp.statusText)}`;
        }
        return;
      }

      const reader = resp.body.getReader();
      const dec    = new TextDecoder();
      let   buf    = '';

      while (true) {
        const { done: d, value } = await reader.read();
        if (d) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const part of parts) {
          if (part.startsWith('data: ')) {
            addLine(part.slice(6));
          }
        }
      }
    } catch (e) {
      if (e.name === 'TypeError' &&
          (e.message.includes('network') || e.message.includes('fetch') || e.message.includes('Failed'))) {
        addLine('— Connection closed (server restarted) —');
      } else {
        error = e.message || String(e);
      }
    } finally {
      running = false;
      done    = true;
    }
  }

  // Start automatically when shown
  $: if (show && !running && !done) doUpdate();

  function handleKey(e) { if (e.key === 'Escape') close(); }
</script>

<svelte:window on:keydown={handleKey} />

{#if show}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <div class="modal-overlay" on:click|self={close}>
    <div class="modal-box">
      <div class="modal-header">
        <h3>🔄 {$t('admin_update_server')}</h3>
        <div style="display:flex;align-items:center;gap:8px;">
          <label class="follow-toggle">
            <input type="checkbox" bind:checked={followLog} />
            {$t('logs_follow')}
          </label>
          {#if !running}
            <button class="close-btn" on:click={close}>✕</button>
          {/if}
        </div>
      </div>

      <div class="log-header">
        <span class="log-label">{running ? $t('running') : done ? '✓ Done' : ''}</span>
        {#if done && !running}
          <button class="small" on:click={() => { reset(); doUpdate(); }}>🔄 Run again</button>
        {/if}
      </div>

      <div class="log-box" bind:this={logEl}>
        {#each lines as line}
          <div class="log-line"
               class:ok={line.startsWith('✓')}
               class:err={line.startsWith('✗') || line.startsWith('ERROR')}>
            {line}
          </div>
        {/each}
        {#if running}
          <div class="log-line blink">▌</div>
        {/if}
      </div>

      {#if error}
        <div class="error-msg">{error}</div>
      {/if}

      {#if done}
        <div class="action-row">
          <button on:click={close}>{$t('close')}</button>
        </div>
      {/if}
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
    padding: 24px 28px;
    width: min(96vw, 680px);
    max-height: 88vh;
    display: flex;
    flex-direction: column;
    gap: 14px;
    box-shadow: 0 8px 40px rgba(0,0,0,0.5);
  }
  .modal-header {
    display: flex; align-items: center; justify-content: space-between;
  }
  .modal-header h3 { margin: 0; font-size: 16px; color: #c0c8e0; font-weight: 600; }
  .close-btn {
    background: transparent; border: none; color: #505070;
    font-size: 16px; cursor: pointer; padding: 4px;
  }
  .close-btn:hover { color: #a0b0d0; }

  .log-header {
    display: flex; align-items: center; justify-content: space-between;
    font-size: 11px; color: #6070a0;
  }
  .log-label { font-weight: 600; }
  .follow-toggle { display: flex; align-items: center; gap: 4px; font-size: 11px; color: #7080a0; cursor: pointer; }
  .follow-toggle input { cursor: pointer; }

  .log-box {
    flex: 1;
    overflow-y: auto;
    background: #0e0e18;
    border: 1px solid #2a2a3a;
    border-radius: 6px;
    padding: 10px 12px;
    font-family: 'Courier New', monospace;
    font-size: 11px;
    line-height: 1.6;
    min-height: 200px;
    max-height: 55vh;
    color: #c0d0c0;
  }
  .log-line { white-space: pre-wrap; word-break: break-all; }
  .log-line.ok  { color: #60c060; }
  .log-line.err { color: #e07070; }
  .log-line.blink { animation: blink 1s step-end infinite; }
  @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }

  .action-row { display: flex; gap: 8px; flex-wrap: wrap; }
  button {
    background: #2a2a42; color: #8090b8;
    border: 1px solid #3a3a5a; padding: 7px 14px;
    border-radius: 6px; font-size: 12px; cursor: pointer;
  }
  button.small { padding: 4px 10px; font-size: 11px; }
  button:hover:not(:disabled) { background: #3a3a5a; color: #a0c4ff; }

  .error-msg {
    font-size: 12px; color: #e07070;
    background: #2a1010; border: 1px solid #5a2020;
    padding: 8px 10px; border-radius: 4px;
    word-break: break-word;
  }
</style>
