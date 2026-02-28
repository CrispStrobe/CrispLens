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

echo "--- 1. Navigating to renderer ---"
cd electron-app-v2/renderer

echo "--- 2. Building frontend (npm run build) ---"
npm run build

echo "--- 3. Navigating back to root ---"
cd ../..

echo "--- 4. Staging all changes (including backend) ---"
git add .

echo "--- 5. Committing with message: $MESSAGE ---"
git commit -m "$MESSAGE"

echo "--- 6. Pushing to remote ---"
git push

echo "--- 7. Final status check ---"
git status

echo "--- Done! ---"
