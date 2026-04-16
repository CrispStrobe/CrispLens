-- Complete database schema for face recognition system
-- Version: 2.0 - FTS5 Optional
-- Features: Foreign keys, indexes, triggers, proper constraints

-- Enable foreign key support
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ============================================================================
-- PEOPLE TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL CHECK(length(trim(name)) >= 1),
    notes TEXT,
    
    -- Metadata
    total_appearances INTEGER DEFAULT 0,
    first_seen TIMESTAMP,
    last_seen TIMESTAMP,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_people_name ON people(name);
CREATE INDEX IF NOT EXISTS idx_people_updated ON people(updated_at);
CREATE INDEX IF NOT EXISTS idx_people_appearances ON people(total_appearances DESC);

-- ============================================================================
-- IMAGES TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    
    -- File information
    filepath TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    file_hash TEXT,
    file_size INTEGER CHECK(file_size >= 0),
    width INTEGER CHECK(width > 0),
    height INTEGER CHECK(height > 0),
    format TEXT,

    -- Local machine path (Electron hybrid mode — original file on client disk)
    local_path TEXT,

    -- Optional blob storage
    image_blob BLOB,
    thumbnail_blob BLOB,

    -- EXIF metadata
    taken_at TIMESTAMP,
    location_lat REAL CHECK(location_lat BETWEEN -90 AND 90),
    location_lng REAL CHECK(location_lng BETWEEN -180 AND 180),
    location_name TEXT,
    camera_make TEXT,
    camera_model TEXT,
    iso INTEGER,
    aperture REAL,
    shutter_speed TEXT,
    focal_length REAL,
    
    -- VLM enrichment
    ai_description TEXT,
    ai_scene_type TEXT,
    ai_tags TEXT,
    ai_confidence REAL CHECK(ai_confidence BETWEEN 0 AND 1),
    ai_provider TEXT,
    
    -- Processing status
    processed BOOLEAN DEFAULT 0 CHECK(processed IN (0, 1)),
    processing_error TEXT,
    face_count INTEGER DEFAULT 0 CHECK(face_count >= 0),
    metadata_written BOOLEAN DEFAULT 0 CHECK(metadata_written IN (0, 1)),

    -- User curation
    rating INTEGER DEFAULT 0,
    flag TEXT,
    description TEXT,

    -- Perceptual hash for visual duplicate detection
    phash TEXT,

    -- User curation extended
    favorite   BOOLEAN DEFAULT 0,
    star_rating INTEGER DEFAULT 0,
    color_flag TEXT,
    creator    TEXT,
    copyright  TEXT,

    -- Archive metadata (Bildarchiv workflow)
    bildarchiv_path      TEXT,
    bildauswahl_path     TEXT,
    fachbereich          TEXT,
    veranstaltungsnummer TEXT,
    veranstaltungstitel  TEXT,
    urheber              TEXT,
    datum_event          DATE,

    -- Ownership and visibility (access control)
    owner_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    visibility TEXT DEFAULT 'shared' CHECK(visibility IN ('shared', 'private')),

    -- Media type (image vs. video) — video uses video_frames table for per-frame data
    media_type   TEXT DEFAULT 'image' CHECK(media_type IN ('image', 'video')),
    duration_sec REAL,
    fps          REAL,
    frame_count  INTEGER,
    transcript   TEXT,

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_images_processed ON images(processed);
CREATE INDEX IF NOT EXISTS idx_images_filename ON images(filename);
CREATE INDEX IF NOT EXISTS idx_images_filepath ON images(filepath);
CREATE INDEX IF NOT EXISTS idx_images_file_hash ON images(file_hash);
-- Composite partial unique index: allows same content for different users,
-- but prevents same user from having hash-identical rows.
-- NULL owner_id rows (freshly inserted, ownership set after) are exempt via NULL != NULL uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS idx_images_file_hash_owner
    ON images(file_hash, owner_id)
    WHERE file_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_images_local_path ON images(local_path);
CREATE INDEX IF NOT EXISTS idx_images_taken_at ON images(taken_at);
CREATE INDEX IF NOT EXISTS idx_images_face_count ON images(face_count DESC);
CREATE INDEX IF NOT EXISTS idx_images_scene_type ON images(ai_scene_type);
CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_images_phash ON images(phash);

-- Create text search indexes on description and tags (basic LIKE search fallback)
CREATE INDEX IF NOT EXISTS idx_images_description ON images(ai_description);
CREATE INDEX IF NOT EXISTS idx_images_tags ON images(ai_tags);
CREATE INDEX IF NOT EXISTS idx_images_owner ON images(owner_id);
CREATE INDEX IF NOT EXISTS idx_images_visibility ON images(visibility);
CREATE INDEX IF NOT EXISTS idx_images_media_type ON images(media_type);

-- ============================================================================
-- VIDEO_FRAMES TABLE
-- Per-frame data for video rows in the images table.  One images row per
-- video (media_type='video'); many video_frames rows referencing it.
-- Each extracted frame has its own faces rows (linked via frame_id -> image_id?
-- No: faces still reference images.id of the video row for aggregation, but
-- the frame metadata lives here so we know the timestamp of a given detection.
-- ============================================================================
CREATE TABLE IF NOT EXISTS video_frames (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id         INTEGER NOT NULL,       -- parent video row in images
    frame_index      INTEGER NOT NULL,       -- 0-based sequence within the video
    timestamp_ms     INTEGER NOT NULL,       -- offset from video start
    is_keyframe      INTEGER DEFAULT 0,      -- 1 = ffmpeg scene-change hit
    phash            TEXT,                   -- perceptual hash for dedup
    thumbnail_path   TEXT,                   -- on-disk jpeg thumbnail (opt.)
    face_count       INTEGER DEFAULT 0,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_video_frames_image ON video_frames(image_id);
CREATE INDEX IF NOT EXISTS idx_video_frames_ts    ON video_frames(image_id, timestamp_ms);
CREATE UNIQUE INDEX IF NOT EXISTS idx_video_frames_image_idx
    ON video_frames(image_id, frame_index);

-- Link a faces row to the specific frame it was detected in (videos only).
-- NULL for image-based detections.
-- The column is added here so schema_complete.sql reflects reality;
-- fix_db.sh also ALTER-adds it idempotently for existing DBs.
-- (faces.frame_id is NULL for still images.)

-- ============================================================================
-- FACES TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS faces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id INTEGER NOT NULL,
    
    -- Normalized bounding box (0-1 coordinates)
    bbox_top REAL NOT NULL CHECK(bbox_top BETWEEN 0 AND 1),
    bbox_right REAL NOT NULL CHECK(bbox_right BETWEEN 0 AND 1),
    bbox_bottom REAL NOT NULL CHECK(bbox_bottom BETWEEN 0 AND 1),
    bbox_left REAL NOT NULL CHECK(bbox_left BETWEEN 0 AND 1),
    
    -- Quality metrics
    detection_confidence REAL NOT NULL CHECK(detection_confidence BETWEEN 0 AND 1),
    face_quality REAL DEFAULT 1.0 CHECK(face_quality BETWEEN 0 AND 1),
    
    -- Face attributes (optional)
    estimated_age INTEGER CHECK(estimated_age BETWEEN 0 AND 150),
    estimated_gender TEXT CHECK(estimated_gender IN ('male', 'female', 'unknown')),
    pose_roll REAL,
    pose_yaw REAL,
    pose_pitch REAL,

    -- Video support: which frame this face was detected in (NULL for still images)
    frame_id INTEGER REFERENCES video_frames(id) ON DELETE CASCADE,

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_faces_image ON faces(image_id);
CREATE INDEX IF NOT EXISTS idx_faces_confidence ON faces(detection_confidence DESC);
CREATE INDEX IF NOT EXISTS idx_faces_quality ON faces(face_quality DESC);

-- ============================================================================
-- FACE EMBEDDINGS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS face_embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    face_id INTEGER NOT NULL,
    person_id INTEGER,
    
    -- Embedding data
    embedding_vector BLOB NOT NULL,
    embedding_dimension INTEGER NOT NULL CHECK(embedding_dimension > 0),
    embedding_model TEXT,
    
    -- Recognition
    recognition_confidence REAL CHECK(recognition_confidence BETWEEN 0 AND 1),
    verified BOOLEAN DEFAULT 0 CHECK(verified IN (0, 1)),
    verification_method TEXT,
    
    -- FAISS index
    faiss_index INTEGER,
    faiss_distance REAL,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (face_id) REFERENCES faces(id) ON DELETE CASCADE,
    FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_embeddings_person ON face_embeddings(person_id);
CREATE INDEX IF NOT EXISTS idx_embeddings_face ON face_embeddings(face_id);
CREATE INDEX IF NOT EXISTS idx_embeddings_faiss_index ON face_embeddings(faiss_index);
CREATE INDEX IF NOT EXISTS idx_embeddings_confidence ON face_embeddings(recognition_confidence DESC);
CREATE INDEX IF NOT EXISTS idx_embeddings_verified ON face_embeddings(verified);

-- ============================================================================
-- SETTINGS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    value_type TEXT DEFAULT 'string' CHECK(value_type IN ('string', 'int', 'float', 'bool', 'json')),
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_settings_updated ON settings(updated_at);

-- Insert default settings
INSERT OR IGNORE INTO settings (key, value, value_type, description) VALUES
    ('backend', 'insightface', 'string', 'Face recognition backend'),
    ('model', 'buffalo_l', 'string', 'InsightFace model name'),
    ('detection_threshold', '0.6', 'float', 'Face detection threshold'),
    ('recognition_threshold', '0.4', 'float', 'Face recognition threshold'),
    ('store_in_db', 'true', 'bool', 'Store images in database'),
    ('store_on_disk', 'true', 'bool', 'Keep images on disk'),
    ('write_metadata', 'false', 'bool', 'Write metadata to files'),
    ('enable_vlm', 'false', 'bool', 'Enable VLM enrichment'),
    ('vlm_provider', 'anthropic', 'string', 'VLM provider'),
    ('language', 'de', 'string', 'UI language'),
    ('db_version', '2.0', 'string', 'Database schema version'),
    ('fts5_available', 'false', 'bool', 'FTS5 full-text search available');

-- ============================================================================
-- PROCESSING QUEUE TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS processing_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id INTEGER,
    filepath TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
    priority INTEGER DEFAULT 0,
    error_message TEXT,
    retries INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    
    FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_queue_status ON processing_queue(status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_queue_created ON processing_queue(created_at);

-- ============================================================================
-- AUDIT LOG TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    record_id INTEGER,
    action TEXT NOT NULL CHECK(action IN ('INSERT', 'UPDATE', 'DELETE')),
    old_values TEXT,
    new_values TEXT,
    user_id INTEGER,
    username TEXT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_table ON audit_log(table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);

-- ============================================================================
-- TAGS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL CHECK(length(trim(name)) >= 1),
    category TEXT,
    color TEXT,
    usage_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
CREATE INDEX IF NOT EXISTS idx_tags_category ON tags(category);
CREATE INDEX IF NOT EXISTS idx_tags_usage ON tags(usage_count DESC);

-- ============================================================================
-- IMAGE_TAGS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS image_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    confidence REAL DEFAULT 1.0 CHECK(confidence BETWEEN 0 AND 1),
    source TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(image_id, tag_id),
    FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_image_tags_image ON image_tags(image_id);
CREATE INDEX IF NOT EXISTS idx_image_tags_tag ON image_tags(tag_id);

-- ============================================================================
-- IMAGE_SHARES TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS image_shares (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id   INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    shared_by  INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(image_id, user_id),
    FOREIGN KEY (image_id)  REFERENCES images(id)  ON DELETE CASCADE,
    FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE,
    FOREIGN KEY (shared_by) REFERENCES users(id)   ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_image_shares_image ON image_shares(image_id);
CREATE INDEX IF NOT EXISTS idx_image_shares_user  ON image_shares(user_id);

-- ============================================================================
-- ALBUM_SHARES TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS album_shares (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    album_id   INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    shared_by  INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(album_id, user_id),
    FOREIGN KEY (album_id)  REFERENCES albums(id)  ON DELETE CASCADE,
    FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE,
    FOREIGN KEY (shared_by) REFERENCES users(id)   ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_album_shares_album ON album_shares(album_id);
CREATE INDEX IF NOT EXISTS idx_album_shares_user  ON album_shares(user_id);

-- ============================================================================
-- BATCH_JOBS TABLES
-- ============================================================================
CREATE TABLE IF NOT EXISTS batch_jobs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id         INTEGER NOT NULL,
    name             TEXT,
    status           TEXT NOT NULL DEFAULT 'pending',
    source_path      TEXT,
    recursive        INTEGER DEFAULT 1,
    follow_symlinks  INTEGER DEFAULT 0,
    visibility       TEXT DEFAULT 'shared',
    det_params       TEXT,
    tag_ids          TEXT,
    new_tag_names    TEXT,
    album_id         INTEGER,
    new_album_name   TEXT,
    total_count      INTEGER DEFAULT 0,
    done_count       INTEGER DEFAULT 0,
    error_count      INTEGER DEFAULT 0,
    skipped_count    INTEGER DEFAULT 0,
    created_at       TEXT DEFAULT (datetime('now')),
    started_at       TEXT,
    finished_at      TEXT
);

CREATE TABLE IF NOT EXISTS batch_job_files (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id       INTEGER NOT NULL REFERENCES batch_jobs(id) ON DELETE CASCADE,
    filepath     TEXT NOT NULL,
    local_path   TEXT,
    status       TEXT NOT NULL DEFAULT 'pending',
    image_id     INTEGER,
    error_msg    TEXT,
    skip_reason  TEXT,
    processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_bjf_job_status  ON batch_job_files(job_id, status);
CREATE INDEX IF NOT EXISTS idx_bj_owner_status ON batch_jobs(owner_id, status);

-- ============================================================================
-- TRIGGERS
-- ============================================================================

CREATE TRIGGER IF NOT EXISTS update_people_timestamp 
AFTER UPDATE ON people
BEGIN
    UPDATE people SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_images_timestamp 
AFTER UPDATE ON images
BEGIN
    UPDATE images SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_embeddings_timestamp 
AFTER UPDATE ON face_embeddings
BEGIN
    UPDATE face_embeddings SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_settings_timestamp 
AFTER UPDATE ON settings
BEGIN
    UPDATE settings SET updated_at = CURRENT_TIMESTAMP WHERE key = NEW.key;
END;

CREATE TRIGGER IF NOT EXISTS update_people_appearances_insert
AFTER INSERT ON face_embeddings
WHEN NEW.person_id IS NOT NULL
BEGIN
    UPDATE people 
    SET total_appearances = total_appearances + 1,
        last_seen = CURRENT_TIMESTAMP,
        first_seen = COALESCE(first_seen, CURRENT_TIMESTAMP)
    WHERE id = NEW.person_id;
END;

CREATE TRIGGER IF NOT EXISTS update_people_appearances_delete
AFTER DELETE ON face_embeddings
WHEN OLD.person_id IS NOT NULL
BEGIN
    UPDATE people 
    SET total_appearances = MAX(0, total_appearances - 1)
    WHERE id = OLD.person_id;
END;

CREATE TRIGGER IF NOT EXISTS update_tag_usage_insert
AFTER INSERT ON image_tags
BEGIN
    UPDATE tags SET usage_count = usage_count + 1 WHERE id = NEW.tag_id;
END;

CREATE TRIGGER IF NOT EXISTS update_tag_usage_delete
AFTER DELETE ON image_tags
BEGIN
    UPDATE tags SET usage_count = MAX(0, usage_count - 1) WHERE id = OLD.tag_id;
END;

-- ============================================================================
-- VIEWS
-- ============================================================================

CREATE VIEW IF NOT EXISTS v_images_enriched AS
SELECT 
    i.id,
    i.filepath,
    i.filename,
    i.taken_at,
    i.face_count,
    i.ai_description,
    i.ai_scene_type,
    i.ai_tags,
    i.processed,
    GROUP_CONCAT(DISTINCT p.name) as people_names,
    COUNT(DISTINCT fe.person_id) as identified_people_count,
    i.created_at,
    i.updated_at
FROM images i
LEFT JOIN faces f ON i.id = f.image_id
LEFT JOIN face_embeddings fe ON f.id = fe.face_id
LEFT JOIN people p ON fe.person_id = p.id
GROUP BY i.id;

CREATE VIEW IF NOT EXISTS v_people_stats AS
SELECT 
    p.id,
    p.name,
    p.total_appearances,
    p.first_seen,
    p.last_seen,
    COUNT(DISTINCT f.image_id) as unique_images,
    AVG(fe.recognition_confidence) as avg_confidence,
    SUM(CASE WHEN fe.verified = 1 THEN 1 ELSE 0 END) as verified_count
FROM people p
LEFT JOIN face_embeddings fe ON p.id = fe.person_id
LEFT JOIN faces f ON fe.face_id = f.id
GROUP BY p.id;

CREATE VIEW IF NOT EXISTS v_unidentified_faces AS
SELECT 
    f.id as face_id,
    f.image_id,
    i.filepath,
    i.filename,
    f.detection_confidence,
    f.face_quality,
    i.taken_at
FROM faces f
JOIN images i ON f.image_id = i.id
LEFT JOIN face_embeddings fe ON f.id = fe.face_id
WHERE fe.person_id IS NULL OR fe.recognition_confidence < 0.5
ORDER BY f.face_quality DESC, f.detection_confidence DESC;

-- ============================================================================
-- ANALYZE AND OPTIMIZE
-- ============================================================================

ANALYZE;

-- ============================================================================
-- COMPLETION
-- ============================================================================

INSERT OR REPLACE INTO settings (key, value, value_type, description)
VALUES ('schema_version', '2.0', 'string', 'Current database schema version');

INSERT OR REPLACE INTO settings (key, value, value_type, description)
VALUES ('schema_initialized', datetime('now'), 'string', 'Schema initialization timestamp');

-- ============================================================================
-- SZENENTYP SEED TAGS (category='Szenentyp')
-- ============================================================================
-- Predefined scene-type tags for event photography/videography.
-- Users can add more freely — same category, managed via the tags UI.
INSERT OR IGNORE INTO tags (name, category, color) VALUES
    ('Podium',       'Szenentyp', '#4080c0'),
    ('Saal',         'Szenentyp', '#4080c0'),
    ('Publikum',     'Szenentyp', '#4080c0'),
    ('Rollstuhl',    'Szenentyp', '#4080c0'),
    ('Junge Leute',  'Szenentyp', '#4080c0'),
    ('Dialog',       'Szenentyp', '#4080c0'),
    ('Ausstellung',  'Szenentyp', '#4080c0'),
    ('Vernissage',   'Szenentyp', '#4080c0');

SELECT 'Database schema initialized successfully - Version 2.0' as status;