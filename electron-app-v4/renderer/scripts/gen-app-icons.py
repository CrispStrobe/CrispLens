#!/usr/bin/env python3
"""
gen-app-icons.py — Generate CrispLens icons from a source PNG using Pillow.
Used for PWA and iOS/Android app icons.

Usage:
    python3 scripts/gen-app-icons.py ../../CrispLens.png
"""
import os, sys

try:
    from PIL import Image
except ImportError:
    print("Pillow not found — install it:  pip install Pillow")
    sys.exit(1)

def generate_icons(source_path):
    if not os.path.exists(source_path):
        print(f"Source file not found: {source_path}")
        return

    script_dir = os.path.dirname(os.path.abspath(__file__))
    renderer_root = os.path.join(script_dir, '..')
    
    # Output directories
    pwa_icons_dir = os.path.join(renderer_root, 'public', 'icons')
    ios_icons_dir = os.path.join(renderer_root, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset')
    
    os.makedirs(pwa_icons_dir, exist_ok=True)
    
    with Image.open(source_path) as img:
        # 1. PWA Icons
        pwa_sizes = (72, 96, 128, 144, 152, 192, 384, 512)
        for size in pwa_sizes:
            out_path = os.path.join(pwa_icons_dir, f'icon-{size}.png')
            img.resize((size, size), Image.Resampling.LANCZOS).save(out_path, optimize=True)
            print(f"  ✔ PWA icon-{size}.png")
        
        # Favicon
        img.resize((32, 32), Image.Resampling.LANCZOS).save(os.path.join(renderer_root, 'public', 'favicon.png'), optimize=True)
        print("  ✔ favicon.png")

        # Maskable
        img.resize((512, 512), Image.Resampling.LANCZOS).save(os.path.join(pwa_icons_dir, 'icon-512-maskable.png'), optimize=True)
        print("  ✔ icon-512-maskable.png")

        # 2. iOS Icons (if directory exists)
        if os.path.exists(ios_icons_dir):
            # Sizes required by our new Contents.json
            ios_sizes = [20, 29, 40, 58, 60, 76, 80, 87, 120, 152, 167, 180, 1024]
            for size in ios_sizes:
                # iOS app icons must be opaque (no transparency)
                bg = Image.new("RGB", (size, size), (18, 18, 24)) # Match app background
                resized = img.resize((size, size), Image.Resampling.LANCZOS)
                if resized.mode == 'RGBA':
                    bg.paste(resized, (0, 0), resized)
                    bg.save(os.path.join(ios_icons_dir, f'AppIcon-{size}.png'), "PNG")
                else:
                    resized.save(os.path.join(ios_icons_dir, f'AppIcon-{size}.png'), "PNG")
                print(f"  ✔ iOS AppIcon-{size}.png")
        else:
            print(f"\nSkipping iOS icons (directory not found: {ios_icons_dir})")

if __name__ == '__main__':
    source = sys.argv[1] if len(sys.argv) > 1 else '../../CrispLens.png'
    generate_icons(source)
