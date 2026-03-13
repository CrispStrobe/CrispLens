#!/bin/bash

# release-v4.sh - Build and Publish CrispLens v4 for macOS
# Equivalent to release-v4.ps1 but for macOS (dmg)

set -e # Exit on error

# --- 0. Ensure GitHub CLI (gh) is installed ---
echo "--- Checking for GitHub CLI ---"
if ! command -v gh &> /dev/null; then
    echo "gh not found. Please install it via Homebrew: brew install gh"
    exit 1
fi

# --- 1. Checking Token ---
echo "--- Checking Token ---"
if [ -z "$GH_TOKEN" ]; then
    export GH_TOKEN=$(gh auth token)
fi

# --- 2. Building UI ---
echo "--- Building UI ---"
cd electron-app-v4/renderer
npm install --silent
npm run build
cd ../..

# --- 3. Git Operations ---
echo "--- Git Operations ---"
# Extract version using node -p
PKG_VERSION=$(node -p "require('./electron-app-v4/package.json').version")
TAG="v$PKG_VERSION-v4"

git add .
# Commit only if there are changes
if ! git diff-index --quiet HEAD --; then
    git commit -m "Release $TAG"
else
    echo "Nothing to commit"
fi

echo "Handling tag $TAG..."
# Delete remote tag if it exists
git push origin --delete "$TAG" 2>/dev/null || echo "Remote tag did not exist, continuing."

# Force create/update local tag
git tag -fa "$TAG" -m "Release $TAG"
git push origin main
git push origin "$TAG"

# --- 4. Build and Publish ---
echo "--- Building and Publishing (macOS DMG) ---"
cd electron-app-v4
npm install --silent

# Future Apple Dev Account handling:
# If you get an account, set these env vars before running:
# export APPLE_ID="your@email.com"
# export APPLE_ID_PASSWORD="your-app-specific-password"
# export APPLE_TEAM_ID="YOURTEAMID"

# Build for macOS (DMG)
# --mac: build for macOS
# -p always: publish to GitHub Releases
npx electron-builder --mac -p always

cd ..

echo "--- Done! Release $TAG published ---"
