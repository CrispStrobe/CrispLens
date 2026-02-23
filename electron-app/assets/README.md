# Assets

Place your `icon.ico` file here (256×256 recommended, multi-size ICO).

The icon is used for:
- The application window title bar
- The system tray
- The NSIS installer

If no `icon.ico` is present the app still runs, but without a custom icon.

## Quick icon generation

If you have an SVG or PNG, you can convert it with ImageMagick:

```bash
# From a 256×256 PNG:
magick input.png -resize 256x256 icon.ico

# Multi-size ICO (16, 32, 48, 64, 128, 256):
magick input.png \
  \( -clone 0 -resize 16x16   \) \
  \( -clone 0 -resize 32x32   \) \
  \( -clone 0 -resize 48x48   \) \
  \( -clone 0 -resize 64x64   \) \
  \( -clone 0 -resize 128x128 \) \
  \( -clone 0 -resize 256x256 \) \
  -delete 0 icon.ico
```
