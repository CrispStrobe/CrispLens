# CrispLens

A self-hosted face recognition and photo management system. Ships as a high-performance Python/FastAPI server (**v2**) and a portable, Python-free Node.js/WASM edition (**v4**).

**Live Demo (v4 Standalone):** [https://crisplens.vercel.app](https://crisplens.vercel.app)

---

## Which Version to Use?

| Feature | **v2 — Python FastAPI** | **v4 — Pure Node.js** |
|---|---|---|
| **Backend** | Python / FastAPI / Uvicorn | Node.js / Express |
| **Inference** | InsightFace (Python) / dlib | SCRFD + ArcFace (ONNX) |
| **Connection Modes** | Client+Server / Thin Client | Server / Standalone (Browser-only) |
| **Hardware Accel** | CoreML (macOS) / CUDA (Linux) | WASM / WebGL / WebGPU |
| **Mobile** | Capacitor (connects to VPS) | PWA / Capacitor (Local Inference) |
| **Recommended for** | High-perf server deployments | Privacy-first / Serverless / Demo |

> **v4** lives in `electron-app-v4/` — zero Python dependency, same 512D ArcFace vectors, same SQLite DB.
> Run with `cd electron-app-v4 && npm install && node server.js`.

---

## Table of Contents

- [Features](#features)
- [v4 — Pure Node.js (Server & Standalone)](#v4--pure-nodejs-server--standalone)
  - [Server Mode](#server-mode)
  - [Standalone Mode (Browser-only)](#standalone-mode-browser-only)
- [v2 — Python FastAPI Setup](#v2--python-fastapi-setup)
- [Desktop App V2 — Build & Run](#desktop-app-v2--build--run)
- [Architecture Overview](#architecture-overview)
- [VPS Deployment](#vps-deployment)
- [Deployment Topologies](#deployment-topologies)
- [Troubleshooting](#troubleshooting)
- [Legacy Versions (v1 Gradio)](#legacy-versions-v1-gradio)

---

## Features

- **Face detection & recognition** — SCRFD + ArcFace ONNX (v4) or InsightFace/dlib (v2). Bit-identical 512D vectors across versions.
- **High-Resolution Standalone Storage** — v4 Standalone mode supports dynamic storage resolution (up to 1200px) in the browser's IndexedDB.
- **Hybrid Ingest Modes** — Upload-full or `local_infer` (ONNX on client, only vectors sent to remote).
- **Privacy Mode** — `local_infer` ensures full images never leave your local machine.
- **AI Image Enrichment** — 9 VLM providers (Anthropic, OpenAI, etc.); scene type, description, auto-tags.
- **Role-based Access Control** — admin / mediamanager / user roles; image visibility (shared/private).
- **Duplicate Detection** — filename+size, SHA256, pHash visual; resolve: delete/db-only/symlink.
- **Image Editing** — EXIF-preserving rotate, free-draw crop, format conversion.

---

## v4 — Pure Node.js (Server & Standalone)

No Python setup required. Uses ONNX Runtime for server-side or browser-side inference.

### Server Mode
Run as a traditional backend on your machine or a VPS.
```bash
cd electron-app-v4
npm install
node server.js          # → http://localhost:7861
```

### Standalone Mode (Browser-only)
The app runs entirely in the browser using WASM SQLite and WASM ONNX.
- **Database**: Browser IndexedDB (WASM SQLite).
- **Inference**: SCRFD + ArcFace (WASM) + Optional MediaPipe (GPU).
- **Resolution**: Adjustable via **Settings → Offline Cache → Thumbnail size**. Storing images at up to 1200px allows for high-quality archival entirely within the browser.

---

## v2 — Python FastAPI Setup

Best for high-performance server deployments where Python InsightFace can utilize GPU or CoreML acceleration.

### Prerequisites
- Python 3.10+
- pip, sqlite3

### Install and Run
```bash
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp config.example.yaml config.yaml
sqlite3 face_recognition.db < schema_complete.sql
uvicorn fastapi_app:app --reload --port 7865
```
Open `http://localhost:7865`. Create admin account on first login.

---

## Desktop App V2 — Build & Run

### Development Mode
```bash
# Terminal 1 — FastAPI backend
uvicorn fastapi_app:app --reload --port 7865

# Terminal 2 — Svelte dev server
cd electron-app-v2/renderer
npm install && npm run dev

# Terminal 3 — Electron shell
cd electron-app-v2
ELECTRON_DEV=1 npm start
```

### Building Binaries
```bash
cd electron-app-v2/renderer && npm run build
cd .. && npm run build           # DMG (macOS), NSIS (Win), AppImage (Linux)
```

---

## Architecture Overview

### v4 — Three-Axis Connection Model

v4 separates three concerns: UI Source, API Server, and Inference Engine.

```
Axis 1: UI source         Axis 2: API + DB server     Axis 3: Inference engine
─────────────────         ──────────────────────────   ──────────────────────────
Where the JS bundle       Where all API calls go        Where face detection runs
comes from                (set in Settings UI)          (set in Processing Override)

local v4 Node.js    ──►   localhost:7861 (local v4)  ──►  Local ONNX (default)
compiled/hosted     ──►   https://vps (remote v2)    ──►  [remote handles its own]
any static host     ──►   any CrispLens instance     ──►  Remote v2 (upload_bytes)
                                                      ──►  Local ONNX → vectors only
                                                           (local_infer = privacy mode)
```

---

## VPS Deployment

### Interactive Install (v2)
On a fresh Ubuntu/Debian VPS:
```bash
git clone https://github.com/CrispStrobe/CrispLens /opt/crisp-lens
sudo bash /opt/crisp-lens/deploy-v2.sh
```

### Container / Docker (v4)
The v4 edition is ideal for containerized environments.
```bash
docker build -t crisplens .
docker run -d -p 7861:7861 -v crisp-data:/data --name crisplens crisplens
```

---

## Deployment Topologies

- **Local-only**: Each user runs their own Electron app with a local database.
- **Shared NAS**: Multiple clients point to a single `face_recognition.db` on a network share.
- **Central VPS**: A single high-power server handles API and storage; clients connect via browser or thin Electron shell.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "No faces found" | Image too small / threshold too high | Lower `detection_threshold` or increase storage resolution (v4 Standalone). |
| Startup takes >60 s | `buffalo_l` loading on CPU | Use `buffalo_s` or enable `use_coreml` (macOS). |
| `localfile://` fail | macOS Full Disk Access | Add CrispLens to System Preferences → Privacy → Full Disk Access. |
| SSE stream stops | nginx buffering | Ensure `proxy_buffering off` in nginx config for `/api/`. |

---

## Legacy Versions (v1 Gradio)

The original Gradio-based UI is still available but no longer actively developed.

### Python setup (v1 Gradio)
```bash
source venv/bin/activate
python face_rec_ui.py   # → http://localhost:7860
```
Default credentials: **admin / admin123**.

---

For detailed v2 documentation, see [electron-app-v2/README.md](electron-app-v2/README.md).
For detailed v4 documentation, see [electron-app-v4/README.md](electron-app-v4/README.md).
