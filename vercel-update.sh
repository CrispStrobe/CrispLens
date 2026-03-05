#!/usr/bin/env bash
# vercel-update.sh — Build locally and update crisplens.vercel.app

set -e

# 1. Clean up accidental "dist" link if it exists
if [ -d "electron-app-v4/renderer/dist/.vercel" ]; then
  rm -rf "electron-app-v4/renderer/dist/.vercel"
fi

echo "--- 1. Preparing Models ---"
# Create models directory in public so Vite includes them in the build
mkdir -p electron-app-v4/renderer/public/models

# Try to find models locally to bundle them for "Zero Server" deployment
MODEL_SRC=""
if [ -d "$HOME/.insightface/models/buffalo_l" ]; then
  MODEL_SRC="$HOME/.insightface/models/buffalo_l"
elif [ -d "models/buffalo_l" ]; then
  MODEL_SRC="models/buffalo_l"
fi

if [ -n "$MODEL_SRC" ]; then
  echo "Copying models from $MODEL_SRC..."
  cp "$MODEL_SRC/det_10g.onnx" electron-app-v4/renderer/public/models/
  cp "$MODEL_SRC/w600k_r50.onnx" electron-app-v4/renderer/public/models/
else
  echo "Warning: buffalo_l models not found locally. App will fall back to HF mirrors at runtime."
fi

echo "--- 2. Generating Icons ---"
cd electron-app-v4/renderer
npm run gen-icons

echo "--- 3. Building Frontend ---"
npm run build

echo "--- 4. Deploying to Vercel (Project: crisplens) ---"
# Explicit project name to prevent "dist" project creation
vercel deploy dist --prod --yes --name crisplens

echo "--- Done! ---"
echo "Your app should be live at: https://crisplens.vercel.app"
