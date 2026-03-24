<script>
  import { t } from '../stores.js';
  import { onMount } from 'svelte';

  export let show = false;

  let licenses = [];
  let loading = false;
  let error = '';

  async function loadLicenses() {
    if (licenses.length > 0) return;
    loading = true;
    try {
      const res = await fetch('/licenses.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      licenses = await res.json();
    } catch (e) {
      console.warn('Could not load licenses.json:', e);
      error = e.message;
    } finally {
      loading = false;
    }
  }

  $: if (show) loadLicenses();

  function close() {
    show = false;
  }

  function handleKey(e) {
    if (e.key === 'Escape') close();
  }

  function openExternal(url) {
    if (window.electron && window.electron.openExternal) {
      window.electron.openExternal(url);
    } else {
      window.open(url, '_blank');
    }
  }
</script>

<svelte:window on:keydown={handleKey} />

{#if show}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <div class="modal-overlay" on:click|self={close}>
    <div class="modal-box">
      <div class="modal-header">
        <h3>ℹ️ {$t('tab_about')}</h3>
        <button class="close-btn" on:click={close}>✕</button>
      </div>

      <div class="modal-content">
        <section class="legal-section">
          <h4>{$t('tab_privacy')}</h4>
          <p>
            CrispLens is designed with a privacy-first approach. All face detection, recognition, 
            and image processing is performed locally on your machine or your private server. 
            No biometric data or images are sent to third-party services unless you explicitly 
            enable optional cloud features (like specific VLM providers).
          </p>
        </section>

        <section class="legal-section">
          <h4>{$t('legal_imprint')}</h4>
          <p>
            Christian Ströbele<br />
            Nikolausstr. 5<br />
            70190 Stuttgart<br />
            Deutschland/Germany
          </p>
        </section>

        <section class="legal-section">
          <h4>Contact</h4>
          <p>
            Email: <a href="mailto:postmaster@crispstro.be">postmaster@crispstro.be</a><br />
            Phone: +49 176 6421 8601
          </p>
        </section>

        <section class="legal-section">
          <h4>Disclaimer</h4>
          <p>
            This software is provided "as is", without warranty of any kind, express or implied, 
            including but not limited to the warranties of merchantability, fitness for a particular 
            purpose and noninfringement. In no event shall the authors or copyright holders be liable 
            for any claim, damages or other liability, whether in an action of contract, tort or otherwise, 
            arising from, out of or in connection with the software or the use or other dealings in the software.
          </p>
        </section>

        <div class="divider"></div>

        <section class="licenses-section">
          <h4>Open Source Licenses</h4>
          <p class="intro">
            CrispLens is built upon many open source projects. Below is a list of the libraries and components used in this application.
          </p>

          {#if loading}
            <div class="status">Loading licenses...</div>
          {:else if error}
            <div class="status error">Could not load licenses: {error}</div>
          {:else if licenses.length === 0}
            <div class="status">No license information found.</div>
          {:else}
            <div class="licenses-list">
              {#each licenses as lib}
                <div class="license-item">
                  <div class="lib-header">
                    <span class="lib-name">{lib.name}</span>
                    <span class="lib-version">v{lib.version}</span>
                    <span class="lib-source badge">{lib.source}</span>
                  </div>
                  <div class="lib-meta">
                    <span class="lib-license">{lib.license}</span>
                    {#if lib.author}
                      <span class="lib-author">by {lib.author}</span>
                    {/if}
                  </div>
                  {#if lib.link}
                    <button class="link-btn" on:click={() => openExternal(lib.link)}>
                      View Source ↗
                    </button>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </section>
      </div>

      <div class="modal-footer">
        <button on:click={close}>{$t('close')}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-overlay {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.7);
    display: flex; align-items: center; justify-content: center;
    z-index: 2100;
  }
  .modal-box {
    background: #1a1a28;
    border: 1px solid #2a2a3a;
    border-radius: 12px;
    width: min(94vw, 750px);
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 12px 50px rgba(0,0,0,0.6);
  }
  .modal-header {
    padding: 20px 24px;
    border-bottom: 1px solid #2a2a3a;
    display: flex; align-items: center; justify-content: space-between;
  }
  .modal-header h3 { margin: 0; font-size: 18px; color: #c0c8e0; font-weight: 600; }
  .close-btn {
    background: transparent; border: none; color: #505070;
    font-size: 20px; cursor: pointer; padding: 4px;
  }
  .close-btn:hover { color: #a0b0d0; }

  .modal-content {
    flex: 1;
    overflow-y: auto;
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .legal-section h4 {
    margin: 0 0 8px 0;
    font-size: 14px;
    color: #8090b8;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .legal-section p {
    margin: 0;
    font-size: 14px;
    color: #b0b8d0;
    line-height: 1.6;
  }
  .legal-section a {
    color: #64acff;
    text-decoration: none;
  }
  .legal-section a:hover {
    text-decoration: underline;
  }

  .divider {
    height: 1px;
    background: #2a2a3a;
    margin: 10px 0;
  }

  .licenses-section h4 {
    margin: 0 0 12px 0;
    font-size: 14px;
    color: #8090b8;
    text-transform: uppercase;
  }
  .intro {
    font-size: 13px;
    color: #7080a0;
    margin-bottom: 16px;
  }

  .status {
    padding: 20px;
    text-align: center;
    color: #607090;
    font-style: italic;
  }
  .status.error { color: #e07070; }

  .licenses-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 12px;
  }

  .license-item {
    background: #14141e;
    border: 1px solid #242434;
    border-radius: 8px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .lib-header {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .lib-name {
    font-weight: 600;
    color: #d0d8f0;
    font-size: 13px;
  }
  .lib-version {
    font-size: 11px;
    color: #607090;
  }
  .badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 4px;
    background: #2a2a42;
    color: #8090b8;
    border: 1px solid #3a3a5a;
  }

  .lib-meta {
    font-size: 11px;
    display: flex;
    justify-content: space-between;
    color: #7080a0;
  }
  .lib-license {
    font-weight: 600;
    color: #a0b0d0;
  }

  .link-btn {
    align-self: flex-start;
    background: transparent;
    border: none;
    color: #5a8ae0;
    font-size: 11px;
    padding: 2px 0;
    cursor: pointer;
    margin-top: 4px;
  }
  .link-btn:hover { color: #80acff; text-decoration: underline; }

  .modal-footer {
    padding: 16px 24px;
    border-top: 1px solid #2a2a3a;
    display: flex;
    justify-content: flex-end;
  }

  button {
    background: #2a2a42; color: #a0b0d0;
    border: 1px solid #3a3a5a; padding: 8px 20px;
    border-radius: 6px; font-size: 13px; cursor: pointer;
    transition: all 0.2s;
  }
  button:hover { background: #3a3a5a; color: #fff; border-color: #4a4a6a; }
</style>
