<script>
  import { onMount } from 'svelte';
  import { watchFolders } from '../stores.js';
  import {
    fetchWatchFolders,
    addWatchFolder,
    updateWatchFolder,
    deleteWatchFolder,
    scanWatchFolder,
  } from '../api.js';

  let folders = [];
  let loading = false;
  let addPath = '';
  let addError = '';
  let scanStreams = {};   // { [id]: SSE stream handle }
  let scanProgress = {}; // { [id]: { total, done, errors, current, all_found } }
  let scanDone = {};     // { [id]: bool }

  async function load() {
    loading = true;
    try {
      folders = await fetchWatchFolders();
      watchFolders.set(folders);
    } catch (e) {
      console.error('WatchFoldersView load error:', e);
    } finally {
      loading = false;
    }
  }

  // Pick a folder — Electron native dialog or fallback
  async function pickFolder() {
    try {
      const result = await window.electronAPI.openFolderDialog();
      if (result) addPath = result;
    } catch {
      // fallback: prompt
      const p = window.prompt('Enter folder path:');
      if (p) addPath = p;
    }
  }

  async function addFolder() {
    addError = '';
    const path = addPath.trim();
    if (!path) return;
    try {
      const folder = await addWatchFolder({ path, recursive: true, auto_scan: false, scan_interval_hours: 24 });
      folders = [folder, ...folders];
      watchFolders.set(folders);
      addPath = '';
    } catch (e) {
      addError = e.message.includes('409') ? 'This folder is already being watched.' : e.message;
    }
  }

  async function removeFolder(id) {
    if (!confirm('Remove this watch folder?')) return;
    try {
      await deleteWatchFolder(id);
      folders = folders.filter(f => f.id !== id);
      watchFolders.set(folders);
    } catch (e) {
      alert(`Error: ${e.message}`);
    }
  }

  async function toggleUpdate(folder, field, value) {
    try {
      const updated = await updateWatchFolder(folder.id, { [field]: value });
      folders = folders.map(f => f.id === folder.id ? updated : f);
      watchFolders.set(folders);
    } catch (e) {
      console.error('Update error:', e);
    }
  }

  function startScan(folder) {
    if (scanStreams[folder.id]) return;
    scanProgress = { ...scanProgress, [folder.id]: { total: 0, done: 0, errors: 0, current: '', all_found: 0 } };
    scanDone = { ...scanDone, [folder.id]: false };

    const stream = scanWatchFolder(folder.id, event => {
      if (event.started) {
        scanProgress = {
          ...scanProgress,
          [folder.id]: {
            ...scanProgress[folder.id],
            total:     event.total,
            all_found: event.all_found ?? 0,
          },
        };
      } else if (event.done) {
        scanStreams = { ...scanStreams, [folder.id]: null };
        scanDone    = { ...scanDone,   [folder.id]: true };
        // Store final added/errors counts from done event (authoritative)
        scanProgress = {
          ...scanProgress,
          [folder.id]: {
            ...scanProgress[folder.id],
            done:   event.added ?? scanProgress[folder.id]?.done ?? 0,
            errors: event.errors ?? scanProgress[folder.id]?.errors ?? 0,
          },
        };
        load();  // refresh stats
      } else {
        scanProgress = {
          ...scanProgress,
          [folder.id]: {
            ...scanProgress[folder.id],
            done:    event.index,
            current: event.path?.split('/').pop() || '',
            errors:  (scanProgress[folder.id]?.errors ?? 0) + (event.error ? 1 : 0),
          },
        };
      }
    });

    scanStreams = { ...scanStreams, [folder.id]: stream };
  }

  function cancelScan(id) {
    const s = scanStreams[id];
    if (s) { s.close(); }
    scanStreams = { ...scanStreams, [id]: null };
  }

  function formatDate(ts) {
    if (!ts) return '—';
    try { return new Date(ts).toLocaleString(); } catch { return ts; }
  }

  onMount(load);
</script>

<div class="wf-view">
  <div class="header">
    <span class="title">Watch Folders</span>
    <div class="add-area">
      <input
        type="text"
        class="path-input"
        placeholder="Folder path…"
        bind:value={addPath}
        on:keydown={e => e.key === 'Enter' && addFolder()}
      />
      <button on:click={pickFolder}>Browse…</button>
      <button class="primary" on:click={addFolder} disabled={!addPath.trim()}>Add</button>
    </div>
    {#if addError}
      <div class="add-error">{addError}</div>
    {/if}
  </div>

  <div class="list-area">
    {#if loading}
      <div class="empty-state">Loading…</div>
    {:else if folders.length === 0}
      <div class="empty-state">
        <div class="empty-icon">📡</div>
        <div>No watch folders yet.</div>
        <div class="empty-sub">Add a folder above to automatically ingest new images.</div>
      </div>
    {:else}
      {#each folders as folder (folder.id)}
        {@const prog = scanProgress[folder.id]}
        {@const scanning = !!scanStreams[folder.id]}
        {@const done = !!scanDone[folder.id]}

        <div class="folder-card">
          <div class="folder-top">
            <div class="folder-path" title={folder.path}>{folder.path}</div>
            <button class="remove-btn" on:click={() => removeFolder(folder.id)} title="Remove">✕</button>
          </div>

          <!-- Settings row -->
          <div class="settings-row">
            <label class="toggle-label">
              <input
                type="checkbox"
                checked={!!folder.recursive}
                on:change={e => toggleUpdate(folder, 'recursive', e.target.checked)}
              />
              Recursive
            </label>
            <label class="toggle-label">
              <input
                type="checkbox"
                checked={!!folder.auto_scan}
                on:change={e => toggleUpdate(folder, 'auto_scan', e.target.checked)}
              />
              Auto-scan
            </label>
            {#if folder.auto_scan}
              <label class="interval-label">
                Every
                <input
                  type="number"
                  class="interval-input"
                  min="0.1" max="720" step="0.5"
                  value={folder.scan_interval_hours}
                  on:change={e => toggleUpdate(folder, 'scan_interval_hours', parseFloat(e.target.value))}
                />
                h
              </label>
            {/if}
          </div>

          <!-- Stats row -->
          <div class="stats-row">
            <span class="stat-item" title="Total images added to DB">
              📥 {folder.files_added} added
            </span>
            <span class="stat-item" title="Last scan time">
              🕐 {formatDate(folder.last_scanned_at)}
            </span>
          </div>

          <!-- Scan progress / button -->
          {#if scanning && prog}
            <div class="scan-progress">
              <div class="scan-label">
                Scanning… {prog.done}/{prog.total} new
                {#if prog.all_found > 0}({prog.all_found} found){/if}
                {#if prog.current}— {prog.current}{/if}
                {#if prog.errors > 0}<span class="err">{prog.errors} errors</span>{/if}
              </div>
              <div class="prog-bar-wrap">
                <div
                  class="prog-bar"
                  style="width: {prog.total ? (prog.done / prog.total) * 100 : 0}%"
                ></div>
              </div>
              <button class="btn-sm" on:click={() => cancelScan(folder.id)}>Cancel</button>
            </div>
          {:else if done && prog}
            <div class="scan-done">
              ✅ Scan complete — {prog.done} image{prog.done === 1 ? '' : 's'} added.
              {#if prog.errors > 0}<span class="err">{prog.errors} errors</span>{/if}
              <button class="btn-sm" on:click={() => { scanDone = { ...scanDone, [folder.id]: false }; }}>
                Dismiss
              </button>
            </div>
          {:else}
            <div class="scan-action">
              <button class="primary btn-sm" on:click={() => startScan(folder)}>
                Scan Now
              </button>
              {#if folder.auto_scan}
                <span class="auto-hint">Auto-scan every {folder.scan_interval_hours}h</span>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .wf-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .header {
    padding: 10px 14px;
    border-bottom: 1px solid #2a2a3a;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .title { font-size: 14px; font-weight: 600; color: #d0d0f0; }
  .add-area { display: flex; gap: 6px; align-items: center; }
  .path-input { flex: 1; font-size: 12px; }
  .add-error { font-size: 11px; color: #e06060; }

  .list-area { flex: 1; overflow-y: auto; padding: 10px; }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 280px;
    color: #505070;
    gap: 8px;
  }
  .empty-icon { font-size: 40px; margin-bottom: 4px; }
  .empty-sub { font-size: 11px; color: #404060; }

  /* ── Folder card ── */
  .folder-card {
    background: #1a1a28;
    border: 1px solid #242438;
    border-radius: 7px;
    padding: 10px 12px;
    margin-bottom: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .folder-top {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }
  .folder-path {
    flex: 1;
    font-size: 12px;
    color: #c0c0e0;
    word-break: break-all;
    font-family: monospace;
  }
  .remove-btn {
    background: transparent;
    color: #604040;
    font-size: 12px;
    padding: 2px 5px;
    flex-shrink: 0;
  }
  .remove-btn:hover { background: #3a1a1a; color: #e06060; }

  .settings-row {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
  }
  .toggle-label {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: #8090b0;
    cursor: pointer;
  }
  .interval-label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: #8090b0;
  }
  .interval-input { width: 60px; font-size: 11px; padding: 2px 5px; }

  .stats-row {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
  }
  .stat-item { font-size: 10px; color: #505070; }

  /* ── Scan progress ── */
  .scan-progress {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .scan-label { font-size: 11px; color: #8090b0; flex: 1; }
  .prog-bar-wrap {
    width: 100px;
    height: 5px;
    background: #2a2a42;
    border-radius: 3px;
    overflow: hidden;
  }
  .prog-bar { height: 100%; background: #4a6fa5; transition: width 0.2s; }

  .scan-done {
    font-size: 11px;
    color: #50c878;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .scan-action {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .auto-hint { font-size: 10px; color: #404060; }
  .btn-sm { font-size: 11px; padding: 3px 10px; }
  .err { color: #e06060; margin-left: 4px; font-size: 10px; }
</style>
