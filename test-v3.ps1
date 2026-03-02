# test-v3.ps1
# 1. Install dependencies
# 2. Download models
# 3. Run head-to-head comparison with existing database

Write-Host "--- CrispLens v3: Pure Node.js Prototype Setup & Test ---" -ForegroundColor Cyan

cd electron-app-v3-proto

# 1. Install npm dependencies (compiles native modules)
Write-Host "`n[1/3] Installing native dependencies..." -ForegroundColor Yellow
npm install

# 2. Download Buffalo_L ONNX models
Write-Host "`n[2/3] Downloading AI models..." -ForegroundColor Yellow
node model-manager.js

# 3. Run head-to-head comparison
# Find your DB first
$dbPath = "$env:APPDATA\CrispLens\face_recognition.db"
if (-not (Test-Path $dbPath)) {
    Write-Host "`nSearching for face_recognition.db in workspace..." -ForegroundColor Gray
    $found = Get-ChildItem -Recurse -Filter "face_recognition.db" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $dbPath = $found.FullName }
}

Write-Host "`n[3/3] Running Head-to-Head Comparison..." -ForegroundColor Yellow
Write-Host "Using Database: $dbPath" -ForegroundColor Gray
node compare-engines.js "$dbPath"

Write-Host "`n--- Validation Complete ---" -ForegroundColor Cyan
