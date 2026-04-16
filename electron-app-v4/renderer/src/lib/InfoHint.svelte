<script>
  export let text = '';
  export let html = '';
  export let title = '';
  export let width = '320px';

  let open = false;
  let anchor;
  let hovering = false;

  function toggle() { open = !open; }
  function close() { if (!hovering) open = false; }
  function enter() { hovering = true; open = true; }
  function leave() { hovering = false; setTimeout(() => { if (!hovering) open = false; }, 150); }
</script>

<span class="info-hint" bind:this={anchor} on:mouseenter={enter} on:mouseleave={leave}>
  <button
    type="button"
    class="info-btn"
    aria-label={title || 'info'}
    on:click|stopPropagation={toggle}
    on:blur={() => setTimeout(close, 200)}
  >i</button>
  {#if open}
    <span class="info-pop" style="width:{width};" role="tooltip">
      {#if title}<strong class="info-title">{title}</strong>{/if}
      {#if html}
        <!-- The `html` prop is reserved for dev-authored i18n strings (see stores.js). -->
        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
        {@html html}
      {:else}
        <span>{text}</span>
      {/if}
    </span>
  {/if}
</span>

<style>
  .info-hint {
    display: inline-block;
    position: relative;
    line-height: 1;
    vertical-align: middle;
    margin-left: 4px;
  }
  .info-btn {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 1px solid #4a6080;
    background: #1a2030;
    color: #a0c0e0;
    font-family: serif;
    font-style: italic;
    font-size: 11px;
    font-weight: 700;
    line-height: 14px;
    padding: 0;
    cursor: pointer;
    user-select: none;
  }
  .info-btn:hover, .info-btn:focus {
    background: #2a3a55;
    color: #d0e0f0;
    outline: none;
  }
  .info-pop {
    position: absolute;
    left: 20px;
    top: -4px;
    z-index: 100;
    display: block;
    padding: 8px 10px;
    background: #121826;
    border: 1px solid #2a3550;
    border-radius: 6px;
    color: #d0d8e0;
    font-size: 11.5px;
    font-weight: normal;
    line-height: 1.45;
    box-shadow: 0 4px 14px rgba(0,0,0,0.4);
    white-space: normal;
    text-transform: none;
    letter-spacing: normal;
  }
  .info-title {
    display: block;
    margin-bottom: 4px;
    color: #a0c0e0;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.03em;
  }
  .info-pop :global(code) {
    background: #1e2638;
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 10.5px;
  }
  .info-pop :global(strong) {
    color: #d8e4f0;
  }
</style>
