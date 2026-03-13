# deploy-win.ps1 — CrispLens Local Windows Deployment

$ErrorActionPreference = "Continue"

Write-Host "`n╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║      CrispLens — Windows Local Deployment Script             ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════════════╝`n" -ForegroundColor Cyan

# --- 1. Dependency Checks ---
Write-Host "--- 1. Checking Dependencies ---" -ForegroundColor Cyan

# Check Python
try {
    $pythonVer = python --version 2>&1
    Write-Host "  ✔ Python found: $pythonVer" -ForegroundColor Green
} catch {
    Write-Host "  ✘ Python not found. Please install Python 3.10+ from python.org" -ForegroundColor Red
    exit 1
}

# Check Node.js
try {
    $nodeVer = node -v
    Write-Host "  ✔ Node.js found: $nodeVer" -ForegroundColor Green
} catch {
    Write-Host "  ✘ Node.js not found. Please install Node.js 20+ from nodejs.org" -ForegroundColor Red
    exit 1
}

# Check Git
try {
    $gitVer = git --version
    Write-Host "  ✔ Git found: $gitVer" -ForegroundColor Green
} catch {
    Write-Host "  ✘ Git not found. Please install Git from git-scm.com" -ForegroundColor Red
    exit 1
}

# --- 2. Setup v2 (Python FastAPI) ---
Write-Host "`n--- 2. Setting up v2 (Python FastAPI) ---" -ForegroundColor Cyan

if (-not (Test-Path "venv")) {
    Write-Host "  Creating virtual environment..."
    python -m venv venv
}
Write-Host "  Installing/Updating dependencies..."
.\venv\Scripts\pip install --upgrade pip -q
.\venv\Scripts\pip install -r requirements.txt -q
Write-Host "  ✔ v2 Python dependencies ready" -ForegroundColor Green

Write-Host "  Building v2 UI..."
Push-Location electron-app-v2/renderer
npm install --quiet
npm run build --silent
Pop-Location
Write-Host "  ✔ v2 UI built" -ForegroundColor Green

# --- 3. Setup v4 (Node.js Express) ---
Write-Host "`n--- 3. Setting up v4 (Node.js Express) ---" -ForegroundColor Cyan

Write-Host "  Installing server dependencies..."
Push-Location electron-app-v4
npm install --quiet
Pop-Location

Write-Host "  Building v4 UI..."
Push-Location electron-app-v4/renderer
npm install --quiet
npm run build --silent
Pop-Location
Write-Host "  ✔ v4 dependencies and UI ready" -ForegroundColor Green

# --- 4. Database Initialization ---
Write-Host "`n--- 4. Database Check ---" -ForegroundColor Cyan
if (-not (Test-Path "face_recognition.db")) {
    Write-Host "  Initializing database from schema..."
    if (Get-Command sqlite3 -ErrorAction SilentlyContinue) {
        sqlite3 face_recognition.db < schema_complete.sql
        Write-Host "  ✔ Database created" -ForegroundColor Green
    } else {
        Write-Host "  ⚠ sqlite3 CLI not found. Database will be created on first run." -ForegroundColor Yellow
    }
} else {
    Write-Host "  ✔ Database already exists" -ForegroundColor Green
}

# --- 5. Summary ---
Write-Host "`n════════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Deployment Complete! " -ForegroundColor Green
Write-Host "════════════════════════════════════════════════════════════════" -ForegroundColor Cyan

Write-Host "`nTo run v4 (Node.js backend + Electron):" -ForegroundColor White
Write-Host "  cd electron-app-v4"
Write-Host "  npx electron ."

Write-Host "`nTo run v2 (Python backend):" -ForegroundColor White
Write-Host "  .\venv\Scripts\python fastapi_app.py"

Write-Host "`nTo build a Windows Release (v4):" -ForegroundColor White
Write-Host "  .\release-v4.ps1"
Write-Host "`n"
