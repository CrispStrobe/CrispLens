# release-v4.ps1 - Build and Publish CrispLens v4

$ErrorActionPreference = "Stop"

# --- 0. Ensure GitHub CLI (gh) is installed ---
Write-Host "--- Checking for GitHub CLI ---"
$env:Path += ";$env:LOCALAPPDATA\Microsoft\WindowsApps;C:\Program Files\GitHub CLI"
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Host "gh not found, installing via winget..."
    winget install --id GitHub.cli --silent --accept-source-agreements --accept-package-agreements
}

# --- 1. Checking Token ---
Write-Host "--- Checking Token ---"
if (-not $env:GH_TOKEN) {
    $env:GH_TOKEN = (gh auth token).Trim()
}

# --- 2. Building UI ---
Write-Host "--- Building UI ---"
cd electron-app-v4/renderer
npm run build
cd ../..

# --- 3. Git Operations ---
Write-Host "--- Git Operations ---"
$pkgVersion = (Get-Content electron-app-v4/package.json | ConvertFrom-Json).version
$tag = "v$pkgVersion-v4"
git add .
try { git commit -m "Release $tag" } catch { Write-Host "Nothing to commit" }

Write-Host "Handling tag $tag..."
try {
    git push origin --delete $tag 2>$null
    Write-Host "Deleted existing remote tag."
} catch {
    Write-Host "Remote tag did not exist, continuing."
}

git tag -fa $tag -m "Release $tag" # Force create/update local tag
git push origin main
git push origin $tag # Push the new tag

# --- 4. Build and Publish ---
Write-Host "--- Building and Publishing ---"
cd electron-app-v4
npx electron-builder --win -p always
cd ..

Write-Host "--- Done! Release $tag published ---"
