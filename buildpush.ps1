# buildpush.ps1 — Automate frontend build and git deployment (Windows)

$ErrorActionPreference = "Stop"

if ($args.Count -eq 0) {
    Write-Host "Error: No commit message provided." -ForegroundColor Red
    Write-Host "Usage: .\buildpush.ps1 'your commit message'"
    exit 1
}

$message = $args[0]

Write-Host "--- 1. Building v2 renderer ---" -ForegroundColor Cyan
Push-Location electron-app-v2/renderer
npm run build
Pop-Location

Write-Host "--- 2. Building v4 renderer ---" -ForegroundColor Cyan
Push-Location electron-app-v4/renderer
npm run build
Pop-Location

Write-Host "--- 3. Staging all changes ---" -ForegroundColor Cyan
git add .

Write-Host "--- 4. Committing with message: $message ---" -ForegroundColor Cyan
git commit -m $message

Write-Host "--- 5. Pushing to remote ---" -ForegroundColor Cyan
git push

Write-Host "--- 6. Final status check ---" -ForegroundColor Cyan
git status

Write-Host "--- Done! ---" -ForegroundColor Green
