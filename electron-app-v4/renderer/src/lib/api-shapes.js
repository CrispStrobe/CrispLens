/**
 * api-shapes.js — Canonical response shapes for all API functions.
 *
 * IMPORTANT: This file is the single source of truth for what each API
 * function must return, regardless of which implementation handles it:
 *   - v4 Node/Express server routes (server/routes/*.js)
 *   - LocalAdapter.js (browser/Capacitor standalone mode)
 *   - v2 Python FastAPI (partial — not all endpoints exist there)
 *
 * When adding a field to a server route, ADD IT HERE and update LocalAdapter.
 * When adding a field to LocalAdapter, ADD IT HERE and update server routes.
 *
 * Shapes are documented as JSDoc typedefs for IDE support.
 * They are NOT enforced at runtime — see TODO below.
 *
 * TODO: Add a lightweight runtime shape-checker (dev-mode only) that wraps
 * _guard() and the fetch helpers, logs mismatches as console.warn, and can
 * be toggled via localStorage.setItem('CRISP_SHAPE_CHECK','1').
 */

// ─────────────────────────────────────────────────────────────────────────────
// IMAGES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Single image object returned by fetchImage(id) and each element of fetchImages().
 * Server: server/routes/images.js rowToApi()
 * Local:  LocalAdapter.js getImage() / getImages()
 *
 * @typedef {Object} ImageShape
 * @property {number}   id
 * @property {string}   filename
 * @property {string}   filepath          - server-side path (may be UUID staged path)
 * @property {string}   [local_path]      - alias: origin_path — original source path
 * @property {string}   [origin_path]     - alias of local_path
 * @property {string}   [server_path]     - alias of filepath
 * @property {number}   [width]
 * @property {number}   [height]
 * @property {number}   [file_size]
 * @property {string}   [taken_at]        - alias of date_taken
 * @property {string}   [date_taken]
 * @property {string}   [created_at]      - alias of date_processed
 * @property {string}   [date_processed]
 * @property {string}   [ai_description]  - VLM-generated description
 * @property {string}   [ai_scene_type]   - VLM-generated scene type (free-form text)
 * @property {string[]} [ai_tags_list]    - VLM-generated tags as array (split from ai_tags CSV)
 * @property {string}   [visibility]      - 'shared' | 'private'
 * @property {number}   [face_count]
 * @property {DetectedPerson[]} [detected_people]
 */

/**
 * @typedef {Object} DetectedPerson
 * @property {number|null} face_id      - null in batch list queries (LocalAdapter); set in single-image fetch
 * @property {number|null} person_id
 * @property {string|null} name
 */

// ─────────────────────────────────────────────────────────────────────────────
// IMPORT / INGEST
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Response from importProcessed() and uploadLocal().
 * Server (upload-local):    server/routes/ingest.js
 * Server (import-processed): server/routes/ingest.js
 * Local:                    LocalAdapter.js importProcessed()
 *
 * NOTE: LocalAdapter returns top-level description/scene_type/tags.
 *       Server upload-local returns them nested under vlm: {}.
 *       ProcessView.svelte handles BOTH forms:
 *         startWebLocalInfer path  → reads resp.description / resp.scene_type / resp.tags
 *         startUploadFull path     → reads resp.vlm?.description / resp.vlm?.scene_type / resp.vlm?.tags
 *       TODO: Normalize to one shape (prefer nested vlm:{}) in a future refactor.
 *
 * @typedef {Object} ImportResult
 * @property {boolean}  ok
 * @property {number}   image_id
 * @property {number}   face_count        - number of faces stored
 * @property {boolean}  [skipped]         - true if duplicate detected and skipped
 * @property {boolean}  [shared_duplicate] - true if duplicate belongs to another user (server only)
 * @property {string[]} [people]          - names of recognized people (LocalAdapter only)
 * @property {VlmResult} [vlm]            - VLM enrichment (server upload-local path)
 * @property {string}   [description]     - VLM description (LocalAdapter / import-processed path)
 * @property {string}   [scene_type]      - VLM scene type  (LocalAdapter / import-processed path)
 * @property {string[]} [tags]            - VLM tags        (LocalAdapter / import-processed path)
 */

/**
 * @typedef {Object} VlmResult
 * @property {string|null} description
 * @property {string|null} scene_type
 * @property {string[]}    tags
 */

// ─────────────────────────────────────────────────────────────────────────────
// FACE CLUSTERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Response from fetchFaceClusters().
 * Server: server/routes/faces.js GET /faces/clusters
 * Local:  LocalAdapter.js fetchFaceClusters()
 *
 * @typedef {Object} FaceCluster
 * @property {number}      cluster_id
 * @property {number}      size
 * @property {ClusterFace[]} faces
 */

/**
 * @typedef {Object} ClusterFace
 * @property {number}      face_id
 * @property {number}      image_id
 * @property {BBox}        bbox
 * @property {number}      [face_quality]
 * @property {number}      [detection_confidence]
 * @property {string|null} person_name
 * @property {string|null} [_crop_data_url]  - LocalAdapter only: base64 data URL from face_thumbnail
 */

/**
 * @typedef {Object} BBox
 * @property {number} top
 * @property {number} right
 * @property {number} bottom
 * @property {number} left
 */

// ─────────────────────────────────────────────────────────────────────────────
// RE-IDENTIFY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Response from reIdentifyFaces().
 * Server: server/routes/faces.js POST /faces/re-identify
 * Local:  LocalAdapter.js reIdentifyFaces()
 *
 * @typedef {Object} ReIdentifyResult
 * @property {number} updated        - faces that got a person_id assigned
 * @property {number} total_checked  - faces examined
 * @property {string} [message]      - informational message if no index available (server only)
 */

// ─────────────────────────────────────────────────────────────────────────────
// PEOPLE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Single person object returned by fetchPeople() elements and fetchPerson(id).
 * Server: server/routes/people.js
 * Local:  LocalAdapter.js getPeople() / getPerson()
 *
 * @typedef {Object} PersonShape
 * @property {number}   id
 * @property {string}   name
 * @property {number}   [total_appearances]
 * @property {number}   [face_count]       - alias of total_appearances (server)
 * @property {number}   [thumbnail_face_id]
 * @property {number}   [thumbnail_image_id]
 */

export default {}; // module marker — import for IDE typedef support
