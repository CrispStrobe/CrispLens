'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Setup log stream (loading window) ───────────────────────────────────
  onSetupLog:    (cb) => ipcRenderer.on('setup-log',    (_e, msg)  => cb(msg)),
  onSetupError:  (cb) => ipcRenderer.on('setup-error',  (_e, msg)  => cb(msg)),
  onSetupDone:   (cb) => ipcRenderer.on('setup-done',   (_e, port) => cb(port)),
  onSetupDetail: (cb) => ipcRenderer.on('setup-detail', (_e, msg)  => cb(msg)),

  // ── Mode chooser ────────────────────────────────────────────────────────
  on:   (channel, cb) => ipcRenderer.on(channel, (_e, ...args) => cb(...args)),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  saveSettings: (data) => ipcRenderer.invoke('save-settings', data),
  getSettings:  () => ipcRenderer.invoke('get-settings'),

  // ── Native file dialogs ─────────────────────────────────────────────────
  openFileDialog:   (opts) => ipcRenderer.invoke('open-file-dialog',   opts),
  openFolderDialog: (opts) => ipcRenderer.invoke('open-folder-dialog', opts),

  // ── App info ────────────────────────────────────────────────────────────
  getPort: () => ipcRenderer.invoke('get-port'),

  // ── Local model management ───────────────────────────────────────────────
  checkLocalModels: () =>
    ipcRenderer.invoke('check-local-models'),
  downloadModel: (modelName, pythonPath) =>
    ipcRenderer.invoke('download-model', { modelName, pythonPath }),
  testPython: (pythonPath) =>
    ipcRenderer.invoke('test-python', pythonPath),
  onDownloadProgress: (cb) =>
    ipcRenderer.on('download-progress', (_e, d) => cb(d)),

  // ── Local image processing (mode C) ─────────────────────────────────────
  processImagesLocally: (paths, model, pythonPath) =>
    ipcRenderer.invoke('process-images-locally', { paths, model, pythonPath }),
  onLocalProcessResult: (cb) => {
    const handler = (_e, d) => cb(d);
    ipcRenderer.on('local-process-result', handler);
    return () => ipcRenderer.removeListener('local-process-result', handler);
  },

  // ── Read local file bytes for upload-full mode (mode B) ─────────────────
  readLocalFile: (filePath) =>
    ipcRenderer.invoke('read-local-file', filePath),

  // ── Browse local filesystem for FilesystemView ───────────────────────────
  readLocalDir: (dirPath) =>
    ipcRenderer.invoke('read-local-dir', dirPath),

  // ── Setup wizard helpers ─────────────────────────────────────────────────
  detectPython:       ()  => ipcRenderer.invoke('detect-python'),
  getDefaultDataDir:  ()  => ipcRenderer.invoke('get-default-data-dir'),

  // ── App lifecycle ────────────────────────────────────────────────────────
  relaunchApp: () => ipcRenderer.invoke('relaunch-app'),
  switchDb:    (dbPath) => ipcRenderer.invoke('switch-db', dbPath),
});
