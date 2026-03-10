/**
 * ConsoleCapture.js — ring-buffer console capture for standalone/local mode.
 * Install once at app startup; ServerLogsModal reads capturedLines[] in local mode.
 */

const MAX_LINES = 1000;

export const capturedLines = [];
let installed = false;

export function installConsoleCapture() {
  if (installed) return;
  installed = true;

  const _levels = { log: 'LOG', warn: 'WARN', error: 'ERROR', info: 'INFO', debug: 'DEBUG' };
  for (const [method, tag] of Object.entries(_levels)) {
    const orig = console[method].bind(console);
    console[method] = (...args) => {
      orig(...args);
      const msg = args.map(a => {
        try {
          return typeof a === 'object' ? JSON.stringify(a) : String(a);
        } catch {
          return String(a);
        }
      }).join(' ');
      const ts = new Date().toISOString().replace('T', ' ').slice(0, 23);
      capturedLines.push(`[${ts}] ${tag}: ${msg}`);
      if (capturedLines.length > MAX_LINES) capturedLines.splice(0, capturedLines.length - MAX_LINES);
    };
  }
}

export function getCapturedLines(count = 200) {
  return capturedLines.slice(-count);
}
