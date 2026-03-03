# CrispLens v4 — Pure Node.js, Python-Free

Zero Python. Zero venv. Same 512D ArcFace vectors. Same SQLite DB as v2.

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

Deploy `renderer/dist/` to any static host and run `node server.js` on the server. Users can "Install App" in Chrome/Safari for a standalone PWA experience.

### 3. iOS & Android (Capacitor)

**From the top-level `electron-app-v4/` directory:**

```bash
# First-time setup (creates ios/ or android/ native project)
npm run mobile:setup:ios
npm run mobile:setup:android

# Build + sync (rebuild JS → copy into native project)
npm run mobile:sync

# Open in Xcode / Android Studio
npm run mobile:open:ios
npm run mobile:open:android

# Build + launch on device/simulator
npm run mobile:run:ios
npm run mobile:run:android
```

**Or from `renderer/` directly:**

```bash
cd electron-app-v4/renderer
npm install
npx cap add ios         # sets up Xcode project in renderer/ios/
npx cap add android     # sets up Android Studio project in renderer/android/
npm run build && npx cap sync   # build + copy dist/ into native projects
npx cap run ios
npx cap run android
```

**Point the app at a remote server:**

The mobile app is a thin shell — it connects to a CrispLens server for all API calls.
Configure the server URL in Settings → API / Database Server, or at build time:

```bash
CAPACITOR_SERVER_URL=http://192.168.1.x:7861 npx cap run ios
```

**Local inference on device (privacy-first):**

Enable "Local inference (browser/mobile)" in the Process view drop zone. This uses
`onnxruntime-web` (WASM) + Canvas API to run the full SCRFD detection + ArcFace embedding
pipeline on-device. Only 512D vectors + thumbnail are sent to the server — full images
never leave the device. Models (~180 MB) are downloaded once from the configured server
and cached via the browser Cache API.

| Library | Role | Mobile backend |
|---|---|---|
| `onnxruntime-web` | SCRFD detection + ArcFace embedding | WASM (single-threaded, no COOP/COEP needed) |
| `@mediapipe/tasks-vision` | Alternative detector (`det_model=mediapipe`) | WebGL / GPU-accelerated |
| `voy-search` | Optional HNSW index for offline recognition | WASM |
| `@capacitor/camera` | Native camera access | Capacitor plugin |
| `@capacitor/filesystem` | Local file access | Capacitor plugin |

---

## Configuration

| Env var | Default | Description |
|---|---|---|
| `PORT` | `7861` | API server listen port |
| `DB_PATH` | `../face_recognition.db` | Path to SQLite database |
| `DEFAULT_ADMIN_USER` | `admin` | Bootstrap admin username (if users table is empty) |
| `DEFAULT_ADMIN_PASS` | `admin` | Bootstrap admin password |
| `UPLOAD_DIR` | `../data/uploads` | Where uploaded images are stored |
| `DEBUG` | `` | Set to `1` for verbose detection/embedding logs |

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
# → http://localhost:5173
```

---

## Models

### Face Detection + Recognition

Buffalo_l models are shared with Python InsightFace:
- Auto-detected at: `~/.insightface/models/buffalo_l/`
- Or downloaded automatically on first run: `node core/model-downloader.js`

| Model file | Purpose | Size |
|---|---|---|
| `det_10g.onnx` | SCRFD-10GF face detection | ~16 MB |
| `w600k_r50.onnx` | ArcFace ResNet50, 512D embeddings | ~166 MB |

### YuNet (optional second detector)

YuNet is downloaded on demand when first selected as `det_model=yunet`:
- Source: `opencv_zoo/face_detection_yunet_2023mar.onnx`
- Size: ~370 KB (tiny, included in the model dir)
- Advantage: very fast, good at small faces
- Disadvantage: no landmark output (landmarks set to None; embedding still computed from aligned crop)

---

## Three-Axis Connection Architecture

The connection model has three independent axes, each configurable separately:

```
┌─────────────────────────────────────────────────────────────┐
│  Axis 1: UI source                                          │
│    Where the HTML/JS bundle comes from                      │
│    → local v4 Node.js  / remote v2 FastAPI / static host   │
│    → irrelevant to the other two axes                       │
├─────────────────────────────────────────────────────────────┤
│  Axis 2: API + DB server  (Settings → API/Database Server)  │
│    All browser API calls (images, people, faces, DB) go here│
│    Stored in: localStorage 'remote_url'                     │
│    Options:                                                  │
│    • Same origin (default) — local v4 at localhost:7861     │
│    • https://remote-v2.example.com — remote v2 FastAPI      │
│    • http://other-host:7861 — any other CrispLens instance  │
│    When changed: page reloads and all data comes from there │
├─────────────────────────────────────────────────────────────┤
│  Axis 3: Inference engine  (only when Axis 2 = local v4)   │
│                                                             │
│  processing_backend = 'local'  (default)                   │
│    v4 ONNX runs SCRFD/YuNet detection + ArcFace embedding  │
│    Results stored in local DB                               │
│                                                             │
│  processing_backend = 'remote_v2'                          │
│    remote_v2_mode = 'upload_bytes'                         │
│      Full image → remote v2 → remote inference + storage   │
│    remote_v2_mode = 'local_infer'                          │
│      v4 ONNX runs locally (privacy-friendly, no image sent) │
│      Only 512D vectors + thumbnail → remote v2             │
│      Remote v2 does FAISS matching only, stores to its DB  │
└─────────────────────────────────────────────────────────────┘
```

### Changing the API server (Settings → API/Database Server)

In the browser, go to Settings and change the "Server URL" field. After clicking "Connect" the page reloads pointing at the new server. This is how you switch between local v4 and a remote v2 FastAPI — once pointed at remote v2, you see that server's images, people, and DB.

### Processing Override (Settings → Processing Override, admin only)

Only active when the API server is local v4. Adds an optional remote inference server:

| Mode | What goes over the network | Who runs inference |
|---|---|---|
| `local` (default) | Nothing extra | Local v4 ONNX |
| `remote_v2` + `upload_bytes` | Full image bytes | Remote v2 Python InsightFace |
| `remote_v2` + `local_infer` | 512D vectors + 200px thumbnail | Local v4 ONNX |

`local_infer` is the privacy-friendly bandwidth-efficient mode: full images never leave the machine. The remote v2 server only receives the detection result — it runs person-matching (FAISS) and stores the embedding in its own DB.

---

## Face Detection Models

| `det_model` value | Engine | Notes |
|---|---|---|
| `auto` (default) | SCRFD-10GF (buffalo_l) | Best accuracy, 5 landmark points |
| `yunet` | YuNet 2023 | Smaller/faster, ~370 KB model, auto-downloaded |
| `none` | — | Skip detection; VLM description only |

Remote v2 backends additionally support `retinaface`, `scrfd`, `mediapipe` — these appear in the dropdown automatically when the processing backend is set to `remote_v2`.

Detection parameters (tunable per-request in Process view and FaceIdentifyModal):

| Parameter | Default | Description |
|---|---|---|
| `det_thresh` | `0.5` | Minimum face detection confidence |
| `min_face_size` | `0` | Minimum face short-side in pixels (0 = no filter) |
| `max_size` | `0` | Downscale image long-edge before detection (0 = no limit) |
| `rec_thresh` | `0.4` | Minimum cosine similarity for person recognition |

---

## Processing Pipeline (local)

```
imagePath
    │
    ▼  sharp.rotate()          — EXIF auto-rotation to display space
    ▼  letterbox 640×640       — top-left, black padding (matches InsightFace)
    ▼  SCRFD-10GF  (det_10g.onnx)
    │    ├─ scores, bboxes, kps  (9 output tensors, 3 strides × 3 types)
    │    └─ NMS → face list  [{bbox:[x1,y1,x2,y2], score, landmarks:[5pts]}]
    │
    ▼  ArcFace alignment (face-align.js)
    │    Similarity transform: 5 source landmarks → canonical 112×112 template
    │    Umeyama closed-form (same as skimage.transform.SimilarityTransform)
    │
    ▼  ArcFace ResNet50  (w600k_r50.onnx)
    │    Preprocessing: (pixel − 127.5) / 128.0, NCHW, RGB
    │    Output: 512D float32 → L2-normalised → face embedding
    │
    ▼  VectorStore.search()    — cosine similarity vs all enrolled embeddings
    │    Backends tried in order: usearch HNSW → faiss-node → brute-force
    │
    ▼  SQLite write
         images / faces / face_embeddings
```

---

## `POST /api/ingest/import-processed` (remote store)

When `local_infer` mode is active, v4 calls `FaceEngine.extractFaceData()` and POSTs the result to the remote v2's `import-processed` endpoint. The remote server:
1. Deduplicates by `file_hash` + optional `owner_id`
2. Stores the thumbnail to disk
3. Inserts image + face records
4. Runs FAISS person-matching on the received embeddings
5. Stores results in its own DB

Payload format (sent by v4, received by v2):

```json
{
  "local_path":    "/path/to/original.jpg",
  "filename":      "original.jpg",
  "width":         4032,
  "height":        3024,
  "file_size":     3145728,
  "file_hash":     "sha256hex...",
  "thumbnail_b64": "base64-encoded-200px-jpeg",
  "local_model":   "buffalo_l",
  "visibility":    "shared",
  "faces": [
    {
      "bbox_left":            0.23,
      "bbox_top":             0.10,
      "bbox_right":           0.45,
      "bbox_bottom":          0.58,
      "detection_confidence": 0.97,
      "embedding":            [0.012, -0.034, ...],
      "embedding_dimension":  512
    }
  ]
}
```

---

## Server Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/health` | — | Health check + model_ready flag |
| `GET` | `/api/images` | ✓ | Browse images (filter by person/tag/date/folder/album) |
| `GET` | `/api/images/:id` | ✓ | Image detail |
| `GET` | `/api/images/:id/thumbnail` | ✓ | Resized thumbnail (sharp) |
| `GET` | `/api/images/:id/full` | ✓ | Full-resolution download |
| `POST` | `/api/images/:id/re-detect` | ✓ | Re-run detection on one image |
| `GET` | `/api/people` | ✓ | List all recognised people |
| `POST` | `/api/ingest/upload-local` | ✓ | Upload image file → full pipeline |
| `POST` | `/api/ingest/import-processed` | ✓ | Accept pre-computed embeddings (v4 local_infer or v2 Mode C) |
| `POST` | `/api/process/batch` | ✓ | SSE batch processing (server-side folder) |
| `GET` | `/api/settings` | ✓ | Get all settings |
| `PUT` | `/api/settings` | admin | Save settings |
| `GET` | `/api/settings/processing-status` | admin | Test remote backend reachability |
| `POST` | `/api/settings/test-remote-v2` | admin | Test remote v2 with form values (before saving) |
| `GET` | `/api/settings/engine-status` | ✓ | ONNX model load status |
| `POST` | `/api/batch-jobs` | ✓ | Create batch job |
| `POST` | `/api/batch-jobs/:id/start` | ✓ | Start batch job (SSE progress) |

---

## Compatibility Test

```bash
node proto-test.js                          # test against existing DB
node proto-selfcontained.js                 # self-contained (downloads AT&T dataset)
node proto-selfcontained.js ../face_rec.db  # also searches existing DB
```

---

## Key Files

```
electron-app-v4/
├── server.js                   Express server, port 7861
├── core/
│   ├── face-engine.js          SCRFD detection + ArcFace embedding + extractFaceData()
│   ├── face-align.js           Umeyama similarity transform + bilinear warp 112×112
│   ├── model-downloader.js     Downloads buffalo_l + YuNet (opencv_zoo)
│   ├── remote-v2-client.js     HTTP client for remote v2 FastAPI (auth, import-processed)
│   └── search.js               VectorStore: usearch HNSW → faiss-node → brute-force cosine
├── server/
│   ├── db.js                   better-sqlite3 singleton
│   ├── auth.js                 PBKDF2 session auth
│   ├── processor.js            processImageIntoDb() + remote routing
│   └── routes/
│       ├── images.js           image CRUD + thumbnail + re-detect
│       ├── people.js           person CRUD + merge + reassign
│       ├── faces.js            unidentified faces + clusters + face-crop
│       ├── search.js           text + vector similarity search
│       ├── process.js          SSE batch processing
│       ├── ingest.js           upload-local + import-processed
│       ├── settings.js         settings CRUD + engine/db status + remote v2 test
│       └── misc.js             tags/albums/events/watchfolders/filesystem/batch-jobs
└── renderer/src/
    ├── App.svelte              Root shell — health polling, API base URL, i18n init
    ├── api.js                  Typed fetch wrappers; setRemoteBase() for remote API
    ├── stores.js               Svelte stores (processingBackend, currentUser, t(), …)
    └── lib/
        ├── SettingsView.svelte API/DB server URL + processing override + users
        ├── ProcessView.svelte  Upload + local folder scan; det params; backend badge
        ├── FaceIdentifyModal.svelte  SVG bbox overlay + per-face re-detect + det model
        └── ...                 (all other views identical to v2)
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Models not found` on startup | Run `node core/model-downloader.js` or copy `buffalo_l/` to `~/.insightface/models/buffalo_l/` |
| API calls go to wrong server | Settings → API/Database Server → update URL → Connect (page reloads) |
| Remote v2 "Nicht erreichbar" | Check URL uses `https://` (no trailing port if nginx on 443); test with `curl -v https://host/api/health` |
| `local_infer` mode: no faces imported | Check remote v2 logs for `import-processed` errors; verify `buffalo_l` models present locally |
| YuNet not found | Deleted automatically on first `det_model=yunet` request — ensure write access to model dir |
| 304 cached responses | Express ETags are normal; browser cache invalidated on new data automatically |
| `DEBUG=1 node server.js` | Prints per-image detection counts, bbox coords, embedding similarity scores |
