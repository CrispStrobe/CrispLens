<script>
  import { onMount } from 'svelte';
  import { t } from '../stores.js';
  import {
    fetchCloudDrives, createCloudDrive, updateCloudDrive, deleteCloudDrive,
    getCloudDriveConfig, testCloudDrive, mountCloudDrive, unmountCloudDrive,
    isLocalMode,
  } from '../api.js';

  const DRIVE_TYPES = ['smb', 'sftp', 'filen', 'internxt'];
  const localMode = isLocalMode();

  let drives = [];
  let loading = false;
  let error = '';

  // Modal state
  let showModal = false;
  let editingId = null;   // null = create
  let saving = false;
  let testResult = null;  // { ok, message }
  let testing = false;

  // Form fields
  let form = emptyForm();

  function emptyForm() {
    return {
      name: '',
      type: 'smb',
      mount_point: '',
      scope: 'system',
      allowed_roles: ['admin', 'medienverwalter'],
      auto_mount: false,
      read_only: false,
      // SMB
      server: '', share: '', username: '', password: '', domain: '',
      // SFTP
      host: '', port: 22, remote_path: '/', ssh_key: '',
      // Filen / Internxt
      email: '', cloud_password: '', tfa_code: '',
    };
  }

  function buildConfig(f) {
    if (f.type === 'smb') {
      return { server: f.server, share: f.share, username: f.username,
               password: f.password, domain: f.domain, read_only: f.read_only };
    } else if (f.type === 'sftp') {
      return { server: f.host, port: Number(f.port), username: f.username,
               password: f.password, remote_path: f.remote_path, ssh_key: f.ssh_key };
    } else {
      return { email: f.email, password: f.cloud_password, tfa_code: f.tfa_code };
    }
  }

  async function load() {
    if (localMode) { drives = []; return; }
    loading = true; error = '';
    try {
      drives = await fetchCloudDrives();
    } catch (e) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  function openCreate() {
    editingId = null;
    form = emptyForm();
    testResult = null;
    showModal = true;
  }

  async function openEdit(drive) {
    editingId = drive.id;
    // Start with non-credential fields (always available)
    form = {
      ...emptyForm(),
      name: drive.name,
      type: drive.type,
      mount_point: drive.mount_point || '',
      scope: drive.scope || 'system',
      allowed_roles: Array.isArray(drive.allowed_roles) ? [...drive.allowed_roles] : ['admin', 'medienverwalter'],
      auto_mount: !!drive.auto_mount,
    };
    testResult = null;
    showModal = true;

    // Fetch decrypted config to pre-fill credential fields
    try {
      const cfg = await getCloudDriveConfig(drive.id);
      if (drive.type === 'smb') {
        form = { ...form,
          server: cfg.server || '', share: cfg.share || '',
          username: cfg.username || '', password: cfg.password || '',
          domain: cfg.domain || '', read_only: !!cfg.read_only,
        };
      } else if (drive.type === 'sftp') {
        form = { ...form,
          host: cfg.server || '', port: cfg.port || 22,
          username: cfg.username || '', password: cfg.password || '',
          remote_path: cfg.remote_path || '/', ssh_key: cfg.ssh_key || '',
        };
      } else {
        // filen / internxt
        form = { ...form,
          email: cfg.email || '', cloud_password: cfg.password || '',
          tfa_code: cfg.tfa_code || '',
        };
      }
    } catch (e) {
      // Non-fatal — user can re-enter credentials
      error = `Could not load credentials: ${e.message}`;
    }
  }

  async function saveDrive() {
    saving = true; error = '';
    try {
      const body = {
        name: form.name,
        type: form.type,
        config: buildConfig(form),
        mount_point: form.mount_point || null,
        scope: form.scope,
        allowed_roles: form.allowed_roles,
        auto_mount: form.auto_mount,
      };
      if (editingId) {
        await updateCloudDrive(editingId, body);
      } else {
        await createCloudDrive(body);
      }
      showModal = false;
      await load();
    } catch (e) {
      error = e.message;
    } finally {
      saving = false;
    }
  }

  async function deleteDrive(id) {
    if (!confirm($t('drive_delete_confirm'))) return;
    try {
      await deleteCloudDrive(id);
      await load();
    } catch (e) {
      alert(e.message);
    }
  }

  async function mountDrive(drive) {
    try {
      if (drive.is_mounted) {
        await unmountCloudDrive(drive.id);
      } else {
        await mountCloudDrive(drive.id);
      }
      await load();
    } catch (e) {
      alert(e.message);
    }
  }

  async function testConnection() {
    testing = true; testResult = null;
    try {
      const data = await testCloudDrive(form.type, buildConfig(form));
      testResult = data;
    } catch (e) {
      testResult = { ok: false, message: e.message };
    } finally {
      testing = false;
    }
  }

  function driveStatusLabel(drive) {
    if (drive.type === 'smb' || drive.type === 'sftp') {
      return drive.is_mounted ? $t('drive_status_mounted') : $t('drive_status_offline');
    }
    return drive.is_mounted ? $t('drive_status_connected') : $t('drive_status_offline');
  }

  function driveActionLabel(drive) {
    if (drive.type === 'smb' || drive.type === 'sftp') {
      return drive.is_mounted ? $t('drive_unmount') : $t('drive_mount');
    }
    return drive.is_mounted ? $t('drive_disconnect') : $t('drive_connect');
  }

  function toggleRole(role) {
    if (form.allowed_roles.includes(role)) {
      form.allowed_roles = form.allowed_roles.filter(r => r !== role);
    } else {
      form.allowed_roles = [...form.allowed_roles, role];
    }
  }

  onMount(load);
</script>

<div class="cd-view">
  <!-- Header -->
  <div class="header">
    <h2>{$t('cloud_drives')}</h2>
    <div class="header-actions">
      <button on:click={load} title={$t('refresh')}>🔄</button>
      <button class="primary" on:click={openCreate}>+ {$t('add_drive')}</button>
    </div>
  </div>

  {#if localMode}
    <div class="info-banner">☁️ Cloud drives require a server connection. Switch to server mode in Settings to use this feature.</div>
  {/if}

  {#if error}
    <div class="err-banner">{error}</div>
  {/if}

  {#if loading}
    <div class="empty">{$t('loading')}</div>
  {:else if drives.length === 0}
    <div class="empty">
      <div class="empty-icon">☁️</div>
      <p>{$t('no_cloud_drives')}</p>
      <p class="hint">{$t('no_cloud_drives_hint')}</p>
    </div>
  {:else}
    <div class="drives-list">
      {#each drives as drive (drive.id)}
        <div class="drive-card" class:mounted={drive.is_mounted}>
          <div class="drive-info">
            <span class="drive-icon">{drive.type === 'smb' ? '🗄' : drive.type === 'sftp' ? '🔒' : drive.type === 'filen' ? '☁' : '🌐'}</span>
            <div class="drive-meta">
              <span class="drive-name">{drive.name}</span>
              <span class="drive-type-badge">{drive.type.toUpperCase()}</span>
              {#if drive.mount_point}
                <span class="drive-path">{drive.mount_point}</span>
              {/if}
            </div>
          </div>
          <div class="drive-right">
            <span class="status-dot" class:on={drive.is_mounted}></span>
            <span class="status-label">{driveStatusLabel(drive)}</span>
            {#if drive.last_error && !drive.is_mounted}
              <span class="err-tip" title={drive.last_error}>⚠</span>
            {/if}
            <button class="sm" on:click={() => mountDrive(drive)}>
              {driveActionLabel(drive)}
            </button>
            <button class="sm muted" on:click={() => openEdit(drive)}>{$t('drive_edit')}</button>
            <button class="sm danger" on:click={() => deleteDrive(drive.id)}>{$t('drive_delete')}</button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<!-- Add / Edit Modal -->
{#if showModal}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <div class="modal-backdrop" on:click|self={() => showModal = false}>
    <div class="modal">
      <div class="modal-header">
        <h3>{editingId ? $t('drive_edit') : $t('add_drive')}</h3>
        <button class="close-btn" on:click={() => showModal = false}>✕</button>
      </div>

      <div class="modal-body">
        <!-- Common fields -->
        <label class="field">
          <span>{$t('drive_name')}</span>
          <input type="text" bind:value={form.name} placeholder={$t('drive_placeholder_name')} />
        </label>

        <label class="field">
          <span>{$t('drive_type')}</span>
          <select bind:value={form.type}>
            {#each DRIVE_TYPES as t}
              <option value={t}>{t.toUpperCase()}</option>
            {/each}
          </select>
        </label>

        <!-- SMB fields -->
        {#if form.type === 'smb'}
          <label class="field">
            <span>{$t('drive_server')}</span>
            <input type="text" bind:value={form.server} placeholder={$t('drive_placeholder_server')} />
          </label>
          <label class="field">
            <span>{$t('drive_share')}</span>
            <input type="text" bind:value={form.share} placeholder={$t('drive_placeholder_share')} />
          </label>
          <label class="field">
            <span>{$t('drive_username')}</span>
            <input type="text" bind:value={form.username} autocomplete="username" />
          </label>
          <label class="field">
            <span>{$t('drive_password')}</span>
            <input type="password" bind:value={form.password} autocomplete="current-password" />
          </label>
          <label class="field">
            <span>{$t('drive_domain')}</span>
            <input type="text" bind:value={form.domain} />
          </label>
          <label class="field">
            <span>{$t('drive_mount_point')}</span>
            <input type="text" bind:value={form.mount_point} placeholder={$t('drive_placeholder_mount_smb')} />
          </label>
          <label class="field inline">
            <input type="checkbox" bind:checked={form.read_only} />
            <span>{$t('drive_read_only')}</span>
          </label>
        {/if}

        <!-- SFTP fields -->
        {#if form.type === 'sftp'}
          <label class="field">
            <span>{$t('drive_host')}</span>
            <input type="text" bind:value={form.host} placeholder={$t('drive_placeholder_host')} />
          </label>
          <label class="field">
            <span>{$t('drive_port')}</span>
            <input type="number" bind:value={form.port} min="1" max="65535" />
          </label>
          <label class="field">
            <span>{$t('drive_username')}</span>
            <input type="text" bind:value={form.username} autocomplete="username" />
          </label>
          <label class="field">
            <span>{$t('drive_password')}</span>
            <input type="password" bind:value={form.password} autocomplete="current-password" />
          </label>
          <label class="field">
            <span>{$t('drive_ssh_key')}</span>
            <input type="text" bind:value={form.ssh_key} placeholder={$t('drive_placeholder_ssh_key')} />
          </label>
          <label class="field">
            <span>{$t('drive_remote_path')}</span>
            <input type="text" bind:value={form.remote_path} placeholder={$t('drive_placeholder_remote_path')} />
          </label>
          <label class="field">
            <span>{$t('drive_mount_point')}</span>
            <input type="text" bind:value={form.mount_point} placeholder={$t('drive_placeholder_mount_sftp')} />
          </label>
        {/if}

        <!-- Filen / Internxt fields -->
        {#if form.type === 'filen' || form.type === 'internxt'}
          <label class="field">
            <span>{$t('drive_email')}</span>
            <input type="email" bind:value={form.email} autocomplete="email" />
          </label>
          <label class="field">
            <span>{$t('drive_password')}</span>
            <input type="password" bind:value={form.cloud_password} autocomplete="current-password" />
          </label>
          <label class="field">
            <span>{$t('drive_tfa')}</span>
            <input type="text" bind:value={form.tfa_code} placeholder={$t('drive_placeholder_tfa')} />
          </label>
        {/if}

        <!-- Access control -->
        <div class="field">
          <span>{$t('drive_scope')}</span>
          <div class="radio-row">
            <label class="radio">
              <input type="radio" bind:group={form.scope} value="system" />
              {$t('drive_scope_system')}
            </label>
            <label class="radio">
              <input type="radio" bind:group={form.scope} value="user" />
              {$t('drive_scope_user')}
            </label>
          </div>
        </div>

        <div class="field">
          <span>{$t('drive_allowed_roles')}</span>
          <div class="roles-row">
            {#each ['admin', 'medienverwalter', 'user'] as role}
              <label class="role-chip" class:active={form.allowed_roles.includes(role)}>
                <input type="checkbox"
                  checked={form.allowed_roles.includes(role)}
                  on:change={() => toggleRole(role)} />
                {role}
              </label>
            {/each}
          </div>
        </div>

        <label class="field inline">
          <input type="checkbox" bind:checked={form.auto_mount} />
          <span>{$t('drive_auto_mount')}</span>
        </label>

        <!-- Test result -->
        {#if testResult}
          <div class="test-result" class:ok={testResult.ok}>
            {testResult.ok ? '✅' : '❌'} {testResult.message}
          </div>
        {/if}
      </div>

      <div class="modal-footer">
        <button on:click={testConnection} disabled={testing}>
          {testing ? '…' : $t('drive_test')}
        </button>
        <div class="spacer"></div>
        <button on:click={() => showModal = false}>{$t('cancel')}</button>
        <button class="primary" on:click={saveDrive} disabled={saving || !form.name}>
          {saving ? '…' : $t('drive_save')}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .cd-view {
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
  }
  .header h2 { font-size: 15px; font-weight: 600; color: #c0c8e0; margin: 0; }
  .header-actions { display: flex; gap: 8px; }

  .info-banner {
    background: #1a1a2a;
    color: #8090b8;
    padding: 8px 16px;
    font-size: 12px;
    border-bottom: 1px solid #2a2a4a;
  }
  .err-banner {
    background: #2a1a1a;
    color: #e08080;
    padding: 8px 16px;
    font-size: 12px;
    border-bottom: 1px solid #3a2a2a;
  }

  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: #505070;
    font-size: 13px;
  }
  .empty-icon { font-size: 40px; }
  .hint { font-size: 11px; color: #404060; }

  .drives-list {
    flex: 1;
    overflow-y: auto;
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .drive-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: #1a1a2a;
    border: 1px solid #2a2a3a;
    border-radius: 8px;
    padding: 12px 14px;
    gap: 12px;
    flex-wrap: wrap;
  }
  .drive-card.mounted { border-color: #2a4a2a; }

  .drive-info { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
  .drive-icon { font-size: 22px; flex-shrink: 0; }
  .drive-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
  .drive-name { font-size: 13px; font-weight: 600; color: #c0c8e0; }
  .drive-type-badge {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 4px;
    background: #252540;
    color: #6070a0;
    font-weight: 600;
  }
  .drive-path { font-size: 11px; color: #505070; word-break: break-all; }

  .drive-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; flex-wrap: wrap; }
  .status-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: #404060;
    flex-shrink: 0;
  }
  .status-dot.on { background: #40a060; }
  .status-label { font-size: 11px; color: #607090; }
  .err-tip { color: #c09030; cursor: help; }

  .sm { font-size: 11px; padding: 3px 8px; border-radius: 4px; }
  .muted { color: #505070; background: transparent; }
  .muted:hover { background: #2a2a42; color: #8090b8; }
  .danger { color: #c05050; background: transparent; }
  .danger:hover { background: #2a1a1a; color: #e06060; }

  /* Modal */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }
  .modal {
    background: #1a1a2e;
    border: 1px solid #2a2a4a;
    border-radius: 10px;
    width: 480px;
    max-width: 95vw;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
  }
  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border-bottom: 1px solid #2a2a3a;
    flex-shrink: 0;
  }
  .modal-header h3 { font-size: 14px; font-weight: 600; color: #c0c8e0; margin: 0; }
  .close-btn { background: transparent; color: #607090; font-size: 14px; padding: 2px 6px; }
  .close-btn:hover { color: #e0e0f0; }

  .modal-body {
    padding: 14px 16px;
    overflow-y: auto;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .field > span {
    font-size: 11px;
    color: #6080a0;
    font-weight: 500;
  }
  .field input, .field select {
    background: #111120;
    border: 1px solid #2a2a4a;
    border-radius: 4px;
    color: #c0c8e0;
    font-size: 12px;
    padding: 5px 8px;
  }
  .field.inline {
    flex-direction: row;
    align-items: center;
    gap: 8px;
  }
  .field.inline span { font-size: 12px; }
  .radio-row, .roles-row {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
  }
  .radio { display: flex; align-items: center; gap: 5px; font-size: 12px; color: #8090b8; cursor: pointer; }
  .role-chip {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    padding: 3px 8px;
    border-radius: 10px;
    background: #1e1e30;
    border: 1px solid #3a3a5a;
    color: #8090b8;
    cursor: pointer;
    transition: background 0.12s;
  }
  .role-chip.active { background: #2a3a5a; border-color: #4a6aaa; color: #a0c4ff; }
  .role-chip input { display: none; }

  .test-result {
    padding: 8px 10px;
    border-radius: 5px;
    font-size: 12px;
    background: #1a1a10;
    border: 1px solid #3a3a20;
    color: #c09040;
  }
  .test-result.ok { background: #101a10; border-color: #203a20; color: #60a060; }

  .modal-footer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid #2a2a3a;
    flex-shrink: 0;
  }
  .spacer { flex: 1; }
</style>
