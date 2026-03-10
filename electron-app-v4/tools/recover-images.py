#!/usr/bin/env python3
"""
recover-images.py — Extract deleted image rows from SQLite free pages.
Usage: python3 tools/recover-images.py [path/to/face_recognition.db]
"""
import os, sys, re, sqlite3, struct

DB_PATH = sys.argv[1] if len(sys.argv) > 1 else \
    os.path.join(os.path.dirname(__file__), '..', '..', 'face_recognition.db')
DB_PATH = os.path.realpath(DB_PATH)

if not os.path.exists(DB_PATH):
    print(f"DB not found: {DB_PATH}")
    sys.exit(1)

# Read raw bytes from DB (and WAL if present)
with open(DB_PATH, 'rb') as f:
    db_bytes = f.read()

wal_path = DB_PATH + '-wal'
wal_bytes = b''
if os.path.exists(wal_path):
    with open(wal_path, 'rb') as f:
        wal_bytes = f.read()
    print(f"WAL: {wal_path}  ({len(wal_bytes)/1024/1024:.1f}MB)")

combined = db_bytes + wal_bytes
print(f"DB: {DB_PATH}  ({len(db_bytes)/1024/1024:.1f}MB)")
print(f"Total scan: {len(combined)/1024/1024:.1f}MB")

# ── Extract printable strings ─────────────────────────────────────────────────
def extract_strings(data, min_len=10):
    results = []
    current = []
    for b in data:
        if 0x20 <= b < 0x7f:
            current.append(chr(b))
        else:
            if len(current) >= min_len:
                results.append(''.join(current))
            current = []
    if len(current) >= min_len:
        results.append(''.join(current))
    return results

strings = extract_strings(combined, min_len=10)
print(f"Extracted {len(strings)} printable strings")

# ── Filter and group image-related strings ────────────────────────────────────
IMG_RE  = re.compile(r'^/[^\x00-\x1f]{5,300}\.(jpg|jpeg|png|webp|heic|heif|gif|bmp)$', re.I)
HASH_RE = re.compile(r'^[0-9a-f]{64}$')
DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}')
SCENE_T = {'portrait','indoor','outdoor','group','landscape','event','nature','urban','conference','presentation','other'}

# Collect unique image paths first
all_paths = [s for s in strings if IMG_RE.match(s)]
unique_paths = list(dict.fromkeys(all_paths))  # preserve order, deduplicate
print(f"Distinct image paths: {len(unique_paths)}")

# Try to extract records: for each filepath, scan nearby strings for metadata
records = {}
str_idx = {s: i for i, s in enumerate(strings)}  # first occurrence index

for fp in unique_paths:
    # Skip duplicated UUID paths (the filename duplicate of the filepath)
    basename = os.path.basename(fp)
    rec = {'filepath': fp, 'filename': basename, 'file_hash': None,
           'local_path': None, 'ai_desc': None, 'scene_type': None,
           'taken_at': None}

    idx = str_idx.get(fp, 0)
    window = strings[max(0, idx-5):idx+30]

    for s in window:
        if s == fp: continue
        if not rec['file_hash'] and HASH_RE.match(s):
            rec['file_hash'] = s
        elif not rec['local_path'] and IMG_RE.match(s) and s != fp:
            rec['local_path'] = s
        elif not rec['taken_at'] and DATE_RE.match(s):
            rec['taken_at'] = s[:19]
        elif not rec['scene_type'] and s.lower() in SCENE_T:
            rec['scene_type'] = s.lower()
        elif (not rec['ai_desc'] and len(s) > 40 and ' ' in s
              and s[0].isupper() and not s.startswith('/')):
            rec['ai_desc'] = s

    if fp not in records:
        records[fp] = rec
    else:
        # Merge
        existing = records[fp]
        for k in ('file_hash','local_path','taken_at','scene_type','ai_desc'):
            if rec[k] and not existing[k]:
                existing[k] = rec[k]

print(f"Records assembled: {len(records)}")

# ── Check files exist ──────────────────────────────────────────────────────────
found = sum(1 for r in records.values()
            if os.path.exists(r['filepath']) or os.path.exists(r.get('local_path') or ''))
print(f"Files still on disk: {found}/{len(records)}")

# ── Insert into DB ─────────────────────────────────────────────────────────────
con = sqlite3.connect(DB_PATH)
cur = con.cursor()

cur.execute("SELECT COUNT(*) FROM images")
existing_count = cur.fetchone()[0]
if existing_count > 0:
    print(f"\nimages table already has {existing_count} rows.")
    print("DELETE FROM images first if you want to re-run recovery.")
    con.close()
    sys.exit(0)

inserted = 0
for r in records.values():
    try:
        cur.execute("""
            INSERT OR IGNORE INTO images
              (filepath, filename, file_hash, local_path, visibility,
               ai_description, ai_scene_type, taken_at,
               processed, processed_at, created_at)
            VALUES (?,?,?,?,?, ?,?,?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        """, (r['filepath'], r['filename'], r['file_hash'], r['local_path'], 'shared',
              r['ai_desc'], r['scene_type'], r['taken_at']))
        if cur.rowcount:
            inserted += 1
    except Exception as e:
        print(f"  Skip {r['filename']}: {e}")

con.commit()
print(f"\n✓ Re-inserted {inserted} image records.")
print("  Face detection data (bboxes/embeddings) must be re-run via batch processing.")

# Show sample
cur.execute("SELECT id, filename, local_path, ai_description IS NOT NULL FROM images LIMIT 5")
rows = cur.fetchall()
print("\nSample recovered rows:")
for row in rows:
    print(f"  id={row[0]}  {row[1]}  local={bool(row[2])}  has_desc={bool(row[3])}")

con.close()
