<script>
  import { createEventDispatcher } from 'svelte';
  import { acceptNcLicense } from '../api.js';

  export let show = false;

  const dispatch = createEventDispatcher();

  let confirmNonCommercial = false;
  let confirmResponsibility = false;
  let accepting = false;
  let errorMsg = '';

  $: canAccept = confirmNonCommercial && confirmResponsibility;

  async function doAccept() {
    if (!canAccept) return;
    accepting = true;
    errorMsg = '';
    try {
      await acceptNcLicense();
      show = false;
      dispatch('accepted');
    } catch (e) {
      errorMsg = e.message || 'Failed to save license acceptance.';
    } finally {
      accepting = false;
    }
  }

  function doDecline() {
    show = false;
    dispatch('declined');
  }

  function openExternal(url) {
    if (window.electron && window.electron.openExternal) {
      window.electron.openExternal(url);
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }
</script>

{#if show}
  <div class="overlay" role="dialog" aria-modal="true" aria-labelledby="license-title">
    <div class="modal-box">
      <div class="modal-header">
        <h3 id="license-title">Model License &amp; Legal Notice</h3>
      </div>

      <div class="modal-content">

        <!-- ── General disclaimer ───────────────────────────────────── -->
        <section class="section warning-section">
          <h4>Legal Disclaimer</h4>
          <p>
            CrispLens is provided <strong>"as is"</strong>, without warranty of any kind.
            Facial recognition involves the collection and processing of biometric data.
            <strong>You are solely responsible for ensuring compliance with all applicable
            local, state, and international laws</strong>, including but not limited to:
          </p>
          <ul>
            <li>Biometric privacy laws (BIPA, GDPR Art. 9, CCPA, PIPL, etc.)</li>
            <li>Data protection and consent requirements</li>
            <li>Applicable patent law (face recognition algorithms may be patented)</li>
            <li>Any sector-specific regulations (employment, health, law enforcement, etc.)</li>
          </ul>
          <p>
            The authors and contributors of CrispLens assume <strong>no liability</strong> for
            any misuse, legal infringement, damages, or consequences arising from your use of
            this software or the AI models it downloads.
          </p>
        </section>

        <!-- ── InsightFace / buffalo_l NC license ──────────────────── -->
        <section class="section nc-section">
          <h4>InsightFace Models — Non-Commercial License Required</h4>
          <p>
            The default face recognition models (<strong>buffalo_l</strong>: SCRFD-10GF detector
            + ArcFace R50 embedder) are developed by the
            <button class="link-btn" on:click={() => openExternal('https://github.com/deepinsight/insightface')}>InsightFace project</button>
            and released under a <strong>non-commercial research license</strong>.
          </p>
          <div class="license-box">
            <strong>Key restrictions:</strong>
            <ul>
              <li>Free for academic and personal (non-commercial) use only.</li>
              <li>Commercial use requires a separate written agreement with the InsightFace team.</li>
              <li>The ArcFace algorithm may be subject to patent protections.</li>
              <li>Model weights must not be redistributed without permission.</li>
            </ul>
            <p class="license-links">
              <button class="link-btn" on:click={() => openExternal('https://github.com/deepinsight/insightface/tree/master/model_zoo')}>
                InsightFace model zoo license ↗
              </button>
              &nbsp;·&nbsp;
              <button class="link-btn" on:click={() => openExternal('https://insightface.ai/')}>
                InsightFace commercial licensing ↗
              </button>
            </p>
          </div>
          <p class="free-alt">
            <strong>Commercially-free alternatives:</strong>
            <br>• <strong>YuNet</strong> (Apache 2.0) — face <em>detection only</em>, no
            recognition/embedding. Select "YuNet" in Settings → Detection Model.
            <br>• <strong>dlib</strong> (BSL-1.0 / MIT) — full detection + 128-D recognition,
            commercially permissive. Available in the Python v2 backend.
            <br>• <strong>AuraFace-v1</strong> (fal.ai, Apache 2.0) — 512-D recognition,
            commercially permissive, ~2–4% below ArcFace accuracy. Select in Settings → Embedding Model.
            <br>• <strong>SFace</strong> (OpenCV Zoo, Apache 2.0) — 128-D recognition,
            commercially permissive. Select in Settings → Embedding Model.
          </p>
        </section>

        <!-- ── Checkboxes ───────────────────────────────────────────── -->
        <section class="section checks-section">
          <label class="check-label" class:checked={confirmNonCommercial}>
            <input type="checkbox" bind:checked={confirmNonCommercial} />
            <span>
              I confirm that I will use CrispLens and the InsightFace buffalo_l models
              <strong>for non-commercial purposes only</strong> (personal, academic, or research use).
              I understand that commercial use requires a separate license from InsightFace.
            </span>
          </label>

          <label class="check-label" class:checked={confirmResponsibility}>
            <input type="checkbox" bind:checked={confirmResponsibility} />
            <span>
              I accept full responsibility for legal compliance, including privacy laws,
              biometric data regulations, and any applicable patent obligations in my jurisdiction.
              I have read and understood the disclaimer above.
            </span>
          </label>
        </section>

        {#if errorMsg}
          <div class="error-msg">{errorMsg}</div>
        {/if}

      </div>

      <div class="modal-footer">
        <button class="btn-decline" on:click={doDecline} disabled={accepting}>
          Use Free Models Only (YuNet + AuraFace-v1, Apache 2.0)
        </button>
        <button
          class="btn-accept"
          class:disabled={!canAccept}
          on:click={doAccept}
          disabled={!canAccept || accepting}
        >
          {#if accepting}Saving…{:else}Accept &amp; Download Models (Non-commercial use only){/if}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.85);
    display: flex; align-items: center; justify-content: center;
    z-index: 9000;
    padding: 16px;
  }

  .modal-box {
    background: #13131f;
    border: 1px solid #3a3a5a;
    border-radius: 12px;
    width: min(96vw, 760px);
    max-height: 92vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 16px 60px rgba(0, 0, 0, 0.8);
  }

  .modal-header {
    padding: 20px 24px 16px;
    border-bottom: 1px solid #2a2a3a;
  }
  .modal-header h3 {
    margin: 0;
    font-size: 17px;
    color: #e0c080;
    font-weight: 700;
  }

  .modal-content {
    flex: 1;
    overflow-y: auto;
    padding: 20px 24px;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  .section h4 {
    margin: 0 0 10px 0;
    font-size: 12px;
    color: #8090b8;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 700;
  }
  .section p, .section li {
    font-size: 13px;
    color: #b0b8d0;
    line-height: 1.65;
  }
  .section ul {
    margin: 6px 0 10px 18px;
    padding: 0;
  }
  .section li { margin-bottom: 3px; }

  .warning-section {
    background: #1c1412;
    border: 1px solid #5a3a20;
    border-radius: 8px;
    padding: 14px 16px;
  }
  .warning-section h4 { color: #c07030; }
  .warning-section p, .warning-section li { color: #c0a880; }
  .warning-section strong { color: #e0c080; }

  .nc-section {
    background: #12141c;
    border: 1px solid #2a3a5a;
    border-radius: 8px;
    padding: 14px 16px;
  }

  .license-box {
    background: #0e1018;
    border: 1px solid #2a2a42;
    border-radius: 6px;
    padding: 12px 14px;
    margin: 10px 0;
    font-size: 13px;
    color: #a0b0d0;
  }
  .license-box strong { color: #c0d0f0; display: block; margin-bottom: 6px; }
  .license-box ul { margin: 6px 0 0 16px; }
  .license-box li { color: #9090b8; margin-bottom: 4px; }

  .license-links {
    margin: 10px 0 0 0;
    font-size: 12px;
    color: #6080a0;
  }

  .free-alt {
    background: #101810;
    border-left: 3px solid #3a6a3a;
    padding: 8px 12px;
    border-radius: 0 6px 6px 0;
    margin-top: 8px;
    font-size: 12px;
    color: #80a880;
  }

  .checks-section {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .check-label {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    background: #161620;
    border: 1px solid #2a2a42;
    border-radius: 8px;
    padding: 12px 14px;
    cursor: pointer;
    transition: border-color 0.2s, background 0.2s;
    font-size: 13px;
    color: #a0b0d0;
    line-height: 1.55;
  }
  .check-label.checked {
    border-color: #4a7a4a;
    background: #111a11;
  }
  .check-label input[type="checkbox"] {
    margin-top: 2px;
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    accent-color: #4a9a4a;
    cursor: pointer;
  }
  .check-label strong { color: #d0d8f0; }

  .error-msg {
    background: #2a1a1a;
    border: 1px solid #6a2a2a;
    color: #e08080;
    border-radius: 6px;
    padding: 10px 14px;
    font-size: 13px;
  }

  .modal-footer {
    padding: 16px 24px;
    border-top: 1px solid #2a2a3a;
    display: flex;
    gap: 10px;
    justify-content: flex-end;
    flex-wrap: wrap;
  }

  .btn-decline {
    background: #1e1e2e;
    border: 1px solid #3a3a5a;
    color: #8090b0;
    padding: 9px 16px;
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.2s;
  }
  .btn-decline:hover { background: #2a2a42; color: #a0b0d0; }

  .btn-accept {
    background: #2a5a2a;
    border: 1px solid #4a8a4a;
    color: #a0e0a0;
    padding: 9px 20px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }
  .btn-accept:hover:not(.disabled):not(:disabled) { background: #3a7a3a; color: #c0f0c0; }
  .btn-accept.disabled, .btn-accept:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .link-btn {
    background: none;
    border: none;
    color: #5a8ae0;
    font-size: inherit;
    cursor: pointer;
    padding: 0;
    text-decoration: underline;
    text-decoration-style: dotted;
  }
  .link-btn:hover { color: #80acff; }
</style>
