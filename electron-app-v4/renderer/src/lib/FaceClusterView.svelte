<script>
  import { onMount } from 'svelte';
  import { allPeople, t } from '../stores.js';
  import { fetchFaceClusters, faceCropUrl, assignCluster, fetchPeople, reIdentifyFaces } from '../api.js';

  let clusters = [];
  let loading = false;
  let threshold = 0.55;
  let pendingThreshold = 0.55;
  let showAll = false;   // false = unidentified only; true = all faces

  // Per-cluster state: name input and selected face IDs
  let clusterNames = {};       // { cluster_id: '' }
  let selectedFaces = {};      // { cluster_id: Set<face_id> }
  let skipped = new Set();     // cluster_ids hidden this session
  let assigning = new Set();   // cluster_ids currently being assigned

  onMount(loadClusters);

  async function loadClusters() {
    loading = true;
    clusters = [];
    try {
      const data = await fetchFaceClusters(threshold, 300, showAll);
      clusters = data;
      clusterNames = {};
      selectedFaces = {};
      for (const c of clusters) {
        clusterNames[c.cluster_id] = '';
        selectedFaces[c.cluster_id] = new Set();
      }
    } catch (e) {
      console.error('loadClusters error:', e);
    } finally {
      loading = false;
    }
  }

  function applyThreshold() {
    threshold = pendingThreshold;
    loadClusters();
  }

  function toggleFace(clusterId, faceId) {
    const s = new Set(selectedFaces[clusterId] ?? []);
    s.has(faceId) ? s.delete(faceId) : s.add(faceId);
    selectedFaces = { ...selectedFaces, [clusterId]: s };
  }

  function selectAllInCluster(cluster) {
    const s = new Set(cluster.faces.map(f => f.face_id));
    selectedFaces = { ...selectedFaces, [cluster.cluster_id]: s };
  }

  function deselectAllInCluster(clusterId) {
    selectedFaces = { ...selectedFaces, [clusterId]: new Set() };
  }

  async function applyToAll(cluster) {
    const name = clusterNames[cluster.cluster_id]?.trim();
    if (!name) return;
    await doAssign(cluster.cluster_id, cluster.faces.map(f => f.face_id), name);
  }

  async function applyToSelected(cluster) {
    const name = clusterNames[cluster.cluster_id]?.trim();
    const ids = [...(selectedFaces[cluster.cluster_id] ?? [])];
    if (!name || !ids.length) return;
    await doAssign(cluster.cluster_id, ids, name);
  }

  async function doAssign(clusterId, faceIds, name) {
    assigning = new Set([...assigning, clusterId]);
    try {
      await assignCluster(faceIds, name);
      clusters = clusters.map(c => {
        if (c.cluster_id !== clusterId) return c;
        const remaining = c.faces.filter(f => !faceIds.includes(f.face_id));
        return { ...c, faces: remaining, size: remaining.length };
      }).filter(c => c.size > 0);
      allPeople.set(await fetchPeople().catch(() => []));
    } catch (e) {
      alert('Assignment failed: ' + e.message);
    } finally {
      assigning = new Set([...assigning].filter(id => id !== clusterId));
    }
  }

  function skipCluster(clusterId) {
    skipped = new Set([...skipped, clusterId]);
  }

  let reIdentifying = false;
  let reIdentifyMsg = '';

  async function doReIdentifyAll() {
    if (!confirm('Run recognition on all unidentified faces against the trained person index?')) return;
    reIdentifying = true;
    reIdentifyMsg = 'Running…';
    try {
      const r = await reIdentifyFaces(null, threshold);
      reIdentifyMsg = `✓ ${r.updated} of ${r.total_checked} faces matched`;
      if (r.updated > 0) {
        allPeople.set(await fetchPeople().catch(() => []));
        await loadClusters();
      }
    } catch (e) {
      reIdentifyMsg = '✗ ' + e.message;
    } finally {
      reIdentifying = false;
    }
  }

  $: visibleClusters = clusters.filter(c => !skipped.has(c.cluster_id) && c.size > 0);
  $: totalFaces = clusters.reduce((s, c) => s + c.size, 0);
</script>

<div class="cluster-view">
  <!-- Header controls -->
  <div class="header">
    <div class="header-left">
      <h2>{$t('face_clusters')}</h2>
      {#if !loading}
        <span class="sub">{visibleClusters.length} {$t('face_clusters').toLowerCase()} · {totalFaces} {$t('no_faces_detected').toLowerCase()}</span>
      {/if}
    </div>
    <div class="controls">
      <label>
        {$t('similarity_threshold')}:
        <input
          type="range"
          min="0.3" max="0.85" step="0.05"
          bind:value={pendingThreshold}
          style="width:120px;"
        />
        <span class="dim">{Math.round(pendingThreshold * 100)}%</span>
      </label>
      <button class="primary" on:click={applyThreshold}>{$t('apply')}</button>
      <button on:click={loadClusters} title={$t('refresh')}>🔄</button>
      <button class="re-id-btn" on:click={doReIdentifyAll} disabled={reIdentifying}
        title="Match all unidentified faces against the trained person index">
        {reIdentifying ? '…' : '🔍 Re-identify all'}
      </button>
      {#if reIdentifyMsg}<span class="re-id-msg">{reIdentifyMsg}</span>{/if}
      <label class="toggle-label" title="Include already-identified faces in clusters">
        <input type="checkbox" bind:checked={showAll} on:change={loadClusters} />
        All faces
      </label>
    </div>
  </div>

  {#if loading}
    <div class="loading">{$t('clustering_faces')}</div>
  {:else if visibleClusters.length === 0}
    <div class="empty">
      <p>{$t('no_clusters_found')}</p>
      <p>{$t('no_clusters_detail')}</p>
    </div>
  {:else}
    <div class="clusters-list">
      {#each visibleClusters as cluster (cluster.cluster_id)}
        <div class="cluster-card">
          <!-- Cluster header -->
          <div class="cluster-header">
            <span class="cluster-size">{cluster.size} {$t('face_num').toLowerCase()}{cluster.size !== 1 ? 's' : ''}</span>
            <div class="cluster-actions">
              <button class="sm" on:click={() => selectAllInCluster(cluster)}>{$t('select_all')}</button>
              <button class="sm" on:click={() => deselectAllInCluster(cluster.cluster_id)}>{$t('deselect')}</button>
              <button class="sm muted" on:click={() => skipCluster(cluster.cluster_id)}>{$t('skip')}</button>
            </div>
          </div>

          <!-- Face grid -->
          <div class="face-grid">
            {#each cluster.faces as face (face.face_id)}
              <!-- svelte-ignore a11y-click-events-have-key-events -->
              <div
                class="face-crop"
                class:sel={selectedFaces[cluster.cluster_id]?.has(face.face_id)}
                on:click={() => toggleFace(cluster.cluster_id, face.face_id)}
                title="{face.person_name ? face.person_name + ' · ' : ''}#{face.face_id} · {$t('quality')}: {face.face_quality?.toFixed(2) ?? 'n/a'}"
              >
                <img
                  src={face._crop_data_url || faceCropUrl(face.image_id, face.face_id, 96)}
                  alt="face"
                  loading="lazy"
                  width="80"
                  height="80"
                />
                {#if selectedFaces[cluster.cluster_id]?.has(face.face_id)}
                  <div class="check">✓</div>
                {/if}
                {#if face.person_name}
                  <div class="face-name-tag">{face.person_name}</div>
                {/if}
              </div>
            {/each}
          </div>

          <!-- Name assignment -->
          <div class="assign-row">
            <input
              type="text"
              list="people-list"
              placeholder={$t('enter_person_name')}
              bind:value={clusterNames[cluster.cluster_id]}
              on:keydown={e => e.key === 'Enter' && applyToAll(cluster)}
            />
            <button
              class="primary sm"
              on:click={() => applyToAll(cluster)}
              disabled={!clusterNames[cluster.cluster_id]?.trim() || assigning.has(cluster.cluster_id)}
            >
              {assigning.has(cluster.cluster_id) ? '…' : $t('apply_to_all')}
            </button>
            <button
              class="sm"
              on:click={() => applyToSelected(cluster)}
              disabled={
                !clusterNames[cluster.cluster_id]?.trim() ||
                !(selectedFaces[cluster.cluster_id]?.size > 0) ||
                assigning.has(cluster.cluster_id)
              }
            >
              {$t('apply_to_selected')} ({selectedFaces[cluster.cluster_id]?.size ?? 0})
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .cluster-view {
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
  .header-left h2 { font-size: 15px; font-weight: 600; color: #c0c8e0; margin: 0; }
  .sub { font-size: 11px; color: #505070; margin-left: 8px; }
  .controls {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .controls label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: #8090b8;
  }
  .dim { color: #607090; font-size: 11px; }

  .loading, .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: #505070;
    font-size: 13px;
    gap: 8px;
  }
  .empty p { margin: 0; }

  .clusters-list {
    flex: 1;
    overflow-y: auto;
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .cluster-card {
    background: #1a1a2a;
    border: 1px solid #2a2a3a;
    border-radius: 8px;
    padding: 12px;
  }

  .cluster-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }
  .cluster-size {
    font-size: 12px;
    font-weight: 600;
    color: #8090b8;
  }
  .cluster-actions { display: flex; gap: 6px; }

  .face-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 10px;
  }

  .face-crop {
    position: relative;
    width: 80px;
    height: 80px;
    border-radius: 6px;
    overflow: hidden;
    border: 2px solid transparent;
    cursor: pointer;
    background: #111120;
    flex-shrink: 0;
  }
  .face-crop:hover { border-color: #5060a0; }
  .face-crop.sel   { border-color: #4a90ff; }
  .face-crop img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .check {
    position: absolute;
    inset: 0;
    background: rgba(60, 120, 255, 0.35);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 22px;
    color: white;
    pointer-events: none;
  }

  /* Name tag for already-identified faces in "show all" mode */
  .face-name-tag {
    position: absolute;
    bottom: 0; left: 0; right: 0;
    background: rgba(0,0,0,0.65);
    color: #a0d0ff;
    font-size: 8px;
    text-align: center;
    padding: 1px 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
  }

  /* "All faces" toggle checkbox label */
  .toggle-label {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: #8090b8;
    cursor: pointer;
    user-select: none;
  }
  .toggle-label input[type=checkbox] {
    width: auto;
    padding: 0;
    border: none;
    background: transparent;
    cursor: pointer;
    accent-color: #6080c0;
  }

  .assign-row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .assign-row input {
    flex: 1;
    min-width: 160px;
  }

  .sm { font-size: 11px; padding: 3px 8px; border-radius: 4px; }
  .muted { color: #505070; background: transparent; }
  .muted:hover { background: #2a2a42; color: #8090b8; }
</style>
