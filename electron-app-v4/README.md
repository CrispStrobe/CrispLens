# CrispLens v4 — Pure Node.js, Python-Free

Zero Python. Zero venv. Same 512D ArcFace vectors. Same SQLite DB as v2. 
Powered by ONNX Runtime (WASM/Node.js) for high-performance cross-platform face recognition.

**Live Demo:** [https://crisplens.vercel.app](https://crisplens.vercel.app)

---

## Connection Modes

v4 is designed for maximum flexibility, supporting two primary operational modes:

### 1. Server Mode (Backend)
Run as a Node.js/Express server on your machine or VPS.
- **Backend**: Express + better-sqlite3.
- **Inference**: SCRFD + ArcFace via `onnxruntime-node`.
- **UI**: Served as static files, accessible from any browser on your network.

### 2. Standalone Mode (Browser-only / Demo)
The app runs entirely within your web browser. Ideal for zero-install usage and extreme privacy.
- **Database**: WASM SQLite (@capacitor-community/sqlite) stored in IndexedDB.
- **Inference**: SCRFD + ArcFace via `onnxruntime-web` + Optional MediaPipe (GPU-accelerated).
- **Storage Resolution**: Adjustable from **200px to 1200px** via **Settings → Offline Cache**. Storing at 1200px enables high-quality local archival without a server.

---

## Quick Start (Server Mode)

```bash
cd electron-app-v4      # ← must be in this directory
npm install             # first time only
node server.js          # start API + UI at http://localhost:7861
```

Open http://localhost:7861 in your browser. Login: **admin / admin**

---

## Platform Targets

### 1. Desktop App (Electron)
```bash
npm run build:ui        # builds renderer/dist
npm run start:electron  # run as Electron app
```

### 2. Web / PWA
The Svelte UI can be deployed to any static host (like Vercel). In this mode, it defaults to **Standalone Mode** using browser-local storage.

### 3. iOS & Android (Capacitor)
Local inference on device ensures full images never leave the phone. Only 512D vectors + thumbnails are sent to your remote server.

---

## Detection Models

| Model | Mode | Notes |
|---|---|---|
| **SCRFD-10GF** | Server / Web | Best accuracy, shared with v2. |
| **YuNet** | Server / Web | Very fast, excellent for small faces. |
| **MediaPipe** | Web / Mobile | WebGL/GPU-accelerated detection. |
| **ArcFace R50** | All | Generates standardized 512D embeddings. |

---

## Configuration

| Env var | Default | Description |
|---|---|---|
| `PORT` | `7861` | API server listen port |
| `DB_PATH` | `../face_recognition.db` | Path to SQLite database |
| `DEBUG` | `` | Set to `1` for verbose detection/embedding logs |

---

## High-Resolution Standalone Storage

When using the app in **Standalone Mode** (e.g., via the Vercel demo), you can control the quality of images stored in your browser's database:

1.  Go to **Settings**.
2.  Locate the **Offline Cache** section.
3.  Move the **Thumbnail size** slider (up to 1200px).
4.  Newly processed images will be stored at this higher resolution.

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
│    Options:                                                 │
│    • Same origin (default) — local v4 at localhost:7861     │
│    • Standalone — Browser IndexedDB (no server)             │
│    • Remote — any CrispLens v2 or v4 instance               │
├─────────────────────────────────────────────────────────────┤
│  Axis 3: Inference Engine (Settings → Processing Override)  │
│    Where face detection and embedding runs                  │
│    Options:                                                 │
│    • Local — uses your device (ONNX / WASM)                 │
│    • Remote — sends data to another server for processing   │
└─────────────────────────────────────────────────────────────┘
```

---

## Server Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/health` | — | Health check + model_ready flag |
| `GET` | `/api/images` | ✓ | Browse images (filter by person/tag/date/album) |
| `GET` | `/api/images/:id/thumbnail` | ✓ | Resized thumbnail (Sharp) |
| `POST` | `/api/images/:id/re-detect` | ✓ | Re-run detection on one image |
| `POST` | `/api/ingest/import-processed` | ✓ | Accept pre-computed embeddings |
| `POST` | `/api/process/batch` | ✓ | SSE batch processing (server-side folder) |

---

## Development Workflow

### Full dev (hot-reload)
```bash
# Terminal 1 — backend
node server.js

# Terminal 2 — frontend
cd renderer && npm run dev
# → http://localhost:5173
```
