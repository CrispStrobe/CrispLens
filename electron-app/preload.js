'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Setup log stream (splash window) ───────────────────────────────────
  onSetupLog:   (cb) => ipcRenderer.on('setup-log',   (_e, msg)  => cb(msg)),
  onSetupError: (cb) => ipcRenderer.on('setup-error', (_e, msg)  => cb(msg)),
  onSetupDone:  (cb) => ipcRenderer.on('setup-done',  (_e, port) => cb(port)),

  // ── First-run mode chooser ──────────────────────────────────────────────
  // Show mode chooser when main process requests it
  onShowModeChooser: (cb) => ipcRenderer.on('show-mode-chooser', (_e) => cb()),

  // Renderer tells main which mode the user chose
  sendModeChoice: (choice) => ipcRenderer.send('mode-chosen', choice),
  // { mode: 'local' } or { mode: 'remote', remoteUrl: 'http://...' }

  // ── Persistent settings ─────────────────────────────────────────────────
  getSettings:  ()       => ipcRenderer.invoke('get-settings'),
  saveSettings: (data)   => ipcRenderer.invoke('save-settings', data),
  resetSettings: ()      => ipcRenderer.invoke('reset-settings'),
});
