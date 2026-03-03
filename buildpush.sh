#!/bin/bash
# buildpush.sh — Automate frontend build and git deployment

# Exit immediately if a command exits with a non-zero status.
set -e

if [ -z "$1" ]; then
  echo "Error: No commit message provided."
  echo "Usage: ./buildpush.sh "your commit message""
  exit 1
fi

MESSAGE="$1"

echo "--- 1. Building v2 renderer ---"
cd electron-app-v2/renderer
npm run build
cd ../..

echo "--- 2. Building v4 renderer ---"
cd electron-app-v4/renderer
npm run build
cd ../..

echo "--- 3. Staging all changes ---"
git add .

echo "--- 4. Committing with message: $MESSAGE ---"
git commit -m "$MESSAGE"

echo "--- 5. Pushing to remote ---"
git push

echo "--- 6. Final status check ---"
git status

echo "--- Done! ---"
