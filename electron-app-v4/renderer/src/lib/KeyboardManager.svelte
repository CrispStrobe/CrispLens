<script>
  /**
   * KeyboardManager — global keyboard shortcut handler (XnView style).
   * Mounted once at App level. Handles rating, flags, thumb size,
   * selection ops, and gallery mode toggle.
   *
   * Keys handled here (not in Gallery/Lightbox):
   *   1–5, 0        → star rating for active image
   *   X / P / U     → color flags (delete / pick / unflag)
   *   G             → toggle grid ↔ table (gallery only)
   *   T             → focus toolbar search input
   *   + / = / - / * → thumb size ±20 / reset (gallery only; lightbox handles zoom)
   *   Delete        → delete selected images (gallery only)
   *   Ctrl+A        → select all
   *   Ctrl+D        → deselect all
   *   Ctrl+I        → invert selection
   */

  import {
    selectedId, selectedItems, galleryImages, lastClickedId,
    galleryMode, thumbSize, starRatings, colorFlags,
  } from '../stores.js';
  import { patchRating, patchFlag, deleteImage } from '../api.js';

  function isInputFocused() {
    const el = document.activeElement;
    return el && (
      el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.tagName === 'SELECT' ||
      el.isContentEditable
    );
  }

  /** Get the "active" image id: lightbox target or last clicked in gallery. */
  function getActiveId() {
    if ($selectedId) return $selectedId;
    if ($lastClickedId) return $lastClickedId;
    if ($selectedItems.size === 1) return [...$selectedItems][0];
    return null;
  }

  async function handleKey(e) {
    if (isInputFocused()) return;

    const inLightbox = $selectedId !== null;
    const key = e.key;
    const ctrl = e.ctrlKey || e.metaKey;

    // ── Selection operations (gallery only) ─────────────────────────────────

    if (!inLightbox && ctrl) {
      if (key === 'a') {
        e.preventDefault();
        selectedItems.set(new Set($galleryImages.map(i => i.id)));
        return;
      }
      if (key === 'd') {
        e.preventDefault();
        selectedItems.set(new Set());
        return;
      }
      if (key === 'i') {
        e.preventDefault();
        const all = new Set($galleryImages.map(i => i.id));
        selectedItems.update(sel => new Set([...all].filter(id => !sel.has(id))));
        return;
      }
    }

    if (ctrl) return; // don't capture other Ctrl combos

    // ── Gallery-only shortcuts ────────────────────────────────────────────────

    if (!inLightbox) {
      if (key === '+' || key === '=') {
        thumbSize.update(s => Math.min(400, s + 20));
        return;
      }
      if (key === '-') {
        thumbSize.update(s => Math.max(80, s - 20));
        return;
      }
      if (key === '*') {
        thumbSize.set(200);
        return;
      }
      if (key === 'g' || key === 'G') {
        galleryMode.update(m => m === 'grid' ? 'table' : 'grid');
        return;
      }
      if (key === 't' || key === 'T') {
        // Focus the first toolbar search input if present
        const inp = document.querySelector('.toolbar-search, input[type="search"], input[placeholder*="earch"]');
        if (inp) { inp.focus(); inp.select(); }
        return;
      }
      if (key === 'Delete' && $selectedItems.size > 0) {
        const count = $selectedItems.size;
        if (!confirm(`Delete ${count} image${count === 1 ? '' : 's'}?`)) return;
        const ids = [...$selectedItems];
        for (const id of ids) {
          await deleteImage(id).catch(() => {});
        }
        galleryImages.update(list => list.filter(i => !ids.includes(i.id)));
        selectedItems.set(new Set());
        return;
      }
    }

    // ── Shared shortcuts (gallery + lightbox) ────────────────────────────────

    const active = getActiveId();

    // Star rating 1–5 and 0 to clear
    if (key >= '0' && key <= '5') {
      if (!active) return;
      const rating = parseInt(key);
      await patchRating(active, rating).catch(() => {});
      starRatings.update(r => ({ ...r, [active]: rating }));
      return;
    }

    // Color flags: X = delete flag, P = pick flag, U = unflag
    if ((key === 'x' || key === 'X') && active) {
      const cur = $colorFlags[active];
      const next = cur === 'delete' ? null : 'delete';
      await patchFlag(active, next).catch(() => {});
      colorFlags.update(f => ({ ...f, [active]: next }));
      return;
    }
    if ((key === 'p' || key === 'P') && active) {
      const cur = $colorFlags[active];
      const next = cur === 'pick' ? null : 'pick';
      await patchFlag(active, next).catch(() => {});
      colorFlags.update(f => ({ ...f, [active]: next }));
      return;
    }
    if ((key === 'u' || key === 'U') && active) {
      await patchFlag(active, null).catch(() => {});
      colorFlags.update(f => ({ ...f, [active]: null }));
      return;
    }
  }
</script>

<svelte:window on:keydown={handleKey} />
