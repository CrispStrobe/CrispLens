'use strict';

/**
 * preload.js — Electron preload for CrispLens v4
 *
 * Exposes safe IPC bridges to the renderer (Svelte app).
 * Everything here is synchronously available as window.electronAPI.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── App info ────────────────────────────────────────────────────────────────
  getPort:     () => ipcRenderer.invoke('get-port'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (data) => ipcRenderer.invoke('save-settings', data),

  // ── App lifecycle ────────────────────────────────────────────────────────────
  relaunchApp:   () => ipcRenderer.invoke('relaunch-app'),
  switchDb:      (dbPath) => ipcRenderer.invoke('switch-db', dbPath),
  setRemoteUrl:  (url)    => ipcRenderer.invoke('set-remote-url', url),

  // ── Native dialogs ───────────────────────────────────────────────────────────
  openFileDialog:   (opts) => ipcRenderer.invoke('open-file-dialog', opts),
  openFolderDialog: (opts) => ipcRenderer.invoke('open-folder-dialog', opts),

  // ── Local file I/O ───────────────────────────────────────────────────────────
  readLocalFile: (filePath) => ipcRenderer.invoke('read-local-file', filePath),
  readLocalDir:  (dirPath)  => ipcRenderer.invoke('read-local-dir', dirPath),

  // ── OS Trash (for duplicate cleanup) ─────────────────────────────────────────
  trashItems: (paths) => ipcRenderer.invoke('trash-items', paths),

  // ── Generic IPC ─────────────────────────────────────────────────────────────
  on:   (channel, cb) => ipcRenderer.on(channel, (_e, ...args) => cb(...args)),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
});
