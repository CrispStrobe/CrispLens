# CrispLens v2 — Svelte + FastAPI + Electron

A desktop-native photo management and face recognition application. Svelte 4 frontend, FastAPI backend, Electron shell. Ships as a single binary with a first-run wizard — no manual setup required by the user.

**Live Demo (v4 Standalone):** [https://crisplens.vercel.app](https://crisplens.vercel.app)

See the [root README](../README.md) for complete environment variable, config.yaml, and API reference.

---

## Feature Overview

### Browse & Discovery

| Feature | Description |
|---|---|
| **Gallery (grid)** | Virtual-scrolling thumbnail grid — handles tens of thousands of images without lag |
| **Table view** | Data-rich list with sortable columns |
| **People view** | Browse and search by recognised person; click through to all their images |
| **Tags view** | Filter images by AI-generated or manual tags |
| **Timeline view** | Browse by month/year |
| **Folders view** | Browse by filesystem folder (DB-registered images only) |
| **Multi-select** | Cmd/Ctrl+click to toggle, Shift+click for range; floating action bar for batch ops |

### Face Recognition & Identification

| Feature | Description |
|---|---|
| **Automatic recognition** | InsightFace (`buffalo_l/m/s/sc`) or dlib; FAISS index for fast similarity search |
| **Identify view** | Gallery filtered to images with unidentified faces |
| **Face Identify Modal** | SVG bbox overlay (green = identified, orange = unknown); per-face autocomplete; "Save all" |
| **Training** | Train from selected images or batch-train from folder structure (one subfolder per person) |
| **Reassign face** | Correct a wrong identification directly from the lightbox |

### Ingest & Hybrid Processing

| Feature | Description |
|---|---|
| **Mode B — Upload full** | Electron reads local file → uploads to VPS → VPS processes (InsightFace + VLM) + stores `local_path` |
| **Mode C — Local process** | Electron runs InsightFace locally (`local_processor.py`) → POSTs thumbnail + 512D embeddings → VPS does FAISS matching only (no re-detection, no VLM) |
| **Server folder section** | Always visible in ProcessView — enter or browse a VPS path to trigger server-side SSE batch scan without transferring files |
| **Lightbox local access** | When `local_path` is set, Electron loads full-res image via `localfile://` (instant, no network) |
| **Browser fallback** | In-browser lightbox shows preview + "Full resolution only in desktop app" warning |
| **Model management** | Settings UI shows download status per model (`buffalo_l/m/s/sc`), triggers download, shows progress |
| **Python path** | Configurable Python interpreter for local InsightFace; auto-detects venv or `python3` |
| **Filesystem browser** | Navigate real FS; DB-status badges per file/folder; select → "Add to DB" (SSE) |
| **Watch folders** | Register folders; manual "Scan Now" (SSE); optional auto-scan interval |
| **Duplicate detection** | Filename+Size / SHA256 hash / pHash visual. Resolve: delete / DB-only / symlink. Face merge by bbox IOU |
| **v4 local_infer compatibility** | `POST /api/ingest/import-processed` accepts pre-computed embeddings from v4's Node.js ONNX engine — same endpoint used by Mode C. v4 users can point at this v2 server as their API+DB backend while running inference locally (no Python required on client) |

### Image Editing

| Feature | Description |
|---|---|
| **Rotate** | In-place EXIF-preserving rotation; lightbox re-renders via version key |
| **Crop** | Free-draw crop via `CropModal.svelte`; saved to disk |
| **Convert** | Single or batch format conversion via SSE stream |

### VLM Enrichment

| Feature | Description |
|---|---|
| **Scene classification** | AI-generated scene type |
| **Description** | Free-text description of image content |
| **Auto-tagging** | AI-generated keyword tags |
| **Providers** | Anthropic, OpenAI, Nebius, Scaleway, OpenRouter, Mistral, Groq, Poe, Ollama |
| **Per-user VLM** | Non-admins can override provider, model, and enable/disable for their own processing via Settings (personal VLM section) or `PUT /api/settings/user-vlm`. Resolves as: user override → global `config.yaml` → disabled |

### Admin Panel

| Feature | Description |
|---|---|
| **Update Server** | Streams `fix_db.sh` output live in-browser (git pull + DB migrate + service restart); no SSH required |
| **View Logs** | Displays the last N lines of the FastAPI application log in a scrollable modal; streams via SSE |
| **Reload Engine** | Hot-reloads the face recognition engine without a full service restart |
| **User management** | Create / promote / deactivate users |

The Update Server button requires:
- A NOPASSWD sudoers entry for the service user (added automatically by `deploy-v2.sh` Phase 3b or `patch_deployment.sh` FIX 1)
- No `NoNewPrivileges=yes` in the systemd unit (removed by `deploy-v2.sh` or `patch_deployment.sh` FIX 2)
- Apache `<Location /api/admin> SetEnv proxy-nokeepalive 1 </Location>` inside the VirtualHost (`patch_deployment.sh` FIX 3)

### Settings & Auth

| Feature | Description |
|---|---|
| **API key manager** | Per-provider Fernet-encrypted keys; system (admin) or user scope; Test button per key |
| **Config** | Backend/model/thresholds (admin only); VLM settings, language, upload size (any user) |
| **Auth** | Cookie-based sessions; admin / mediamanager / user roles; image ownership + visibility; per-image sharing |
| **User management** | Admin UI: create/edit/delete users, reset lockout; `GET/POST /api/users`, `PATCH/DELETE /api/users/{id}` |
| **Password management** | Any user: change own password. Admin: set any user's password via 🔑 button in Users table |
| **Upload size limit** | Settings → Storage: optionally resize uploaded images to a max dimension before saving on server |
| **Duplicate upload** | Same user re-uploading same file → instant dedup by SHA-256 + owner (no re-processing). Different user uploading same content → separate record per user with full hash stored (composite partial index `UNIQUE(file_hash, owner_id)` per user). Missing hashes can be backfilled via Duplicates → Fill Hashes |
| **i18n** | German and English (server-authoritative; client-side instant switch) |

---

## First-Run Setup Wizard

On first launch (no `electron-settings.json`) the wizard guides setup through four steps:

```
Step 1 — Role
┌─────────────────────────────────────────────────────────┐
│  ┌─────────────────────┐ ┌──────────────┐ ┌──────────┐  │
│  │ ● Client + Server   │ │ Client only  │ │  Server  │  │
│  │   (recommended)     │ │ (remote VPS) │ │  only    │  │
│  └─────────────────────┘ └──────────────┘ └──────────┘  │
└─────────────────────────────────────────────────────────┘

Step 2 — Server config  (skipped for Client only)
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

Step 3 — Client config  (skipped for Server only)
┌─────────────────────────────────────────────────────────┐
│  Connect to:  ● Local server (from step 2)              │
│               ○ Remote server: [https://...]            │
│  Ingest mode (when remote):                             │
│    ● Upload full images  ○ Local InsightFace            │
└─────────────────────────────────────────────────────────┘

Step 4 — Installing
┌─────────────────────────────────────────────────────────┐
│  ✓ Python 3.12 detected                                 │
│  ✓ Dependencies installed (from stamp file)             │
│  ✓ Database initialised                                 │
│  ↻ Downloading buffalo_l (~340 MB)  ████░░░░  45%       │
└─────────────────────────────────────────────────────────┘
```

### Role behaviour

| Role | What runs |
|---|---|
| **Client + Server** | FastAPI subprocess + full Svelte UI (default, like "local" mode) |
| **Client only** | No local Python; Electron loads configured remote VPS URL; ingest modes B/C + server folder section available |
| **Server only** | FastAPI subprocess; no BrowserWindow; system tray only; accessible from any browser or remote Electron |

To re-run the wizard: tray icon → **Switch mode / Reset settings**.

---

## `electron-settings.json` Schema

Stored in the platform app-data directory. `adminPass` is **never written to disk**.

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
| `server.dataDir` | string | absolute path | Parent dir for DB, thumbnails, FAISS index, logs |
| `server.dbPath` | string | path | Absolute or relative-to-`dataDir`; default `face_recognition.db` |
| `server.reuseExistingDb` | boolean | | Skip schema init; attach to existing DB |
| `server.adminUser` | string | | Bootstrap admin username (first-run only; ignored if any admin exists) |
| `server.pythonPath` | string | | Python interpreter; empty = auto-detect venv or `python3` on PATH |
| `server.workers` | number | ≥1 | uvicorn worker count |
| `client.connectTo` | string | `local` \| `remote` | `local` = wizard step-2 server; `remote` = `remoteUrl` |
| `client.remoteUrl` | string | full URL | VPS address when `connectTo=remote` |
| `client.processingMode` | string | `upload_full` \| `local_process` | Ingest mode; default `upload_full`; only used when `connectTo=remote` |
| `client.localModel` | string | `buffalo_l/m/s/sc` | InsightFace model for Mode C local processing |
| `client.pythonPath` | string | | Python for local InsightFace (Mode C); empty = auto |

---

## Hybrid Ingest Flow

```
Local Mac / v4 Node.js               VPS / Local Server (v2 FastAPI)
──────────────────────               ────────────────────────────────

Server folder section  (VPS-side, browse or type a path)
  ProcessView → POST /api/process/batch {serverPath}
                                      → scans VPS FS
                                      → SSE progress ←

Mode B — upload_full
  Electron
    readLocalFile(path) → ArrayBuffer
    uploadLocal(buf, localPath) →     POST /api/ingest/upload-local
                                        writes tmp file
                                        InsightFace detect+embed
                                        VLM description (optional)
                                        stores local_path in DB
                                      ← {image_id, face_count}
  Lightbox → localfile:///path (instant)

Mode C — local_process  (v2 Electron)
  local_processor.py subprocess
    InsightFace detects + embeds locally
    → NDJSON per image to Electron stdout
  Electron
    importProcessed(result) →         POST /api/ingest/import-processed
                                        saves 200px thumbnail to disk
                                        inserts image + face records
                                        FAISS match → person_id
                                        stores local_path in DB
                                      ← {image_id, people, face_count}
  Lightbox → localfile:///path (instant)

v4 local_infer mode  (v4 Node.js → v2 FastAPI as remote store)
  v4 core/face-engine.js
    ONNX SCRFD detects faces locally
    ArcFace embeds each face locally (512D, L2-normalised)
    Generates 200px JPEG thumbnail
    Computes sha256 file hash
  v4 processor.js
    importProcessed(data) →           POST /api/ingest/import-processed
                                        (same endpoint as Mode C)
                                        saves thumbnail to disk
                                        FAISS match → person_id
                                        stores in v2 DB
                                      ← {image_id, people, face_count}
  Full images never leave the local machine — only vectors + thumbnail
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Electron v2  (electron-app-v2/)                                 │
│  setup-wizard.html → main.js → PythonManager                    │
│  → FastAPI subprocess (port configurable, default 7865)          │
│  → BrowserWindow (Svelte build or Vite dev) [role: both/client]  │
│  → Tray only                                [role: server]       │
│                                                                  │
│  localfile:// custom protocol — full-res images from local disk  │
│  process-images-locally IPC — local_processor.py subprocess     │
└──────────────────────────────────────────────────────────────────┘
                          │
                          ▼  REST + SSE  (default :7865)
┌──────────────────────────────────────────────────────────────────┐
│  FastAPI Backend  (fastapi_app.py)                               │
│  ├── routers/images.py          image browse, detail, CRUD       │
│  ├── routers/people.py          person CRUD, merge, reassign     │
│  ├── routers/search.py          name-based search                │
│  ├── routers/processing.py      single / batch SSE pipeline      │
│  ├── routers/auth.py            login / session                  │
│  ├── routers/settings.py        config read-write                │
│  ├── routers/api_keys.py        encrypted VLM key management     │
│  ├── routers/filesystem.py      FS browse + add-to-DB (SSE)      │
│  ├── routers/watchfolders.py    watch folder CRUD + scan (SSE)   │
│  ├── routers/duplicates.py      dup groups, resolve, pHash scan  │
│  └── routers/ingest.py          upload-local + import-processed  │
│                                                                  │
│  face_recognition_core.py       InsightFace/dlib + FAISS         │
│  local_processor.py             InsightFace subprocess (NDJSON)  │
│  image_ops.py                   EXIF, metadata, thumbnail, CRUD  │
│  vlm_providers.py               VLM provider adapters (9×)       │
│  api_key_manager.py             Fernet-encrypted key store       │
│  permissions.py                 bcrypt/PBKDF2 user auth          │
└──────────────────────────────────────────────────────────────────┘
                          │
                          ▼  SQLite (WAL mode)  — path configurable
┌──────────────────────────────────────────────────────────────────┐
│  face_recognition.db                                             │
│  ├── images      filepath, local_path, owner_id, EXIF, VLM      │
│  ├── faces       bbox (0–1 normalised), quality, age, gender     │
│  ├── face_embeddings  embedding vector, person_id, confidence    │
│  ├── people      name, appearance count, first/last seen         │
│  ├── users       username, role, vlm_enabled/provider/model      │
│  ├── tags / image_tags                                           │
│  ├── image_shares / album_shares  per-item access grants         │
│  ├── watch_folders   path, schedule, last_scan stats             │
│  ├── cloud_drives    SMB/SFTP/Filen/Internxt mount configs       │
│  └── settings    key-value config                                │
└──────────────────────────────────────────────────────────────────┘
```

### Frontend (renderer/src/)

```
App.svelte                  root shell (view router)
api.js                      typed fetch wrappers for all endpoints
stores.js                   Svelte writable stores (global state)
lib/
  Gallery.svelte              virtual-scroll image grid
  TableView.svelte            sortable list browse
  Lightbox.svelte             full-screen viewer (localfile:// aware)
  PeopleView.svelte           person list + detail
  TagsView.svelte             tag browser
  DatesView.svelte            timeline by month/year
  FoldersView.svelte          folder tree (DB-registered)
  ProcessView.svelte          2-mode ingest UI (B/C) + server folder section
  TrainView.svelte            person training
  SettingsView.svelte         config + API keys + ingest mode card
  IdentifyView.svelte         gallery of images needing ID
  FaceIdentifyModal.svelte    SVG bbox overlay + per-face selector
  FaceClusterView.svelte      unsupervised face clusters + assign
  FilesystemView.svelte       real FS navigator + DB status
  WatchFoldersView.svelte     watch folder manager
  DuplicatesView.svelte       duplicate groups + resolve
  ServerDirPicker.svelte      reusable modal for picking a VPS directory
  Toolbar.svelte              top nav bar
  Sidebar.svelte              left nav
  SelectionToolbar.svelte     floating multi-select actions
  StatusBar.svelte            bottom status
  MetaPanel.svelte            image metadata side panel
  BatchEditModal.svelte       bulk metadata edit
  CropModal.svelte            free-draw crop
  ContextMenu.svelte          right-click menu
```

---

## Environment Variables

### FastAPI backend (`fastapi_app.py`)

| Variable | Default | Description |
|---|---|---|
| `FACE_REC_DATA_DIR` | `` (cwd) | Data dir: `config.yaml`, DB, thumbnails, logs, FAISS index |
| `FACE_REC_PORT` | `7865` | FastAPI listen port |
| `FACE_REC_DB_PATH` | `` | Absolute DB path — **overrides** `config.yaml` and `FACE_REC_DATA_DIR` |
| `FACE_REC_WORKERS` | `1` | uvicorn worker count |
| `FACE_REC_LOG_LEVEL` | `INFO` | `DEBUG` \| `INFO` \| `WARNING` \| `ERROR` |
| `CRISP_ADMIN_USER` | `` | Bootstrap admin username (first start only; skipped if admin exists) |
| `CRISP_ADMIN_PASS` | `` | Bootstrap admin password (min 8 chars; first start only) |

### Local processor (`local_processor.py` — Mode C)

| Variable | Default | Description |
|---|---|---|
| `INSIGHTFACE_MODEL` | `buffalo_l` | Model: `buffalo_l` \| `buffalo_m` \| `buffalo_s` \| `buffalo_sc` |
| `USE_COREML` | `1` | `1` = Apple Neural Engine on macOS; `0` = force CPU |
| `INSIGHTFACE_HOME` | `~/.insightface` | Model cache directory override |

### Electron main process

| Variable | Default | Description |
|---|---|---|
| `ELECTRON_DEV` | `` | Set to `1` to skip wizard and load Vite dev server (`http://localhost:5173`) |

---

## Development

### Prerequisites
- Node.js 20+
- Python 3.10+

### Run in development mode

```bash
# Terminal 1 — FastAPI backend
uvicorn fastapi_app:app --reload --port 7865

# Terminal 2 — Svelte dev server (HMR, proxies /api → :7865)
cd electron-app-v2/renderer
npm install && npm run dev
# Open http://localhost:5173

# Terminal 3 — Electron shell (skips wizard, loads Vite)
cd electron-app-v2
npm install
ELECTRON_DEV=1 npm start
```

### Production build

```bash
# 1. Build Svelte frontend
cd electron-app-v2/renderer
npm run build           # → dist/ (served by FastAPI as StaticFiles)

# 2. Package Electron app
cd electron-app-v2
npm run build           # DMG on macOS, NSIS on Windows, AppImage on Linux
```

---

## VPS Deployment

See `deploy-v2.sh` in the project root:

```bash
sudo bash deploy-v2.sh
```

### Fully scripted (no prompts)

```bash
export CRISP_ADMIN_USER=admin
export CRISP_ADMIN_PASS='s3cr3t!X9'
export CRISP_DOMAIN=faces.example.com
export CRISP_SSL=true
export CRISP_SSL_EMAIL=ops@example.com
export CRISP_YES=1
sudo -E bash deploy-v2.sh
```

### `deploy-v2.sh` variables

| Variable | Default | Required | Description |
|---|---|---|---|
| `CRISP_INSTALL_DIR` | `/opt/crisp-lens` | | Installation directory |
| `CRISP_SVC_USER` | `face-rec` | | System user (created if missing) |
| `CRISP_SVC_NAME` | `face-rec` | | systemd service name |
| `CRISP_PORT` | first free ≥ 7865 | | FastAPI listen port |
| `CRISP_WORKERS` | `1` | | uvicorn worker count |
| `CRISP_ADMIN_USER` | `admin` | **yes** | Bootstrap admin username |
| `CRISP_ADMIN_PASS` | — | **yes** | Bootstrap admin password (min 8 chars) |
| `CRISP_DOMAIN` | — | | nginx domain; omit to skip nginx |
| `CRISP_SSL` | `false` | | `true` = Let's Encrypt HTTPS |
| `CRISP_SSL_EMAIL` | — | if SSL | Let's Encrypt email |
| `CRISP_YES` | `0` | | `1` = skip all confirmations |
| `CRISP_CONTAINER` | `0` | | `1` = container mode (auto-detected from `/.dockerenv`) |

### Container / Docker

```bash
docker build -t crisp-lens .

docker run -d -p 7865:7865 \
  -v crisp-data:/data \
  -e FACE_REC_DATA_DIR=/data \
  -e CRISP_ADMIN_USER=admin \
  -e CRISP_ADMIN_PASS='s3cr3t!X9' \
  --name crisp-lens \
  crisp-lens
```

Container runtime variables:

| Variable | Default | Description |
|---|---|---|
| `FACE_REC_PORT` | `7865` | Listen port |
| `FACE_REC_DATA_DIR` | `/data` | Data directory (mount a volume here) |
| `FACE_REC_WORKERS` | `1` | uvicorn worker count |
| `FACE_REC_DB_PATH` | — | Absolute DB path (optional override) |
| `FACE_REC_LOG_LEVEL` | `info` | Log level |
| `CRISP_ADMIN_USER` | — | Bootstrap admin (first start only) |
| `CRISP_ADMIN_PASS` | — | Bootstrap admin password (first start only) |

---

## Configuration (`config.yaml`)

See the [full config.yaml reference in the root README](../README.md#configuration-reference-configyaml).

Quick VPS defaults (auto-patched by `deploy-v2.sh`):

```yaml
face_recognition:
  lazy_init: true             # defer heavy model load to first request
  insightface:
    use_coreml: false         # CoreML is macOS only
    model: buffalo_l          # change to buffalo_s for faster startup
    detection_threshold: 0.7
    recognition_threshold: 0.4
    det_size: [640, 640]

database:
  path: face_recognition.db   # overridden by FACE_REC_DB_PATH env var

ui:
  language: en                # de | en
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `PUT /settings → 403` as non-admin | Expected: recognition settings (backend, thresholds) are admin-only. VLM, language, storage save fine |
| Upload 422 `faces.image_id NOT NULL` | Schema not yet migrated — restart the service; `fastapi_app.py` migrates the DB automatically on startup (replaces old `file_hash UNIQUE` with a per-user composite partial index) |
| Non-admin can't delete image | Image may be owned by another user. You can only delete images you own or unowned (legacy) images |
| Wizard loops after completion | Delete `electron-settings.json` from app data dir; tray → Reset settings |
| `localfile://` images don't load | macOS Full Disk Access: System Preferences → Privacy → Full Disk Access → add CrispLens |
| Mode C subprocess crash | Check Python path in Settings; run `python local_processor.py` manually to see error |
| Mode C "model not found" | Settings → Model Management → Download `buffalo_l` (or whichever model is selected) |
| SSE stream stops in browser | nginx: `proxy_buffering off` in `/api/` location. Apache: `SetEnv no-gzip 1` inside the VirtualHost `<Location /api>` block |
| Admin Update Server hangs / exit code 1 | Missing NOPASSWD sudoers entry or `NoNewPrivileges=yes` in systemd unit | Run `sudo bash patch_deployment.sh` on the VPS |
| FAISS not reloaded after import | `POST /api/ingest/import-processed` reloads FAISS internally |
| Electron remote: 401 after login | Ensure `CRISP_HTTPS_COOKIES=1` in the systemd unit (set automatically by `deploy-v2.sh`) |
| Face clusters show broken images | Expected for Mode C imports — face crops now fall back to stored thumbnail automatically |
| Folders view shows VPS paths | Upgrade required: `git pull && sudo bash fix_db.sh` — now uses `local_path` for folder grouping |
| Port conflict | Set `FACE_REC_PORT=7866` env var or change port in wizard/settings |
| Startup takes >60 s | Switch to `buffalo_s` or enable `use_coreml: true` (macOS only) |
| Admin bootstrap skipped | Any admin already exists — use the existing account; wizard creates new admin only on first run |
| VLM key not working | Settings → API Key Management → re-enter key; check startup log for `❌ CANNOT DECRYPT` |
