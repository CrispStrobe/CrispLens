<script>
  import { createEventDispatcher } from 'svelte';
  import { patchMetadata, batchEditImages } from '../api.js';
  import { t, selectedItems, galleryImages } from '../stores.js';

  const dispatch = createEventDispatcher();

  let description = '';
  let tags_csv = '';
  let scene_type = '';
  let creator = '';
  let copyright = '';
  let tags_mode = 'replace';  // 'replace' | 'add'
  let saving = false;

  const SCENE_TYPES = ['', 'indoor', 'outdoor', 'portrait', 'group',
                       'landscape', 'event', 'nature', 'urban', 'other'];

  async function save() {
    saving = true;
    try {
      const ids = Array.from($selectedItems);
      const changes = {};
      if (tags_csv || tags_mode === 'replace') {
        if (tags_mode === 'add') changes.tags_add = tags_csv.split(',').map(t => t.trim()).filter(Boolean);
        else changes.tags_csv = tags_csv;
      }
      if (creator.trim())   changes.creator   = creator.trim();
      if (copyright.trim()) changes.copyright = copyright.trim();
      // description and scene_type still use per-image patchMetadata (they have dedicated fields)
      if (description || scene_type) {
        for (const id of ids) {
          await patchMetadata(id, { description, scene_type, tags_csv: '', creator: '', copyright: '' });
        }
      }
      if (Object.keys(changes).length) {
        await batchEditImages(ids, changes);
      }
      dispatch('saved');
      dispatch('close');
    } catch (e) {
      alert('Error saving batch: ' + e.message);
    } finally {
      saving = false;
    }
  }
</script>

<div class="modal-overlay" on:click|self={() => dispatch('close')}>
  <div class="modal">
    <h3>Batch Edit ({$selectedItems.size} items)</h3>
    
    <div class="form-grid">
      <label>{$t('description')}</label>
      <textarea bind:value={description} placeholder="New description for all selected..."></textarea>

      <label>{$t('tags')}</label>
      <div class="tag-row">
        <select bind:value={tags_mode} class="mode-sel">
          <option value="replace">Replace all</option>
          <option value="add">Add</option>
        </select>
        <input type="text" bind:value={tags_csv} placeholder="tag1, tag2…" style="flex:1" />
      </div>

      <label>{$t('pv_creator_label') || 'Creator'}</label>
      <input type="text" bind:value={creator} placeholder="Creator name…" />

      <label>{$t('pv_copyright_label') || 'Copyright'}</label>
      <input type="text" bind:value={copyright} placeholder="© 2025 Name…" />

      <label>{$t('scene_type')}</label>
      <select bind:value={scene_type}>
        {#each SCENE_TYPES as st}
          <option value={st}>{st || '(no change)'}</option>
        {/each}
      </select>
    </div>

    <div class="actions">
      <button on:click={() => dispatch('close')}>{$t('cancel')}</button>
      <button class="primary" on:click={save} disabled={saving}>
        {saving ? $t('loading') : '💾 ' + $t('save')}
      </button>
    </div>
  </div>
</div>

<style>
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 3000;
  }
  .modal {
    background: #1a1a2e;
    padding: 24px;
    border-radius: 12px;
    width: 400px;
    box-shadow: 0 20px 50px rgba(0,0,0,0.5);
    border: 1px solid #3a3a5a;
  }
  h3 { margin-bottom: 20px; color: #a0c4ff; }
  .form-grid { display: grid; grid-template-columns: 100px 1fr; gap: 12px; align-items: center; margin-bottom: 20px; }
  label { font-size: 12px; color: #7080a0; }
  textarea, input, select { width: 100%; }
  .actions { display: flex; justify-content: flex-end; gap: 12px; }
  .tag-row { display: flex; gap: 6px; align-items: center; }
  .mode-sel { width: auto; flex-shrink: 0; }
</style>
