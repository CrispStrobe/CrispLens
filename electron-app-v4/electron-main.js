'use strict';

/**
 * electron-main.js — Electron main process for CrispLens v4
 *
 * Key difference from v2: the backend is our own Node.js/Express server
 * running IN-PROCESS — no Python, no subprocess. Fast start, no venv needed.
 *
 * Architecture:
 *   Electron main → starts Express server → opens BrowserWindow → loads http://localhost:PORT
 *
 * Modes:
 *   dev:  ELECTRON_DEV=1  → loads Vite dev server (http://localhost:5173)
 *   prod: starts Express  → loads http://localhost:PORT
 */

const {
  app, BrowserWindow, Tray, Menu, ipcMain, dialog,
  shell, nativeImage, protocol,
} = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const http = require('http');
const net  = require('net');

// ── localfile:// protocol — serve arbitrary local paths with auth ─────────────
protocol.registerSchemesAsPrivileged([
  { scheme: 'localfile', privileges: { secure: true, standard: true, supportFetchAPI: true } },
]);

// ── Constants ─────────────────────────────────────────────────────────────────

const IS_DEV  = process.env.ELECTRON_DEV === '1' || process.env.NODE_ENV === 'development';
const IS_MAC  = process.platform === 'darwin';
const IS_WIN  = process.platform === 'win32';
const PORT_PREF = parseInt(process.env.PORT || '7861', 10);  // preferred port; may be bumped
let   PORT    = PORT_PREF;  // actual port used — resolved by findFreePort() before server start

/** Find the first free TCP port starting at `start`. Tries up to 20 candidates. */
function findFreePort(start) {
  return new Promise((resolve, reject) => {
    const try_ = (p) => {
      if (p > start + 20) return reject(new Error(`No free port found in range ${start}–${start + 20}`));
      const s = net.createServer();
      s.once('error', () => try_(p + 1));
      s.once('listening', () => s.close(() => resolve(p)));
      s.listen(p, '127.0.0.1');
    };
    try_(start);
  });
}
const VITE_URL = `http://localhost:5173`;

// Always enable debug logs in main/server for better visibility
process.env.DEBUG = '1';
process.env.DEBUG_SQL = IS_DEV ? '1' : '0';

// ── Log capture: redirect console.* to a rotating log file ───────────────────
// The file is served by /api/admin/logs so the in-app log viewer works in prod.
{
  const LOG_DIR  = path.join(app.getPath('logs'));
  const LOG_FILE = path.join(LOG_DIR, 'crisplens.log');
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    // Keep last 2 MB: rename existing log on startup
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    }
    const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    const _stamp = () => new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    const _wrap = (orig, tag) => (...args) => {
      const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
      logStream.write(`${_stamp()} ${tag} ${msg}\n`);
      orig.apply(console, args);
    };
    console.log   = _wrap(console.log,   '[LOG]');
    console.info  = _wrap(console.info,  '[INF]');
    console.warn  = _wrap(console.warn,  '[WRN]');
    console.error = _wrap(console.error, '[ERR]');
    process.env.LOG_FILE = LOG_FILE;
    console.log(`[main] Log file: ${LOG_FILE}`);
  } catch (e) {
    // Non-fatal — proceed without file logging
    console.warn('[main] Could not set up log file:', e.message);
  }
}

const ICON_PATH = path.join(__dirname, 'assets',
  IS_MAC ? 'icon.icns' : IS_WIN ? 'icon.ico' : 'icon.png');

const SETTINGS_FILE = () => path.join(app.getPath('appData'), 'CrispLens', 'settings.json');

// ── Global refs ───────────────────────────────────────────────────────────────

let mainWindow   = null;
let tray         = null;
let expressApp   = null;  // the running http.Server
let serverReady  = false;

// ── Settings helpers ──────────────────────────────────────────────────────────

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')); }
  catch { return {}; }
}

function writeSettings(data) {
  const f = SETTINGS_FILE();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data, null, 2));
}

// ── Resolve DB path ───────────────────────────────────────────────────────────

function resolveDbPath() {
  const settings = readSettings();
  if (settings.dbPath && fs.existsSync(settings.dbPath)) return settings.dbPath;

  // Default: look next to the app package
  const candidates = [
    path.join(__dirname, '..', 'face_recognition.db'),              // dev
    path.join(app.getPath('userData'), 'face_recognition.db'),      // prod
    path.join(os.homedir(), 'CrispLens', 'face_recognition.db'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;

  // Default new-install location
  const defaultPath = path.join(app.getPath('userData'), 'face_recognition.db');
  console.log(`[main] DB not found, will create at: ${defaultPath}`);
  return defaultPath;
}

// ── Start Express server in-process ──────────────────────────────────────────

function startServer(dbPath) {
  return new Promise((resolve, reject) => {
    process.env.DB_PATH    = dbPath;
    process.env.PORT       = String(PORT);
    process.env.UPLOAD_DIR = path.join(path.dirname(dbPath), 'uploads');

    // Load the Express app (server.js returns the app instance)
    let serverModule;
    try { serverModule = require('./server.js'); }
    catch (err) { return reject(err); }

    // server.js calls app.listen() itself and returns the app.
    // Wait for it to be reachable.
    const checkReady = (attempts = 0) => {
      if (attempts > 40) return reject(new Error('Server did not start in time'));
      http.get(`http://127.0.0.1:${PORT}/api/health`, res => {
        if (res.statusCode === 200) { serverReady = true; resolve(); }
        else setTimeout(() => checkReady(attempts + 1), 150);
      }).on('error', () => setTimeout(() => checkReady(attempts + 1), 150));
    };
    checkReady();
  });
}

// ── Create main window ────────────────────────────────────────────────────────

function createWindow(urlOverride) {
  mainWindow = new BrowserWindow({
    width:          1280,
    height:         820,
    minWidth:       800,
    minHeight:      500,
    title:          'CrispLens',
    icon:           fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    backgroundColor: '#0e0e1a',
    webPreferences: {
      preload:            path.join(__dirname, 'preload.js'),
      contextIsolation:   true,
      nodeIntegration:    false,
      sandbox:            false,
      webSecurity:        true,
    },
    show: false,  // show after content loads
  });

  const url = urlOverride || (IS_DEV ? VITE_URL : `http://127.0.0.1:${PORT}`);
  mainWindow.loadURL(url);

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('closed', () => { mainWindow = null; });

  if (IS_DEV) mainWindow.webContents.openDevTools();
}

// ── Tray ──────────────────────────────────────────────────────────────────────

function createTray() {
  if (!fs.existsSync(ICON_PATH)) return;
  const icon = IS_MAC
    ? nativeImage.createFromPath(ICON_PATH).resize({ width: 16 })
    : nativeImage.createFromPath(ICON_PATH);

  tray = new Tray(icon);
  tray.setToolTip('CrispLens v4');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open CrispLens', click: () => { if (mainWindow) mainWindow.show(); else createWindow(); } },
    { label: `API: http://localhost:${PORT}/api`, enabled: false },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
  tray.on('double-click', () => { if (mainWindow) mainWindow.show(); });
}

// ── localfile:// handler ──────────────────────────────────────────────────────

function registerLocalFileProtocol() {
  protocol.handle('localfile', async (req) => {
    const url = new URL(req.url);
    let p = url.hostname + url.pathname;
    // On Windows paths look like localfile:///C:/Users/...
    if (IS_WIN && !p.startsWith('/')) p = '/' + p;
    p = decodeURIComponent(p);
    try {
      const data = fs.readFileSync(p);
      const ext  = path.extname(p).slice(1).toLowerCase();
      const mime = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
        gif: 'image/gif',  webp: 'image/webp', heic: 'image/heic',
        mp4: 'video/mp4',  mov: 'video/quicktime',
      }[ext] || 'application/octet-stream';
      return new Response(data, { headers: { 'Content-Type': mime } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

function registerIpc() {
  ipcMain.handle('get-port',      () => PORT);
  ipcMain.handle('get-settings',  () => readSettings());
  ipcMain.handle('save-settings', (_e, data) => { writeSettings(data); return true; });

  ipcMain.handle('relaunch-app',  () => { app.relaunch(); app.quit(); });

  /** Return info about the database that is ACTUALLY open right now. */
  ipcMain.handle('get-active-db', () => {
    const activePath = process.env.DB_PATH || resolveDbPath();
    let size = 0, writable = false;
    try {
      const stat = fs.statSync(activePath);
      size = stat.size;
      fs.accessSync(activePath, fs.constants.W_OK);
      writable = true;
    } catch { /* file may not exist yet (new install) */ }
    const defaultPath = path.join(app.getPath('userData'), 'face_recognition.db');
    return { activePath, size, writable, defaultPath, isDefault: activePath === defaultPath };
  });

  ipcMain.handle('switch-db', (_e, dbPath) => {
    const s = readSettings();
    writeSettings({ ...s, dbPath, remoteUrl: '' });  // clear remote when switching to local DB
    app.relaunch();
    app.quit();
  });

  /** Clear custom dbPath so next launch resolves the default location. */
  ipcMain.handle('reset-db-to-default', () => {
    const s = readSettings();
    const { dbPath: _removed, ...rest } = s;
    writeSettings({ ...rest, remoteUrl: '' });
    app.relaunch();
    app.quit();
  });

  /** Create a new empty DB file at chosen path (renderer picks via save dialog). */
  ipcMain.handle('create-new-db', async (_e, dbPath) => {
    if (!dbPath) return { ok: false, error: 'No path provided' };
    try {
      // Create an empty file if it doesn't exist
      if (!fs.existsSync(dbPath)) fs.writeFileSync(dbPath, '');
      const s = readSettings();
      writeSettings({ ...s, dbPath, remoteUrl: '' });
      app.relaunch();
      app.quit();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Set or clear the remote VPS URL and relaunch.
  // Pass '' or null to go back to local mode.
  ipcMain.handle('set-remote-url', (_e, url) => {
    const s = readSettings();
    writeSettings({ ...s, remoteUrl: url || '' });
    app.relaunch();
    app.quit();
  });

  ipcMain.handle('open-file-dialog', async (_e, opts = {}) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      ...opts,
    });
    return canceled ? [] : filePaths;
  });

  ipcMain.handle('open-folder-dialog', async (_e, opts = {}) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      ...opts,
    });
    return canceled ? [] : filePaths;
  });

  ipcMain.handle('save-file-dialog', async (_e, opts = {}) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, opts);
    return canceled ? null : filePath;
  });

  ipcMain.handle('read-local-file', async (_e, filePath) => {
    try {
      const buf = fs.readFileSync(filePath);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } catch { return null; }
  });

  ipcMain.handle('read-local-dir', async (_e, dirPath) => {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      return entries.map(e => ({
        name:   e.name,
        path:   path.join(dirPath, e.name),
        is_dir: e.isDirectory(),
      }));
    } catch { return []; }
  });

  ipcMain.handle('get-log-file', () => process.env.LOG_FILE || null);
  ipcMain.handle('show-log-file', () => {
    const f = process.env.LOG_FILE;
    if (f && fs.existsSync(f)) shell.showItemInFolder(f);
  });

  ipcMain.handle('trash-items', async (_e, paths) => {
    const results = [];
    for (const p of paths) {
      try { await shell.trashItem(p); results.push({ path: p, ok: true }); }
      catch (err) { results.push({ path: p, ok: false, error: err.message }); }
    }
    return results;
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  registerLocalFileProtocol();
  registerIpc();

  const settings = readSettings();
  const remoteUrl = settings.remoteUrl || '';

  if (remoteUrl) {
    // ── Remote mode: connect to an existing v2/v4 server ─────────────────────
    console.log(`[main] Remote mode — connecting to: ${remoteUrl}`);
    serverReady = true;  // no local server; skip health check
    createTray();
    createWindow(remoteUrl);
  } else {
    // ── Local mode: start Express in-process ─────────────────────────────────
    createTray();

    // Resolve a free port before starting (avoids silent failure when 7861 is taken)
    try {
      PORT = await findFreePort(PORT_PREF);
      if (PORT !== PORT_PREF) console.log(`[main] Port ${PORT_PREF} in use, using ${PORT} instead`);
    } catch (err) {
      dialog.showErrorBox('CrispLens', `Could not find a free port:\n${err.message}`);
      app.quit();
      return;
    }

    const dbPath = resolveDbPath();
    console.log(`[main] Starting Express server on port ${PORT}, DB: ${dbPath}`);

    try {
      await startServer(dbPath);
      console.log(`[main] Server ready on port ${PORT}`);
    } catch (err) {
      console.error('[main] Server failed to start:', err);
      dialog.showErrorBox('CrispLens', `Failed to start server:\n${err.message}`);
      app.quit();
      return;
    }

    createWindow();
  }
});

app.on('window-all-closed', () => {
  if (!IS_MAC) app.quit();
});

app.on('activate', () => {
  // On macOS, 'activate' can fire before 'ready' completes (e.g. first launch).
  // Only create a window once the app is fully ready and the server is up.
  if (app.isReady() && serverReady && mainWindow === null) createWindow();
});

app.on('quit', () => {
  if (expressApp) { try { expressApp.close(); } catch {} }
});
