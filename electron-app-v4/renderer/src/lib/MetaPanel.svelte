<script>
  import { createEventDispatcher, onMount } from 'svelte';
  import { patchMetadata, renameImage, deleteImage, openInOs, downloadImage, fetchPeople, renamePerson, reassignFace, fetchImage, deleteFace, fetchArchiveChoices } from '../api.js';
  import { t, allPeople, currentUser } from '../stores.js';
  import FaceIdentifyModal from './FaceIdentifyModal.svelte';

  export let image = null;  // full image record

  $: canDelete = $currentUser?.role === 'admin'
    || $currentUser?.role === 'mediamanager'
    || image?.owner_id == null
    || image?.owner_id === $currentUser?.id
    || image?.visibility === 'shared';

  const dispatch = createEventDispatcher();

  let description  = '';
  let scene_type   = '';
  let tags_csv     = '';
  let creator      = '';
  let copyright    = '';
  let new_filename = '';

  // Archive fields
  let fachbereich          = '';
  let veranstaltungsnummer = '';
  let veranstaltungstitel  = '';
  let urheber              = '';
  let datum_event          = '';

  // Autocomplete choices for archive fields
  let archiveChoices = { fachbereich: [], veranstaltungsnummer: [], veranstaltungstitel: [], urheber: [] };

  let saving = false;
  let statusMsg = '';
  let showIdentifyModal = false;
  let _editingId = null; // track which image's fields are loaded

  const SCENE_TYPES = ['', 'indoor', 'outdoor', 'portrait', 'group',
                       'landscape', 'event', 'nature', 'urban', 'other'];

  const FACHBEREICH_CHOICES = ['DIR', 'ÖFA', 'GES', 'GUS', 'HOH', 'INZ', 'IRD', 'MMN', 'NUT', 'KUN', 'RSP', 'SUG'];

  // Only reset editable fields when switching to a different image.
  $: if (image && image.id !== _editingId) {
    _editingId           = image.id;
    description          = image.ai_description ?? '';
    scene_type           = image.ai_scene_type  ?? '';
    tags_csv             = (image.ai_tags_list ?? []).join(', ');
    creator              = image.creator        ?? '';
    copyright            = image.copyright      ?? '';
    new_filename         = image.filename       ?? '';
    fachbereich          = image.fachbereich          ?? '';
    veranstaltungsnummer = image.veranstaltungsnummer ?? '';
    veranstaltungstitel  = image.veranstaltungstitel  ?? '';
    urheber              = image.urheber              ?? '';
    datum_event          = image.datum_event          ?? '';
  }

  onMount(async () => {
    try {
      const c = await fetchArchiveChoices();
      if (c?.choices) archiveChoices = { ...archiveChoices, ...c.choices };
    } catch { /* ignore */ }
  });

  async function save() {
    saving = true;
    statusMsg = '';
    try {
      await patchMetadata(image.id, {
        description, scene_type, tags_csv, creator, copyright,
        fachbereich:          fachbereich          || null,
        veranstaltungsnummer: veranstaltungsnummer || null,
        veranstaltungstitel:  veranstaltungstitel  || null,
        urheber:              urheber              || null,
        datum_event:          datum_event          || null,
      });
      statusMsg = '✓ Saved';
      dispatch('saved');
    } catch (e) {
      statusMsg = '✗ ' + e.message;
    } finally {
      saving = false;
    }
  }

  async function doRename() {
    if (!new_filename.trim() || new_filename === image.filename) return;
    saving = true;
    statusMsg = '';
    try {
      await renameImage(image.id, new_filename.trim());
      statusMsg = '✓ Renamed';
      dispatch('renamed', { new_filename: new_filename.trim() });
    } catch (e) {
      statusMsg = '✗ ' + e.message;
    } finally {
      saving = false;
    }
  }

  async function doDelete() {
    if (!confirm(`Delete "${image.filename}"? This cannot be undone.`)) return;
    try {
      await deleteImage(image.id);
      dispatch('deleted', { id: image.id });
    } catch (e) {
      statusMsg = '✗ ' + e.message;
    }
  }

  async function doOpen() {
    const res = await openInOs(image.id).catch(() => null);
    if (res && !res.ok && res.headless) {
      await navigator.clipboard.writeText(res.path).catch(() => {});
      alert(`Server path (headless — downloading instead):\n${res.path}`);
      downloadImage(image.id, image.filename);
    }
  }

  let editingFaceId = null;
  let fixName = '';

  // Sequential label for unidentified faces (no name assigned)
  $: unidentifiedIdx = (() => {
    const map = {};
    let n = 0;
    for (const p of (image?.detected_people ?? [])) {
      if (!p.name) map[p.face_id] = ++n;
    }
    return map;
  })();

  function faceLabel(p) {
    return p.name || `${$t('unidentified')} (${unidentifiedIdx[p.face_id] ?? '?'})`;
  }

  async function startFix(face) {
    editingFaceId = face.face_id;
    fixName = face.name || '';
  }

  async function doFix() {
    if (!fixName.trim() || !editingFaceId) { editingFaceId = null; return; }
    try {
      await reassignFace(editingFaceId, fixName.trim());
      statusMsg = '✓ Identification updated';
      image = await fetchImage(image.id);
      allPeople.set(await fetchPeople());
    } catch (e) {
      statusMsg = '✗ ' + e.message;
    } finally {
      editingFaceId = null;
    }
  }

  async function doRemoveFace(face_id) {
    if (!confirm('Remove this face detection?')) return;
    try {
      await deleteFace(image.id, face_id);
      image = await fetchImage(image.id);
      statusMsg = '✓ Face removed';
    } catch (e) {
      statusMsg = '✗ ' + e.message;
    }
  }

  async function onIdentifyDone(e) {
    showIdentifyModal = false;
    if (e.detail.saved) {
      image = await fetchImage(image.id);
      dispatch('saved');
    }
  }
</script>

{#if image}
<div class="meta-panel">

  <!-- Ordnerpfad — always visible -->
  {#if image.local_path || image.filepath}
  <div class="path-line" title={image.local_path || image.filepath}>
    <b>{$t('folder_path')}:</b> {image.local_path || image.filepath}
  </div>
  {/if}

  <!-- Collapsible extended details (ID, quality, filename, camera, etc.) -->
  <details class="exif-details">
    <summary class="exif-summary">{$t('more_details') || 'Mehr Details…'}</summary>

    <div class="exif-line"><b>ID:</b> {image.id}</div>

    {#if image.width && image.height}
    <div class="exif-line"><b>{$t('quality')}:</b> {image.width} × {image.height}</div>
    {/if}

    {#if image.thumb_width && image.thumb_height && (image.thumb_width !== image.width || image.thumb_height !== image.height)}
    <div class="exif-line dim">🖼 {image.thumb_width} × {image.thumb_height} ({$t('stored_thumbnail') || 'stored'})</div>
    {/if}

    <!-- Dateiname + rename inline -->
    <div class="section-label">✏️ {$t('filename')}</div>
    <div class="rename-row">
      <input type="text" bind:value={new_filename} class="flex1" />
      <button on:click={doRename} disabled={saving || new_filename === image.filename}>
        {$t('edit')}
      </button>
    </div>

    {#if image.taken_at}
      <div class="exif-line">📅 <b>{$t('exif_date') || 'EXIF'}:</b> {image.taken_at}</div>
    {/if}
    {#if image.created_at}
      <div class="exif-line">📥 <b>{$t('date_imported') || 'Imported'}:</b> {image.created_at}</div>
    {/if}
    {#if image.updated_at}
      <div class="exif-line">✏️ <b>{$t('date_modified')}:</b> {image.updated_at}</div>
    {/if}
    {#if image.processed_at ?? image.created_at}
      <div class="exif-line">⚙️ <b>{$t('date_processed') || 'Processed'}:</b> {image.processed_at ?? image.created_at}</div>
    {/if}
    {#if image.file_size}
      <div class="exif-line">💾 <b>{$t('file_size') || 'Size'}:</b> {(image.file_size / 1024 / 1024).toFixed(2)} MB</div>
    {/if}
    {#if image.camera_make || image.camera_model}
      <div class="exif-line cam">📷 {[image.camera_make, image.camera_model].filter(Boolean).join(' ')}</div>
    {/if}
    {#if image.iso || image.aperture || image.shutter_speed || image.focal_length}
      <div class="exif-line">
        {#if image.iso}ISO {image.iso}{/if}
        {#if image.aperture} · f/{image.aperture}{/if}
        {#if image.shutter_speed} · {image.shutter_speed}{/if}
        {#if image.focal_length} · {image.focal_length}mm{/if}
      </div>
    {/if}
    {#if image.location_name || (image.location_lat && image.location_lng)}
      <div class="exif-line">📍 {image.location_name || `${Number(image.location_lat).toFixed(4)}, ${Number(image.location_lng).toFixed(4)}`}</div>
    {/if}
    {#if image.format}
      <div class="exif-line">🗂 {image.format}</div>
    {/if}

    <!-- Archive paths (read-only) -->
    {#if image.bildarchiv_path}
      <div class="exif-line archive-path">🗄 <b>Bildarchiv:</b> {image.bildarchiv_path}</div>
    {/if}
    {#if image.bildauswahl_path}
      <div class="exif-line archive-path">🖼 <b>Bildauswahl:</b> {image.bildauswahl_path}</div>
    {/if}
  </details>

  <div class="divider"></div>

  <!-- Collapsible people section -->
  <details class="people-details" open>
    <summary class="people-summary">👤 {$t('people_detected')}</summary>

    {#if image.detected_people?.length}
      <div class="chips">
        {#each image.detected_people as p (p.face_id)}
          <div class="chip-group">
            <span class="chip person" class:unidentified={!p.name}>{faceLabel(p)}</span>
            <button class="small-fix" on:click={() => startFix(p)}>Fix</button>
            <button class="small-fix danger-text" on:click={() => doRemoveFace(p.face_id)}>✕</button>
          </div>
        {/each}
      </div>
      {#if editingFaceId}
        <div class="fix-row">
          <input type="text" bind:value={fixName} list="people-list" class="flex1" />
          <button on:click={() => doFix()}>OK</button>
        </div>
      {/if}
    {:else}
      <div class="no-people">None detected</div>
    {/if}
    <button class="btn-sm full mt-4" on:click={() => showIdentifyModal = true}>
      Re-identify
    </button>
  </details>

  <div class="divider"></div>

  <!-- Collapsible FIELDS section -->
  <details class="fields-details">
    <summary class="fields-summary">{$t('fields') || 'FIELDS'}</summary>

    <!-- Tags -->
    <div class="section-label">🏷 {$t('tags')}</div>
    <input
      type="text"
      bind:value={tags_csv}
      placeholder="tag1, tag2, …"
      class="full"
      list="people-list"
    />

    <!-- Scene type -->
    <div class="section-label">🎬 {$t('scene_type')}</div>
    <input type="text" bind:value={scene_type} class="full" placeholder="indoor, portrait, conference…"
           list="scene-type-suggestions" />
    <datalist id="scene-type-suggestions">
      {#each SCENE_TYPES.filter(Boolean) as st (st)}
        <option value={st}></option>
      {/each}
    </datalist>

    <!-- Description -->
    <div class="section-label">📝 {$t('description')}</div>
    <textarea bind:value={description} rows="3" class="full" placeholder="{$t('description')}…"></textarea>

    <!-- Creator / Copyright -->
    <div class="section-label">✍️ {$t('pv_creator_label') || 'Creator'}</div>
    <input type="text" bind:value={creator} class="full" placeholder="{$t('pv_creator_placeholder') || 'Creator name…'}" />
    <div class="section-label">© {$t('pv_copyright_label') || 'Copyright'}</div>
    <input type="text" bind:value={copyright} class="full" placeholder="{$t('pv_copyright_placeholder') || '© 2025 Name…'}" />

    <!-- Archive metadata -->
    <div class="archive-sep">— {$t('archive_metadata') || 'Archiv-Metadaten'} —</div>

    <div class="section-label">🏢 {$t('arch_fachbereich') || 'Fachbereich'}</div>
    <input type="text" bind:value={fachbereich} class="full" list="fachbereich-list"
           placeholder="DIR, ÖFA, GES…" />
    <datalist id="fachbereich-list">
      {#each FACHBEREICH_CHOICES as c (c)}
        <option value={c}></option>
      {/each}
    </datalist>

    <div class="section-label">🔢 {$t('arch_veranstaltungsnummer') || 'Veranstaltungsnummer'}</div>
    <input type="text" bind:value={veranstaltungsnummer} class="full" list="vnummer-list"
           placeholder="2025-001…" />
    <datalist id="vnummer-list">
      {#each (archiveChoices.veranstaltungsnummer || []) as c (c)}
        <option value={c}></option>
      {/each}
    </datalist>

    <div class="section-label">📅 {$t('arch_datum') || 'Datum'}</div>
    <input type="date" bind:value={datum_event} class="full" />

    <div class="section-label">🎪 {$t('arch_veranstaltungstitel') || 'Veranstaltungstitel'}</div>
    <input type="text" bind:value={veranstaltungstitel} class="full" list="vtitel-list"
           placeholder="Titel der Veranstaltung…" />
    <datalist id="vtitel-list">
      {#each (archiveChoices.veranstaltungstitel || []) as c (c)}
        <option value={c}></option>
      {/each}
    </datalist>

    <div class="section-label">✒️ {$t('arch_urheber') || 'Urheber'}</div>
    <input type="text" bind:value={urheber} class="full" list="urheber-list"
           placeholder="Fotografin / Fotograf…" />
    <datalist id="urheber-list">
      {#each (archiveChoices.urheber || []) as c (c)}
        <option value={c}></option>
      {/each}
    </datalist>

    <!-- Save -->
    <button class="primary full mt-4" on:click={save} disabled={saving}>
      {saving ? $t('loading') : '💾 ' + $t('save')}
    </button>
    {#if statusMsg}
      <div class="status-msg">{statusMsg}</div>
    {/if}
  </details>

  <div class="divider"></div>

  <!-- Actions -->
  <div class="action-row">
    <button on:click={doOpen}>🖼 {$t('view')}</button>
    {#if canDelete}
      <button class="danger" on:click={doDelete}>🗑 {$t('delete')}</button>
    {:else}
      <button class="danger" disabled title="You don't own this image">🗑 {$t('delete')}</button>
    {/if}
  </div>
</div>

{#if showIdentifyModal}
  <FaceIdentifyModal imageId={image.id} on:close={onIdentifyDone} />
{/if}
{/if}

<style>
  .meta-panel {
    width: 260px;
    min-width: 220px;
    max-width: 300px;
    background: #1a1a28;
    border-left: 1px solid #2a2a3a;
    padding: 12px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
  }
  .path-line {
    color: #7090b0;
    font-size: 10px;
    line-height: 1.4;
    word-break: break-all;
    padding: 2px 0 4px;
  }
  .exif-line {
    color: #8090a8;
    font-size: 11px;
    line-height: 1.5;
  }
  .exif-line.cam { color: #a0b0c8; font-weight: 600; }
  .exif-line.dim { color: #606080; }
  .exif-line.archive-path { color: #6090a0; font-size: 10px; word-break: break-all; }
  .exif-details { margin: 2px 0; }
  .exif-summary {
    font-size: 10px; color: #505070; cursor: pointer;
    user-select: none; list-style: none; padding: 2px 0;
  }
  .exif-summary::-webkit-details-marker { display: none; }
  .exif-summary::before { content: '▶ '; font-size: 8px; }
  details[open] > .exif-summary::before { content: '▼ '; }

  .people-details { margin-top: 4px; }
  .people-summary {
    font-weight: bold; color: #6080a0; text-transform: uppercase;
    letter-spacing: 0.08em; font-size: 10px; cursor: pointer;
    user-select: none; list-style: none; padding: 2px 0;
  }
  .people-summary::-webkit-details-marker { display: none; }
  .people-summary::before { content: '▶ '; font-size: 8px; }
  details[open] > .people-summary::before { content: '▼ '; }

  .fields-details { margin-top: 4px; }
  .fields-summary {
    font-weight: bold; color: #6080a0; text-transform: uppercase;
    letter-spacing: 0.1em; font-size: 10px; cursor: pointer;
    user-select: none; list-style: none; padding: 2px 0;
  }
  .fields-summary::-webkit-details-marker { display: none; }
  .fields-summary::before { content: '▶ '; font-size: 8px; }
  details[open] > .fields-summary::before { content: '▼ '; }

  .archive-sep {
    font-size: 9px; color: #4a5a7a; text-align: center;
    margin: 8px 0 4px; letter-spacing: 0.05em;
    border-top: 1px solid #2a2a3a; padding-top: 6px;
  }
  .divider { border-top: 1px solid #2a2a3a; margin: 6px 0; }
  .section-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #505070;
    margin-top: 4px;
  }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip {
    background: #252545;
    color: #9090c0;
    font-size: 11px;
    padding: 2px 7px;
    border-radius: 8px;
  }
  .chip.person { background: #1e2e50; color: #80a8d8; }
  .chip.person.unidentified { background: #2e2010; color: #a08050; font-style: italic; }
  .chip-group { display: flex; align-items: center; background: #1e2e50; border-radius: 8px; overflow: hidden; }
  .small-fix { background: #2a3a6a; color: #a0c4ff; border: none; padding: 2px 6px; font-size: 9px; cursor: pointer; height: 100%; }
  .small-fix:hover { background: #3a4a8a; }
  .small-fix.danger-text { color: #ff8080; }
  .small-fix.danger-text:hover { background: #5a3a3a; }
  .fix-row { display: flex; gap: 4px; margin-top: 6px; }
  .no-people { font-size: 11px; color: #505070; font-style: italic; }
  .mt-4 { margin-top: 4px; }
  .full { width: 100%; }
  textarea { resize: vertical; min-height: 54px; font-size: 12px; }
  .status-msg { font-size: 11px; color: #80a080; }
  .rename-row { display: flex; gap: 6px; margin-top: 4px; }
  .flex1 { flex: 1; }
  .action-row { display: flex; gap: 6px; }
  .action-row button { flex: 1; }
</style>
