<script>
  import { onMount } from 'svelte';
  import { allPeople, t } from '../stores.js';
  import { fetchImages, fetchPeople, thumbnailUrl } from '../api.js';
  import FaceIdentifyModal from './FaceIdentifyModal.svelte';

  let images = [];
  let loading = false;
  let sort = 'most_faces';
  let identifyImageId = null;   // currently open in modal
  let showAll = false;  // false = only images with unidentified faces; true = all images with faces

  async function load() {
    loading = true;
    try {
      images = await fetchImages({ unidentified: showAll ? false : true, sort, limit: 500 });
    } catch (e) {
      console.error('IdentifyView load error:', e);
    } finally {
      loading = false;
    }
  }

  function onModalClose(saved) {
    identifyImageId = null;
    if (saved) load();
  }

  onMount(load);
</script>

<div class="identify-view">
  <!-- Header / controls -->
  <div class="header">
    <div class="title-area">
      <span class="title">{$t('identify_persons')}</span>
      {#if !loading}
        <span class="count-badge">
          {images.length} {images.length === 1 ? $t('image_pending') : $t('images_pending')}
        </span>
      {/if}
    </div>
    <div class="controls">
      <label class="ctrl-label">{$t('sort_by')}</label>
      <select bind:value={sort} on:change={load}>
        <option value="most_faces">{$t('sort_most_faces')}</option>
        <option value="newest">{$t('sort_newest')}</option>
        <option value="oldest">{$t('sort_oldest')}</option>
      </select>
      <label class="toggle-label" title="Show all images with detected faces, not just unidentified">
        <input type="checkbox" bind:checked={showAll} on:change={load} />
        All faces
      </label>
      <button on:click={load} disabled={loading}>
        {loading ? '…' : $t('refresh')}
      </button>
    </div>
  </div>

  <!-- Grid -->
  <div class="grid-wrap">
    {#if loading}
      <div class="empty-state">{$t('loading')}</div>
    {:else if images.length === 0}
      <div class="empty-state">
        <div class="empty-icon">{showAll ? '📷' : '✅'}</div>
        <div>{showAll ? 'No images with detected faces.' : $t('all_faces_identified')}</div>
        <div class="empty-sub">{$t('process_more_images')}</div>
      </div>
    {:else}
      <div class="grid">
        {#each images as img (img.id)}
          <button class="card" on:click={() => identifyImageId = img.id}>
            <div class="thumb-wrap">
              <img
                src={thumbnailUrl(img.id, 200)}
                alt={img.filename}
                loading="lazy"
              />
              <div class="badges">
                {#if img.face_count}
                  <span class="badge face-badge" title="{img.face_count} faces">
                    {img.face_count}
                  </span>
                {/if}
              </div>
            </div>
            <div class="card-label" title={img.filename}>{img.filename}</div>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>

{#if identifyImageId !== null}
  <FaceIdentifyModal
    imageId={identifyImageId}
    on:close={e => onModalClose(e.detail?.saved)}
  />
{/if}

<style>
  .identify-view {
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
    gap: 12px;
    flex-shrink: 0;
  }
  .title-area { display: flex; align-items: center; gap: 10px; }
  .title { font-size: 14px; font-weight: 600; color: #d0d0f0; }
  .count-badge {
    background: #3a2040;
    color: #e89050;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 10px;
  }
  .controls { display: flex; align-items: center; gap: 8px; }
  .ctrl-label { font-size: 11px; color: #606080; }
  .toggle-label {
    display: flex; align-items: center; gap: 4px;
    font-size: 11px; color: #8090b8; cursor: pointer; user-select: none;
  }
  .toggle-label input[type=checkbox] {
    width: auto; padding: 0; border: none; background: transparent; cursor: pointer; accent-color: #6080c0;
  }

  .grid-wrap {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 10px;
  }
  .card {
    background: #1e1e2e;
    border: 1px solid #2a2a3a;
    border-radius: 6px;
    padding: 0;
    cursor: pointer;
    transition: border-color 0.15s, transform 0.1s;
    overflow: hidden;
    text-align: left;
    display: flex;
    flex-direction: column;
  }
  .card:hover { border-color: #5060a0; transform: translateY(-1px); }
  .thumb-wrap { position: relative; aspect-ratio: 4/3; overflow: hidden; background: #0e0e18; }
  .thumb-wrap img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .badges { position: absolute; top: 4px; left: 4px; display: flex; gap: 4px; flex-wrap: wrap; }
  .badge {
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 8px;
    font-weight: 600;
  }
  .face-badge { background: rgba(220,100,40,0.85); color: #fff; }
  .card-label {
    padding: 5px 7px;
    font-size: 10px;
    color: #808098;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    min-height: 300px;
    color: #505070;
    gap: 8px;
  }
  .empty-icon { font-size: 40px; margin-bottom: 4px; }
  .empty-sub { font-size: 11px; color: #404060; }
</style>
