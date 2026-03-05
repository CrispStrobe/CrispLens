# CrispLens

A self-hosted face recognition and photo management system. Ships as a full-featured Python/FastAPI server (v2) and a Python-free pure Node.js/WASM edition (v4).

**Live Demo:** [https://crisplens.vercel.app](https://crisplens.vercel.app)

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
  - [Standalone Mode (Demo)](#standalone-mode-demo)
- [v2 — Python FastAPI Setup](#v2--python-fastapi-setup)
- [Desktop App V2 — Build & Run](#desktop-app-v2--build--run)
- [Architecture Overview](#architecture-overview)
- [Deployment Topologies](#deployment-topologies)
- [Legacy Versions (v1 Gradio)](#legacy-versions-v1-gradio)
- [Troubleshooting](#troubleshooting)

---

## Features

- **Face detection & recognition** — SCRFD + ArcFace ONNX (v4) or InsightFace/dlib (v2).
- **High-Resolution Standalone Storage** — v4 Standalone mode supports dynamic storage resolution (up to 1200px) in the browser's IndexedDB.
- **FAISS / usearch vector search** — fast nearest-neighbour lookup.
- **Hybrid ingest modes** — Upload-full or `local_infer` (ONNX on client, only vectors sent to remote).
- **Privacy mode** — `local_infer` ensures full images never leave your local machine.
- **AI image enrichment** — 9 VLM providers; scene type, description, auto-tags.
- **Role-based access control** — admin / mediamanager / user roles; image visibility (shared/private).
- **Identify view** — gallery of images with unidentified faces; SVG bbox overlay + autocomplete.
- **Image editing** — EXIF-preserving rotate, free-draw crop, format conversion.

---

## v4 — Pure Node.js (Server & Standalone)

No Python setup required. Uses ONNX Runtime for server-side or browser-side inference.

### Server Mode
Run as a traditional backend. It serves the UI and provides an API for storage and inference.
```bash
cd electron-app-v4
npm install
node server.js          # → http://localhost:7861
```

### Standalone Mode (Demo)
The app can run entirely in the browser using WASM SQLite and WASM ONNX.
- **Inference**: SCRFD + ArcFace (WASM) + Optional MediaPipe (GPU).
- **Storage**: Browser IndexedDB (WASM SQLite).
- **Resolution**: Adjustable via **Settings → Offline Cache → Thumbnail size**. Storing images at up to 1200px allows for high-quality archival entirely within the browser.

**Live Demo**: [https://crisplens.vercel.app](https://crisplens.vercel.app)

---

## v2 — Python FastAPI Setup

Best for high-performance server deployments where Python InsightFace can utilize GPU or CoreML acceleration.

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp config.example.yaml config.yaml
sqlite3 face_recognition.db < schema_complete.sql
uvicorn fastapi_app:app --reload --port 7865
```

---

## Architecture overview

### v4 — Three-Axis Connection Model

v4 separates three concerns: UI Source, API Server, and Inference Engine.

```
Axis 1: UI source         Axis 2: API + DB server     Axis 3: Inference engine
─────────────────         ──────────────────────────   ──────────────────────────
Where the JS bundle       Where all API calls go        Where face detection runs
comes from                (set in Settings UI)          (set in Processing Override)

local v4 Node.js    ──►   localhost:7861 (local v4)  ──►  Local ONNX (default)
compiled/hosted     ──►   https://vps (remote v2)    ──►  [remote handles its own]
any static host     ──►   any CrispLens instance     ──►  Local ONNX → vectors only
                                                           (local_infer = privacy mode)
```

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

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "No faces found" | Image too small / threshold too high | Lower `detection_threshold` or increase storage resolution. |
| Startup takes >60 s | `buffalo_l` loading on CPU | Use `buffalo_s` or enable `use_coreml` (macOS). |
| Standalone mode slow | WASM inference | Enable "Use GPU" if available or use a smaller detection model. |

For detailed v4 documentation, see [electron-app-v4/README.md](electron-app-v4/README.md).
