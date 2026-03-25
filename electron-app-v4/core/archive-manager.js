'use strict';
/**
 * archive-manager.js — File organization, path building, and EXIF writing
 * for the CrispLens Bildarchiv / Bildauswahl workflow.
 *
 * Public API:
 *   getArchiveConfig(db)
 *   saveArchiveConfig(db, config)
 *   buildFolderPath(archiveCfg, meta)
 *   buildFilename(filenameTpl, meta, destDir, ext)
 *   organizeFile(sourcePath, destPath, action)   action: 'copy'|'move'|'leave'
 *   getImagePersonNames(db, imageId)
 *   getArchiveChoices(db)
 *   writeExifMetadata(filePath, fields, exifMapping)   returns {ok, skipped, reason}
 *   resolveImagePath(db, imageId)   bildarchiv → bildauswahl → filepath → local_path
 */

const fs   = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const DEBUG = !!process.env.DEBUG;
function dbg(...args) { if (DEBUG) console.log('[archive]', ...args); }

// ─── Default config ───────────────────────────────────────────────────────────

const DEFAULT_FIELDS = [
  {
    id: 'fachbereich', label: 'Fachbereich', type: 'select',
    choices: ['DIR', 'ÖFA', 'GES', 'GUS', 'HOH', 'INZ', 'IRD', 'MMN', 'NUT', 'KUN', 'RSP', 'SUG'],
    allow_custom: false, required: false, order: 1,
  },
  {
    id: 'veranstaltungsnummer', label: 'Veranstaltungsnummer', type: 'text',
    choices: [], allow_custom: true, required: false, order: 2,
  },
  {
    id: 'datum', label: 'Datum', type: 'date',
    choices: [], allow_custom: true, required: false, order: 3,
  },
  {
    id: 'veranstaltungstitel', label: 'Veranstaltungstitel', type: 'text',
    choices: [], allow_custom: true, required: false, order: 4,
  },
  {
    id: 'urheber', label: 'Urheber', type: 'text',
    choices: [], allow_custom: true, required: false, order: 5,
  },
];

const DEFAULT_EXIF_MAPPING = {
  fachbereich:          ['XPSubject#0'],
  veranstaltungsnummer: ['XPSubject#1'],
  veranstaltungstitel:  ['XPSubject#2'],
  urheber:              ['Copyright', 'XPCopyright', 'dc:rights'],
  datum:                ['DateTimeOriginal', 'CreateDate'],
};

const DEFAULT_CONFIG = {
  version: 1,
  fields: DEFAULT_FIELDS,
  bildarchiv: {
    base_path: '/mnt/bildarchiv',
    folder_template: '{fachbereich}/{year}/{veranstaltungstitel}',
    filename_template: '{fachbereich}_{veranstaltungsnummer}_{year}_{month}_{description}_{counter}',
    default_action: 'copy',
    create_jpg: false,
  },
  bildauswahl: {
    base_path: '/mnt/bildauswahl',
    folder_template: '{fachbereich}/{year}/{veranstaltungstitel}',
    filename_template: '{fachbereich}_{veranstaltungsnummer}_{year}_{month}_{names}_{counter}',
    default_action: 'copy',
    create_jpg: false,
  },
  exif_mapping: DEFAULT_EXIF_MAPPING,
};

// ─── Config storage ───────────────────────────────────────────────────────────

/**
 * Load archive config from DB, merged with defaults.
 * @param {import('better-sqlite3').Database} db
 * @returns {object}
 */
function getArchiveConfig(db) {
  try {
    const row = db.prepare("SELECT value FROM archive_config WHERE key='config'").get();
    if (row?.value) {
      const stored = JSON.parse(row.value);
      // Deep merge fields — stored overrides defaults
      const merged = {
        ...DEFAULT_CONFIG,
        ...stored,
        bildarchiv: { ...DEFAULT_CONFIG.bildarchiv, ...(stored.bildarchiv || {}) },
        bildauswahl: { ...DEFAULT_CONFIG.bildauswahl, ...(stored.bildauswahl || {}) },
        exif_mapping: { ...DEFAULT_CONFIG.exif_mapping, ...(stored.exif_mapping || {}) },
        fields: stored.fields || DEFAULT_CONFIG.fields,
      };
      dbg('getArchiveConfig: loaded from DB, version', merged.version);
      return merged;
    }
  } catch (err) {
    console.error('[archive] getArchiveConfig error — returning defaults:', err.message);
  }
  dbg('getArchiveConfig: using defaults');
  return { ...DEFAULT_CONFIG };
}

/**
 * Persist archive config to DB.
 * @param {import('better-sqlite3').Database} db
 * @param {object} config
 */
function saveArchiveConfig(db, config) {
  try {
    const value = JSON.stringify({ ...config, version: (config.version || 1) });
    db.prepare(`
      INSERT INTO archive_config(key, value, updated_at)
      VALUES ('config', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(value);
    dbg('saveArchiveConfig: saved', Object.keys(config).join(', '));
  } catch (err) {
    console.error('[archive] saveArchiveConfig error:', err.message);
    throw err;
  }
}

// ─── Template engine ──────────────────────────────────────────────────────────

/**
 * Sanitize a string for safe use in a filename/path segment.
 * Replaces disallowed chars with underscores, collapses runs of underscores.
 */
function sanitizeSegment(str) {
  if (!str) return '';
  return String(str)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/__+/g, '_')
    .replace(/^_+|_+$/g, '')
    .trim();
}

/**
 * Extract year and month from a date string or Date object.
 * Returns { year: '2025', month: '03' }.
 */
function extractYearMonth(dateVal) {
  try {
    const d = dateVal ? new Date(dateVal) : new Date();
    if (isNaN(d.getTime())) return { year: String(new Date().getFullYear()), month: String(new Date().getMonth() + 1).padStart(2, '0') };
    return {
      year:  String(d.getFullYear()),
      month: String(d.getMonth() + 1).padStart(2, '0'),
    };
  } catch {
    const now = new Date();
    return { year: String(now.getFullYear()), month: String(now.getMonth() + 1).padStart(2, '0') };
  }
}

/**
 * Expand a template string with the given variables.
 * Variables: {fachbereich}, {year}, {month}, {veranstaltungstitel},
 *            {veranstaltungsnummer}, {description}, {names}, {counter}, {ext}, {filename}
 * Missing variables become empty string (then sanitized).
 * @param {string} template
 * @param {object} vars
 * @returns {string}
 */
function expandTemplate(template, vars) {
  return template.replace(/\{([^}]+)\}/g, (_, key) => {
    const val = vars[key];
    return val !== undefined && val !== null && val !== '' ? String(val) : '';
  });
}

/**
 * Build the destination folder path from an archive config section and image metadata.
 * @param {object} archiveSectionCfg  — bildarchiv or bildauswahl section
 * @param {object} meta               — { fachbereich, veranstaltungstitel, datum, ... }
 * @returns {string} absolute folder path
 */
function buildFolderPath(archiveSectionCfg, meta) {
  const { year, month } = extractYearMonth(meta.datum);
  const vars = {
    fachbereich:          sanitizeSegment(meta.fachbereich || ''),
    veranstaltungstitel:  sanitizeSegment(meta.veranstaltungstitel || ''),
    veranstaltungsnummer: sanitizeSegment(meta.veranstaltungsnummer || ''),
    year,
    month,
  };
  const folderRel = expandTemplate(archiveSectionCfg.folder_template, vars);
  // Remove empty path segments from template expansion (e.g. "//" → "/")
  const folderClean = folderRel.split('/').filter(s => s.trim() !== '').join('/');
  const result = path.join(archiveSectionCfg.base_path, folderClean);
  dbg('buildFolderPath:', result);
  return result;
}

/**
 * Build the destination filename (without extension).
 * Tries counter 001, 002, … until a non-existing file is found.
 * @param {string} filenameTpl      — filename_template from config
 * @param {object} meta             — image metadata vars
 * @param {string} destDir          — destination directory (to check for existing files)
 * @param {string} ext              — file extension including dot (e.g. '.jpg')
 * @returns {{ filename: string, fullPath: string, counter: number }}
 */
function buildFilename(filenameTpl, meta, destDir, ext) {
  const { year, month } = extractYearMonth(meta.datum);
  const baseVars = {
    fachbereich:          sanitizeSegment(meta.fachbereich || ''),
    veranstaltungstitel:  sanitizeSegment(meta.veranstaltungstitel || ''),
    veranstaltungsnummer: sanitizeSegment(meta.veranstaltungsnummer || ''),
    description:          sanitizeSegment(meta.description || meta.names || ''),
    names:                sanitizeSegment(meta.names || meta.description || ''),
    year,
    month,
  };

  let counter = 1;
  while (counter <= 9999) {
    const counterStr = String(counter).padStart(3, '0');
    const vars = { ...baseVars, counter: counterStr };
    let rawName = expandTemplate(filenameTpl, vars);
    // Clean up: remove double underscores, leading/trailing underscores per segment
    rawName = rawName
      .split('_')
      .filter(s => s.trim() !== '')
      .join('_')
      .replace(/__+/g, '_');

    const filename = rawName + ext.toLowerCase();
    const fullPath = path.join(destDir, filename);

    if (!fs.existsSync(fullPath)) {
      dbg(`buildFilename: found free slot ${filename} (counter=${counter})`);
      return { filename, fullPath, counter };
    }
    counter++;
  }
  // Fallback: use timestamp
  const ts = Date.now();
  const filename = `archive_${ts}${ext}`;
  return { filename, fullPath: path.join(destDir, filename), counter: ts };
}

// ─── File operations ──────────────────────────────────────────────────────────

/**
 * Ensure directory (and all parents) exist.
 */
function ensureDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    dbg('ensureDir OK:', dirPath);
  } catch (err) {
    console.error('[archive] ensureDir failed:', dirPath, err.message);
    throw err;
  }
}

/**
 * Copy or move a file to destination path.
 * action: 'copy' | 'move' | 'leave'
 * Returns { ok, action, destPath, error? }
 */
async function organizeFile(sourcePath, destPath, action) {
  dbg(`organizeFile: action=${action} src=${sourcePath} → dest=${destPath}`);

  if (action === 'leave') {
    dbg('organizeFile: action=leave, skipping file operation');
    return { ok: true, action, destPath: sourcePath };
  }

  if (!fs.existsSync(sourcePath)) {
    const err = `Source file not found: ${sourcePath}`;
    console.error('[archive]', err);
    return { ok: false, action, destPath: null, error: err };
  }

  try {
    ensureDir(path.dirname(destPath));

    if (action === 'copy') {
      fs.copyFileSync(sourcePath, destPath);
      console.log(`[archive] Copied: ${sourcePath} → ${destPath}`);
      return { ok: true, action, destPath };
    } else if (action === 'move') {
      try {
        fs.renameSync(sourcePath, destPath);
      } catch (_crossDevErr) {
        // Cross-device: copy then delete
        dbg('organizeFile: rename failed (cross-device?), falling back to copy+delete');
        fs.copyFileSync(sourcePath, destPath);
        fs.unlinkSync(sourcePath);
      }
      console.log(`[archive] Moved: ${sourcePath} → ${destPath}`);
      return { ok: true, action, destPath };
    } else {
      return { ok: false, action, destPath: null, error: `Unknown action: ${action}` };
    }
  } catch (err) {
    console.error(`[archive] organizeFile failed (${action}):`, err.message);
    return { ok: false, action, destPath: null, error: err.message };
  }
}

// ─── Person names ─────────────────────────────────────────────────────────────

/**
 * Get last names of identified persons in an image, joined by underscores.
 * Returns empty string if no identified faces.
 */
function getImagePersonNames(db, imageId) {
  try {
    const rows = db.prepare(`
      SELECT DISTINCT p.name
      FROM faces f
      JOIN face_embeddings fe ON fe.face_id = f.id
      JOIN people p           ON p.id = fe.person_id
      WHERE f.image_id = ?
        AND fe.person_id IS NOT NULL
        AND p.name IS NOT NULL
      ORDER BY p.name
    `).all(imageId);
    if (!rows.length) { dbg('getImagePersonNames: no identified faces for image', imageId); return ''; }
    // Extract last names (last word of full name)
    const lastNames = rows.map(r => {
      const parts = r.name.trim().split(/\s+/);
      return parts[parts.length - 1];
    });
    const result = lastNames.join('_');
    dbg(`getImagePersonNames image=${imageId} → ${result}`);
    return result;
  } catch (err) {
    console.error('[archive] getImagePersonNames error:', err.message);
    return '';
  }
}

// ─── Autocomplete choices ─────────────────────────────────────────────────────

/**
 * Return existing distinct values for each archive field from the images table.
 * Used for autocomplete dropdowns in the UI.
 */
function getArchiveChoices(db) {
  const choices = {};
  const fields = ['fachbereich', 'veranstaltungsnummer', 'veranstaltungstitel', 'urheber'];
  for (const field of fields) {
    try {
      const rows = db.prepare(`
        SELECT DISTINCT ${field} as val FROM images
        WHERE ${field} IS NOT NULL AND ${field} != ''
        ORDER BY ${field}
      `).all();
      choices[field] = rows.map(r => r.val);
      dbg(`getArchiveChoices.${field}: ${choices[field].length} values`);
    } catch (err) {
      console.warn(`[archive] getArchiveChoices.${field} error:`, err.message);
      choices[field] = [];
    }
  }
  return choices;
}

// ─── ExifTool integration ─────────────────────────────────────────────────────

let _exiftoolAvailable = null;   // cached: true | false | null (not yet checked)

async function checkExiftoolAvailable() {
  if (_exiftoolAvailable !== null) return _exiftoolAvailable;
  try {
    await execFileAsync('exiftool', ['-ver'], { timeout: 5000 });
    _exiftoolAvailable = true;
    console.log('[archive] exiftool is available');
  } catch {
    _exiftoolAvailable = false;
    console.warn('[archive] exiftool not found — EXIF writing will be skipped');
  }
  return _exiftoolAvailable;
}

/**
 * Write EXIF / IPTC / XMP metadata to a file using exiftool.
 *
 * @param {string} filePath        — path to the image file
 * @param {object} fields          — { fachbereich, veranstaltungsnummer, veranstaltungstitel, urheber, datum, ... }
 * @param {object} exifMapping     — mapping from field id → array of exiftool tag names
 * @returns {Promise<{ok:boolean, skipped:boolean, reason:string, tags:object}>}
 */
async function writeExifMetadata(filePath, fields, exifMapping) {
  dbg('writeExifMetadata start:', filePath, JSON.stringify(fields));

  if (!fs.existsSync(filePath)) {
    return { ok: false, skipped: false, reason: `File not found: ${filePath}`, tags: {} };
  }

  const available = await checkExiftoolAvailable();
  if (!available) {
    return { ok: true, skipped: true, reason: 'exiftool not installed — EXIF metadata not written', tags: {} };
  }

  // Build exiftool args: -TAG=VALUE for each field + its mapped tags
  const args = ['-overwrite_original', '-charset', 'UTF8'];
  const tagsWritten = {};

  for (const [fieldId, tagNames] of Object.entries(exifMapping)) {
    const value = fields[fieldId];
    if (value === undefined || value === null || value === '') continue;

    const strValue = String(value);
    for (const tagName of (Array.isArray(tagNames) ? tagNames : [tagNames])) {
      // Handle XPSubject array index: XPSubject#0 → use list append/position hack
      // For simplicity, skip positional array tags (they require read-modify-write)
      if (tagName.includes('#')) {
        dbg(`writeExifMetadata: skipping positional tag ${tagName} (not supported without read-first)`);
        continue;
      }
      args.push(`-${tagName}=${strValue}`);
      tagsWritten[tagName] = strValue;
    }
  }

  // Build XPSubject from combined fachbereich + veranstaltungsnummer + veranstaltungstitel
  const xpSubjectParts = [
    fields.fachbereich || '',
    fields.veranstaltungsnummer || '',
    fields.veranstaltungstitel || '',
  ].filter(s => s !== '');
  if (xpSubjectParts.length) {
    const xpSubjectVal = xpSubjectParts.join('_');
    args.push(`-XPSubject=${xpSubjectVal}`);
    args.push(`-Subject=${xpSubjectVal}`);
    tagsWritten['XPSubject'] = xpSubjectVal;
    tagsWritten['Subject'] = xpSubjectVal;
  }

  args.push(filePath);

  dbg('writeExifMetadata exiftool args:', args.slice(0, -1).join(' '));

  try {
    const { stderr } = await execFileAsync('exiftool', args, { timeout: 30000 });
    if (stderr?.trim()) console.warn('[archive] exiftool stderr:', stderr.trim());
    console.log(`[archive] writeExifMetadata OK: ${filePath} tags=${Object.keys(tagsWritten).join(',')}`);
    return { ok: true, skipped: false, reason: '', tags: tagsWritten };
  } catch (err) {
    console.error('[archive] writeExifMetadata exiftool error:', err.message);
    return { ok: false, skipped: false, reason: err.message, tags: tagsWritten };
  }
}

// ─── Priority path resolution ─────────────────────────────────────────────────

/**
 * Resolve the best available path for opening a full-size image.
 * Priority: bildarchiv_path → bildauswahl_path → filepath → local_path
 * Returns { path, source } where source is 'bildarchiv'|'bildauswahl'|'original'|'thumbnail'
 */
function resolveImagePath(db, imageId) {
  try {
    const row = db.prepare('SELECT filepath, local_path, bildarchiv_path, bildauswahl_path FROM images WHERE id=?').get(imageId);
    if (!row) { console.warn('[archive] resolveImagePath: image not found', imageId); return null; }

    dbg(`resolveImagePath id=${imageId}:`, JSON.stringify(row));

    for (const [source, p] of [
      ['bildarchiv',  row.bildarchiv_path],
      ['bildauswahl', row.bildauswahl_path],
      ['original',    row.filepath],
      ['original',    row.local_path],
    ]) {
      if (p && fs.existsSync(p)) {
        dbg(`resolveImagePath: using ${source} → ${p}`);
        return { path: p, source };
      }
    }
    console.warn('[archive] resolveImagePath: no file found for image', imageId);
    return null;
  } catch (err) {
    console.error('[archive] resolveImagePath error:', err.message);
    return null;
  }
}

// ─── Full organize pipeline ───────────────────────────────────────────────────

/**
 * Organize a single image: build path, copy/move, write EXIF, update DB.
 *
 * @param {object} opts
 *   db             - better-sqlite3 db
 *   imageId        - image row id
 *   archiveCfg     - full archive config object
 *   meta           - { fachbereich, veranstaltungsnummer, veranstaltungstitel, urheber, datum }
 *   archiveType    - 'bildarchiv' | 'bildauswahl'
 *   action         - 'copy' | 'move' | 'leave'
 *   writeExif      - boolean
 * @returns {Promise<{ok, destPath, exif, error?}>}
 */
async function organizeImage({ db, imageId, archiveCfg, meta, archiveType, action, writeExif: doWriteExif }) {
  console.log(`[archive] organizeImage start: id=${imageId} type=${archiveType} action=${action}`);

  try {
    // Get source file
    const row = db.prepare('SELECT filepath, local_path, filename FROM images WHERE id=?').get(imageId);
    if (!row) throw new Error(`Image ${imageId} not found in DB`);

    // Resolve best available source path
    const sourcePath = (row.filepath && fs.existsSync(row.filepath))
      ? row.filepath
      : (row.local_path && fs.existsSync(row.local_path))
        ? row.local_path
        : null;

    if (!sourcePath && action !== 'leave') {
      throw new Error(`No accessible file for image ${imageId} (filepath=${row.filepath}, local_path=${row.local_path})`);
    }

    // Get person names for description/names variable
    const personNames = getImagePersonNames(db, imageId);

    // Build destination path
    const sectionCfg = archiveCfg[archiveType];  // bildarchiv or bildauswahl
    const destDir = buildFolderPath(sectionCfg, meta);
    const ext = sourcePath ? path.extname(sourcePath) : (row.filename ? path.extname(row.filename) : '.jpg');

    const metaWithNames = {
      ...meta,
      names: meta.names || personNames,
      description: meta.description || personNames,
    };

    const { filename, fullPath: destPath } = buildFilename(
      sectionCfg.filename_template,
      metaWithNames,
      destDir,
      ext
    );

    dbg(`organizeImage: destPath=${destPath} filename=${filename}`);

    // Perform file operation
    let fileResult = { ok: true, destPath: sourcePath };
    if (action !== 'leave' && sourcePath) {
      fileResult = await organizeFile(sourcePath, destPath, action);
      if (!fileResult.ok) throw new Error(fileResult.error);
    }

    const finalPath = fileResult.destPath || destPath;

    // Write EXIF if requested
    let exifResult = { ok: true, skipped: true, reason: 'Not requested', tags: {} };
    if (doWriteExif && finalPath && fs.existsSync(finalPath)) {
      exifResult = await writeExifMetadata(finalPath, meta, archiveCfg.exif_mapping || DEFAULT_EXIF_MAPPING);
    }

    // Update DB: archive fields + path column
    const pathCol = archiveType === 'bildarchiv' ? 'bildarchiv_path' : 'bildauswahl_path';
    db.prepare(`
      UPDATE images SET
        ${pathCol} = ?,
        fachbereich = COALESCE(?, fachbereich),
        veranstaltungsnummer = COALESCE(?, veranstaltungsnummer),
        veranstaltungstitel = COALESCE(?, veranstaltungstitel),
        urheber = COALESCE(?, urheber),
        datum_event = COALESCE(?, datum_event),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      finalPath,
      meta.fachbereich || null,
      meta.veranstaltungsnummer || null,
      meta.veranstaltungstitel || null,
      meta.urheber || null,
      meta.datum || null,
      imageId,
    );

    console.log(`[archive] organizeImage OK: id=${imageId} → ${finalPath} exif.ok=${exifResult.ok} exif.skipped=${exifResult.skipped}`);
    return { ok: true, destPath: finalPath, filename, exif: exifResult };

  } catch (err) {
    console.error(`[archive] organizeImage FAILED id=${imageId}:`, err.message);
    return { ok: false, destPath: null, error: err.message, exif: null };
  }
}

// ─── Rename / resort ──────────────────────────────────────────────────────────

/**
 * Rename an already-organized image in-place (update DB + optionally rename file).
 * Used after person identification changes.
 */
async function renameArchiveImage({ db, imageId, archiveCfg, meta, archiveType, renameFile }) {
  console.log(`[archive] renameArchiveImage: id=${imageId} type=${archiveType}`);
  try {
    const pathCol = archiveType === 'bildarchiv' ? 'bildarchiv_path' : 'bildauswahl_path';
    const row = db.prepare(`SELECT ${pathCol}, filepath, local_path, filename FROM images WHERE id=?`).get(imageId);
    if (!row) throw new Error(`Image ${imageId} not found`);

    const existingPath = row[pathCol];
    const personNames = getImagePersonNames(db, imageId);
    const metaWithNames = { ...meta, names: meta.names || personNames, description: meta.description || personNames };

    if (renameFile && existingPath && fs.existsSync(existingPath)) {
      const sectionCfg = archiveCfg[archiveType];
      const ext = path.extname(existingPath);
      const destDir = buildFolderPath(sectionCfg, meta);
      ensureDir(destDir);
      const { filename, fullPath: newPath } = buildFilename(
        sectionCfg.filename_template, metaWithNames, destDir, ext
      );
      if (newPath !== existingPath) {
        fs.renameSync(existingPath, newPath);
        db.prepare(`UPDATE images SET ${pathCol}=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(newPath, imageId);
        console.log(`[archive] renameArchiveImage renamed: ${existingPath} → ${newPath}`);
        return { ok: true, oldPath: existingPath, newPath, filename };
      }
    }

    // Just update metadata in DB
    db.prepare(`
      UPDATE images SET
        fachbereich = COALESCE(?, fachbereich),
        veranstaltungsnummer = COALESCE(?, veranstaltungsnummer),
        veranstaltungstitel = COALESCE(?, veranstaltungstitel),
        urheber = COALESCE(?, urheber),
        datum_event = COALESCE(?, datum_event),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      meta.fachbereich || null, meta.veranstaltungsnummer || null,
      meta.veranstaltungstitel || null, meta.urheber || null,
      meta.datum || null, imageId
    );
    return { ok: true, oldPath: existingPath, newPath: existingPath };
  } catch (err) {
    console.error('[archive] renameArchiveImage error:', err.message);
    return { ok: false, error: err.message };
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  DEFAULT_CONFIG,
  getArchiveConfig,
  saveArchiveConfig,
  buildFolderPath,
  buildFilename,
  organizeFile,
  organizeImage,
  renameArchiveImage,
  getImagePersonNames,
  getArchiveChoices,
  writeExifMetadata,
  checkExiftoolAvailable,
  resolveImagePath,
  sanitizeSegment,
  expandTemplate,
};
