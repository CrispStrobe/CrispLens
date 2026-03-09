# CrispLens v4 — Pure Node.js, Python-Free

Zero Python. Zero venv. Same 512D ArcFace vectors. Same SQLite DB as v2.
Powered by ONNX Runtime (WASM/Node.js) for high-performance cross-platform face recognition.

**Live Demo:** [https://crisplens.vercel.app](https://crisplens.vercel.app)

---

## Connection Modes

v4 supports three primary operational modes:

### 1. Server Mode (Backend)
Run as a Node.js/Express server on your machine or VPS.
- **Backend**: Express + better-sqlite3
- **Inference**: SCRFD + ArcFace via `onnxruntime-node`
- **UI**: Served as static files, accessible from any browser on your network

### 2. Standalone Mode (Browser-only / Demo)
The app runs entirely within your web browser. Ideal for zero-install usage and extreme privacy.
- **Database**: WASM SQLite (`@capacitor-community/sqlite`) stored in IndexedDB
- **Inference**: SCRFD + ArcFace via `onnxruntime-web` + optional MediaPipe (GPU-accelerated)
- **Storage Resolution**: Adjustable from 200px to 1200px via **Settings → Offline Cache**
- **Offline Sync**: Processed embeddings queue locally and push to a remote server on reconnect

### 3. Desktop App (Electron)
Self-contained desktop app for macOS, Windows, and Linux. Bundles the Express server in-process — no separate terminal required.
- **DB Management**: Choose an existing `.db` file, create a new one, or reset to the default location
- **Port**: Automatically finds a free port starting at 7861 (no crash if port is taken)
- **Local File Access**: `localfile://` protocol for serving original full-resolution images securely

---

## Quick Start

### Server Mode
```bash
cd electron-app-v4
npm install
node server.js          # → http://localhost:7861
```
Open `http://localhost:7861`. Login: **admin / admin**

### Electron App (development)
```bash
npm run build:ui        # builds renderer/dist first
npm run start:electron  # run as Electron app
```

### Hot-reload development
```bash
# Terminal 1 — backend
node server.js

# Terminal 2 — frontend (Vite dev server)
cd renderer && npm run dev
# → http://localhost:5173  (proxies /api to 7861)
```

---

## Platform Targets

| Target | Launch | Notes |
|---|---|---|
| **Desktop (Electron)** | `npm run start:electron` | macOS DMG / Windows NSIS / Linux AppImage |
| **Web / PWA** | Deploy `renderer/dist` to any static host | Standalone mode by default |
| **iOS** | `npm run mobile:run:ios` | Capacitor + local ONNX inference |
| **Android** | `npm run mobile:run:android` | Capacitor + local ONNX inference |

---

## Detection & Recognition Models

| Model | Mode | Notes |
|---|---|---|
| **SCRFD-10GF** (`det_10g.onnx`) | Server / Web | Best accuracy; auto-downloaded on first start |
| **YuNet** (`yunet_2023mar.onnx`) | Server / Web | Very fast; excellent for small faces; auto-downloaded |
| **MediaPipe FaceLandmarker** | Web / Mobile | WebGL/GPU-accelerated; fallback landmark set |
| **ArcFace R50** (`w600k_r50.onnx`) | All | 512D embeddings; identical to InsightFace buffalo_l |

Models are auto-downloaded to `~/.insightface/models/buffalo_l/` on first run (or reuse existing InsightFace cache).

---

## Duplicate Import Detection

ProcessView offers a **Duplicates** switch (inside detection settings) applied to every batch:

| Mode | Behaviour |
|---|---|
| **Skip** (default) | Compute SHA-256 hash before ONNX inference; skip if hash or filepath already in DB |
| **Overwrite** | Delete existing faces/tags/embeddings for the matched row; re-process and update in-place |
| **Always add** | Insert a new image row even if content is identical (use for intentional re-imports) |

For **Skip** mode in local/standalone builds the hash check happens _before_ the expensive ONNX pipeline runs, saving significant time when re-processing a folder.

---

## Settings Persistence

Settings survive **Clear Database** and **Hard Reset (Purge All)**:

| Setting | Storage | Survives data wipe | Survives hard reset |
|---|---|---|---|
| Thumbnail/storage size | SQLite `settings` (`pref_thumb_size`) | Yes | Yes |
| Max items, Max size (MB) | SQLite `settings` | Yes | Yes |
| API server URL, locale | `localStorage` (`_CONFIG_KEYS`) | — | Yes (preserved) |
| Server presets | `localStorage` | — | Yes (preserved) |

`clearDatabase()` deletes only face/image/person data — settings, users, and albums are preserved.
`hardResetApp()` saves config keys from `localStorage` before clearing, then restores them.

---

## Three-Axis Connection Architecture

v4 separates three concerns, allowing you to mix and match UI, API, and Inference sources:

```
┌─────────────────────────────────────────────────────────────┐
│  Axis 1: UI Source                                          │
│    Where the HTML/JS bundle comes from                      │
│    → local v4 Node.js / Vercel / GitHub Pages               │
├─────────────────────────────────────────────────────────────┤
│  Axis 2: API + DB Server (Settings → API/Database Server)   │
│    All browser API calls (images, people, faces, DB) go here│
│    • Same origin (default) — local v4 at localhost:7861     │
│    • Standalone — Browser IndexedDB (no server)             │
│    • Remote — any CrispLens v2 or v4 instance               │
├─────────────────────────────────────────────────────────────┤
│  Axis 3: Inference Engine (Settings → Processing Override)  │
│    Where face detection and embedding runs                  │
│    • Local ONNX — server-side (Node.js) or device (WASM)   │
│    • Remote v2 — full image upload to remote server         │
│    • Local Infer — device ONNX → only vectors sent remotely │
│      (local_infer = privacy mode, full images never leave)  │
└─────────────────────────────────────────────────────────────┘
```

---

## Standalone Mode — Offline Cache

All processing results, face thumbnails, and embeddings are stored in the browser's IndexedDB (WASM SQLite). Key settings:

- **Thumbnail size** (200–1200 px) — quality of stored preview images; persists in SQLite across resets
- **Max items** — cap on how many images the local DB retains before oldest are pruned
- **Max size (MB)** — total IndexedDB budget

The local Voy HNSW index (built from known-person embeddings) enables sub-millisecond face re-identification without any server round-trip.

---

## Mobile (Capacitor)

Local inference on iOS/Android ensures full images never leave the device. Only 512D vectors + thumbnails are sent to your remote server.

```bash
# First-time setup
npm run mobile:setup:ios    # or :android
npm run mobile:sync

# Run on device
npm run mobile:run:ios      # or :android
```

The Camera plugin is pre-imported at module load to avoid the iOS 2-tap-to-open bug.
Origin file paths (`item.path`) are always preserved as `local_path` in the database record.

---

## Hardware Acceleration (ORT Backends)

Available backends depend on platform (shown automatically in Settings):

| Backend | Platform | Notes |
|---|---|---|
| **CoreML** ★ | macOS only | Recommended for Apple Silicon + Intel Mac |
| **CUDA** | Linux / Windows | Requires CUDA toolkit + compatible GPU |
| **DirectML** | Windows only | Works on any modern GPU (AMD/NVIDIA/Intel) |
| **WebGL / WebGPU** | Browser | Hardware-accelerated WASM inference |
| **CPU** | All | Default fallback |

---

## Key API Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/health` | — | Health check + model_ready flag |
| `GET` | `/api/images` | ✓ | Browse images (filter by person/tag/date/album/unidentified) |
| `GET` | `/api/images/:id/thumbnail` | ✓ | Resized thumbnail via Sharp |
| `GET` | `/api/faces/unidentified` | ✓ | Faces without a person assignment |
| `GET` | `/api/faces/clusters` | ✓ | Cosine-clustered unidentified faces |
| `POST` | `/api/ingest/import-processed` | ✓ | Accept pre-computed embeddings + thumbnail (Mode C) |
| `POST` | `/api/ingest/upload-local` | ✓ | Upload image file for server-side processing |
| `POST` | `/api/process/batch` | ✓ | SSE batch processing of a server-side folder |
| `POST` | `/api/process/single` | ✓ | Process one image on the server |
| `GET` | `/api/people` | ✓ | List known people |
| `GET` | `/api/people/embeddings` | ✓ | 512D representative embeddings (for offline sync) |
| `GET` | `/api/settings` | ✓ | Flat settings JSON |
| `PUT` | `/api/settings` | ✓ (admin) | Update settings |

---

## Configuration

| Env var | Default | Description |
|---|---|---|
| `PORT` | `7861` | API server listen port (Electron finds a free port automatically) |
| `DB_PATH` | `../face_recognition.db` | Path to SQLite database |
| `UPLOAD_DIR` | next to DB | Directory for uploaded image files |
| `DEBUG` | `0` | Set to `1` for verbose detection/embedding logs |
| `DEBUG_SQL` | `0` | Set to `1` to log all SQL statements |
| `DEFAULT_ADMIN_USER` | `admin` | Fallback admin username (if no `users` table) |
| `DEFAULT_ADMIN_PASS` | `admin` | Fallback admin password |

---

## Key Source Files

| File | Description |
|---|---|
| `server.js` | Express entry point; serves API + static UI |
| `electron-main.js` | Electron main process; starts server in-process; IPC handlers |
| `preload.js` | Electron context bridge (exposes `window.electronAPI`) |
| `core/face-engine.js` | SCRFD detection + ArcFace embedding (Node.js) |
| `core/face-align.js` | 5-point Umeyama similarity transform + bilinear warp to 112×112 |
| `core/search.js` | VectorStore: usearch HNSW → faiss-node → brute-force cosine |
| `core/model-downloader.js` | Auto-downloads buffalo_l + YuNet models |
| `core/remote-v2-client.js` | RemoteV2Client — session-cookie auth, processFilepath/Bytes/SSE |
| `server/db.js` | better-sqlite3 singleton |
| `server/auth.js` | Session-based auth; PBKDF2 password verify |
| `server/processor.js` | `processImageIntoDb()` — routes to local ONNX or remote v2 |
| `server/routes/process.js` | SSE batch processing, single, train, scan-folder |
| `server/routes/ingest.js` | multer upload, `import-processed` (Mode C) |
| `server/routes/settings.js` | Settings CRUD; `loadFlat`, `getProcessingBackend` exports |
| `renderer/src/lib/LocalAdapter.js` | Browser-side DB adapter (WASM SQLite); duplicate detection |
| `renderer/src/lib/LocalDB.js` | Schema, migrations, `clearDatabase`, `hardResetApp` |
| `renderer/src/lib/FaceEngineWeb.js` | Browser ONNX inference (SCRFD + ArcFace + MediaPipe) |
| `renderer/src/lib/SyncManager.js` | IndexedDB sync; offline queue; push pending on reconnect |
| `renderer/src/api.js` | Unified API client (server mode + local adapter mode) |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| No images shown after launch | `db_mode` defaulted to `local` | Settings auto-corrects for Electron; check Settings → Storage Mode |
| Port 7861 already in use | Another process | Electron auto-selects next free port (7862–7881) |
| "No faces found" | Image too small / threshold too high | Lower detection threshold; increase storage resolution |
| Models not downloading | Network / firewall | Manually place `det_10g.onnx` + `w600k_r50.onnx` in `~/.insightface/models/buffalo_l/` |
| iOS photo picker needs 2 taps | Capacitor Camera not pre-loaded | Fixed in current build (plugin imported at module init) |
| `localfile://` returns 404 | macOS Full Disk Access | Add CrispLens to System Preferences → Privacy → Full Disk Access |
| Voy match returns "Unknown" | Unidentified embeddings in HNSW index | Fixed: only named-person embeddings are indexed |
| Settings wiped after hard reset | Config keys not in preserved set | Fixed: `_CONFIG_KEYS` list saved/restored in `hardResetApp()` |
