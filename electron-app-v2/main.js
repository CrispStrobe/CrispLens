'use strict';

/**
 * main.js — Electron main process for Face Recognition System v2
 *
 * In dev:  loads Svelte Vite dev server at http://localhost:5173
 * In prod: loads local FastAPI server OR a remote URL based on settings.
 */

const {
  app, BrowserWindow, Tray, Menu, shell,
  ipcMain, dialog, nativeImage, protocol,
} = require('electron');
const path   = require('path');
const fs     = require('fs');
const http   = require('http');
const os     = require('os');
const { spawn } = require('child_process');
const { PythonManager } = require('./python-manager');

// ─── localfile:// custom protocol ────────────────────────────────────────────
// Must be registered before app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'localfile', privileges: { secure: true, standard: true, supportFetchAPI: true } },
  // app:// serves the bundled Svelte SPA when we don't start a local FastAPI.
  // Must be registered as standard+secure so ES-module scripts and fetch() work.
  { scheme: 'app',       privileges: { secure: true, standard: true, supportFetchAPI: true } },
]);

// ─── constants ───────────────────────────────────────────────────────────────

const APP_NAME      = 'CrispLens';
// macOS requires .icns for system UI; Windows uses .ico; Linux falls back to .icns
const ICON_PATH = path.join(__dirname, 'assets',
  process.platform === 'darwin' ? 'icon.icns' : 'icon.ico');
const SETTINGS_FILE = () => path.join(app.getPath('appData'), 'CrispLens', 'electron-settings.json');
const IS_DEV        = process.env.NODE_ENV === 'development' || process.env.ELECTRON_DEV === '1';
const VITE_URL      = 'http://localhost:5173';

// ─── global refs ─────────────────────────────────────────────────────────────

let loadingWindow = null;
let wizardWindow  = null;
let mainWindow    = null;
let tray          = null;
let pythonManager = null;
let _serverPort   = null;
let _remoteUrl    = null;  // VPS display URL shown in tray
let _spaUrl       = null;  // actual URL loaded into mainWindow
let _spaServer    = null;  // Node http.Server serving bundled SPA in remote mode

// ─── settings helpers ─────────────────────────────────────────────────────────

function readSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE(), 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

function writeSettings(data) {
  const file = SETTINGS_FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ─── IPC handlers ────────────────────────────────────────────────────────────

ipcMain.handle('get-port',     () => _serverPort);
ipcMain.handle('get-settings', () => readSettings());
ipcMain.handle('save-settings', (_e, data) => {
  // Strip sensitive fields before persisting
  const clean = JSON.parse(JSON.stringify(data));
  if (clean.server) delete clean.server.adminPass;
  writeSettings(clean);
  return true;
});

ipcMain.handle('relaunch-app', () => {
  app.relaunch();
  app.exit(0);
});

// Switch DB path: save new dbPath into settings.server.dbPath, then relaunch
ipcMain.handle('switch-db', (_e, newDbPath) => {
  const settings = readSettings() || {};
  if (!settings.server) settings.server = {};
  settings.server.dbPath = newDbPath;
  settings.server.reuseExistingDb = true;
  writeSettings(settings);
  app.relaunch();
  app.exit(0);
});

ipcMain.handle('get-default-data-dir', () =>
  path.join(app.getPath('appData'), APP_NAME)
);

ipcMain.handle('detect-python', async () => {
  const candidates = process.platform === 'win32'
    ? [
        'py', 'python', 'python3',
        ...['313', '312', '311', '310'].map(v =>
          path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', `Python${v}`, 'python.exe')
        ),
        ...['313', '312', '311', '310'].map(v => `C:\\Python${v}\\python.exe`),
      ]
    : [
        'python3', 'python3.12', 'python3.11', 'python3.10', 'python',
        '/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3'
      ];

  const { execFile } = require('child_process');
  for (const exe of candidates) {
    try {
      const result = await new Promise((resolve, reject) => {
        execFile(exe, ['--version'], { timeout: 4000, encoding: 'utf8' }, (err, out, err2) => {
          if (err) reject(err); else resolve(out + err2);
        });
      });
      const m = result.match(/Python (\d+)\.(\d+)/);
      if (m && (+m[1] > 3 || (+m[1] === 3 && +m[2] >= 10))) {
        return { exe, version: `${m[1]}.${m[2]}` };
      }
    } catch { /* try next */ }
  }
  return null;
});

ipcMain.handle('open-file-dialog', async (_e, opts = {}) => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tiff'] },
    ],
    ...opts,
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('open-folder-dialog', async (_e, opts = {}) => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    ...opts,
  });
  return result.canceled ? null : result.filePaths[0];
});

// ─── Python helpers ───────────────────────────────────────────────────────────

/**
 * Resolve a Python executable.
 * Priority: explicit pythonPath → local venv → system python3.
 */
function resolvePython(pythonPath) {
  if (pythonPath && pythonPath.trim()) return pythonPath.trim();

  // Look for a local venv relative to the app's main script directory
  const scriptDir = path.dirname(__filename);
  const venvPy    = path.join(scriptDir, '..', 'venv', 'bin', 'python');
  if (fs.existsSync(venvPy)) return venvPy;

  return 'python3';
}

function spawnPython(pythonPath, args, opts = {}) {
  const exe = resolvePython(pythonPath);
  return spawn(exe, args, { ...opts });
}

// ─── Local model management IPC ──────────────────────────────────────────────

const INSIGHTFACE_MODELS = ['buffalo_l', 'buffalo_m', 'buffalo_s', 'buffalo_sc'];

ipcMain.handle('check-local-models', () => {
  const modelsDir = path.join(os.homedir(), '.insightface', 'models');
  const status = {};
  for (const m of INSIGHTFACE_MODELS) {
    const dir = path.join(modelsDir, m);
    try {
      const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      status[m] = files.some(f => f.endsWith('.onnx'));
    } catch {
      status[m] = false;
    }
  }
  return status;
});

ipcMain.handle('download-model', (event, { modelName, pythonPath }) => {
  return new Promise((resolve, reject) => {
    const code = `
from insightface.app import FaceAnalysis
import sys
print(f'Downloading {sys.argv[1]}...', flush=True)
app = FaceAnalysis(name=sys.argv[1], allowed_modules=['detection','recognition'])
app.prepare(ctx_id=-1)
print('done', flush=True)
`.trim();

    const py = spawnPython(pythonPath, ['-c', code, modelName], {
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    py.stdout.on('data', d => {
      event.sender.send('download-progress', { model: modelName, msg: d.toString().trim() });
    });
    py.stderr.on('data', d => {
      event.sender.send('download-progress', { model: modelName, msg: d.toString().trim() });
    });
    py.on('close', code => {
      if (code === 0) resolve(true);
      else reject(new Error(`Download process exited with code ${code}`));
    });
    py.on('error', reject);
  });
});

ipcMain.handle('test-python', async (_e, pythonPath) => {
  return new Promise(resolve => {
    const py = spawnPython(pythonPath, ['-c', 'import insightface; print("ok")'], {
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    let out = '', err = '';
    py.stdout.on('data', d => { out += d.toString(); });
    py.stderr.on('data', d => { err += d.toString(); });
    py.on('close', code => {
      if (code === 0 && out.includes('ok')) resolve({ ok: true });
      else resolve({ ok: false, error: err.trim() || `exit code ${code}` });
    });
    py.on('error', e => resolve({ ok: false, error: e.message }));
  });
});

// ─── Local image processing IPC ──────────────────────────────────────────────

ipcMain.handle('process-images-locally', (event, { paths, model, pythonPath }) => {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(path.dirname(__filename), '..', 'local_processor.py');

    const py = spawnPython(pythonPath, [scriptPath], {
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        INSIGHTFACE_MODEL: model || 'buffalo_l',
      },
    });

    let stderrBuf = '';
    let lineBuf   = '';

    py.stdout.on('data', chunk => {
      lineBuf += chunk.toString();
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          event.sender.send('local-process-result', JSON.parse(line));
        } catch (e) {
          // Not JSON — ignore (shouldn't happen; stdout is pure NDJSON)
        }
      }
    });

    py.stderr.on('data', d => { stderrBuf += d.toString(); });

    // Write paths to stdin
    for (const p of paths) {
      py.stdin.write(p + '\n');
    }
    py.stdin.end();

    py.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`local_processor exited ${code}: ${stderrBuf.slice(-500)}`));
    });
    py.on('error', reject);
  });
});

// ─── Read local file for upload-full mode ────────────────────────────────────

ipcMain.handle('read-local-file', (_e, filePath) => {
  try {
    return fs.readFileSync(filePath); // Returns Buffer → serialised as ArrayBuffer in renderer
  } catch (e) {
    throw new Error(`Cannot read file: ${e.message}`);
  }
});

// ─── Trash local files (duplicate local cleanup) ─────────────────────────────

ipcMain.handle('trash-items', async (_e, paths) => {
  const results = [];
  for (const p of paths) {
    try {
      await shell.trashItem(p);
      results.push({ path: p, ok: true });
    } catch (err) {
      results.push({ path: p, ok: false, error: err.message });
    }
  }
  return results;
});

// ─── Tiny SPA static-file server (remote/client mode) ────────────────────────
// Serves renderer/dist/ over plain HTTP so the page has a real http://127.0.0.1
// origin. This is necessary because Chromium's CORS stack doesn't reliably set
// referrer/initiator for custom-protocol (app://) pages, breaking our CORS
// interceptor for cross-origin credentialed fetches to the VPS.

const SPA_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
};

function startSpaServer() {
  const distDir = app.isPackaged
    ? path.join(process.resourcesPath, 'renderer', 'dist')
    : path.join(__dirname, 'renderer', 'dist');

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // Strip query string; fall back to index.html for SPA routes
      const cleanUrl  = (req.url || '/').split('?')[0];
      const candidate = path.join(distDir, cleanUrl === '/' ? 'index.html' : cleanUrl);
      const filePath  = fs.existsSync(candidate) ? candidate : path.join(distDir, 'index.html');
      const ext       = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': SPA_MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    });

    server.listen(0, '127.0.0.1', () => {
      _spaServer = server;
      resolve(`http://127.0.0.1:${server.address().port}/`);
    });
    server.on('error', reject);
  });
}

// ─── Browse local directory for FilesystemView ───────────────────────────────

const LOCAL_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.pgm']);

ipcMain.handle('read-local-dir', (_e, dirPath) => {
  try {
    const resolved = dirPath || os.homedir();
    const dirents  = fs.readdirSync(resolved, { withFileTypes: true });
    const entries  = dirents
      .filter(e => !e.name.startsWith('.'))
      .map(e => {
        const fullPath = path.join(resolved, e.name);
        const isDir    = e.isDirectory();
        const ext      = path.extname(e.name).toLowerCase();
        let size = 0;
        if (!isDir) {
          try { size = fs.statSync(fullPath).size; } catch { /* ignore */ }
        }
        return { name: e.name, path: fullPath, is_dir: isDir, is_image: !isDir && LOCAL_IMAGE_EXTS.has(ext), size };
      })
      .sort((a, b) => {
        if (a.is_dir !== b.is_dir) return b.is_dir ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
    const parentPath = resolved !== path.parse(resolved).root ? path.dirname(resolved) : null;
    return { path: resolved, parent: parentPath, entries };
  } catch (e) {
    throw new Error(`Cannot read directory: ${e.message}`);
  }
});

// ─── Loading window ───────────────────────────────────────────────────────────

function createLoadingWindow() {
  loadingWindow = new BrowserWindow({
    width:     520,
    height:    380,
    frame:     false,
    resizable: false,
    center:    true,
    icon:      fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });
  loadingWindow.loadFile(path.join(__dirname, 'loading.html'));
}

// ─── Wizard window ───────────────────────────────────────────────────────────

function createWizardWindow() {
  wizardWindow = new BrowserWindow({
    width:     680,
    height:    580,
    frame:     false,
    resizable: false,
    center:    true,
    icon:      fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });
  wizardWindow.loadFile(path.join(__dirname, 'setup-wizard.html'));
  wizardWindow.on('closed', () => { wizardWindow = null; });
}

/** Show wizard on first run; resolves with the full config (incl. adminPass in memory). */
function runWizard() {
  return new Promise(resolve => {
    createWizardWindow();
    const onComplete = (_event, config) => {
      ipcMain.removeListener('wizard-cancelled', onCancel);
      resolve(config);
    };
    const onCancel = () => {
      ipcMain.removeListener('wizard-complete', onComplete);
      resolve(null);
    };
    ipcMain.once('wizard-complete', onComplete);
    ipcMain.once('wizard-cancelled', onCancel);
  });
}

/** After setup completes, open the main window (for role=both) or just close wizard. */
ipcMain.on('wizard-open-app', () => {
  if (wizardWindow && !wizardWindow.isDestroyed()) wizardWindow.close();
  if (!mainWindow) {
    if (_spaUrl)     createMainWindow(null, _spaUrl);
    else if (_serverPort) createMainWindow(_serverPort);
  }
});

// ─── Main window ─────────────────────────────────────────────────────────────

function createMainWindow(port, remoteUrl) {
  const url = remoteUrl || (IS_DEV ? VITE_URL : `http://127.0.0.1:${port}/`);

  mainWindow = new BrowserWindow({
    width:     1400,
    height:    900,
    minWidth:  960,
    minHeight: 640,
    title:     APP_NAME,
    icon:      fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    show:      false,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  mainWindow.loadURL(url);

  mainWindow.once('ready-to-show', () => {
    if (loadingWindow && !loadingWindow.isDestroyed()) {
      loadingWindow.close();
      loadingWindow = null;
    }
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('close', e => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── System tray ─────────────────────────────────────────────────────────────

function createTray(port, remoteUrl) {
  const icon = fs.existsSync(ICON_PATH) ? ICON_PATH : nativeImage.createEmpty();
  // remoteUrl === null → server-only (no UI window), undefined → use local port
  const isServerOnly = (remoteUrl === null && !IS_DEV);
  const url  = remoteUrl || (IS_DEV ? VITE_URL : `http://127.0.0.1:${port}/`);
  const modeLabel = remoteUrl ? `Remote: ${remoteUrl}` : (IS_DEV ? 'Dev Mode' : `Server port ${port}`);

  if (tray) tray.destroy();
  tray = new Tray(icon);
  tray.setToolTip(`${APP_NAME} — ${modeLabel}`);

  const menuTemplate = [
    { label: APP_NAME, enabled: false },
    { label: modeLabel, enabled: false },
    { type: 'separator' },
    ...(!isServerOnly ? [{
      label: 'Open',
      click: () => {
        if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
        else createMainWindow(port, remoteUrl || undefined);
      },
    }] : []),
    { label: 'Open in Browser', click: () => shell.openExternal(url) },
  ];

  tray.setContextMenu(Menu.buildFromTemplate([
    ...menuTemplate,
    { type: 'separator' },
    {
      label: 'Switch mode / Reset settings',
      click: async () => {
        const { response } = await dialog.showMessageBox({
          type: 'question',
          buttons: ['Reset & Restart', 'Cancel'],
          defaultId: 1,
          message: 'Reset connection settings?',
          detail: 'The app will restart and show the mode chooser again.',
        });
        if (response === 0) {
          // Clear settings so wizard shows on next launch
          const file = SETTINGS_FILE();
          try { require('fs').unlinkSync(file); } catch { /* already gone */ }
          app.relaunch();
          app.exit(0);
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        if (pythonManager) pythonManager.stop();
        tray.destroy();
        app.quit();
      },
    },
  ]));

  tray.on('double-click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    else createMainWindow(port, remoteUrl);
  });
}

// ─── IPC helpers ──────────────────────────────────────────────────────────────

function sendToLoading(channel, payload) {
  if (loadingWindow && !loadingWindow.isDestroyed()) {
    loadingWindow.webContents.send(channel, payload);
  }
}

function waitForModeChoice() {
  return new Promise(resolve => {
    ipcMain.once('mode-chosen', (_event, choice) => resolve(choice));
  });
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

async function startApp() {
  if (IS_DEV) {
    createMainWindow(null);
    _serverPort = parseInt(process.env.FACE_REC_PORT || '7865', 10);
    createTray(_serverPort);
    return;
  }

  // Show splash immediately — before anything else.
  createLoadingWindow();
  await new Promise(resolve => loadingWindow.webContents.once('did-finish-load', resolve));
  sendToLoading('setup-log', 'Reading configuration…');

  let settings = readSettings();

  // Migrate legacy settings format (mode: 'local' | 'remote') to new role-based format
  if (settings && !settings.role) {
    if (settings.mode === 'remote') {
      settings = {
        role: 'client',
        server: {},
        client: { connectTo: 'remote', remoteUrl: settings.remoteUrl || '' },
      };
    } else {
      settings = {
        role: 'both',
        server: { port: parseInt(process.env.FACE_REC_PORT || '7865', 10) },
        client: { connectTo: 'local' },
      };
    }
    writeSettings(settings);
  }

  // First run — no settings yet → show wizard
  if (!settings) {
    sendToLoading('setup-log', 'First run — opening setup wizard…');
    await new Promise(r => setTimeout(r, 600)); // let user read the splash
    if (loadingWindow && !loadingWindow.isDestroyed()) loadingWindow.close();
    loadingWindow = null;
    settings = await runWizard();
    if (!settings) { app.quit(); return; }
    // settings saved by wizard (adminPass stripped); we have full config in memory
    // Re-open loading for the Python startup phase
    createLoadingWindow();
    await new Promise(resolve => loadingWindow.webContents.once('did-finish-load', resolve));
  }

  const { role = 'both', server: srvCfg = {}, client: cliCfg = {} } = settings;

  // ── Client-only OR Both+remote: serve bundled SPA, no local Python ──────
  // Start a tiny Node HTTP server for the SPA so the page has a real
  // http://127.0.0.1 origin — required for our CORS interceptor to work on
  // cross-origin credentialed requests to the VPS.
  if (role === 'client' || (role === 'both' && cliCfg.connectTo === 'remote')) {
    const vpsUrl = cliCfg.remoteUrl || '';
    _remoteUrl = vpsUrl;

    sendToLoading('setup-log',    vpsUrl ? `Connecting to ${vpsUrl}` : 'Opening app…');
    sendToLoading('setup-detail', 'Preparing interface…');

    _spaUrl = await startSpaServer();
    sendToLoading('setup-done', null);

    if (wizardWindow && !wizardWindow.isDestroyed()) wizardWindow.close();
    createMainWindow(null, _spaUrl);
    createTray(null, vpsUrl || _spaUrl);
    return;
  }

  // ── Server or Both: start Python backend ──────────────────────────────────
  const useWizard = wizardWindow && !wizardWindow.isDestroyed();

  function sendProgress(channel, payload) {
    if (useWizard && wizardWindow && !wizardWindow.isDestroyed()) {
      wizardWindow.webContents.send(channel, payload);
    } else {
      sendToLoading(channel, payload);
    }
  }

  // Describe what we're doing before starting Python
  if (role === 'both' && cliCfg.connectTo === 'remote') {
    sendProgress('setup-log',   'Starting local AI backend…');
    sendProgress('setup-detail', `UI will connect to ${cliCfg.remoteUrl || 'remote server'}`);
  } else {
    sendProgress('setup-log', 'Starting local AI backend…');
  }

  pythonManager = new PythonManager({
    config:  srvCfg,
    onLog: msg => {
      // Suppress raw uvicorn/access-log noise; only forward meaningful lines.
      if (/^INFO:\s+\d+\.\d+\.\d+\.\d+/.test(msg)) return; // HTTP access log
      if (/^INFO:\s+(Started server|Waiting for application|Uvicorn running)/.test(msg)) {
        // Replace raw uvicorn startup lines with a clean milestone
        if (msg.includes('Uvicorn running')) sendProgress('setup-log', 'Backend ready ✓');
        return;
      }
      sendProgress('setup-log', msg);
    },
    onError: msg => sendProgress('setup-error', msg),
  });

  try {
    const port = await pythonManager.start();
    _serverPort = port;
    _spaUrl     = `http://127.0.0.1:${port}/`;
    sendProgress('setup-done', port);
    createTray(port, role === 'server' ? null : undefined);

    if (role !== 'server') {
      // For 'both': auto-open main window after brief success display
      const openMain = () => {
        if (wizardWindow && !wizardWindow.isDestroyed()) wizardWindow.close();
        createMainWindow(port);
      };
      if (useWizard) setTimeout(openMain, 1800);
      else openMain();
    }
    // For 'server': no main window — tray-only
  } catch (err) {
    sendProgress('setup-error', err.message);
    await new Promise(r => setTimeout(r, 800));
    dialog.showErrorBox(
      `${APP_NAME} — Startup Error`,
      `Failed to start the Python backend:\n\n${err.message}\n\n` +
      'Please check that Python 3.10+ is installed and try again.'
    );
    app.exit(1);
  }
}

// ─── Electron lifecycle ───────────────────────────────────────────────────────

app.whenReady().then(() => {
  const { session, webContents } = require('electron');

  // ── app:// protocol — serves bundled Svelte SPA without a local FastAPI ──
  // Used when role=client or role=both+connectTo=remote so the user doesn't
  // see a confusing "uvicorn starting on 127.0.0.1" splash.
  const spaDistDir = app.isPackaged
    ? path.join(process.resourcesPath, 'renderer', 'dist')
    : path.join(__dirname, 'renderer', 'dist');

  protocol.registerFileProtocol('app', (request, callback) => {
    try {
      const parsed   = new URL(request.url);
      const relPath  = parsed.pathname.slice(1); // strip leading '/'
      const filePath = path.join(spaDistDir, relPath || 'index.html');
      // SPA fallback: unknown paths → index.html (client-side routing)
      if (relPath && fs.existsSync(filePath)) callback({ path: filePath });
      else callback({ path: path.join(spaDistDir, 'index.html') });
    } catch {
      callback({ error: -6 }); // FILE_NOT_FOUND
    }
  });

  // ── CORS interceptor ────────────────────────────────────────────────────
  // Chromium blocks cross-origin credentialed requests when the server sends
  // Access-Control-Allow-Origin: * (wildcard + credentials is forbidden by
  // the Fetch spec).  We intercept every response and replace the wildcard
  // with the actual requesting origin so Chromium accepts it — including for
  // OPTIONS preflight where details.referrer is often empty.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };

    // Build a lowercase-key map for reliable lookup (HTTP headers are case-insensitive)
    const lc = {};
    for (const [k, v] of Object.entries(headers)) lc[k.toLowerCase()] = { key: k, val: v };

    const acao = lc['access-control-allow-origin'];
    if (acao && acao.val[0] === '*') {
      // Determine the actual requesting origin.
      // Three-level fallback because preflight OPTIONS often has no Referer header.
      let origin = null;

      // 1. Referer header (present for most sub-resource requests)
      if (!origin && details.referrer) {
        try { origin = new URL(details.referrer).origin; } catch { /* ignore */ }
      }

      // 2. initiator string (present for OPTIONS preflight and fetch() calls)
      if (!origin && details.initiator) {
        try { origin = new URL(details.initiator).origin; } catch {
          origin = details.initiator; // may already be a bare origin string
        }
      }

      // 3. URL of the BrowserWindow that owns this request
      if (!origin && details.webContentsId) {
        try {
          const wc = webContents.fromId(details.webContentsId);
          if (wc) origin = new URL(wc.getURL()).origin;
        } catch { /* ignore */ }
      }

      if (origin) {
        delete headers[acao.key]; // remove original (may have mixed casing)
        headers['access-control-allow-origin']      = [origin];
        headers['access-control-allow-credentials'] = ['true'];
        if (!lc['access-control-allow-methods'])
          headers['access-control-allow-methods'] = ['GET, POST, PUT, PATCH, DELETE, OPTIONS'];
        if (!lc['access-control-allow-headers'])
          headers['access-control-allow-headers'] = ['Content-Type, Authorization, X-Requested-With'];
      }
    }

    callback({ responseHeaders: headers });
  });

  // Serve local files via localfile:// — used by Lightbox for full-res images
  protocol.registerFileProtocol('localfile', (request, callback) => {
    try {
      // request.url looks like: localfile:///Users/christian/Photos/IMG.jpg
      const filePath = decodeURIComponent(request.url.replace(/^localfile:\/\//, ''));
      callback({ path: filePath });
    } catch (e) {
      callback({ error: -6 }); // FILE_NOT_FOUND
    }
  });

  startApp();
});
app.on('window-all-closed', () => { /* stay alive in tray */ });
app.on('before-quit', () => {
  app.isQuitting = true;
  if (pythonManager) pythonManager.stop();
  if (_spaServer)    _spaServer.close();
});
app.on('activate', () => {
  if (mainWindow) mainWindow.show();
});
