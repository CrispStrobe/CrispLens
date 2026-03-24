# CrispLens

A self-hosted face recognition and photo management system. Ships as a high-performance Python/FastAPI server (**v2**) and a portable, Python-free Node.js/WASM edition (**v4**).

**Live Demo (v4 Standalone):** [https://crisplens.vercel.app](https://crisplens.vercel.app)

---

## Which Version to Use?

| Feature | **v2 — Python FastAPI** | **v4 — Pure Node.js** |
|---|---|---|
| **Backend** | Python / FastAPI / Uvicorn | Node.js / Express |
| **Inference** | InsightFace (Python) / dlib | SCRFD + ArcFace (ONNX) |
| **Connection Modes** | Client+Server / Thin Client | Server / Standalone / Electron |
| **Hardware Accel** | CoreML (macOS) / CUDA (Linux) | CoreML / CUDA / DirectML / WebGL / WebGPU |
| **Mobile** | Capacitor (connects to VPS) | PWA / Capacitor (Local On-Device Inference) |
| **Duplicate Detection** | SHA256 / pHash / name+size | SHA256 (pre-ONNX, skip/overwrite/always-add) |
| **Recommended for** | High-perf server deployments | Privacy-first / Serverless / Desktop / Mobile |

> **v4** lives in `electron-app-v4/` — zero Python dependency, same 512D ArcFace vectors, same SQLite DB.
> Run with `cd electron-app-v4 && npm install && node server.js`.

---

## Table of Contents

- [Features](#features)
- [v4 — Pure Node.js](#v4--pure-nodejs)
  - [Server Mode](#server-mode)
  - [Standalone Mode](#standalone-mode-browser-only)
  - [Desktop App (Electron)](#desktop-app-electron)
  - [Mobile (Capacitor)](#mobile-capacitor)
- [v2 — Python FastAPI Setup](#v2--python-fastapi-setup)
- [Architecture Overview](#architecture-overview)
- [Deployment Topologies](#deployment-topologies)
- [VPS Deployment](#vps-deployment)
- [Troubleshooting](#troubleshooting)
- [Legacy Versions (v1 Gradio)](#legacy-versions-v1-gradio)

---

## Features

- **Face detection & recognition** — SCRFD + ArcFace ONNX (v4) or InsightFace/dlib (v2). Bit-identical 512D vectors across versions.
- **Duplicate Import Detection** — v4: SHA-256 pre-check before ONNX (fast skip), plus overwrite and always-add modes. v2: SHA256 / pHash / name+size with resolve actions.
- **Privacy Mode** — `local_infer`: ONNX runs on your device, only 512D vectors + thumbnail sent to remote. Full images never leave your machine.
- **Hybrid Ingest Modes** — direct upload, server-side folder scan, or `import-processed` (pre-computed vectors from any client).
- **AI Image Enrichment** — 9 VLM providers (Anthropic, OpenAI, Nebius, Scaleway, OpenRouter, Mistral, Groq, Poe, Ollama); scene type, description, auto-tags. Works directly from the browser in Standalone mode.
- **Offline-First (Standalone)** — browser-side WASM SQLite + HNSW index (Voy). True offline operation: Service Worker (PWA) caches all logic and WASM binaries. The app remains fully functional (face detection, search, VLM, and **BFL AI generation**) even when the Node server is stopped.
- **Direct Cloud Ingest** — Direct browser-to-cloud downloads for Internxt and Filen, bypassing the Node server for maximum performance and privacy.
- **Role-based Access Control** — admin / mediamanager / user roles; image visibility (shared/private).
- **Settings Persistence** — key settings survive hard reset via SQLite `pref_*` keys and preserved `localStorage` config keys.
- **Image Editing** — EXIF-preserving rotate, free-draw crop, canvas resize, **BFL AI editing** (Flux Kontext/Fill).

---

## v4 — Pure Node.js

No Python setup required. Uses ONNX Runtime for server-side or browser-side inference.

### Server Mode
Run as a traditional backend on your machine or a VPS.
```bash
cd electron-app-v4
npm install
node server.js          # → http://localhost:7861
```
Login: **admin / admin**

### Standalone Mode (Browser-only)
The app runs entirely in the browser using WASM SQLite and WASM ONNX.
- **Database**: Browser IndexedDB (WASM SQLite).
- **Inference**: SCRFD + ArcFace (WASM) + optional MediaPipe (GPU).
- **True Offline**: Service Worker (PWA) caches all Javascript bundles and WASM runtimes. The app remains fully functional (face detection, search, VLM, and BFL generation) even if the Node server is stopped.
- **Direct Access**: Browser calls cloud providers directly for downloads (Internxt/Filen), VLM enrichment, and BFL generation, bypassing the Node proxy whenever possible.
- **Offline Sync**: Processed results queue locally and push to a remote server on reconnect.

### Desktop App (Electron)
```bash
cd electron-app-v4
npm run build:ui        # build the Svelte renderer
npm run start:electron  # launch Electron
```
The Electron app embeds the Express server in-process — no separate terminal needed. It automatically finds a free port (starting at 7861) and offers full database file management (open existing, create new, reset to default).

#### Automated Releases (v4)
The project includes scripts to build, tag, and publish releases directly to GitHub:
- **macOS (DMG)**: Run `./release-v4.sh`
- **Windows (EXE)**: Run `powershell ./release-v4.ps1` (requires PowerShell)

Both scripts require the [GitHub CLI (gh)](https://cli.github.com/) to be installed and authenticated.

### Mobile (Capacitor)
Local inference on iOS/Android — full images never leave the device. Only 512D vectors + thumbnails are sent to your configured remote server.
```bash
npm run mobile:setup:ios    # or :android (first time)
npm run mobile:sync
npm run mobile:run:ios      # or :android
```

---

## Duplicate Import Detection (v4)

Found in **Process → ⚙ Detection settings → Duplicates**:

| Mode | Behaviour |
|---|---|
| **Skip** (default) | Hash the file before running ONNX; skip entirely if already in DB. Fast — saves full inference time on re-scanned folders. |
| **Overwrite** | Delete existing faces/tags, re-process the image, update the existing row in-place. |
| **Always add** | Insert a new record even if the same content exists — for intentional re-imports. |

---

## v2 — Python FastAPI Setup

Best for high-performance server deployments where Python InsightFace can utilise GPU or CoreML acceleration.

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

### v2 Desktop App (Electron + Python backend)

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

**Building binaries:**
```bash
cd electron-app-v2/renderer && npm run build
cd .. && npm run build           # DMG (macOS), NSIS (Win), AppImage (Linux)
```

---

## Architecture Overview

### v4 — Three-Axis Connection Model

v4 separates three independent concerns: UI Source, API Server, and Inference Engine.

```
Axis 1: UI source        Axis 2: API + DB server      Axis 3: Inference engine
─────────────────        ──────────────────────────    ────────────────────────
Where the JS bundle      Where all API calls go         Where face detection runs
comes from               (set in Settings UI)           (set in Processing settings)

local v4 Node.js   ──►   localhost:7861 (local v4) ──►  Local ONNX (Node.js / WASM)
compiled/hosted    ──►   https://vps (remote v2)   ──►  Remote v2 (upload_bytes)
Vercel / GitHub    ──►   any CrispLens instance    ──►  Local ONNX → vectors only
                                                         (local_infer = privacy mode)
```

### Duplicate detection flow (v4 local/standalone)

```
File selected
    │
    ├─ duplicateMode = 'skip'?
    │       └── SHA-256 hash → DB lookup → already exists? → skip (no ONNX run)
    │
    └── Run SCRFD + ArcFace (ONNX)
            │
            ├── importProcessed({ file_hash, local_path, duplicate_mode })
            │       ├── 'skip'      → return {skipped:true} if hash/path matches
            │       ├── 'overwrite' → DELETE old faces/tags, UPDATE row, re-insert
            │       └── 'always_add' → INSERT new row regardless
            │
            └── Store: filename, filepath, local_path, file_hash, thumbnail, embeddings
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
The v4 edition is ideal for containerised environments.
```bash
docker build -t crisplens .
docker run -d -p 7861:7861 -v crisp-data:/data --name crisplens crisplens
```

---

## Deployment Topologies

- **Local-only**: Each user runs their own Electron app with a local database file.
- **Shared NAS**: Multiple clients point to a single `face_recognition.db` on a network share.
- **Central VPS**: A single high-power server handles API and storage; clients connect via browser or thin Electron shell.
- **Privacy / Offline**: Standalone mode — no server at all; full ONNX inference and storage in-browser; optionally sync to VPS when online.
- **Hybrid mobile**: Capacitor app runs ONNX locally on iOS/Android; only vectors + thumbnails are sent to the remote server.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "ABI mismatch" during start | Node version conflict | Run `electron-builder install-app-deps` in v4 dir |
| "No images shown" in Electron | `db_mode` defaulted to `local` | Fixed automatically; check Settings → Storage Mode |
| Port 7861 in use | Another process | Electron auto-picks next free port (7862–7881) |
| "No faces found" | Image too small / threshold too high | Lower `detection_threshold`; increase storage resolution in Standalone mode |
| Startup takes >60 s | `buffalo_l` loading on CPU | Enable CoreML (macOS) or CUDA in Settings → Hardware Acceleration |
| iOS photo picker needs 2 taps | Capacitor Camera plugin lazy-loaded | Fixed — plugin pre-imported at module init |
| `localfile://` fail | macOS Full Disk Access | Add CrispLens to System Preferences → Privacy → Full Disk Access |
| SSE stream stops | nginx buffering | Add `proxy_buffering off` in nginx config for `/api/` |
| Voy match returns "Unknown" | Unidentified embeddings in HNSW index | Fixed — only named-person embeddings are indexed |
| Settings wiped after hard reset | Config keys not preserved | Fixed — `hardResetApp()` saves/restores `_CONFIG_KEYS` from `localStorage` |

---

## Legacy Versions (v1 Gradio)

The original Gradio-based UI is still available but no longer actively developed.

```bash
source venv/bin/activate
python face_rec_ui.py   # → http://localhost:7860
```
Default credentials: **admin / admin123**

---

For detailed v4 documentation, see [electron-app-v4/README.md](electron-app-v4/README.md).
For detailed v2 documentation, see [electron-app-v2/README.md](electron-app-v2/README.md).
