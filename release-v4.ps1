# release-v4.ps1 - Build and Publish CrispLens v4

$ErrorActionPreference = "Stop"

# --- 0. Ensure GitHub CLI (gh) is installed ---
Write-Host "--- Checking for GitHub CLI ---"
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Host "gh not found, installing..."
    winget install --id GitHub.cli --silent --accept-source-agreements --accept-package-agreements
    $env:Path += ";C:\Program Files\GitHub CLI"
}

# --- 1. Checking Token ---
Write-Host "--- Checking Token ---"
if (-not $env:GH_TOKEN) {
    $ghToken = & gh auth token 2>$null
    if ($ghToken) {
        $env:GH_TOKEN = $ghToken.Trim()
    } else {
        Write-Host "? Not logged into gh CLI. Run 'gh auth login'" -ForegroundColor Red
        exit 1
    }
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
git push origin ":refs/tags/$tag" 2>$null # Delete remote tag if it exists
git tag -fa $tag -m "Release $tag" # Force create/update local tag
git push origin main
git push origin $tag # Push the new tag

# --- 4. Build and Publish ---
Write-Host "--- Building and Publishing ---"
cd electron-app-v4
npx electron-builder --win -p always
cd ..

Write-Host "--- Done! Release $tag published ---"
