# CrispLens v4 — Pure Node.js, Python-Free

Zero Python. Zero venv. Same 512D ArcFace vectors. Same SQLite DB.

---

## Quick Start

```bash
cd electron-app-v4      # ← must be in this directory
npm install             # first time only
node server.js          # start API + UI at http://localhost:7861
```

Open http://localhost:7861 in your browser. Login: **admin / admin**

---

## Platform Targets

### 1. Desktop App (Electron — macOS, Windows, Linux)

```bash
cd electron-app-v4
npm run build:ui        # builds renderer/dist (Svelte → static files)
npm run start:electron  # run as Electron app (no browser needed)

# Development (hot-reload UI + Electron shell):
npm run dev:ui &        # Vite dev server on port 5173
npm run dev             # Electron loads port 5173 automatically
```

**Build installers:**
```bash
npm run build:mac       # → dist-electron/*.dmg  (requires macOS or Wine)
npm run build:win       # → dist-electron/*.exe
npm run build:linux     # → dist-electron/*.AppImage, *.deb
npm run build:all       # → all platforms
```

### 2. Web / PWA

```bash
cd electron-app-v4/renderer
npm run build           # → dist/ (includes service worker + manifest)
```
Deploy the `renderer/dist/` folder to any static host. Run `node server.js` on the server.
Users can "Install App" in Chrome/Safari for a standalone PWA experience.

### 3. iOS & Android (Capacitor)

```bash
cd electron-app-v4/renderer
npm install             # first time
npx cap add ios         # sets up Xcode project
npx cap add android     # sets up Android Studio project

npm run build           # build the web assets
npx cap sync            # copy dist/ into native projects

# Point the app at your running Node.js server:
CAPACITOR_SERVER_URL=http://192.168.1.x:7861 npx cap run ios
CAPACITOR_SERVER_URL=http://192.168.1.x:7861 npx cap run android
```

---

## Configuration

| Env var | Default | Description |
|---|---|---|
| `PORT` | `7861` | API server port |
| `DB_PATH` | `../face_recognition.db` | Path to SQLite database |
| `DEFAULT_ADMIN_USER` | `admin` | Login username (if no users table) |
| `DEFAULT_ADMIN_PASS` | `admin` | Login password (if no users table) |
| `UPLOAD_DIR` | `../data/uploads` | Where uploaded images are stored |

```bash
PORT=8080 DB_PATH=/data/photos.db node server.js
```

---

## Development Workflow

### Server only (API + static UI)
```bash
node server.js
# → http://localhost:7861 (serves pre-built renderer/dist)
```

### Full dev (hot-reload)
```bash
# Terminal 1 — backend
node server.js

# Terminal 2 — frontend (proxies /api to port 7861)
cd renderer && npm run dev
# → http://localhost:5173  (hot-reloads on Svelte changes)
```

---

## Models

The ArcFace models are shared with Python InsightFace:
- Auto-detected at: `~/.insightface/models/buffalo_l/`
- Or download: `node core/model-downloader.js`

Models needed: `det_10g.onnx` (SCRFD detection) + `w600k_r50.onnx` (ArcFace 512D)

---

## Compatibility Test

```bash
node proto-test.js                          # test against existing DB
node proto-selfcontained.js                 # self-contained test (no DB needed)
node proto-selfcontained.js ../face_rec.db  # also search existing DB
```
