<script>
  import { allPeople, selectedPerson, filters, t } from '../stores.js';
  import { fetchPeople, fetchPerson, renamePerson, mergePeople, deletePerson, thumbnailUrl } from '../api.js';
  import { onMount } from 'svelte';

  let detailPerson = null;
  let loading = false;
  let error = '';

  // Rename state
  let renamingId = null;
  let renameValue = '';

  // Merge state
  let mergeSourceId = null;
  let mergeTargetId = '';

  onMount(async () => {
    try { allPeople.set(await fetchPeople()); } catch { /* ignore */ }
  });

  async function openDetail(person) {
    loading = true;
    error = '';
    detailPerson = null;
    try { detailPerson = await fetchPerson(person.id); }
    catch (e) { error = e.message; }
    finally { loading = false; }
  }

  function backToGrid() { detailPerson = null; }

  // ── Rename ────────────────────────────────────────────────────────────────
  function startRename(person) {
    renamingId = person.id;
    renameValue = person.name;
  }

  async function doRename(person) {
    if (!renameValue.trim() || renameValue === person.name) { renamingId = null; return; }
    try {
      await renamePerson(person.id, renameValue.trim());
      allPeople.set(await fetchPeople());
      if (detailPerson && detailPerson.id === person.id) {
        detailPerson = { ...detailPerson, name: renameValue.trim() };
      }
    } catch (e) { error = e.message; }
    renamingId = null;
  }

  // ── Merge ─────────────────────────────────────────────────────────────────
  async function doMerge() {
    if (!mergeSourceId || !mergeTargetId) return;
    if (!confirm(`Merge all faces of person #${mergeSourceId} into #${mergeTargetId}?`)) return;
    try {
      await mergePeople(Number(mergeSourceId), Number(mergeTargetId));
      allPeople.set(await fetchPeople());
      if (detailPerson) backToGrid();
      mergeSourceId = null;
      mergeTargetId = '';
    } catch (e) { error = e.message; }
  }

  // ── Delete ────────────────────────────────────────────────────────────────
  async function doDelete(person) {
    if (!confirm(`Delete person "${person.name}"? This removes all face embeddings but keeps photos.`)) return;
    try {
      await deletePerson(person.id);
      allPeople.set(await fetchPeople());
      if (detailPerson?.id === person.id) backToGrid();
    } catch (e) { error = e.message; }
  }

  // Filter people by the global search bar query (person name field)
  $: filteredPeople = $filters.person
    ? $allPeople.filter(p => p.name.toLowerCase().includes($filters.person.toLowerCase()))
    : $allPeople;

  // Representative thumbnail — first image in their images list
  function personThumb(person) {
    const img = person.images?.[0];
    return img ? thumbnailUrl(img.id, 120) : null;
  }
</script>

<div class="people-view">
  {#if error}
    <div class="error-banner">✗ {error}</div>
  {/if}

  {#if detailPerson}
    <!-- Person detail -->
    <div class="detail-header">
      <button on:click={backToGrid}>← {$t('back')}</button>
      <h2>{detailPerson.name}</h2>
      <span class="count">{detailPerson.images?.length ?? 0} {$t('stats_total_images')}</span>
      <button on:click={() => startRename(detailPerson)}>✏️ {$t('edit')}</button>
      <button class="danger" on:click={() => doDelete(detailPerson)}>🗑 {$t('delete')}</button>
    </div>

    {#if renamingId === detailPerson.id}
      <div class="rename-bar">
        <input type="text" bind:value={renameValue} on:keydown={e => e.key === 'Enter' && doRename(detailPerson)} />
        <button class="primary" on:click={() => doRename(detailPerson)}>{$t('save')}</button>
        <button on:click={() => renamingId = null}>{$t('cancel')}</button>
      </div>
    {/if}

    <div class="detail-info">
      {#if detailPerson.first_seen}<span>{$t('stats_images_with_date')} (First): {detailPerson.first_seen}</span>{/if}
      {#if detailPerson.last_seen}<span>{$t('stats_images_with_date')} (Last): {detailPerson.last_seen}</span>{/if}
      <span>{$t('people_detected')}: {detailPerson.appearances ?? 0}</span>
    </div>

    <div class="thumb-grid mini">
      {#each detailPerson.images ?? [] as img}
        <div class="mini-thumb">
          <img src={thumbnailUrl(img.id, 120)} alt={img.filename} loading="lazy" />
          <div class="mini-label">{img.filename?.slice(-20) ?? ''}</div>
        </div>
      {/each}
    </div>

  {:else if loading}
    <div class="loading">{$t('loading')}…</div>

  {:else}
    <!-- People grid -->
    <div class="grid-header">
      <h2>{$t('tab_people')} ({filteredPeople.length}{$filters.person ? ` / ${$allPeople.length}` : ''})</h2>

      <!-- Merge tool -->
      <div class="merge-tool">
        <span>{$t('merge')}:</span>
        <select bind:value={mergeSourceId}>
          <option value="">{$t('source')}…</option>
          {#each $allPeople as p}
            <option value={p.id}>{p.name}</option>
          {/each}
        </select>
        <span>→</span>
        <select bind:value={mergeTargetId}>
          <option value="">{$t('target')}…</option>
          {#each $allPeople as p}
            {#if p.id !== Number(mergeSourceId)}
              <option value={p.id}>{p.name}</option>
            {/if}
          {/each}
        </select>
        <button class="primary" on:click={doMerge} disabled={!mergeSourceId || !mergeTargetId}>{$t('merge')}</button>
      </div>
    </div>

    <div class="people-grid">
      {#each filteredPeople as person}
        <div class="person-card" on:click={() => openDetail(person)} on:keydown={() => {}}>
          <div class="person-thumb">
            {#if person.thumb_url || person.images?.[0]}
              <!-- We don't have thumb_url in list endpoint; show placeholder -->
            {/if}
            <div class="person-initials">{person.name.charAt(0).toUpperCase()}</div>
          </div>
          <div class="person-info">
            {#if renamingId === person.id}
              <input
                type="text"
                bind:value={renameValue}
                on:click|stopPropagation
                on:keydown={e => { if (e.key === 'Enter') doRename(person); if (e.key === 'Escape') renamingId = null; }}
              />
            {:else}
              <div class="person-name">{person.name}</div>
            {/if}
            <div class="person-count">{person.appearances ?? 0} {$t('people_detected')}</div>
          </div>
          <div class="person-actions" on:click|stopPropagation>
            <button on:click={() => startRename(person)}>✏️</button>
            <button class="danger" on:click={() => doDelete(person)}>🗑</button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .people-view {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .error-banner { background: #3a1a1a; color: #e08080; padding: 8px 12px; border-radius: 6px; font-size: 12px; }
  h2 { font-size: 1.05rem; color: #c0c8e0; }

  /* Grid header */
  .grid-header { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  .merge-tool { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #707090; }
  .merge-tool select { font-size: 12px; }

  /* People grid */
  .people-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 10px;
  }
  .person-card {
    background: #1a1a28;
    border: 1px solid #2a2a3a;
    border-radius: 8px;
    padding: 12px;
    display: flex;
    align-items: center;
    gap: 10px;
    cursor: pointer;
    transition: border-color 0.15s;
  }
  .person-card:hover { border-color: #6080c0; }
  .person-thumb {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: #252545;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    overflow: hidden;
  }
  .person-initials { color: #8090c0; font-size: 18px; font-weight: 600; }
  .person-info { flex: 1; min-width: 0; }
  .person-name { font-size: 13px; color: #c0c8e0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .person-count { font-size: 11px; color: #505070; }
  .person-actions { display: flex; gap: 4px; }
  .person-actions button { padding: 3px 6px; font-size: 11px; }

  /* Detail view */
  .detail-header {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .detail-header h2 { flex: 1; }
  .count { font-size: 12px; color: #606080; }
  .rename-bar { display: flex; gap: 8px; align-items: center; }
  .rename-bar input { flex: 1; max-width: 300px; }
  .detail-info { display: flex; gap: 12px; font-size: 11px; color: #505070; }
  .loading { color: #404060; padding: 40px; text-align: center; }

  /* Mini thumbnail grid */
  .thumb-grid.mini {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .mini-thumb {
    width: 120px;
    border-radius: 6px;
    overflow: hidden;
    background: #1e1e2e;
  }
  .mini-thumb img { width: 120px; height: 120px; object-fit: cover; display: block; }
  .mini-label {
    font-size: 10px;
    color: #505070;
    padding: 2px 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
