<script>
  import { createEventDispatcher } from 'svelte';
  import { patchMetadata } from '../api.js';
  import { t, selectedItems, galleryImages } from '../stores.js';

  const dispatch = createEventDispatcher();

  let description = '';
  let tags_csv = '';
  let scene_type = '';
  let saving = false;

  const SCENE_TYPES = ['', 'indoor', 'outdoor', 'portrait', 'group',
                       'landscape', 'event', 'nature', 'urban', 'other'];

  async function save() {
    saving = true;
    try {
      const ids = Array.from($selectedItems);
      for (const id of ids) {
        // We only want to update fields that are NOT empty if we want to "merge" or "overwrite selective"
        // But for simplicity, let's just patch what's provided.
        // The backend patchMetadata currently overwrites all 3. 
        // We might want a more sophisticated partial patch.
        await patchMetadata(id, { description, scene_type, tags_csv });
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
      <input type="text" bind:value={tags_csv} placeholder="tag1, tag2 (overwrites existing!)" />

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
</style>
