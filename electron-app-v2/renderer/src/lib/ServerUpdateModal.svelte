<script>
  import { t } from '../stores.js';
  import { streamServerUpdate } from '../api.js';
  import { createEventDispatcher, tick } from 'svelte';

  export let show = false;

  const dispatch = createEventDispatcher();

  let password = '';
  let lines    = [];
  let running  = false;
  let done     = false;
  let error    = '';
  let logEl;
  let followLog = true;

  // Auto-scroll when new lines arrive and followLog is on
  $: if (lines && followLog && logEl) tick().then(() => {
    logEl.scrollTop = logEl.scrollHeight;
  });

  function reset() {
    password = '';
    lines    = [];
    running  = false;
    done     = false;
    error    = '';
  }

  function close() {
    if (running) return;   // don't close while running
    show = false;
    reset();
    dispatch('close');
  }

  async function doUpdate() {
    if (!password || running) return;
    running = true;
    lines   = [];
    done    = false;
    error   = '';
    const pw = password;
    password = '';  // clear from UI immediately after capturing

    try {
      const resp = await streamServerUpdate(pw);
      if (!resp.ok) {
        const msg = await resp.text().catch(() => resp.statusText);
        throw new Error(msg || `HTTP ${resp.status}`);
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
            lines = [...lines, part.slice(6)];
          }
        }
      }
    } catch (e) {
      // Connection drop after restart is expected — treat gracefully
      if (e.name === 'TypeError' && (e.message.includes('network') || e.message.includes('fetch'))) {
        lines = [...lines, '— Connection closed (server restarted) —'];
      } else {
        error = e.message || String(e);
      }
    } finally {
      running = false;
      done    = true;
    }
  }

  function handleKey(e) {
    if (e.key === 'Enter') doUpdate();
    if (e.key === 'Escape') close();
  }
</script>

{#if show}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <div class="modal-overlay" on:click|self={close}>
    <div class="modal-box">
      <div class="modal-header">
        <h3>🔄 {$t('admin_update_server')}</h3>
        {#if !running}
          <button class="close-btn" on:click={close}>✕</button>
        {/if}
      </div>

      {#if !running && !done}
        <!-- Password entry phase -->
        <p class="hint">{$t('update_modal_hint')}</p>

        <label class="field-label" for="upd-pw">{$t('root_password')}</label>
        <input
          id="upd-pw"
          type="password"
          bind:value={password}
          autocomplete="new-password"
          class="pw-input"
          on:keydown={handleKey}
          placeholder="••••••••"
        />

        <div class="action-row">
          <button class="primary" on:click={doUpdate} disabled={!password}>
            {$t('admin_run_update')}
          </button>
          <button on:click={close}>{$t('cancel')}</button>
        </div>

      {:else}
        <!-- Streaming log phase -->
        <div class="log-header">
          <span class="log-label">{running ? $t('running') : '✓ Done'}</span>
          <label class="follow-toggle">
            <input type="checkbox" bind:checked={followLog} />
            {$t('logs_follow')}
          </label>
        </div>

        <div class="log-box" bind:this={logEl}>
          {#each lines as line}
            <div class="log-line" class:ok={line.startsWith('✓')} class:err={line.startsWith('✗') || line.startsWith('ERROR')}>
              {line}
            </div>
          {/each}
          {#if running}
            <div class="log-line blink">▌</div>
          {/if}
        </div>

        {#if done}
          <div class="action-row">
            <button on:click={close}>{$t('close')}</button>
          </div>
        {/if}
      {/if}

      {#if error}
        <div class="error-msg">{error}</div>
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
    margin-bottom: 4px;
  }
  .modal-header h3 { margin: 0; font-size: 16px; color: #c0c8e0; font-weight: 600; }
  .close-btn {
    background: transparent; border: none; color: #505070;
    font-size: 16px; cursor: pointer; padding: 4px;
  }
  .close-btn:hover { color: #a0b0d0; }

  .hint {
    font-size: 12px; color: #7080a0;
    background: #1e1e2e; border: 1px solid #2a2a3a;
    border-radius: 6px; padding: 8px 12px; margin: 0;
  }

  .field-label {
    font-size: 11px; color: #6070a0;
    text-transform: uppercase; letter-spacing: 0.05em;
    font-weight: 600;
  }

  .pw-input {
    width: 100%; box-sizing: border-box;
    background: #1e1e2e; border: 1px solid #3a3a5a;
    color: #e0e0e0; padding: 8px 10px;
    border-radius: 6px; font-size: 14px;
  }
  .pw-input:focus { border-color: #6080c0; outline: none; }

  .action-row { display: flex; gap: 8px; flex-wrap: wrap; }
  button {
    background: #2a2a42; color: #8090b8;
    border: 1px solid #3a3a5a; padding: 7px 14px;
    border-radius: 6px; font-size: 12px; cursor: pointer;
  }
  button:hover:not(:disabled) { background: #3a3a5a; color: #a0c4ff; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  button.primary {
    background: #364070; color: #a0c4ff;
    border-color: #4a5a90; padding: 8px 20px;
    font-size: 13px; font-weight: 500;
  }
  button.primary:hover:not(:disabled) { background: #4a5a90; }

  .log-header {
    display: flex; align-items: center; justify-content: space-between;
    font-size: 11px; color: #6070a0;
  }
  .log-label { font-weight: 600; }
  .follow-toggle { display: flex; align-items: center; gap: 4px; cursor: pointer; }
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
    max-height: 50vh;
    color: #c0d0c0;
  }
  .log-line { white-space: pre-wrap; word-break: break-all; }
  .log-line.ok  { color: #60c060; }
  .log-line.err { color: #e07070; }
  .log-line.blink { animation: blink 1s step-end infinite; }
  @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }

  .error-msg {
    font-size: 12px; color: #e07070;
    background: #2a1010; border: 1px solid #5a2020;
    padding: 8px 10px; border-radius: 4px;
  }
</style>
