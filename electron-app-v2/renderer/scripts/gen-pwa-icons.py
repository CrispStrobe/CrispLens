#!/usr/bin/env python3
"""
gen-pwa-icons.py — Generate CrispLens PWA icons using Pillow.

Run from the renderer/ directory:
    python3 scripts/gen-pwa-icons.py

Outputs:
    public/icons/icon-{72,96,128,144,152,192,384,512}.png
    public/icons/icon-512-maskable.png
    public/favicon.png
"""
import math, os, sys

try:
    from PIL import Image, ImageDraw, ImageFilter
except ImportError:
    print("Pillow not found — install it:  pip install Pillow")
    sys.exit(1)

# ── Colour palette ────────────────────────────────────────────────────────────
BG_DARK    = (14,  14,  26,  255)   # #0e0e1a — very dark navy
BG_MID     = (26,  26,  46,  255)   # #1a1a2e — main background
BLUE       = (74,  111, 165, 255)   # #4a6fa5 — primary accent
BLUE_LIGHT = (90,  143, 195, 255)   # #5a8fc3 — secondary accent
GLOW       = (160, 192, 232, 255)   # #a0c0e8 — inner glow / iris
WHITE_ISH  = (220, 232, 248, 255)   # off-white centre dot


def draw_icon(size: int, maskable: bool = False) -> Image.Image:
    """Render the CrispLens lens icon at *size* × *size* pixels."""
    img  = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    cx = cy = size // 2

    # ── Background ────────────────────────────────────────────────────────────
    if maskable:
        # Full-bleed square (required for maskable icons)
        draw.rectangle([0, 0, size, size], fill=BG_DARK)
        # Subtle inner gradient feel: slightly lighter circle in centre
        grad_r = int(size * 0.62)
        for r in range(grad_r, 0, -2):
            alpha = int(18 * (r / grad_r))
            draw.ellipse(
                [cx - r, cy - r, cx + r, cy + r],
                fill=(26, 26, 46, alpha),
            )
    else:
        # Solid circle (non-maskable)
        draw.ellipse([0, 0, size - 1, size - 1], fill=BG_DARK)

    lw = max(2, size // 28)   # line / ring width

    # ── Outer lens ring ───────────────────────────────────────────────────────
    r_outer = int(size * 0.42)
    draw.ellipse(
        [cx - r_outer, cy - r_outer, cx + r_outer, cy + r_outer],
        outline=BLUE, width=lw,
    )

    # ── Aperture blades (5 spokes from mid-ring to outer ring) ───────────────
    r_mid = int(size * 0.30)
    blade_w = max(1, lw - 1)
    for i in range(5):
        angle = math.radians(i * 72 - 18)   # -18° so a point faces upward
        x1 = cx + r_mid   * math.cos(angle)
        y1 = cy + r_mid   * math.sin(angle)
        x2 = cx + r_outer * math.cos(angle)
        y2 = cy + r_outer * math.sin(angle)
        draw.line([(x1, y1), (x2, y2)], fill=BLUE, width=blade_w)

    # ── Middle ring ───────────────────────────────────────────────────────────
    draw.ellipse(
        [cx - r_mid, cy - r_mid, cx + r_mid, cy + r_mid],
        outline=BLUE_LIGHT, width=max(1, lw - 1),
    )

    # ── Inner "iris" filled circle ────────────────────────────────────────────
    r_iris = int(size * 0.18)
    draw.ellipse(
        [cx - r_iris, cy - r_iris, cx + r_iris, cy + r_iris],
        fill=GLOW,
    )

    # ── Centre pupil dot ──────────────────────────────────────────────────────
    r_pupil = max(2, int(size * 0.07))
    draw.ellipse(
        [cx - r_pupil, cy - r_pupil, cx + r_pupil, cy + r_pupil],
        fill=BG_DARK,
    )

    # ── Tiny specular highlight (top-left of iris) ────────────────────────────
    hl_r = max(1, int(r_iris * 0.28))
    hl_x = cx - int(r_iris * 0.38)
    hl_y = cy - int(r_iris * 0.38)
    draw.ellipse(
        [hl_x - hl_r, hl_y - hl_r, hl_x + hl_r, hl_y + hl_r],
        fill=WHITE_ISH,
    )

    return img


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    out_root   = os.path.join(script_dir, '..', 'public')
    icons_dir  = os.path.join(out_root, 'icons')
    os.makedirs(icons_dir, exist_ok=True)

    # Standard sizes
    for size in (72, 96, 128, 144, 152, 192, 384, 512):
        path = os.path.join(icons_dir, f'icon-{size}.png')
        draw_icon(size).save(path, optimize=True)
        print(f'  ✔  {path}')

    # Maskable (512×512, full-bleed background)
    path = os.path.join(icons_dir, 'icon-512-maskable.png')
    draw_icon(512, maskable=True).save(path, optimize=True)
    print(f'  ✔  {path}')

    # Favicon (32×32)
    fav_path = os.path.join(out_root, 'favicon.png')
    draw_icon(32).save(fav_path, optimize=True)
    print(f'  ✔  {fav_path}')

    print('\n  All icons generated.')


if __name__ == '__main__':
    main()
