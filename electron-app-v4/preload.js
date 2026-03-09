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
  getPort:      () => ipcRenderer.invoke('get-port'),
  getSettings:  () => ipcRenderer.invoke('get-settings'),
  saveSettings: (data) => ipcRenderer.invoke('save-settings', data),

  // ── Database ─────────────────────────────────────────────────────────────────
  getActiveDb:       ()       => ipcRenderer.invoke('get-active-db'),
  switchDb:          (dbPath) => ipcRenderer.invoke('switch-db', dbPath),
  resetDbToDefault:  ()       => ipcRenderer.invoke('reset-db-to-default'),
  createNewDb:       (dbPath) => ipcRenderer.invoke('create-new-db', dbPath),

  // ── App lifecycle ────────────────────────────────────────────────────────────
  relaunchApp:   () => ipcRenderer.invoke('relaunch-app'),
  setRemoteUrl:  (url) => ipcRenderer.invoke('set-remote-url', url),

  // ── Native dialogs ───────────────────────────────────────────────────────────
  openFileDialog:   (opts) => ipcRenderer.invoke('open-file-dialog', opts),
  openFolderDialog: (opts) => ipcRenderer.invoke('open-folder-dialog', opts),
  saveFileDialog:   (opts) => ipcRenderer.invoke('save-file-dialog', opts),

  // ── Local file I/O ───────────────────────────────────────────────────────────
  readLocalFile: (filePath) => ipcRenderer.invoke('read-local-file', filePath),
  readLocalDir:  (dirPath)  => ipcRenderer.invoke('read-local-dir', dirPath),

  // ── OS Trash (for duplicate cleanup) ─────────────────────────────────────────
  trashItems: (paths) => ipcRenderer.invoke('trash-items', paths),

  // ── Logs ─────────────────────────────────────────────────────────────────────
  getLogFile:  () => ipcRenderer.invoke('get-log-file'),
  showLogFile: () => ipcRenderer.invoke('show-log-file'),

  // ── Generic IPC ─────────────────────────────────────────────────────────────
  on:   (channel, cb) => ipcRenderer.on(channel, (_e, ...args) => cb(...args)),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
});
