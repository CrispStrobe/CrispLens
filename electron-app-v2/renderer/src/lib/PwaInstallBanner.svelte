<script>
  import { onMount } from 'svelte';

  let deferredPrompt = null;
  let visible = false;

  onMount(() => {
    // Not relevant in Electron (no beforeinstallprompt event fires there anyway)
    if (window.electronAPI) return;
    // Already installed — running as standalone PWA
    if (window.matchMedia('(display-mode: standalone)').matches) return;
    // User previously dismissed
    if (localStorage.getItem('pwa_install_dismissed')) return;

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      visible = true;
    });

    // Hide banner if the PWA gets installed from somewhere else
    window.addEventListener('appinstalled', () => { visible = false; });
  });

  async function install() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    visible = false;
    if (outcome === 'dismissed') {
      localStorage.setItem('pwa_install_dismissed', '1');
    }
  }

  function dismiss() {
    visible = false;
    localStorage.setItem('pwa_install_dismissed', '1');
  }
</script>

{#if visible}
  <div class="pwa-banner" role="banner">
    <img src="/icons/icon-72.png" alt="CrispLens" class="pwa-icon" />
    <div class="pwa-text">
      <strong>Install CrispLens</strong>
      <span>Add to your home screen for quick access</span>
    </div>
    <button class="pwa-install" on:click={install}>Install</button>
    <button class="pwa-dismiss" on:click={dismiss} title="Dismiss">✕</button>
  </div>
{/if}

<style>
  .pwa-banner {
    position: fixed;
    bottom: 28px;
    left: 50%;
    transform: translateX(-50%);
    background: #1e1e3a;
    border: 1px solid #3a4a7a;
    border-radius: 12px;
    padding: 10px 14px;
    display: flex;
    align-items: center;
    gap: 12px;
    box-shadow: 0 4px 32px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(74,111,165,0.2);
    z-index: 9999;
    max-width: 440px;
    width: calc(100vw - 40px);
    animation: slide-up 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
  }

  @keyframes slide-up {
    from { opacity: 0; transform: translateX(-50%) translateY(24px); }
    to   { opacity: 1; transform: translateX(-50%) translateY(0);    }
  }

  .pwa-icon {
    width: 40px;
    height: 40px;
    border-radius: 8px;
    flex-shrink: 0;
  }

  .pwa-text {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .pwa-text strong {
    font-size: 13px;
    color: #e0e8ff;
    font-weight: 600;
  }

  .pwa-text span {
    font-size: 11px;
    color: #7080a8;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pwa-install {
    background: #4a6fa5;
    color: #fff;
    border: none;
    border-radius: 7px;
    padding: 6px 16px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.15s;
  }

  .pwa-install:hover { background: #5a85c0; }

  .pwa-dismiss {
    background: transparent;
    border: none;
    color: #5060a0;
    font-size: 15px;
    cursor: pointer;
    padding: 4px 6px;
    flex-shrink: 0;
    line-height: 1;
    border-radius: 4px;
    transition: color 0.15s, background 0.15s;
  }

  .pwa-dismiss:hover {
    color: #a0b0d0;
    background: rgba(255,255,255,0.06);
  }
</style>
