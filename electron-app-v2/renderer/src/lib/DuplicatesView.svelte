<script>
  import { onMount } from 'svelte';
  import {
    fetchDuplicateStats,
    fetchDuplicateGroups,
    resolveDuplicate,
    resolveDuplicateBatch,
    scanPhash,
    scanHashes,
    thumbnailUrl,
  } from '../api.js';

  // ── State ──────────────────────────────────────────────────────────────────
  let stats    = null;
  let groups   = [];
  let loading  = false;
  let method   = 'hash';         // name_size | hash | visual
  let threshold = 8;             // pHash hamming threshold (0–20)
  let keepStrategy = 'most_faces'; // most_faces | oldest | largest

  // Per-group "which to keep" (map: group key → image id)
  let keepMap = {};

  // Multi-select for batch resolve
  let selectedGroups = new Set(); // Set<group.key>

  // Batch action
  let batchAction = 'delete_file';  // delete_file | db_only | symlink
  let mergeFaces  = true;

  // Individual resolve state
  let resolving = {};   // { [group.key]: bool }
  let resolved  = {};   // { [group.key]: 'ok' | 'error' }

  // Batch resolve state
  let batchResolving = false;
  let batchDone      = false;
  let batchResult    = null;

  // pHash scan state
  let scanning    = false;
  let scanStream  = null;
  let scanProg    = { total: 0, done: 0 };
  let scanDone    = false;

  // SHA-256 hash scan state
  let hashScanning = false;
  let hashStream   = null;
  let hashProg     = { total: 0, done: 0 };
  let hashScanDone = false;

  // ── Data loading ──────────────────────────────────────────────────────────
  async function loadStats() {
    try { stats = await fetchDuplicateStats(); } catch { stats = null; }
  }

  async function loadGroups() {
    loading = true;
    keepMap = {};
    selectedGroups = new Set();
    resolved = {};
    try {
      groups = await fetchDuplicateGroups(method, threshold);
      // Auto-assign keep based on strategy
      for (const g of groups) {
        keepMap[g.key] = autoKeep(g.images);
      }
    } catch (e) {
      console.error('loadGroups error:', e);
      groups = [];
    } finally {
      loading = false;
    }
  }

  function autoKeep(images) {
    if (!images || images.length === 0) return null;
    if (keepStrategy === 'most_faces') {
      return images.reduce((a, b) => (b.face_count ?? 0) > (a.face_count ?? 0) ? b : a).id;
    }
    if (keepStrategy === 'oldest') {
      return images.reduce((a, b) => (a.created_at ?? '') < (b.created_at ?? '') ? a : b).id;
    }
    if (keepStrategy === 'largest') {
      return images.reduce((a, b) => (b.file_size ?? 0) > (a.file_size ?? 0) ? b : a).id;
    }
    return images[0].id;
  }

  function reapplyKeepStrategy() {
    for (const g of groups) {
      keepMap[g.key] = autoKeep(g.images);
    }
    keepMap = { ...keepMap };
  }

  // ── Group selection ───────────────────────────────────────────────────────
  function toggleGroup(key) {
    const s = new Set(selectedGroups);
    s.has(key) ? s.delete(key) : s.add(key);
    selectedGroups = s;
  }

  function selectAll()   { selectedGroups = new Set(groups.map(g => g.key)); }
  function deselectAll() { selectedGroups = new Set(); }

  // ── Resolve single group ──────────────────────────────────────────────────
  async function resolveGroup(group, action) {
    const keepId = keepMap[group.key];
    if (!keepId) { alert('Select which image to keep.'); return; }
    const deleteIds = group.images.map(i => i.id).filter(id => id !== keepId);
    if (deleteIds.length === 0) return;

    resolving = { ...resolving, [group.key]: true };
    try {
      await resolveDuplicate(keepId, deleteIds, action, mergeFaces);
      resolved = { ...resolved, [group.key]: 'ok' };
      groups = groups.filter(g => g.key !== group.key);
      selectedGroups.delete(group.key);
      selectedGroups = new Set(selectedGroups);
      await loadStats();
    } catch (e) {
      resolved = { ...resolved, [group.key]: 'error' };
      alert(`Error: ${e.message}`);
    } finally {
      resolving = { ...resolving, [group.key]: false };
    }
  }

  // ── Batch resolve ─────────────────────────────────────────────────────────
  async function resolveBatch() {
    if (selectedGroups.size === 0 || batchResolving) return;
    batchResolving = true;
    batchDone = false;
    batchResult = null;

    const groupsToResolve = groups
      .filter(g => selectedGroups.has(g.key))
      .map(g => {
        const keepId   = keepMap[g.key];
        const deleteIds = g.images.map(i => i.id).filter(id => id !== keepId);
        return { keep_id: keepId, delete_ids: deleteIds };
      })
      .filter(g => g.keep_id && g.delete_ids.length > 0);

    try {
      const result = await resolveDuplicateBatch(groupsToResolve, batchAction, mergeFaces);
      batchResult = result;
      batchDone = true;
      // Remove resolved groups from list
      const resolvedKeys = new Set(
        groupsToResolve.map((_, i) => groups.find(g => selectedGroups.has(g.key))?.key).filter(Boolean)
      );
      await loadGroups();
      await loadStats();
    } catch (e) {
      alert(`Batch resolve error: ${e.message}`);
    } finally {
      batchResolving = false;
    }
  }

  // ── pHash scan ───────────────────────────────────────────────────────────
  function startScan() {
    if (scanning) return;
    scanning = true;
    scanDone = false;
    scanProg = { total: 0, done: 0 };

    scanStream = scanPhash(event => {
      if (!event.available) {
        scanning = false;
        alert('imagehash library not installed on server. Run: pip install imagehash');
        return;
      }
      if (event.started) {
        scanProg = { total: event.total, done: 0 };
      } else if (event.done) {
        scanning = false;
        scanDone = true;
        scanStream = null;
        loadStats();
        if (method === 'visual') loadGroups();
      } else {
        scanProg = { ...scanProg, done: event.index };
      }
    });
  }

  function cancelScan() {
    if (scanStream) { scanStream.close(); scanStream = null; }
    scanning = false;
  }

  // ── SHA-256 hash scan ─────────────────────────────────────────────────────
  function startHashScan() {
    if (hashScanning) return;
    hashScanning = true;
    hashScanDone = false;
    hashProg = { total: 0, done: 0 };

    hashStream = scanHashes(event => {
      if (event.started) {
        hashProg = { total: event.total, done: 0 };
      } else if (event.done) {
        hashScanning = false;
        hashScanDone = true;
        hashStream = null;
        loadStats();
        if (method === 'hash') loadGroups();
      } else {
        hashProg = { ...hashProg, done: event.index };
      }
    });
  }

  function cancelHashScan() {
    if (hashStream) { hashStream.close(); hashStream = null; }
    hashScanning = false;
  }

  // ── Formatting helpers ────────────────────────────────────────────────────
  function fmtBytes(b) {
    if (!b) return '0 B';
    if (b < 1024) return `${b} B`;
    if (b < 1024*1024) return `${(b/1024).toFixed(1)} KB`;
    if (b < 1024**3)   return `${(b/1024/1024).toFixed(1)} MB`;
    return `${(b/1024**3).toFixed(2)} GB`;
  }

  function fmtDate(ts) {
    if (!ts) return '—';
    try { return new Date(ts).toLocaleDateString(); } catch { return ts; }
  }

  function folderOf(path) {
    if (!path) return '';
    const parts = path.replace(/\\/g, '/').split('/');
    return parts.slice(0, -1).join('/') || '/';
  }

  onMount(async () => {
    await loadStats();
    await loadGroups();
  });
</script>

<div class="dup-view">
  <!-- ── Header ── -->
  <div class="header">
    <div class="header-left">
      <span class="title">Duplicates</span>
      {#if stats}
        <span class="sub">
          {stats.hash_groups + stats.name_size_groups} groups ·
          {fmtBytes(stats.wasted_bytes)} recoverable
        </span>
      {/if}
    </div>

    <div class="controls">
      <label class="ctrl-label">Method</label>
      <select bind:value={method} on:change={loadGroups}>
        <option value="name_size">Filename + Size</option>
        <option value="hash">Binary hash (SHA256)</option>
        <option value="visual" disabled={!stats?.phash_available}>
          Visual (pHash){stats?.phash_available ? '' : ' — not installed'}
        </option>
      </select>

      {#if method === 'visual'}
        <label class="ctrl-label">Threshold</label>
        <input type="range" min="1" max="20" step="1"
          bind:value={threshold} on:change={loadGroups}
          style="width:80px" />
        <span class="ctrl-val">{threshold}</span>
      {/if}

      <label class="ctrl-label">Keep</label>
      <select bind:value={keepStrategy} on:change={reapplyKeepStrategy}>
        <option value="most_faces">Most faces</option>
        <option value="oldest">Oldest file</option>
        <option value="largest">Largest file</option>
      </select>

      <button on:click={loadGroups} disabled={loading}>
        {loading ? '…' : 'Refresh'}
      </button>
    </div>
  </div>

  <!-- ── SHA-256 hash scan bar (shown when there are missing hashes) ── -->
  {#if stats?.hash_missing > 0 || hashScanning || hashScanDone}
    <div class="scan-bar">
      {#if hashScanning}
        <div class="scan-prog">
          Computing hashes… {hashProg.done}/{hashProg.total}
          <div class="prog-wrap">
            <div class="prog-fill"
              style="width: {hashProg.total ? (hashProg.done/hashProg.total)*100 : 0}%"></div>
          </div>
          <button class="btn-sm" on:click={cancelHashScan}>Cancel</button>
        </div>
      {:else if hashScanDone}
        <span class="scan-ok">✅ Hash scan complete — duplicates updated</span>
      {:else}
        <span class="scan-hint">
          {stats.hash_missing} image{stats.hash_missing === 1 ? '' : 's'} missing SHA-256 hash
          (won't appear in hash duplicate groups)
        </span>
        <button class="primary btn-sm" on:click={startHashScan}>Fill Hashes</button>
      {/if}
    </div>
  {/if}

  <!-- ── pHash scan bar ── -->
  {#if method === 'visual' && stats?.phash_available}
    <div class="scan-bar">
      {#if scanning}
        <div class="scan-prog">
          Scanning pHash… {scanProg.done}/{scanProg.total}
          <div class="prog-wrap">
            <div class="prog-fill"
              style="width: {scanProg.total ? (scanProg.done/scanProg.total)*100 : 0}%"></div>
          </div>
          <button class="btn-sm" on:click={cancelScan}>Cancel</button>
        </div>
      {:else if stats?.phash_missing > 0}
        <span class="scan-hint">
          {stats.phash_missing} image{stats.phash_missing === 1 ? '' : 's'} need pHash computed
        </span>
        <button class="primary btn-sm" on:click={startScan}>Scan pHash</button>
      {:else if scanDone}
        <span class="scan-ok">✅ pHash scan complete</span>
      {:else}
        <span class="scan-ok">✅ All images have pHash</span>
      {/if}
    </div>
  {:else if method === 'visual' && !stats?.phash_available}
    <div class="scan-bar warn">
      imagehash not installed on the server.
      Run <code>pip install imagehash</code> and restart.
    </div>
  {/if}

  <!-- ── Batch toolbar ── -->
  {#if selectedGroups.size > 0}
    <div class="batch-bar">
      <span class="batch-label">{selectedGroups.size} group{selectedGroups.size === 1 ? '' : 's'} selected</span>
      <label class="ctrl-label">Action</label>
      <select bind:value={batchAction}>
        <option value="delete_file">Delete from disk</option>
        <option value="db_only">Remove from DB only</option>
        <option value="symlink">Replace with symlink</option>
      </select>
      <label class="toggle-label">
        <input type="checkbox" bind:checked={mergeFaces} />
        Merge face assignments
      </label>
      <button class="primary" on:click={resolveBatch} disabled={batchResolving}>
        {batchResolving ? 'Resolving…' : 'Resolve selected'}
      </button>
      <button class="btn-sm" on:click={deselectAll}>Deselect</button>
    </div>
  {/if}

  <!-- ── Group list ── -->
  <div class="list">
    {#if loading}
      <div class="empty">Loading…</div>
    {:else if groups.length === 0}
      <div class="empty">
        <div class="empty-icon">✨</div>
        <div>No duplicates found with this method.</div>
        {#if method === 'visual' && stats?.phash_missing > 0}
          <div class="empty-sub">Run "Scan pHash" above first.</div>
        {/if}
      </div>
    {:else}
      <!-- Select all bar -->
      <div class="sel-bar">
        <button class="btn-sm" on:click={selectAll}>Select all</button>
        <button class="btn-sm" on:click={deselectAll}>Deselect all</button>
        <span class="sel-count">{groups.length} groups</span>
      </div>

      {#each groups as group (group.key)}
        {@const isSelected = selectedGroups.has(group.key)}
        {@const isResolving = resolving[group.key]}
        {@const isResolved  = resolved[group.key]}

        <div class="group-card" class:selected={isSelected}>
          <!-- Group header -->
          <div class="group-header">
            <div
              class="g-cb"
              on:click={() => toggleGroup(group.key)}
              role="checkbox"
              aria-checked={isSelected}
              tabindex="0"
              on:keydown={e => e.key === ' ' && toggleGroup(group.key)}
            >{isSelected ? '☑' : '☐'}</div>

            <span class="sim-badge">{group.similarity}</span>
            <span class="img-count">{group.images.length} copies</span>

            <div class="group-actions">
              <!-- Per-group resolve dropdown -->
              <div class="resolve-menu">
                {#if isResolving}
                  <span class="resolving-text">Resolving…</span>
                {:else if isResolved === 'ok'}
                  <span class="resolved-ok">✓ Resolved</span>
                {:else}
                  <button class="btn-sm primary"
                    on:click={() => resolveGroup(group, batchAction)}>
                    Resolve
                  </button>
                  <select bind:value={batchAction} class="action-sel">
                    <option value="delete_file">Delete from disk</option>
                    <option value="db_only">Remove from DB</option>
                    <option value="symlink">Symlink</option>
                  </select>
                {/if}
              </div>
            </div>
          </div>

          <!-- Image rows -->
          <div class="img-rows">
            {#each group.images as img (img.id)}
              {@const isKept = keepMap[group.key] === img.id}
              <div class="img-row" class:kept={isKept}>
                <img
                  src={thumbnailUrl(img.id, 80)}
                  alt={img.filename}
                  loading="lazy"
                  class="thumb"
                />
                <div class="img-meta">
                  <div class="img-name" title={img.filename}>{img.filename}</div>
                  <div class="img-path" title={img.filepath}>{folderOf(img.filepath)}</div>
                  <div class="img-stats">
                    {fmtBytes(img.file_size)}
                    {#if img.face_count} · {img.face_count} face{img.face_count === 1 ? '' : 's'}{/if}
                    {#if img.width && img.height} · {img.width}×{img.height}{/if}
                    · {fmtDate(img.created_at)}
                  </div>
                </div>
                <div class="keep-col">
                  <label class="keep-radio" title="Keep this copy">
                    <input
                      type="radio"
                      name="keep-{group.key}"
                      value={img.id}
                      bind:group={keepMap[group.key]}
                    />
                    Keep
                  </label>
                  {#if isKept}
                    <span class="kept-chip">✓ Keep</span>
                  {:else}
                    <span class="del-chip">Delete</span>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/each}
    {/if}
  </div>

  <!-- ── Stats footer ── -->
  {#if stats}
    <div class="footer">
      <span>By name+size: <b>{stats.name_size_groups}</b> groups</span>
      <span>By hash: <b>{stats.hash_groups}</b> groups</span>
      {#if stats.phash_available}
        <span>Visual: <b>{stats.visual_groups}</b> groups</span>
      {:else}
        <span class="hint">Visual dedup: <code>pip install imagehash</code></span>
      {/if}
      <span>Wasted: <b>{fmtBytes(stats.wasted_bytes)}</b></span>
    </div>
  {/if}
</div>

<style>
  .dup-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  /* ── Header ── */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 14px;
    border-bottom: 1px solid #2a2a3a;
    flex-shrink: 0;
    gap: 12px;
    flex-wrap: wrap;
  }
  .header-left { display: flex; align-items: baseline; gap: 10px; }
  .title { font-size: 14px; font-weight: 600; color: #d0d0f0; }
  .sub  { font-size: 11px; color: #606080; }
  .controls { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
  .ctrl-label { font-size: 10px; color: #606080; }
  .ctrl-val  { font-size: 11px; color: #8090b0; min-width: 18px; }

  /* ── Scan bar ── */
  .scan-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 14px;
    background: #141422;
    border-bottom: 1px solid #2a2a3a;
    font-size: 11px;
    color: #8090b0;
    flex-shrink: 0;
  }
  .scan-bar.warn { color: #e08040; background: #2a1a10; }
  .scan-bar code { background: #2a2a40; padding: 1px 5px; border-radius: 3px; color: #c0c0f0; }
  .scan-prog { display: flex; align-items: center; gap: 8px; flex: 1; }
  .prog-wrap { width: 100px; height: 5px; background: #2a2a42; border-radius: 3px; overflow: hidden; }
  .prog-fill { height: 100%; background: #4a6fa5; transition: width 0.2s; }
  .scan-hint { color: #d08040; }
  .scan-ok  { color: #50c878; }

  /* ── Batch bar ── */
  .batch-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: #1a1a32;
    border-bottom: 1px solid #3a3a60;
    flex-shrink: 0;
    flex-wrap: wrap;
  }
  .batch-label { font-size: 12px; color: #a0a0d0; flex: 1; }
  .toggle-label { display: flex; align-items: center; gap: 4px; font-size: 11px; color: #8090b0; cursor: pointer; }

  /* ── Group list ── */
  .list {
    flex: 1;
    overflow-y: auto;
    padding: 8px 10px;
  }
  .sel-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 2px 8px;
  }
  .sel-count { font-size: 11px; color: #505070; margin-left: 4px; }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 280px;
    color: #505070;
    gap: 8px;
  }
  .empty-icon { font-size: 38px; margin-bottom: 4px; }
  .empty-sub { font-size: 11px; color: #404060; }

  /* ── Group card ── */
  .group-card {
    background: #1a1a28;
    border: 1px solid #242438;
    border-radius: 7px;
    margin-bottom: 8px;
    overflow: hidden;
  }
  .group-card.selected { border-color: #4a6fa5; }

  .group-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: #14142a;
    border-bottom: 1px solid #1e1e36;
  }
  .g-cb { font-size: 14px; color: #606080; cursor: pointer; flex-shrink: 0; }
  .group-card.selected .g-cb { color: #5080c0; }
  .sim-badge {
    font-size: 10px;
    background: #2a2a50;
    color: #8090d0;
    padding: 1px 6px;
    border-radius: 8px;
  }
  .img-count { font-size: 10px; color: #505070; flex: 1; }
  .group-actions { display: flex; align-items: center; gap: 5px; }
  .resolve-menu { display: flex; align-items: center; gap: 5px; }
  .action-sel { font-size: 11px; padding: 2px 5px; }
  .resolving-text { font-size: 11px; color: #8090b0; }
  .resolved-ok { font-size: 11px; color: #50c878; }

  /* ── Image rows ── */
  .img-rows { padding: 4px 0; }
  .img-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    border-bottom: 1px solid #1e1e30;
    transition: background 0.1s;
  }
  .img-row:last-child { border-bottom: none; }
  .img-row.kept { background: #1a2a1a; }
  .img-row:not(.kept) { opacity: 0.75; }

  .thumb {
    width: 64px;
    height: 64px;
    object-fit: cover;
    border-radius: 4px;
    flex-shrink: 0;
    background: #0e0e18;
    display: block;
  }
  .img-meta { flex: 1; min-width: 0; }
  .img-name { font-size: 11px; color: #c0c0e0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .img-path { font-size: 9px; color: #505070; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
  .img-stats { font-size: 9px; color: #404060; margin-top: 2px; }

  .keep-col { display: flex; flex-direction: column; align-items: center; gap: 4px; flex-shrink: 0; min-width: 58px; }
  .keep-radio { display: flex; align-items: center; gap: 4px; font-size: 10px; color: #606080; cursor: pointer; }
  .kept-chip {
    font-size: 9px; padding: 2px 6px; border-radius: 8px;
    background: #1a3a20; color: #50c878;
  }
  .del-chip {
    font-size: 9px; padding: 2px 6px; border-radius: 8px;
    background: #2a1a1a; color: #805060;
  }

  /* ── Footer ── */
  .footer {
    display: flex;
    gap: 20px;
    padding: 6px 14px;
    border-top: 1px solid #2a2a3a;
    font-size: 10px;
    color: #505070;
    flex-shrink: 0;
    flex-wrap: wrap;
  }
  .footer b { color: #8090b0; }
  .hint { color: #404060; }
  .hint code { background: #2a2a40; padding: 1px 4px; border-radius: 3px; }

  .btn-sm { font-size: 11px; padding: 3px 10px; }
</style>
