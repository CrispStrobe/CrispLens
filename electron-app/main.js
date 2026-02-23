'use strict';

/**
 * main.js — Electron main process
 *
 * Startup modes
 * ─────────────
 * local   Each user's machine runs its own Python/Gradio backend.
 *          Multiple local instances may share a SQLite DB on a network drive.
 *          The Python backend does all AI work on this machine.
 *
 * remote  This machine is a thin client.  The Python backend runs elsewhere.
 *          No local Python process is started; the main window just opens
 *          the remote server's URL.
 *
 * On first launch (no electron-settings.json) the splash window shows a
 * mode-chooser screen.  The user's choice is saved and used on subsequent
 * launches.  Settings can be reset from the tray context-menu.
 */

const {
  app, BrowserWindow, Tray, Menu, shell,
  ipcMain, dialog, nativeImage,
} = require('electron');
const path = require('path');
const fs   = require('fs');
const { PythonManager } = require('./python-manager');

// ─── constants ───────────────────────────────────────────────────────────────

const APP_NAME        = 'Face Recognition System';
const ICON_PATH       = path.join(__dirname, 'assets', 'icon.ico');
const SETTINGS_FILE   = () =>
  path.join(app.getPath('appData'), 'FaceRecognitionSystem', 'electron-settings.json');

// ─── global refs ─────────────────────────────────────────────────────────────

let splashWindow  = null;
let mainWindow    = null;
let tray          = null;
let pythonManager = null;

// ─── settings helpers ─────────────────────────────────────────────────────────

function readSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeSettings(data) {
  const file = SETTINGS_FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ─── IPC handlers ────────────────────────────────────────────────────────────

ipcMain.handle('get-settings',  () => readSettings());
ipcMain.handle('save-settings', (_e, data) => { writeSettings(data); return true; });
ipcMain.handle('reset-settings', () => {
  try { fs.unlinkSync(SETTINGS_FILE()); } catch { /* ignore */ }
  return true;
});

// ─── window factories ────────────────────────────────────────────────────────

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width:     560,
    height:    440,
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
  splashWindow.loadFile(path.join(__dirname, 'renderer', 'splash.html'));
}

function createMainWindow(port, remoteUrl) {
  const url = remoteUrl || `http://127.0.0.1:${port}/`;

  mainWindow = new BrowserWindow({
    width:     1300,
    height:    820,
    minWidth:  900,
    minHeight: 600,
    title:     APP_NAME,
    icon:      fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    show:      false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  mainWindow.loadURL(url);

  mainWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
      splashWindow = null;
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

// ─── system tray ─────────────────────────────────────────────────────────────

function createTray(port, remoteUrl) {
  const icon = fs.existsSync(ICON_PATH) ? ICON_PATH : nativeImage.createEmpty();
  const url  = remoteUrl || `http://127.0.0.1:${port}/`;
  const modeLabel = remoteUrl ? `Remote: ${remoteUrl}` : `Local port ${port}`;

  tray = new Tray(icon);

  const rebuild = () => Menu.buildFromTemplate([
    { label: APP_NAME, enabled: false },
    { label: modeLabel, enabled: false },
    { type: 'separator' },
    {
      label: 'Open',
      click: () => {
        if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
        else             createMainWindow(port, remoteUrl);
      },
    },
    { label: 'Open in Browser', click: () => shell.openExternal(url) },
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
          writeSettings({ mode: 'choose' });
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
  ]);

  tray.setToolTip(`${APP_NAME} — ${modeLabel}`);
  tray.setContextMenu(rebuild());

  tray.on('double-click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    else             createMainWindow(port, remoteUrl);
  });
}

// ─── IPC helpers ─────────────────────────────────────────────────────────────

function sendToSplash(channel, payload) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send(channel, payload);
  }
}

/**
 * Wait for the user to submit the mode-chooser form in the splash window.
 * Returns { mode: 'local' } or { mode: 'remote', remoteUrl: '...' }.
 */
function waitForModeChoice() {
  return new Promise(resolve => {
    ipcMain.once('mode-chosen', (_event, choice) => resolve(choice));
  });
}

// ─── app bootstrap ───────────────────────────────────────────────────────────

async function startApp() {
  createSplashWindow();

  // Wait for the splash renderer to load before sending IPC
  await new Promise(resolve =>
    splashWindow.webContents.once('did-finish-load', resolve)
  );

  // ── Read or ask for settings ──────────────────────────────────────────
  let settings = readSettings();

  if (!settings || settings.mode === 'choose') {
    sendToSplash('show-mode-chooser');
    settings = await waitForModeChoice();
    writeSettings(settings);
  }

  // ── Remote mode — skip Python entirely ───────────────────────────────
  if (settings.mode === 'remote') {
    const remoteUrl = settings.remoteUrl;
    sendToSplash('setup-log', `Connecting to remote server: ${remoteUrl}`);
    createMainWindow(null, remoteUrl);
    createTray(null, remoteUrl);
    return;
  }

  // ── Local mode — start Python backend ────────────────────────────────
  pythonManager = new PythonManager({
    onLog:   msg => sendToSplash('setup-log',   msg),
    onError: msg => sendToSplash('setup-error', msg),
  });

  try {
    const port = await pythonManager.start();
    sendToSplash('setup-done', port);
    createMainWindow(port);
    createTray(port);
  } catch (err) {
    sendToSplash('setup-error', err.message);
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

app.whenReady().then(startApp);

app.on('window-all-closed', () => { /* keep alive in tray */ });

app.on('before-quit', () => {
  app.isQuitting = true;
  if (pythonManager) pythonManager.stop();
});

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
});
