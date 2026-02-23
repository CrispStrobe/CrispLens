# CrispLens v2 — Features Roadmap & Implementation Plan

This file is the **single source of truth** for planned features. Each feature block is written as a self-contained implementation brief: a new AI session can pick it up cold and execute it without prior context.

Current state of the codebase is documented in `electron-app-v2/README.md`.

---

## Turn 1 — Albums

### Goal
Virtual photo collections. One image can belong to many albums. Albums appear in the sidebar and can be filtered in the gallery.

### Backend — new `routers/albums.py`

**DB migration** (at router import, idempotent):
```sql
CREATE TABLE IF NOT EXISTS albums (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    description TEXT,
    cover_image_id INTEGER REFERENCES images(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS album_images (
    album_id  INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    image_id  INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    added_at  TEXT DEFAULT CURRENT_TIMESTAMP,
    sort_order INTEGER DEFAULT 0,
    PRIMARY KEY (album_id, image_id)
);
CREATE INDEX IF NOT EXISTS idx_album_images_album ON album_images(album_id);
CREATE INDEX IF NOT EXISTS idx_album_images_image ON album_images(image_id);
```

**Endpoints:**
- `GET /api/albums` → list all albums with image count and cover thumb
- `POST /api/albums` → `{ name, description }` → create
- `PUT /api/albums/{id}` → update name / description / cover_image_id
- `DELETE /api/albums/{id}` → delete album (keep images)
- `GET /api/albums/{id}/images` → list images in album (supports `sort`, `limit`, `offset`)
- `POST /api/albums/{id}/images` → `{ image_ids: [int] }` → add images to album
- `DELETE /api/albums/{id}/images` → `{ image_ids: [int] }` → remove from album

**Update `GET /api/images`:** add `album: int = Query(0)` filter; when set, join `album_images` to filter.

**Register router** in `fastapi_app.py` at `/api/albums`.

### Frontend

**`api.js`** — add wrappers: `fetchAlbums`, `createAlbum`, `updateAlbum`, `deleteAlbum`, `fetchAlbumImages(id, opts)`, `addToAlbum(albumId, imageIds)`, `removeFromAlbum(albumId, imageIds)`.

**`stores.js`** — add `allAlbums = writable([])`.

**`AlbumsView.svelte`** (new):
- Left panel: album list (name, count, cover thumb); "New Album" button at top
- Right panel: gallery of images in selected album (reuse `Gallery.svelte` concept but filtered by album)
- Drag-and-drop sort order (optional, use `sort_order` column)
- Create/rename/delete album via inline editing

**`Sidebar.svelte`** — add "Albums" nav item (📚) under Browse section with badge showing count.

**`App.svelte`** — add `{:else if view === 'albums'}<AlbumsView />{/if}`.

**`SelectionToolbar.svelte`** — add "Add to Album" action: opens a dropdown of existing albums + "New album…" option.

**`ContextMenu.svelte`** — add "Add to Album ▶" submenu item (shows album list).

**`App.svelte` onMount** — add `allAlbums.set(await fetchAlbums())`.

---

## Turn 2 — Keyboard Shortcuts (XnView style)

### Goal
Full keyboard navigation in gallery and lightbox, matching XnView MP conventions. Users who know XnView should feel at home immediately.

### Keyboard map

| Key | Gallery | Lightbox |
|-----|---------|----------|
| `→` / `Space` | Select next | Next image |
| `←` / `Backspace` | Select previous | Previous image |
| `Home` | — | First image |
| `End` | — | Last image |
| `Enter` | Open lightbox | — |
| `Escape` | Deselect all | Close lightbox |
| `Delete` | Delete selected | Delete + advance |
| `1`–`5` | Set star rating | Set star rating |
| `0` | Clear rating | Clear rating |
| `+` / `=` | Increase thumb size | Zoom in |
| `-` | Decrease thumb size | Zoom out |
| `*` | Reset thumb size | Fit to window |
| `F` / `F11` | — | Toggle fullscreen |
| `I` | — | Toggle info panel |
| `R` | — | Rotate CW 90° |
| `L` | — | Rotate CCW 90° |
| `Ctrl+A` | Select all | — |
| `Ctrl+D` | Deselect all | — |
| `Ctrl+I` | Invert selection | — |
| `G` | Toggle grid/table view | — |
| `T` | Focus search/filter | — |
| `S` | — | Star toggle (⭐ / no star) |
| `X` | Flag for delete (red label) | Flag for delete |
| `P` | Flag as pick (green label) | Flag as pick |
| `U` | Unflag | Unflag |
| `C` | Open crop tool | Open crop tool |
| `Ctrl+Z` | Undo last action | Undo |

### Implementation

**`stores.js`** — add:
- `starRatings = writable({})` — `{[image_id]: 1–5}` cache
- `colorFlags  = writable({})` — `{[image_id]: 'pick'|'delete'|null}`

**`routers/images.py`** — add `PATCH /{id}/rating` endpoint: `{ rating: 0–5 }` updates new `star_rating` column. Add `PATCH /{id}/flag` endpoint: `{ flag: 'pick'|'delete'|null }`.

**DB migration** (in images router, idempotent `ALTER TABLE`):
```sql
ALTER TABLE images ADD COLUMN star_rating INTEGER DEFAULT 0;
ALTER TABLE images ADD COLUMN color_flag TEXT;
```

**`KeyboardManager.svelte`** (new, `<svelte:window on:keydown>` wrapper):
- Mount once at App level (in `App.svelte`)
- Reads `$sidebarView`, `$selectedId` (lightbox open?), `$galleryImages`
- Dispatches actions by calling store helpers or API functions
- Suppresses shortcuts when focus is inside `<input>`, `<textarea>`, `<select>`

**`Lightbox.svelte`** — add:
- Zoom state (`zoomLevel`, `panX`, `panY`); `+`/`-` change zoom; mouse wheel zooms; drag to pan at zoom > 1
- `R`/`L` keys call new `PATCH /{id}/rotate` endpoint (rotates EXIF or in-place)
- `I` key toggles existing info panel

**`Gallery.svelte`** — add:
- `+`/`-` adjust `$thumbSize` store (min 80, max 400, step 20)
- Star rating overlay on thumbnail (1–5 dots or star icon bottom-right)
- Color flag dot (top-left): green = pick, red = delete/reject, none = unflagged

**`api.js`** — add `patchRating(id, rating)`, `patchFlag(id, flag)`, `rotateImage(id, direction)`.

---

## Turn 3 — Face Cluster View

### Goal
Show all unidentified face crops tiled in a grid for rapid bulk tagging — the core Picasa "Name Tags" workflow. Cluster similar faces together so the user can tag one and apply to the whole cluster.

### Backend — new endpoint in `routers/duplicates.py` or new `routers/faceCluster.py`

**`GET /api/faces/unidentified`**
Returns all face records with no `person_id` (or `recognition_confidence < 0.5`):
```sql
SELECT f.id as face_id, f.image_id, f.bbox_top, f.bbox_right, f.bbox_bottom, f.bbox_left,
       f.detection_confidence, f.face_quality,
       fe.id as embedding_id, fe.embedding_vector
FROM faces f
LEFT JOIN face_embeddings fe ON f.id = fe.face_id
WHERE fe.person_id IS NULL OR fe.recognition_confidence < 0.5
ORDER BY f.face_quality DESC
```
Returns: `[{ face_id, image_id, bbox, detection_confidence, face_quality }]` (no embedding bytes — too large for JSON).

**`GET /api/faces/clusters?threshold=0.6`**
Groups unidentified faces by embedding cosine similarity (FAISS or numpy dot-product). Returns:
```json
[
  { "cluster_id": 0, "size": 12, "faces": [{ face_id, image_id, bbox }, ...] }
]
```
Backend uses `FaceRecognitionEngine`'s FAISS index to cluster — load embeddings for unidentified faces, run DBSCAN or a simple greedy cosine threshold grouping.

**`GET /api/images/{id}/face-crop?face_id={face_id}&size=128`**
Returns a cropped JPEG of just that face region (PIL crop + resize). Allows the frontend to display face thumbnails without sending the full image.

**`POST /api/faces/assign-cluster`**
Body: `{ cluster_id: int, person_name: str, face_ids: [int] }` → calls `reassign_face` for each face_id.

### Frontend — `FaceClusterView.svelte` (new)

Layout:
```
┌─ Controls ─────────────────────────────────────────────────────┐
│  Mode: [All unidentified ▼]  Cluster threshold: [──●──]  Sort  │
│  N faces · M clusters                                          │
└────────────────────────────────────────────────────────────────┘
┌─ Cluster 1 (12 faces) ─────────────────────────────────────────┐
│  [face] [face] [face] [face] [face] [face] ...                 │
│  ┌─────────────────────────────────────────────────────┐       │
│  │ Name: [____________ ▼]  [Apply to all] [Apply to sel] │     │
│  └─────────────────────────────────────────────────────┘       │
└────────────────────────────────────────────────────────────────┘
```

- Each face crop: fetched from `GET /api/images/{id}/face-crop?face_id=…`
- Click face → toggle select (for partial assignment)
- "Apply to all" in cluster → assigns typed name to all faces in cluster
- "Apply to selected" → assigns only to checked faces
- After assigning: cluster disappears from list, `allPeople` store refreshed
- "Skip cluster" button (hides it for this session)

**`api.js`** — add `fetchUnidentifiedFaces()`, `fetchFaceClusters(threshold)`, `faceCropUrl(imageId, faceId, size)`, `assignCluster(clusterFaceIds, personName)`.

**`Sidebar.svelte`** — add "Face Clusters" nav item with badge showing cluster count.

**`App.svelte`** — add `{:else if view === 'faceclusters'}<FaceClusterView />{/if}`.

---

## Turn 4 — Event Grouping

### Goal
Auto-group photos into "events" based on time gaps. Gap threshold is configurable from 1 hour to 6 days. Events are stored as a virtual grouping (not a table — computed on the fly or cached) and appear as a browseable view.

### Backend

**`GET /api/events?gap_hours=4&limit=200`**
Algorithm:
1. `SELECT id, filepath, filename, taken_at, face_count, ai_description FROM images WHERE processed=1 AND taken_at IS NOT NULL ORDER BY taken_at ASC`
2. Python: iterate sorted by `taken_at`; start new event when gap > `gap_hours`
3. Return: `[{ event_id (synthetic), start, end, count, cover_image_id, images: [...] }]`

Response groups are paginated; `limit` applies to number of events.

For performance, cache the event list in a module-level dict keyed by `(gap_hours, max_image_id)` — invalidate when new images are added.

**Register** in `fastapi_app.py` as inline route: `GET /api/events`.

### Frontend — `EventsView.svelte` (new)

```
┌─ Controls ──────────────────────────────────────────────────────┐
│  Gap: [1h ● ─────────────────── 6d]  2h   [Refresh]            │
└─────────────────────────────────────────────────────────────────┘
┌─ Event: 14 Feb 2024 · 47 photos · 3 faces ────────────────────┐
│  [cover thumb]  Rome Trip                                      │
│  [t] [t] [t] [t] [t] [t] ... (+41 more)                       │
│  [Open event]                                                  │
└─────────────────────────────────────────────────────────────────┘
```

- Gap slider: 1h, 2h, 4h, 8h, 12h, 1d, 2d, 3d, 6d (logarithmic steps)
- Click "Open event" → switches to gallery view with date filter set to event's start–end range
- Cover image = first or most-faces image in group
- Event title = user-editable (stored in localStorage keyed by synthetic event_id hash, or optionally in a new `events` table)

**`api.js`** — add `fetchEvents(gapHours)`.

**`Sidebar.svelte`** — add "Events" nav item (🗓) under Browse section.

**`App.svelte`** — add `{:else if view === 'events'}<EventsView />{/if}`.

---

## Turn 5 — Context Menu: "Show all images with this person"

### Goal
Right-click on any image in the gallery → context menu shows "Show all images with [Name]" for each identified person in that image. Clicking switches gallery to person filter.

### Implementation

**`ContextMenu.svelte`** already exists. Extend it:

1. When context menu opens on an image, fetch the people in that image from the existing `people_names` field already returned by `fetchImages` (it's a `GROUP_CONCAT` of person names).
2. Parse `people_names` (comma-separated string → array).
3. Add menu section "People in this image:" with one item per person: "🔍 All photos of [Name]".
4. On click: `filters.update(f => ({ ...f, person: name })); sidebarView.set('all');`

No new API endpoint needed — `people_names` is already in the image list response.

**Additional context menu items to add in the same turn:**
- "Add to Album ▶" (submenu) — requires Albums feature (Turn 1)
- "Copy file path"
- "Flag as Pick" / "Flag for Delete" (requires Turn 2 ratings)

---

## Turn 6 — Image Cropping

### Goal
User can manually draw a crop rectangle on an image, or enter exact pixel dimensions, then save the cropped version (replaces original or saves as new file).

### Backend — new `routers/editing.py`

**`POST /api/edit/crop`**
Body:
```json
{
  "image_id": 42,
  "x": 100, "y": 80, "width": 600, "height": 400,
  "save_as": "replace" | "new_file",
  "new_filename": "photo_cropped.jpg"
}
```
Implementation:
```python
from PIL import Image
img = Image.open(filepath)
cropped = img.crop((x, y, x + width, y + height))
# if save_as == 'replace': overwrite; update DB (width/height, clear thumb)
# if save_as == 'new_file': save to same folder with new name, insert new DB record
```

**`POST /api/edit/rotate`** (also used by Turn 2 keyboard shortcuts)
Body: `{ image_id: int, direction: 'cw' | 'ccw' | 'flip_h' | 'flip_v' }`

**Register** `editing.router` in `fastapi_app.py` at `/api/edit`.

### Frontend — `CropModal.svelte` (new)

Triggered from:
- Keyboard shortcut `C` (Turn 2)
- Lightbox context menu → "Crop"
- Image right-click → "Crop"

UI:
```
┌─ Crop ─────────────────────────────────────────────────────────┐
│  [image with drag-to-draw overlay rectangle]                   │
│  Presets: [Free] [1:1] [4:3] [16:9] [Custom W____  H____]     │
│  Zoom: [──●──]                                                 │
│  Selection: X:100  Y:80  W:600  H:400                          │
│  Save as: ○ Replace original  ○ Save as new file               │
│  [Crop & Save]  [Reset]  [Cancel]                              │
└─────────────────────────────────────────────────────────────────┘
```

Implementation notes:
- Use `<canvas>` overlay drawn on top of the preview `<img>`
- Mouse down → start rectangle; drag → resize; mouse up → lock selection
- Shift-drag corners to maintain aspect ratio
- Zoom slider (`transform: scale(n)` on the image container with overflow: hidden)
- "Presets" buttons auto-resize selection to nearest matching ratio
- Enter exact X/Y/W/H in inputs → updates the drawn rectangle

**`api.js`** — add `cropImage(image_id, x, y, width, height, saveAs, newFilename)`.

---

## Turn 7 — Image Conversion & Batch Export

### Goal
Convert images between formats (JPEG, PNG, WebP, TIFF), resize/reduce canvas size, adjust quality. Works on a single image from the lightbox, or on a selection from the gallery.

### Backend — extend `routers/editing.py`

**`POST /api/edit/convert`**
Body:
```json
{
  "image_ids": [42, 43],
  "output_format": "jpeg" | "png" | "webp" | "tiff",
  "quality": 85,
  "resize_mode": "none" | "fit" | "fill" | "exact",
  "max_width": 1920,
  "max_height": 1080,
  "save_as": "replace" | "new_file" | "output_folder",
  "output_folder": "/path/to/output",
  "suffix": "_web"
}
```

Uses PIL:
```python
img = Image.open(filepath)
if resize_mode == 'fit':
    img.thumbnail((max_width, max_height), Image.LANCZOS)
elif resize_mode == 'exact':
    img = img.resize((max_width, max_height), Image.LANCZOS)
img.save(out_path, format=output_format.upper(), quality=quality)
```

For batch: returns SSE stream (`POST /api/edit/convert-batch`).

**`GET /api/edit/formats`** — returns supported output formats and their options.

### Frontend — `ConvertModal.svelte` (new)

Triggered from:
- Image right-click → "Convert / Export"
- `SelectionToolbar.svelte` → "Convert selected"

UI for single image:
```
┌─ Convert ──────────────────────────────────────────────────────┐
│  Format:  [JPEG ▼]    Quality: [──●── 85%]  (JPEG/WebP only)  │
│  Resize:  ○ None  ○ Fit (max)  ○ Exact                        │
│           Width: [1920]  Height: [1080]                        │
│  Save:    ○ Replace  ○ New file (suffix: [_web])              │
│           ○ Output folder: [/path/…] [Browse]                 │
│  Preview size: 2.4 MB → ~380 KB                               │
│  [Convert]  [Cancel]                                           │
└─────────────────────────────────────────────────────────────────┘
```

For batch (multiple images selected): same form but shows SSE progress bar after submit.

**`api.js`** — add `convertImages(params)`, `convertBatch(params, onEvent)`.

---

## Implementation Order & Dependencies

```
Turn 1: Albums          (independent — no deps)
Turn 2: Keyboard        (needs star_rating DB col; partially independent)
Turn 3: Face Clusters   (needs GET /api/faces/unidentified — independent)
Turn 4: Event Grouping  (independent)
Turn 5: Context Menu    (needs Albums from Turn 1 for "Add to Album" submenu)
Turn 6: Cropping        (needs new editing.py router)
Turn 7: Conversion      (extends editing.py from Turn 6)
```

Turns 1–4 can be done in any order. Turn 5 depends on Turn 1 (for the album submenu). Turn 7 depends on Turn 6.

---

## Deferred / Future Features

These are acknowledged but deliberately not planned in detail yet:

- **Star ratings display** — filter/sort by rating in gallery (add after Turn 2)
- **Map view** — GPS lat/lng are stored; needs Leaflet.js integration
- **Slideshow mode** — full-screen auto-advance
- **Soft delete / Trash** — move to trash, empty trash action
- **Smart albums / saved searches** — pin a filter set with a name
- **Side-by-side compare** — two images synchronized zoom/pan
- **HEIC / RAW support** — requires rawpy or Pillow HEIF plugin
- **Export presets** — named export configurations (e.g. "Instagram square", "Print 300dpi")
- **Collage / contact sheet** — grid layout of selected images
- **Print layout** — page layout for printing
