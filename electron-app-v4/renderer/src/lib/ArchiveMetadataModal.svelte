<script>
  /**
   * ArchiveMetadataModal.svelte
   * Modal for editing archive metadata (Fachbereich, Veranstaltungsnummer, etc.)
   * and triggering file organization (copy/move to Bildarchiv / Bildauswahl).
   *
   * Props:
   *   imageIds    — array of image IDs to operate on
   *   mode        — 'bildarchiv' | 'bildauswahl' | 'rename'
   *   initialMeta — optional pre-filled metadata object
   *
   * Events:
   *   close
   *   done  — { results, mode }
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import { t } from '../stores.js';
  import {
    fetchArchiveConfig, fetchArchiveChoices,
    organizeToArchive, saveToBildauswahl, renameBatchArchive,
    fetchExiftoolStatus,
  } from '../api.js';

  export let imageIds  = [];
  export let mode      = 'bildarchiv';  // 'bildarchiv' | 'bildauswahl' | 'rename'
  export let initialMeta = {};

  const dispatch = createEventDispatcher();

  // ── State ──────────────────────────────────────────────────────────────────
  let archiveConfig        = null;
  let choices              = {};
  let exiftoolAvailable    = false;
  let loading              = true;
  let running              = false;
  let error                = '';
  let resultMsg            = '';

  // Archive metadata field values (bound to inputs)
  let fachbereich          = initialMeta.fachbereich          || '';
  let veranstaltungsnummer = initialMeta.veranstaltungsnummer || '';
  let datum                = initialMeta.datum                || '';
  let veranstaltungstitel  = initialMeta.veranstaltungstitel  || '';
  let urheber              = initialMeta.urheber              || '';

  // Action settings
  let action     = 'copy';   // 'copy' | 'move' | 'leave'
  let writeExif  = false;
  let renameFile = false;    // for rename mode

  // Autocomplete dropdown state (keyed by field id)
  let dropdownOpen = {};

  // ── Dynamic field list from config ────────────────────────────────────────
  $: fields = (archiveConfig?.fields || []).slice().sort((a, b) => a.order - b.order);

  function sanitize(s) {
    if (!s) return '';
    return String(s).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').replace(/__+/g, '_').replace(/^_+|_+$/g, '');
  }

  function buildPathPreview(cfg, m, fb, vnr, dt, vtit) {
    if (!cfg) return '';
    const sKey = (m === 'bildauswahl') ? 'bildauswahl' : 'bildarchiv';
    const sectionCfg = cfg[sKey];
    if (!sectionCfg) return '';
    const d = dt ? new Date(dt) : new Date();
    const year  = isNaN(d.getTime()) ? String(new Date().getFullYear()) : String(d.getFullYear());
    const month = isNaN(d.getTime()) ? String(new Date().getMonth()+1).padStart(2,'0') : String(d.getMonth()+1).padStart(2,'0');
    const tplVars = {
      fachbereich:          sanitize(fb),
      veranstaltungstitel:  sanitize(vtit),
      veranstaltungsnummer: sanitize(vnr),
      description: '‹Namen›', names: '‹Namen›',
      year, month, counter: '001',
    };
    const expandTpl = tpl => tpl.replace(/\{([^}]+)\}/g, (_, k) => tplVars[k] ?? '');
    const folderRel   = expandTpl(sectionCfg.folder_template   || '');
    const folderClean = folderRel.split('/').filter(s => s.trim()).join('/');
    const fileBase    = expandTpl(sectionCfg.filename_template || '');
    const fileClean   = fileBase.split('_').filter(s => s.trim()).join('_').replace(/__+/g, '_');
    return `${sectionCfg.base_path}/${folderClean}/${fileClean}.{ext}`;
  }

  // ── Path preview — reactive, depends on all field vars ────────────────────
  $: pathPreview = buildPathPreview(archiveConfig, mode, fachbereich, veranstaltungsnummer, datum, veranstaltungstitel);

  // ── Field value helpers ────────────────────────────────────────────────────
  function getFieldValue(id) {
    if (id === 'fachbereich')          return fachbereich;
    if (id === 'veranstaltungsnummer') return veranstaltungsnummer;
    if (id === 'datum')                return datum;
    if (id === 'veranstaltungstitel')  return veranstaltungstitel;
    if (id === 'urheber')              return urheber;
    return '';
  }

  function setFieldValue(id, value) {
    if (id === 'fachbereich')          fachbereich = value;
    else if (id === 'veranstaltungsnummer') veranstaltungsnummer = value;
    else if (id === 'datum')           datum = value;
    else if (id === 'veranstaltungstitel') veranstaltungstitel = value;
    else if (id === 'urheber')         urheber = value;
  }

  function getFilteredChoices(fieldId) {
    const all = choices[fieldId] || [];
    const cur = getFieldValue(fieldId) || '';
    if (!cur.trim()) return all.slice(0, 12);
    return all.filter(c => c.toLowerCase().includes(cur.toLowerCase())).slice(0, 12);
  }

  // ── Load ──────────────────────────────────────────────────────────────────
  onMount(async () => {
    console.log('[ArchiveMetadataModal] onMount imageIds:', imageIds, 'mode:', mode);
    loading = true;
    try {
      [archiveConfig, choices] = await Promise.all([
        fetchArchiveConfig().catch(e => { console.warn('[ArchiveMetadataModal] fetchArchiveConfig failed:', e); return null; }),
        fetchArchiveChoices().catch(e => { console.warn('[ArchiveMetadataModal] fetchArchiveChoices failed:', e); return {}; }),
      ]);
      const statusRes = await fetchExiftoolStatus().catch(() => ({ available: false }));
      exiftoolAvailable = statusRes?.available ?? false;
      // Pre-fill action from config default
      if (archiveConfig) {
        const sKey = (mode === 'bildauswahl') ? 'bildauswahl' : 'bildarchiv';
        const sectionCfg = archiveConfig[sKey];
        if (sectionCfg?.default_action) action = sectionCfg.default_action;
      }
      console.log('[ArchiveMetadataModal] Loaded. exiftool:', exiftoolAvailable, 'fields:', archiveConfig?.fields?.length);
    } catch (e) {
      console.error('[ArchiveMetadataModal] Load error:', e);
      error = e.message;
    } finally {
      loading = false;
    }
  });

  // ── Submit ────────────────────────────────────────────────────────────────
  async function handleSubmit() {
    console.log('[ArchiveMetadataModal] handleSubmit mode:', mode, 'action:', action, 'ids:', imageIds);
    running = true; error = ''; resultMsg = '';
    const meta = { fachbereich, veranstaltungsnummer, datum, veranstaltungstitel, urheber };
    try {
      let result;
      if (mode === 'rename') {
        result = await renameBatchArchive(imageIds, meta, 'bildarchiv', renameFile);
      } else if (mode === 'bildauswahl') {
        result = await saveToBildauswahl(imageIds, meta, action, writeExif);
      } else {
        result = await organizeToArchive(imageIds, meta, action, 'bildarchiv', writeExif);
      }
      console.log('[ArchiveMetadataModal] Result:', result);
      const ok  = result.success_count ?? imageIds.length;
      const err = result.error_count   ?? 0;
      resultMsg = `${ok} ${$t('archive_done')}${err ? ' — ' + err + ' ' + $t('archive_errors') : ''}`;
      setTimeout(() => dispatch('done', { results: result, mode }), 1400);
    } catch (e) {
      console.error('[ArchiveMetadataModal] Submit error:', e);
      error = e.message;
    } finally {
      running = false;
    }
  }

  function closeDropdowns() { dropdownOpen = {}; }
</script>

<svelte:window on:click={closeDropdowns} />

<div class="modal-backdrop" on:click|self={() => dispatch('close')} role="presentation">
  <div class="modal" role="dialog" aria-modal="true">
    <!-- Header -->
    <div class="modal-header">
      <h3>
        {#if mode === 'bildauswahl'}📂 {$t('archive_bildauswahl')}
        {:else if mode === 'rename'}✏️ {$t('archive_rename_resort')}
        {:else}🗂 {$t('archive_meta_title')}{/if}
        <span class="count-badge">{imageIds.length}</span>
      </h3>
      <button class="close-btn" on:click={() => dispatch('close')}>✕</button>
    </div>

    {#if loading}
      <div class="modal-body loading">⏳ Lade Konfiguration…</div>
    {:else}
      <div class="modal-body">

        <!-- Dynamic field inputs -->
        <div class="fields-grid">
          {#each fields as field (field.id)}
            <div class="field-row">
              <label class="field-label" for="amf-{field.id}">
                {field.label}{#if field.required}<span class="req">*</span>{/if}
              </label>

              {#if field.type === 'select'}
                <select
                  id="amf-{field.id}"
                  class="field-input"
                  value={getFieldValue(field.id)}
                  on:change={e => setFieldValue(field.id, e.target.value)}
                >
                  <option value="">— wählen —</option>
                  {#each (field.choices || []) as choice (choice)}
                    <option value={choice}>{choice}</option>
                  {/each}
                </select>

              {:else if field.type === 'date'}
                <input
                  id="amf-{field.id}"
                  type="date"
                  class="field-input"
                  value={getFieldValue(field.id)}
                  on:change={e => setFieldValue(field.id, e.target.value)}
                />

              {:else}
                <!-- Text + autocomplete -->
                <div class="autocomplete-wrap" on:click|stopPropagation>
                  <input
                    id="amf-{field.id}"
                    type="text"
                    class="field-input"
                    value={getFieldValue(field.id)}
                    placeholder="{field.label} eingeben…"
                    on:input={e => { setFieldValue(field.id, e.target.value); dropdownOpen = { ...dropdownOpen, [field.id]: true }; }}
                    on:focus={() => dropdownOpen = { ...dropdownOpen, [field.id]: true }}
                    on:blur={() => setTimeout(() => { dropdownOpen = { ...dropdownOpen, [field.id]: false }; }, 150)}
                  />
                  {#if dropdownOpen[field.id]}
                    {@const filtered = getFilteredChoices(field.id)}
                    {#if filtered.length}
                      <div class="autocomplete-dropdown">
                        {#each filtered as choice (choice)}
                          <button
                            class="autocomplete-opt"
                            on:mousedown|preventDefault={() => { setFieldValue(field.id, choice); dropdownOpen = { ...dropdownOpen, [field.id]: false }; }}
                          >{choice}</button>
                        {/each}
                      </div>
                    {/if}
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
        </div>

        <!-- Action row (not for rename) -->
        {#if mode !== 'rename'}
          <div class="section-divider"></div>
          <div class="field-row">
            <label class="field-label">{$t('archive_action')}</label>
            <select class="field-input" bind:value={action}>
              <option value="copy">{$t('archive_action_copy')}</option>
              <option value="move">{$t('archive_action_move')}</option>
              <option value="leave">{$t('archive_action_leave')}</option>
            </select>
          </div>
          <label class="checkbox-row" style="margin-top:6px">
            <input type="checkbox" bind:checked={writeExif} disabled={!exiftoolAvailable} />
            {$t('archive_write_exif')}
            {#if !exiftoolAvailable}<span class="dim"> (exiftool nicht verfügbar)</span>{/if}
          </label>
        {:else}
          <div class="section-divider"></div>
          <label class="checkbox-row">
            <input type="checkbox" bind:checked={renameFile} />
            {$t('archive_rename_file')}
          </label>
        {/if}

        <!-- Path preview -->
        {#if pathPreview && mode !== 'rename'}
          <div class="path-preview">
            <span class="path-label">{$t('archive_path_preview')}:</span>
            <code>{pathPreview}</code>
          </div>
        {/if}

        <!-- Result / error -->
        {#if resultMsg}<div class="result-msg success">✓ {resultMsg}</div>{/if}
        {#if error}<div class="result-msg error">✗ {error} <button class="err-dismiss" on:click={() => error = ''}>✕</button></div>{/if}
      </div>

      <div class="modal-footer">
        <button class="btn-secondary" on:click={() => dispatch('close')} disabled={running}>{$t('cancel')}</button>
        <button class="btn-primary" on:click={handleSubmit} disabled={running || imageIds.length === 0}>
          {#if running}⏳ {$t('archive_organizing')}
          {:else if mode === 'rename'}✏️ {$t('archive_rename_resort')}
          {:else if mode === 'bildauswahl'}📂 {$t('archive_bildauswahl')}
          {:else}🗂 {action === 'move' ? 'Verschieben' : action === 'copy' ? 'Kopieren' : 'Metadaten speichern'}
          {/if}
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.72);
    display: flex; align-items: center; justify-content: center; z-index: 200;
  }
  .modal {
    background: #1e1e2e; border: 1px solid #4a4a6a; border-radius: 12px;
    width: min(540px, 95vw); max-height: 88vh; display: flex; flex-direction: column;
    box-shadow: 0 20px 60px rgba(0,0,0,0.65);
  }
  .modal-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 20px; border-bottom: 1px solid #3a3a5a;
  }
  .modal-header h3 { margin: 0; font-size: 14px; color: #e0e0f0; display: flex; align-items: center; gap: 8px; }
  .count-badge { background: #3a4a6a; color: #a0c4ff; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .close-btn { background: none; border: none; color: #606080; font-size: 16px; cursor: pointer; padding: 4px 8px; }
  .close-btn:hover { color: #d0d0f0; }

  .modal-body { padding: 16px 20px; overflow-y: auto; flex: 1; }
  .modal-body.loading { display: flex; align-items: center; justify-content: center; min-height: 100px; color: #808090; font-size: 13px; }

  .fields-grid { display: flex; flex-direction: column; gap: 10px; }
  .field-row { display: flex; flex-direction: column; gap: 4px; }
  .field-label { font-size: 10px; color: #8080a0; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
  .req { color: #ff6060; margin-left: 2px; }
  .field-input {
    background: #252538; border: 1px solid #4a4a6a; border-radius: 6px;
    color: #e0e0f0; padding: 7px 10px; font-size: 13px; width: 100%; box-sizing: border-box;
  }
  .field-input:focus { outline: none; border-color: #6a8fff; }
  select.field-input { cursor: pointer; }

  .autocomplete-wrap { position: relative; }
  .autocomplete-dropdown {
    position: absolute; top: calc(100% + 3px); left: 0; right: 0; z-index: 300;
    background: #252538; border: 1px solid #4a4a6a; border-radius: 6px;
    max-height: 160px; overflow-y: auto; box-shadow: 0 8px 24px rgba(0,0,0,0.55);
  }
  .autocomplete-opt {
    display: block; width: 100%; text-align: left; background: none; border: none;
    color: #d0d0e0; padding: 6px 10px; font-size: 12px; cursor: pointer;
  }
  .autocomplete-opt:hover { background: #3a3a5a; color: #a0c4ff; }

  .section-divider { height: 1px; background: #3a3a5a; margin: 12px 0; }

  .checkbox-row { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #c0c0d8; cursor: pointer; }
  .checkbox-row input { accent-color: #6a8fff; }
  .dim { color: #505070; font-size: 11px; }

  .path-preview {
    margin-top: 10px; background: #141420; border: 1px solid #3a3a5a; border-radius: 6px;
    padding: 8px 10px; font-size: 11px; word-break: break-all;
  }
  .path-label { color: #707090; margin-right: 4px; }
  code { color: #a0c4ff; font-family: monospace; }

  .result-msg { margin-top: 10px; padding: 7px 12px; border-radius: 6px; font-size: 12px; display: flex; align-items: center; gap: 8px; }
  .result-msg.success { background: #0a2a1a; border: 1px solid #2a6a3a; color: #60d080; }
  .result-msg.error   { background: #2a0a0a; border: 1px solid #6a2a2a; color: #ff7070; }
  .err-dismiss { background: none; border: none; color: #ff7070; cursor: pointer; font-size: 12px; padding: 0 2px; margin-left: auto; }

  .modal-footer {
    padding: 12px 20px; border-top: 1px solid #3a3a5a;
    display: flex; justify-content: flex-end; gap: 8px;
  }
  .btn-primary {
    background: #3a5aaf; color: #e0e8ff; border: none; border-radius: 6px;
    padding: 8px 18px; font-size: 13px; cursor: pointer; font-weight: 500;
  }
  .btn-primary:hover:not(:disabled) { background: #4a6abf; }
  .btn-primary:disabled { opacity: 0.5; cursor: default; }
  .btn-secondary {
    background: #252538; color: #b0b0c8; border: 1px solid #4a4a6a; border-radius: 6px;
    padding: 8px 18px; font-size: 13px; cursor: pointer;
  }
  .btn-secondary:hover:not(:disabled) { background: #3a3a5a; }
  .btn-secondary:disabled { opacity: 0.5; }
</style>
