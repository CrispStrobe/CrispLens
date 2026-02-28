# CrispLens

A self-hosted face recognition and photo management system. Ships as a standalone Python/FastAPI server, a Gradio web UI (v1), and a next-generation Svelte-based desktop application (V2 — recommended).

## Which Version to Use?

| | Gradio Web UI (v1) | Electron v1 | **Desktop App V2** |
|---|---|---|---|
| Interface | Browser-based | Native wrapper (Gradio) | Svelte SPA |
| Backend | face_rec_ui.py | face_rec_ui.py | fastapi_app.py |
| Default port | 7860 | 7860 | 7865 |
| Hybrid ingest | — | — | ✓ (B/C + server folder) |
| First-run wizard | — | — | ✓ |
| Recommended | — | — | ✓ |

---

## Table of Contents

- [Features](#features)
- [Architecture overview](#architecture-overview)
- [Python setup (v2 FastAPI)](#python-setup-v2-fastapi)
- [Python setup (v1 Gradio)](#python-setup-v1-gradio)
- [Desktop App V2 — Build & Run](#desktop-app-v2--build--run)
  - [Development mode](#development-mode)
  - [Building binaries](#building-binaries)
  - [GitHub Actions CI](#github-actions-ci)
- [VPS deployment](#vps-deployment)
  - [Interactive install](#interactive-install)
  - [Fully automated / CI](#fully-automated--ci)
  - [Container / Docker](#container--docker)
- [First-run Setup Wizard](#first-run-setup-wizard)
- [electron-settings.json schema](#electron-settingsjson-schema)
- [Environment variables reference](#environment-variables-reference)
- [Configuration reference (config.yaml)](#configuration-reference-configyaml)
- [Face recognition backends](#face-recognition-backends)
- [VLM providers](#vlm-providers)
- [User management](#user-management)
- [Training](#training)
- [API key security](#api-key-security)
- [Deployment topologies](#deployment-topologies)
- [File structure](#file-structure)
- [Troubleshooting](#troubleshooting)

---

## Features

- **Face detection & recognition** — InsightFace (`buffalo_l/m/s/sc`) or dlib (HOG/CNN)
- **FAISS vector search** — fast nearest-neighbour lookup over millions of embeddings
- **Hybrid ingest modes** — upload-full (B) and local InsightFace (C); server-side folder section always present in ProcessView for direct VPS path scanning
- **`localfile://` Electron protocol** — full-res images served from local disk instantly
- **AI image enrichment** — 9 VLM providers; scene type, description, auto-tags
- **Encrypted API key storage** — Fernet (AES-128-CBC + HMAC-SHA256); never plaintext
- **Role-based access control** — admin / mediamanager / user roles; image ownership + visibility (shared/private); per-image sharing
- **Duplicate detection** — filename+size, SHA256, pHash visual; resolve: delete/db-only/symlink
- **Batch processing with SSE** — live progress via Server-Sent Events
- **Filesystem browser + watch folders** — real FS navigation, DB-status badges, auto-scan
- **Identify view** — gallery of images with unidentified faces; SVG bbox overlay + autocomplete
- **Image editing** — EXIF-preserving rotate, free-draw crop, format conversion
- **CoreML acceleration** — macOS: ONNX → CoreML compiled on first run, cached
- **Network drive mounting** — SMB/CIFS shares (macOS & Linux)
- **i18n** — German and English

---

## Architecture overview

### Desktop V2 (Recommended)

```
┌───────────────────────────────────────────────────────────────────┐
│  Electron v2 — "Client + Server" (default)                        │
│  setup-wizard.html → main.js → PythonManager → FastAPI (:7865)   │
│  BrowserWindow → Svelte UI                                        │
│  localfile:// protocol — full-res images from local disk          │
└───────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────┐
│  Electron v2 — "Client only" (remote VPS)                         │
│  BrowserWindow → https://your-vps.example.com                    │
│  Ingest mode B: Electron uploads full images → VPS processes      │
│  Ingest mode C: InsightFace on Mac → uploads embeddings only      │
│  Server folder section: browse + trigger VPS-side SSE scan        │
│  Lightbox → localfile:// (instant, no network round-trip)         │
└───────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────┐
│  Electron v2 — "Server only" (headless, tray-icon only)           │
│  FastAPI subprocess, no BrowserWindow                             │
│  Accessible from any browser or remote Electron client            │
└───────────────────────────────────────────────────────────────────┘
```

### FastAPI Backend (v2)

```
┌──────────────────────────────────────────────────────────────────┐
│  fastapi_app.py                                                   │
│  ├── routers/images.py          image browse, detail, CRUD        │
│  ├── routers/people.py          person CRUD, merge, reassign      │
│  ├── routers/search.py          name-based search                 │
│  ├── routers/processing.py      single / batch SSE pipeline       │
│  ├── routers/auth.py            login / session                   │
│  ├── routers/settings.py        config read-write, DB health      │
│  ├── routers/api_keys.py        encrypted VLM key management      │
│  ├── routers/filesystem.py      FS browse + add-to-DB (SSE)       │
│  ├── routers/watchfolders.py    watch folder CRUD + scan (SSE)    │
│  ├── routers/duplicates.py      dup groups, pHash scan, resolve   │
│  ├── routers/ingest.py          upload-local + import-processed   │
│  ├── routers/users.py           user CRUD (admin only)            │
│  ├── routers/deps.py            auth dependencies + access ctrl   │
│  └── routers/face_cluster.py    clustering, face-crop, assign     │
│                                                                   │
│  face_recognition_core.py       InsightFace/dlib + FAISS          │
│  local_processor.py             InsightFace subprocess (NDJSON)   │
│  image_ops.py                   EXIF, metadata, thumbnail, CRUD   │
│  vlm_providers.py               VLM provider adapters (9×)        │
│  api_key_manager.py             Fernet-encrypted key store        │
│  permissions.py                 bcrypt/PBKDF2 user auth           │
└──────────────────────────────────────────────────────────────────┘
                         │
                         ▼  SQLite (WAL mode)
┌──────────────────────────────────────────────────────────────────┐
│  face_recognition.db                                              │
│  ├── images       filepath, local_path, owner_id, visibility,    │
│  │                EXIF, VLM, face_count                           │
│  ├── faces        bbox (0–1 normalised), quality, age, gender     │
│  ├── face_embeddings  embedding vector, person_id, confidence     │
│  ├── people       name, appearance count, first/last seen         │
│  ├── tags / image_tags                                            │
│  ├── users        username, role, vlm_enabled/provider/model      │
│  ├── image_shares / album_shares  per-item access grants          │
│  ├── watch_folders    path, schedule, last_scan stats             │
│  ├── cloud_drives     SMB/SFTP/Filen/Internxt mount configs       │
│  └── settings     key-value config                                │
└──────────────────────────────────────────────────────────────────┘
```

### Gradio Backend (v1, legacy)

```
┌──────────────────────────────────────────────────────────────────┐
│  face_rec_ui.py  (Gradio 6, port 7860)                           │
│  face_recognition_core.py  (same shared engine)                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Python setup (v2 FastAPI)

### Prerequisites

| Requirement | Notes |
|---|---|
| Python 3.10+ | `python3 --version` |
| pip (latest) | `pip install --upgrade pip` |
| sqlite3 | pre-installed on most systems |
| ~4 GB disk | `buffalo_l` model download on first run |

### Install and run

```bash
git clone https://github.com/CrispStrobe/CrispLens
cd CrispLens

python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate

pip install -r requirements.txt

# macOS Apple Silicon — faster ONNX inference
pip install onnxruntime-silicon

# Optional: visual duplicate detection
pip install imagehash

cp config.example.yaml config.yaml
sqlite3 face_recognition.db < schema_complete.sql

uvicorn fastapi_app:app --reload --port 7865
```

Open `http://localhost:7865` — create the admin account via the web UI on first login, or set `CRISP_ADMIN_USER` / `CRISP_ADMIN_PASS` env vars before starting (see [Environment variables](#environment-variables-reference)).

---

## Python setup (v1 Gradio)

```bash
source venv/bin/activate
python face_rec_ui.py
```

Open `http://localhost:7860` — default credentials: **admin / admin123** (change immediately).

---

## Desktop App V2 — Build & Run

### Development mode

```bash
# Terminal 1 — FastAPI backend
uvicorn fastapi_app:app --reload --port 7865

# Terminal 2 — Svelte dev server (HMR, proxies /api → :7865)
cd electron-app-v2/renderer
npm install
npm run dev
# Open http://localhost:5173

# Terminal 3 — Electron shell (skips wizard, loads Vite dev server)
cd electron-app-v2
npm install
ELECTRON_DEV=1 npm start
```

### Building binaries

```bash
# 1. Build Svelte frontend
cd electron-app-v2/renderer
npm run build           # outputs to dist/ (served by FastAPI as StaticFiles)

# 2. Package Electron
cd electron-app-v2
npm run build           # DMG on macOS, NSIS installer on Windows, AppImage on Linux
```

#### macOS code signing + notarisation

```bash
export CSC_LINK=/path/to/cert.p12
export CSC_KEY_PASSWORD=<password>
export APPLE_ID=you@example.com
export APPLE_ID_PASS=app-specific-password
export APPLE_TEAM_ID=XXXXXXXXXX
npm run build:mac
```

Without notarisation, users see a Gatekeeper warning but can still open the app via right-click → Open.

### GitHub Actions CI

```yaml
# .github/workflows/build.yml
jobs:
  build-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: cd electron-app-v2 && npm ci && npm run build
      - uses: actions/upload-artifact@v4
        with: { name: windows, path: electron-app-v2/dist/*.exe }

  build-macos:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: |
          cd electron-app-v2/renderer && npm ci && npm run build
          cd ../.. && cd electron-app-v2 && npm ci && npm run build:mac
      - uses: actions/upload-artifact@v4
        with: { name: macos, path: electron-app-v2/dist/*.dmg }

  build-linux:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: |
          cd electron-app-v2/renderer && npm ci && npm run build
          cd ../.. && cd electron-app-v2 && npm ci && npm run build:linux
      - uses: actions/upload-artifact@v4
        with: { name: linux, path: electron-app-v2/dist/*.AppImage }
```

---

## VPS Deployment

### Interactive install

On a fresh Ubuntu/Debian VPS — prompts for all options:

```bash
git clone https://github.com/CrispStrobe/CrispLens /opt/crisp-lens
sudo bash /opt/crisp-lens/deploy-v2.sh
```

The script:
1. Installs system packages (Python 3.10+, Node.js 20, nginx, certbot, sqlite3, libgl1 …)
2. Creates a dedicated system user (`face-rec`)
3. Creates Python venv + installs `requirements.txt`
4. Builds the Svelte frontend (`npm run build`)
5. Patches `config.yaml` (`use_coreml: false`, `lazy_init: true`)
6. Initialises SQLite from `schema_complete.sql`
7. Registers a systemd service (`uvicorn fastapi_app:app --host 127.0.0.1`)
8. Configures nginx (`proxy_buffering off` for SSE) + optional Let's Encrypt TLS
9. Bootstraps the admin account via `CRISP_ADMIN_USER` / `CRISP_ADMIN_PASS`

### Fully automated / CI

All prompts can be bypassed with environment variables (see [deploy-v2.sh variables](#deploy-v2sh-variables) below):

```bash
export CRISP_ADMIN_USER=admin
export CRISP_ADMIN_PASS='s3cr3t!X9'
export CRISP_DOMAIN=faces.example.com
export CRISP_SSL=true
export CRISP_SSL_EMAIL=ops@example.com
export CRISP_YES=1
sudo -E bash deploy-v2.sh
```

Useful commands after deployment:

```bash
journalctl -u face-rec -f          # live logs
systemctl status  face-rec         # service status
systemctl restart face-rec         # restart after code/config changes
systemctl stop    face-rec         # stop
```

Update after `git pull`:

```bash
cd /opt/crisp-lens && sudo -u face-rec git pull
sudo -u face-rec venv/bin/pip install -q -r requirements.txt
cd electron-app-v2/renderer && sudo -u face-rec npm run build && cd -
systemctl restart face-rec
```

### Patching an existing install (deployed from an older script)

If the server was deployed before the admin-update feature was added, run the targeted patcher once:

```bash
sudo bash patch_deployment.sh
```

This applies four fixes without touching your data or database:
1. Creates `/etc/sudoers.d/crisp-lens` — NOPASSWD for `fix_db.sh` (service accounts have no shell password; sudo always fails without this)
2. Removes `NoNewPrivileges=yes` from the systemd unit — older scripts set this, which blocks the `sudo` setuid bit entirely
3. Adds `<Location /api>` + `<Location /api/admin>` blocks inside the Apache VirtualHost — prevents mod_deflate buffering of SSE streams
4. Writes `admin.fix_db_path` to `config.yaml` so the UI finds the script path automatically

### Container / Docker

Build the image (no admin credentials baked in):

```bash
docker build -t crisp-lens .
```

Run (admin account created on first start, credentials passed at runtime):

```bash
docker run -d \
  -p 7865:7865 \
  -v crisp-data:/data \
  -e FACE_REC_DATA_DIR=/data \
  -e CRISP_ADMIN_USER=admin \
  -e CRISP_ADMIN_PASS='s3cr3t!X9' \
  --name crisp-lens \
  crisp-lens
```

Or use the deploy script in container mode to build a custom install:

```bash
CRISP_CONTAINER=1 CRISP_INSTALL_DIR=/app bash deploy-v2.sh
```

---

## First-run Setup Wizard

On first launch (no `electron-settings.json`), the V2 app shows a multi-step wizard:

```
Step 1 — Role
┌─────────────────────────────────────────────────────────┐
│  ┌─────────────────────┐ ┌──────────────┐ ┌──────────┐  │
│  │ ● Client + Server   │ │ Client only  │ │  Server  │  │
│  │   (recommended)     │ │ (remote VPS) │ │  only    │  │
│  └─────────────────────┘ └──────────────┘ └──────────┘  │
└─────────────────────────────────────────────────────────┘

Step 2 — Server config  (skipped if Client only)
┌─────────────────────────────────────────────────────────┐
│  Port:           [7865]                                 │
│  Data folder:    [~/Library/.../CrispLens]  [Browse]    │
│  Database:  ● Create new   ○ Reuse existing: [path]     │
│  Admin user:     [admin]                                │
│  Admin password: [●●●●●●●●]  Confirm: [●●●●●●●●]       │
│  ── Advanced ──────────────────────────────────────     │
│  Python:  [auto-detect]  [Browse]  [Test]               │
│  Workers: [1]                                           │
└─────────────────────────────────────────────────────────┘

Step 3 — Client config  (skipped if Server only)
┌─────────────────────────────────────────────────────────┐
│  Connect to:  ● Local server (from step 2)              │
│               ○ Remote server: [https://...]            │
│  Ingest mode (when remote):                             │
│    ● Upload full images  ○ Local InsightFace             │
└─────────────────────────────────────────────────────────┘

Step 4 — Installing
┌─────────────────────────────────────────────────────────┐
│  ✓ Python 3.12 found                                    │
│  ✓ Dependencies installed (stamp file)                  │
│  ✓ Database initialised                                 │
│  ↻ Downloading buffalo_l (~340 MB)  ████░░░░  45%       │
└─────────────────────────────────────────────────────────┘
```

| Role | What runs |
|---|---|
| **Client + Server** | FastAPI subprocess + full Svelte UI (default) |
| **Client only** | No local Python; loads configured remote VPS URL; hybrid ingest available |
| **Server only** | FastAPI subprocess; no BrowserWindow; system tray only |

To re-run the wizard: tray icon → **Switch mode / Reset settings**.

---

## `electron-settings.json` schema

Stored in the platform app-data directory (`~/Library/Application Support/CrispLens/` on macOS).
`adminPass` is **never written to disk** — stripped by `main.js` before saving.

```json
{
  "role": "both",
  "server": {
    "port": 7865,
    "dataDir": "/Users/alice/Library/Application Support/CrispLens",
    "dbPath": "face_recognition.db",
    "reuseExistingDb": false,
    "adminUser": "admin",
    "pythonPath": "",
    "workers": 1
  },
  "client": {
    "connectTo": "local",
    "remoteUrl": "https://faces.example.com",
    "processingMode": "upload_full",
    "localModel": "buffalo_l",
    "pythonPath": ""
  }
}
```

| Field | Type | Values | Description |
|---|---|---|---|
| `role` | string | `both` \| `client` \| `server` | Deployment role |
| `server.port` | number | 1–65535 | FastAPI listen port (`FACE_REC_PORT` env var overrides) |
| `server.dataDir` | string | absolute path | Parent directory for DB, thumbnails, FAISS index |
| `server.dbPath` | string | path | Absolute or relative-to-`dataDir`; default `face_recognition.db` |
| `server.reuseExistingDb` | boolean | | Skip schema init; attach to existing DB |
| `server.adminUser` | string | | Bootstrap admin username (first-run only; ignored if users exist) |
| `server.pythonPath` | string | | Python interpreter; empty = auto-detect venv or `python3` |
| `server.workers` | number | ≥1 | uvicorn worker count |
| `client.connectTo` | string | `local` \| `remote` | `local` = wizard step 2 server; `remote` = `remoteUrl` |
| `client.remoteUrl` | string | full URL | VPS address when `connectTo=remote` |
| `client.processingMode` | string | `upload_full` \| `local_process` | Ingest mode (remote only); default `upload_full` |
| `client.localModel` | string | `buffalo_l/m/s/sc` | InsightFace model for Mode C local processing |
| `client.pythonPath` | string | | Python for local InsightFace; empty = auto |

---

## Environment variables reference

### FastAPI backend (`fastapi_app.py`)

| Variable | Default | Description |
|---|---|---|
| `FACE_REC_DATA_DIR` | `` (cwd) | Data directory: `config.yaml`, DB, thumbnails, FAISS index, logs |
| `FACE_REC_PORT` | `7865` | FastAPI listen port |
| `FACE_REC_DB_PATH` | `` | Absolute path to SQLite DB — **overrides** `config.yaml` and `FACE_REC_DATA_DIR` |
| `FACE_REC_WORKERS` | `1` | uvicorn worker count |
| `FACE_REC_LOG_LEVEL` | `INFO` | Logging level: `DEBUG` \| `INFO` \| `WARNING` \| `ERROR` |
| `CRISP_ADMIN_USER` | `` | Bootstrap admin username on first start (skipped if any admin exists) |
| `CRISP_ADMIN_PASS` | `` | Bootstrap admin password (min 8 chars; first start only) |

### Local processor (`local_processor.py` — Mode C)

| Variable | Default | Description |
|---|---|---|
| `INSIGHTFACE_MODEL` | `buffalo_l` | Model for local face detection: `buffalo_l` \| `buffalo_m` \| `buffalo_s` \| `buffalo_sc` |
| `USE_COREML` | `1` | `1` = enable Apple Neural Engine on macOS; `0` = force CPU |
| `INSIGHTFACE_HOME` | `~/.insightface` | Override model cache directory |

### Electron main process (`main.js`)

| Variable | Default | Description |
|---|---|---|
| `ELECTRON_DEV` | `` | Set to `1` to skip wizard and load Vite dev server (`http://localhost:5173`) |

### `deploy-v2.sh` variables

All prompts are skipped when the corresponding variable is set. Pass via `export` + `sudo -E` or `env VAR=val sudo bash deploy-v2.sh`.

| Variable | Default | Required | Description |
|---|---|---|---|
| `CRISP_INSTALL_DIR` | `/opt/crisp-lens` | | Installation directory |
| `CRISP_SVC_USER` | `face-rec` | | System user (created if missing) |
| `CRISP_SVC_NAME` | `face-rec` | | systemd service name |
| `CRISP_PORT` | first free ≥ 7865 | | FastAPI listen port |
| `CRISP_WORKERS` | `1` | | uvicorn worker count |
| `CRISP_ADMIN_USER` | `admin` | **yes** | Bootstrap admin username |
| `CRISP_ADMIN_PASS` | — | **yes** | Bootstrap admin password (min 8 chars) |
| `CRISP_DOMAIN` | — | | nginx domain/subdomain; omit to skip nginx |
| `CRISP_SSL` | `false` | | `true` = enable Let's Encrypt HTTPS |
| `CRISP_SSL_EMAIL` | — | if SSL | Email for Let's Encrypt |
| `CRISP_YES` | `0` | | `1` = skip all confirmations |
| `CRISP_CONTAINER` | `0` | | `1` = container mode (skips systemd/nginx/user/sudo); auto-detected from `/.dockerenv` |

### Container / `start.sh` runtime variables

| Variable | Default | Description |
|---|---|---|
| `FACE_REC_PORT` | `7865` | Listen port |
| `FACE_REC_DATA_DIR` | `/data` | Data directory (mount a volume here) |
| `FACE_REC_WORKERS` | `1` | uvicorn worker count |
| `FACE_REC_DB_PATH` | — | Absolute path to SQLite DB (optional override) |
| `FACE_REC_LOG_LEVEL` | `info` | Log level |
| `CRISP_ADMIN_USER` | — | Bootstrap admin username (first start only) |
| `CRISP_ADMIN_PASS` | — | Bootstrap admin password (first start only) |

---

## Configuration reference (`config.yaml`)

All settings live in `config.yaml` (copy from `config.example.yaml`). When running via Electron the file is auto-created in the data directory.

### `ui`

| Key | Default | Description |
|---|---|---|
| `language` | `de` | Interface language: `de` \| `en` |
| `server.host` | `0.0.0.0` | Gradio bind address (v1 only; `127.0.0.1` when launched by Electron) |
| `server.port` | `7860` | Gradio port (v1 only; `FACE_REC_PORT` overrides for FastAPI v2) |
| `server.share` | `false` | Gradio public tunnel — keep `false` in production |
| `display.max_images_per_page` | `50` | Gallery pagination limit |
| `display.thumbnail_size` | `[150, 150]` | Thumbnail dimensions |
| `display.show_confidence` | `true` | Show recognition confidence in UI |
| `display.show_rectangles` | `true` | Show bounding boxes on images |

### `face_recognition`

| Key | Default | Description |
|---|---|---|
| `backend` | `insightface` | Engine: `insightface` \| `dlib_hog` \| `dlib_cnn` |
| `lazy_init` | `false` | Defer model load to first request (instant UI start; set `true` on VPS) |
| `faiss_sync_interval` | `30` | Seconds between FAISS mtime checks (shared-DB multi-user setups) |

### `face_recognition.insightface`

| Key | Default | Description |
|---|---|---|
| `model` | `buffalo_l` | `buffalo_l` (best, 340 MB) \| `buffalo_m` \| `buffalo_s` \| `buffalo_sc` (fastest) |
| `detection_threshold` | `0.7` | Lower → more detections, more false positives |
| `recognition_threshold` | `0.4` | Lower → more matches, less precise |
| `use_coreml` | `true` | macOS: compile ONNX → CoreML on first run, cache for fast restarts; set `false` on Linux |
| `det_size` | `[640, 640]` | Detection grid; `[320, 320]` is faster, may miss small faces |
| `adaptive_det_size` | `true` | Dynamically adjust detection grid per image |
| `ctx_id` | `0` | GPU device ID (`-1` = CPU only) |

### `face_recognition.dlib`

| Key | Default | Description |
|---|---|---|
| `model` | `hog` | Detector: `hog` (fast) \| `cnn` (accurate) |
| `detection_threshold` | `0.5` | Lower → more detections |
| `recognition_threshold` | `0.6` | Lower → more matches |
| `num_jitters` | `1` | Encoding iterations; higher = more accurate, slower |

### `face_recognition.processing`

| Key | Default | Description |
|---|---|---|
| `min_face_size` | `60` | Minimum face size in pixels |
| `max_faces_per_image` | `50` | Stop after N faces per image |
| `min_face_quality` | `0.3` | Minimum face quality score (0–1) |
| `face_crop_padding` | `0.25` | Padding around face crops (0–1) |
| `extract_face_crops` | `false` | Save individual face crops to disk |
| `max_face_size` | `0` | Max face size (0 = unlimited) |

### `database`

| Key | Default | Description |
|---|---|---|
| `path` | `face_recognition.db` | SQLite path — absolute or relative to `FACE_REC_DATA_DIR`; overridden by `FACE_REC_DB_PATH` env var |
| `faiss_index` | `face_vectors.index` | FAISS index file path (relative to data dir) |
| `optimization.journal_mode` | `WAL` | SQLite journal mode; `WAL` for concurrency |
| `optimization.synchronous` | `NORMAL` | Sync mode: `OFF` (fast/risky) \| `NORMAL` \| `FULL` (safe) |
| `optimization.cache_size` | `10000` | SQLite page cache (KB) |
| `backup.enabled` | `true` | Automatic DB backups |
| `backup.interval_hours` | `24` | Backup frequency |
| `backup.keep_backups` | `7` | Backups to retain |
| `backup.directory` | `backups` | Backup directory |

### `storage`

| Key | Default | Description |
|---|---|---|
| `store_on_disk` | `true` | Store face crops as JPEG files under `face_crops/` |
| `store_in_db` | `false` | Store face crops as BLOBs in SQLite |
| `generate_thumbnails` | `true` | Generate cached thumbnails |
| `thumbnail_size` | `[200, 200]` | Thumbnail dimensions |
| `calculate_file_hash` | `true` | Compute SHA256 for duplicate detection |
| `hash_algorithm` | `sha256` | Hash algorithm |
| `compression.quality` | `85` | JPEG compression quality (1–100) |
| `write_metadata` | `false` | Write EXIF metadata back to files |
| `upload_max_dimension` | `0` | Resize uploaded images to this max dimension (px) before saving; `0` = keep full resolution |

### `vlm`

| Key | Default | Description |
|---|---|---|
| `enabled` | `false` | Run VLM enrichment during batch import |
| `provider` | `anthropic` | Active provider: `anthropic` \| `openai` \| `nebius` \| `scaleway` \| `openrouter` \| `mistral` \| `groq` \| `poe` \| `ollama` |
| `model` | `` | Model override (empty = provider default) |
| `api.endpoint` | `` | Custom endpoint URL override |
| `api.timeout` | `30` | Request timeout (seconds) |
| `api.max_retries` | `3` | Retry attempts |
| `processing.auto_enrich` | `false` | Auto-enrich all imported images |
| `processing.batch_size` | `10` | VLM batch size |
| `processing.request_delay` | `1.0` | Delay between requests (seconds) |

### `security`

| Key | Default | Description |
|---|---|---|
| `authentication.enabled` | `true` | Require login |
| `authentication.session_timeout` | `480` | Session timeout (minutes) |
| `authentication.max_failed_attempts` | `5` | Failed logins before account lockout |
| `authentication.lockout_duration` | `30` | Lockout duration (minutes) |
| `paths.allowed_paths` | `[/home, /mnt, /media]` | Folders users can browse |
| `paths.blocked_paths` | `[/etc, /sys, /proc, /root, /boot]` | Forbidden system paths |
| `upload.max_file_size_mb` | `50` | Max upload size per image |
| `upload.allowed_extensions` | `.jpg .jpeg .png .gif .bmp .webp` | Allowed formats |

### `features`

| Key | Default | Description |
|---|---|---|
| `duplicate_detection` | `true` | Enable duplicate detection |
| `face_clustering` | `true` | Enable unsupervised face clustering |
| `face_quality_scoring` | `true` | Compute face quality scores |
| `age_gender_estimation` | `false` | Enable age/gender detection |
| `timeline_view` | `true` | Show timeline view |
| `map_view` | `true` | Show map view for geo-tagged images |

### `performance`

| Key | Default | Description |
|---|---|---|
| `num_workers` | `4` | Thread pool size |
| `batch_size` | `50` | Batch processing size |
| `use_gpu` | `false` | GPU acceleration (CUDA) |
| `preprocessing.resize_large_images` | `true` | Downsize large images before processing |
| `preprocessing.max_dimension` | `2048` | Max image dimension |
| `preprocessing.cache_preprocessed` | `true` | Cache resized images |
| `preprocessing.cache_size_mb` | `512` | Preprocessing cache size |

### `admin`

| Key | Default | Description |
|---|---|---|
| `fix_db_path` | `/root/recognize_faces/fix_db.sh` | Absolute path to `fix_db.sh`; set automatically by `deploy-v2.sh` and `patch_deployment.sh`; used by the admin "Update Server" UI |

### `logging`

| Key | Default | Description |
|---|---|---|
| `level` | `INFO` | Log level: `DEBUG` \| `INFO` \| `WARNING` \| `ERROR` |
| `file` | `face_recognition.log` | Log file path |
| `rotation.max_size_mb` | `10` | Max log file size before rotation |
| `rotation.backup_count` | `5` | Number of old log files to retain |
| `audit_enabled` | `true` | Log all user actions |

### `training`

| Key | Default | Description |
|---|---|---|
| `min_images_per_person` | `3` | Minimum images required to train |
| `recommended_images_per_person` | `5` | Recommended count for good accuracy |
| `max_images_per_person` | `100` | Cap on training images per person |
| `validation_split` | `0.2` | Train/validation split |
| `augmentation.enabled` | `true` | Data augmentation (flip, rotation, brightness, contrast) |
| `auto_retrain` | `false` | Auto-retrain when new data added |

---

## Face recognition backends

| Backend | Library | Embedding dim | Notes |
|---|---|---|---|
| `insightface` ✓ default | `insightface` + `onnxruntime` | 512 (ArcFace) | Best accuracy; CoreML on macOS |
| `dlib_hog` | `face_recognition` + `dlib` | 128 (ResNet) | Fast CPU, needs cmake |
| `dlib_cnn` | `face_recognition` + `dlib` | 128 (ResNet) | Accurate, slow; needs cmake |

**Switching backends requires clearing all stored embeddings first.** The Settings UI warns you and blocks the switch if embeddings exist.

### Performance guide

| Model | Download | CPU start | CoreML cached | Accuracy |
|---|---|---|---|---|
| `buffalo_l` | ~340 MB | ~2 min | ~30 s | Best |
| `buffalo_m` | ~200 MB | ~45 s | ~10 s | Good |
| `buffalo_s` | ~100 MB | ~15 s | ~5 s | Fast |
| `buffalo_sc` | ~50 MB | ~10 s | ~3 s | Fastest |

**Performance tips:**
```yaml
face_recognition:
  lazy_init: true                    # defer model load to first request
  insightface:
    model: buffalo_s                 # smaller = faster startup
    use_coreml: true                 # macOS: ~5× faster after first compile
    det_size: [320, 320]             # smaller grid = faster, may miss small faces
    adaptive_det_size: true          # auto-tune per image
```

---

## VLM Providers

Keys are **never stored in plaintext** — encrypted with Fernet (AES-128-CBC + HMAC-SHA256) in SQLite.

**Setup:** Settings → API Key Management → select provider → enter key → Save.
Then: Settings → VLM Activation → select provider + model → Activate.

**Per-user overrides:** Non-admin users can override the global VLM provider, model, and enable/disable status for their own processing requests via Settings (personal VLM section) or `PUT /api/settings/user-vlm`. The effective provider resolves as: user override → global `config.yaml` default → disabled. Admins manage global defaults; each user can tailor VLM to their own API keys and preferences.

| Provider | Model discovery |
|---|---|
| Anthropic | hardcoded list (claude-opus/sonnet/haiku 4.x, claude-3.5) |
| OpenAI | keyword filter (`gpt-4o`, `gpt-4-turbo`, …) |
| Nebius AI | keyword (`vl`, `gemma-3`, `nemotron-nano-v2`) |
| Scaleway | keyword (`pixtral`, `gemma-3`, `mistral-small-3`, `holo2`) |
| OpenRouter | `architecture.modality` contains `image` |
| Mistral AI | hardcoded list — Large 3, Medium 3.1, Small 3.2, Ministral 3/8/14B |
| Groq | hardcoded list (llama-4-scout/maverick, llama-3.2 vision) |
| Poe | `image ∈ input_modalities` + `text ∈ output_modalities` |
| Ollama | keyword (`llava`, `vision`, `vl`, `gemma3`, `mistral-small3`, …) |

---

## User management

| Role | Capabilities |
|---|---|
| `admin` | All images, all API providers, system API keys, user CRUD, DB health, clear embeddings, face-rec settings |
| `mediamanager` | Shared + own private images, all API providers, server API keys |
| `user` | Shared + own private + explicitly-shared images, EU providers only, personal API keys |

Images have **visibility** (`shared` / `private`) and an **owner**. Private images are visible to their owner, explicit share recipients, and admins only. Per-image and per-album sharing is supported via `image_shares` / `album_shares` tables.

**Settings permissions:** Face-recognition settings (backend, model, thresholds, detection size) and global VLM defaults (`config.yaml`) are admin-only. Any authenticated user can set **personal VLM overrides** (provider, model, enable/disable) via Settings or `PUT /api/settings/user-vlm` — these take precedence over the global config for that user's processing requests. UI language and upload size limit are also user-editable.

**Password management:** Any user can change their own password (Settings → Change Password). Admins can set passwords for other accounts via the Users table (🔑 button).

**Duplicate upload behaviour:**
- Same user uploads the same file twice → deduplicated by SHA-256 hash + owner; second upload returns the existing image immediately (no re-processing).
- Different users upload the same file content → each gets their own independent image record; the full SHA-256 hash is stored for every row (a per-user composite partial index `UNIQUE(file_hash, owner_id)` prevents same-user re-uploads while allowing cross-user same-content).
- Image deleted in the UI → hard-deleted from DB; subsequent upload is treated as new.
- Rows with a missing hash (legacy data from before the schema migration) can be backfilled via Duplicates → **Fill Hashes** (`POST /api/duplicates/scan-hashes`).

Passwords use bcrypt (PBKDF2 fallback). Accounts lock after `max_failed_attempts` failures.

Bootstrap admin on first start: set `CRISP_ADMIN_USER` + `CRISP_ADMIN_PASS` env vars before starting (`fastapi_app.py` skips if any admin already exists).

User management API: `GET/POST /api/users`, `PATCH/DELETE /api/users/{id}` (admin only).

---

## Training

**From UI — selected images:** Select images in the gallery → right-click → Train → enter name.

**From UI — folder structure:** One subfolder per person:
```
training_data/
  Alice Smith/
    photo1.jpg  photo2.jpg
  Bob Jones/
    img_001.jpg img_002.jpg
```
Settings → Training → Batch Train from Folder.

**From API:** `POST /api/process/train/folder` with `{ "folder": "/path/to/training_data" }`.

Provide 5–20 varied photos per person for best accuracy.

---

## API key security

- Encrypted with **Fernet (AES-128-CBC + HMAC-SHA256)** before storage
- Encryption key stored in `.api_secret_key` beside the DB file (chmod 600)
- Startup log shows `✅` / `❌ CANNOT DECRYPT` per stored key
- UI shows only masked previews (`****ab12`) — plaintext never exposed
- Two scopes: **system** (admin-only, shared) and **user** (personal override)
- `get_effective_key()`: user key → system key → None

---

## Deployment topologies

### Local-only

Each user runs their own Electron app. Databases are independent.

```
User A Mac:  Electron v2 → FastAPI → face_recognition.db (local)
User B Mac:  Electron v2 → FastAPI → face_recognition.db (local)
```

### Shared SQLite on NAS (≤ 20 users)

All machines point to the same DB on a network share. AI inference runs locally; DB is shared.

```
NAS:  face_recognition.db  +  face_vectors.index
User A: Electron (local AI) → NAS DB
User B: Electron (local AI) → NAS DB
```

Configure via wizard: Server config → Database → enter UNC/mount path.

FAISS sync: each instance checks `mtime` before each recognition request and reloads automatically. Tune with `face_recognition.faiss_sync_interval` (lower = faster propagation, more FS I/O).

### Central VPS

One VPS runs FastAPI; Electron clients (or browsers) connect remotely.

```
VPS:      FastAPI + FAISS + SQLite
Client A: Electron (thin) → https://faces.example.com
Client B: Browser         → https://faces.example.com
```

Hybrid ingest modes available when Electron connects to remote VPS:
- **Mode B** (`upload_full`): Electron reads file → uploads to VPS → VPS runs InsightFace + VLM + stores `local_path`
- **Mode C** (`local_process`): Electron runs InsightFace locally → uploads thumbnail + embeddings only → VPS does FAISS matching + stores `local_path` (no VLM)
- **Server folder section**: always visible in ProcessView — enter or browse a VPS path to trigger a server-side SSE batch scan without transferring files

In all modes, `local_path` is stored on the VPS so the Electron lightbox can serve the full-resolution image instantly via `localfile://` without a network round-trip.

---

## File structure

```
face_rec/
├── face_rec_ui.py              # Gradio UI (v1 entry point, port 7860)
├── fastapi_app.py              # FastAPI backend (v2 entry point, port 7865)
├── face_recognition_core.py    # Core engine (InsightFace/dlib, FAISS, SQLite)
├── image_ops.py                # EXIF, thumbnail, metadata, browse helpers
├── local_processor.py          # Local InsightFace subprocess (NDJSON stdout)
├── vlm_providers.py            # 9 VLM provider adapters + model discovery
├── api_key_manager.py          # Fernet-encrypted API key storage
├── permissions.py              # User auth (bcrypt/PBKDF2, roles, RBAC)
├── folder_training.py          # Batch training from folder structure
├── drive_mount.py              # SMB/CIFS network drive mounting
├── i18n.py                     # Internationalisation (de/en)
├── routers/
│   ├── images.py               # Image browse, detail, CRUD, editing
│   ├── people.py               # Person CRUD, merge, reassign
│   ├── search.py               # Name-based substring search
│   ├── processing.py           # Single/batch SSE processing pipeline
│   ├── auth.py                 # Login/logout/session
│   ├── settings.py             # config.yaml read-write, DB health check
│   ├── api_keys.py             # Encrypted VLM key management
│   ├── filesystem.py           # Real FS browse + add-to-DB (SSE)
│   ├── watchfolders.py         # Watch folder CRUD + auto-scan (SSE)
│   ├── duplicates.py           # Duplicate groups, pHash scan, resolve
│   ├── ingest.py               # Hybrid ingest: upload-local, import-processed
│   ├── users.py                # User CRUD API (admin only)
│   ├── deps.py                 # Auth dependencies, role guards, image access
│   └── face_cluster.py         # Face clustering, face-crop, batch assign
├── config.yaml                 # Main configuration (gitignored)
├── config.example.yaml         # Template — copy to config.yaml
├── schema_complete.sql         # Full database schema
├── requirements.txt            # Python dependencies
├── Dockerfile                  # Multi-stage container build
├── deploy.sh                   # VPS deploy (v1/Gradio)
├── deploy-v2.sh                # VPS deploy (v2/FastAPI, recommended)
├── electron-app/               # Electron v1 (wraps Gradio, port 7860)
└── electron-app-v2/            # Electron v2 (FastAPI + Svelte, recommended)
    ├── main.js                 # Main process (wizard, windows, tray, IPC)
    ├── preload.js              # Context bridge (exposes IPC to renderer)
    ├── python-manager.js       # Venv setup + FastAPI subprocess lifecycle
    ├── setup-wizard.html       # First-run multi-step wizard
    ├── loading.html            # Setup progress screen (legacy)
    ├── package.json            # npm / electron-builder config
    └── renderer/               # Svelte 4 + Vite frontend
        ├── src/
        │   ├── App.svelte          # View router
        │   ├── api.js              # Typed fetch wrappers (all API endpoints)
        │   ├── stores.js           # Global Svelte stores
        │   └── lib/                # All view components
        │       ├── Gallery.svelte
        │       ├── Lightbox.svelte         # localfile:// aware
        │       ├── ProcessView.svelte      # 2-mode ingest + server folder section
        │       ├── SettingsView.svelte     # Config + API keys + ingest mode
        │       ├── IdentifyView.svelte     # Unidentified faces gallery
        │       ├── FaceIdentifyModal.svelte
        │       ├── FaceClusterView.svelte
        │       ├── FilesystemView.svelte
        │       ├── WatchFoldersView.svelte
        │       ├── DuplicatesView.svelte
        │       ├── ServerDirPicker.svelte  # reusable VPS dir browser modal
        │       └── ...
        └── dist/                   # Production build (served by FastAPI)
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `PUT /settings → 403` | Non-admin tried to save recognition settings | Only VLM/language/storage settings are available to non-admins; recognition settings require admin |
| Upload returns 422 `NOT NULL constraint failed: faces.image_id` | Schema not yet migrated | Restart the service — `fastapi_app.py` migrates the `images` table on startup, replacing the old `file_hash UNIQUE` constraint with a per-user composite partial index |
| Startup takes >60 s | `buffalo_l` loading on CPU | `use_coreml: true` or switch to `buffalo_s` |
| `CUDAExecutionProvider` warning | No CUDA (normal on macOS) | CoreML is used instead — ignore |
| Login locked | 5 failed attempts | Admin resets via DB or `reset_failed_attempts()` |
| "No faces found" | Image too small / threshold too high | Lower `detection_threshold` |
| VLM key error | Key not in DB | Settings → API Key Management → enter key |
| API keys lost after restart | `.api_secret_key` deleted | Re-enter affected keys; check startup log for `❌ CANNOT DECRYPT` |
| WebP/TIFF not processed | Old PIL/OpenCV | `pip install --upgrade pillow opencv-python` |
| Electron: "Python not found" | Python not on PATH | Install Python 3.10+ and add to PATH |
| Electron: wizard loops | `electron-settings.json` corrupt | Delete from app data dir; tray → Reset settings |
| Electron: port already in use | Stale Python process | Kill leftover process; or set `CRISP_PORT` / `FACE_REC_PORT` |
| `localfile://` images don't load | macOS Full Disk Access | System Preferences → Privacy → Full Disk Access → add CrispLens |
| Electron remote: still 401 after login | SameSite cookie issue | Ensure `CRISP_HTTPS_COOKIES=1` is set in the systemd unit (added automatically by `deploy-v2.sh`) |
| Mode C subprocess crash | Wrong Python path | Check python path in Settings; run `python local_processor.py` manually |
| SSE stream stops in browser | nginx buffering | Ensure `proxy_buffering off` in nginx `/api/` location block |
| FAISS not reloaded after import | Stale index | `POST /api/ingest/import-processed` reloads internally; or lower `faiss_sync_interval` |
| Backend switch blocked | Embeddings exist | Settings → Clear ALL embeddings → switch backend |
| Shared DB: stale FAISS | Other instance trained | Lower `faiss_sync_interval` (e.g. `10`) |
| dlib not available | `face-recognition` not installed | `pip install face-recognition` (requires cmake + dlib headers) |
| VPS: "Default login" message | Old deploy.sh used | Use `deploy-v2.sh` which sets `CRISP_ADMIN_USER`/`CRISP_ADMIN_PASS` |
| Admin "Update Server" hangs | Missing sudoers NOPASSWD or `NoNewPrivileges=yes` in unit | Run `sudo bash patch_deployment.sh` to apply all fixes at once |
| Admin "Update Server" exit code 1 | `NoNewPrivileges=yes` in systemd unit blocks sudo setuid | Run `sudo bash patch_deployment.sh` (FIX 2) or manually remove `NoNewPrivileges=yes` from `/etc/systemd/system/face-rec.service` and `systemctl daemon-reload && systemctl restart face-rec` |
| Server logs / API responses hang in browser | Apache mod_deflate buffering (missing `no-gzip` Location block) | Add `<Location /api> SetEnv no-gzip 1 </Location>` inside each Apache VirtualHost; or run `sudo bash patch_deployment.sh` (FIX 3) |
| SSE stream works on HTTP but not HTTPS | certbot added a new `<VirtualHost *:443>` block without Location directives | Re-run `sudo bash patch_deployment.sh` — it patches all VirtualHost blocks that contain a ProxyPass directive |
