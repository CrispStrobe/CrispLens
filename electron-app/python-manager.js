/**
 * python-manager.js
 *
 * Manages the lifecycle of the Python/Gradio backend process:
 *   1. Locate Python 3.10+ (system-wide or via Python Launcher on Windows)
 *   2. Create / reuse a venv in the user data directory
 *   3. Install pip dependencies (streaming output → caller callback)
 *   4. Copy/seed config.yaml and initialise the SQLite schema on first run
 *   5. Pick a free TCP port
 *   6. Spawn the Python process with FACE_REC_DATA_DIR / FACE_REC_PORT env vars
 *   7. Poll for HTTP readiness and resolve with the port number
 */

'use strict';

const { spawn, execFile } = require('child_process');
const path   = require('path');
const fs     = require('fs');
const net    = require('net');
const http   = require('http');
const os     = require('os');
const { app } = require('electron');

// ─── constants ───────────────────────────────────────────────────────────────

const APP_NAME      = 'FaceRecognitionSystem';
const START_PORT    = 7860;
const READY_TIMEOUT = 300_000;   // 5 minutes — model download can take a while
const POLL_INTERVAL = 2_000;

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Run a command and return { stdout, stderr } or throw on non-zero exit. */
function runCommand(exe, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { ...opts, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

/** Spawn a command, stream stdout/stderr line-by-line, resolve on exit. */
function spawnStreaming(exe, args, opts, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let buffer = '';

    function processChunk(chunk) {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trimEnd();
        buffer = buffer.slice(idx + 1);
        if (line) onLine(line);
      }
    }

    child.stdout.on('data', processChunk);
    child.stderr.on('data', processChunk);
    child.on('close', code => {
      if (buffer.trim()) onLine(buffer.trim());
      if (code === 0) resolve();
      else reject(new Error(`Process exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

/** Find a free TCP port starting from `start`. */
function findFreePort(start = START_PORT) {
  return new Promise((resolve, reject) => {
    let port = start;
    function tryPort() {
      const server = net.createServer();
      server.once('error', () => { port++; if (port > 65535) reject(new Error('No free port')); else tryPort(); });
      server.once('listening', () => { server.close(() => resolve(port)); });
      server.listen(port, '127.0.0.1');
    }
    tryPort();
  });
}

/** Poll http://127.0.0.1:{port} until it returns 200 or times out. */
function waitForServer(port, timeout = READY_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    function poll() {
      if (Date.now() > deadline) return reject(new Error('Timed out waiting for Python server'));
      http.get(`http://127.0.0.1:${port}/`, res => {
        res.resume();
        if (res.statusCode === 200 || res.statusCode === 302) resolve();
        else setTimeout(poll, POLL_INTERVAL);
      }).on('error', () => setTimeout(poll, POLL_INTERVAL));
    }
    poll();
  });
}

// ─── Python detection ────────────────────────────────────────────────────────

/** Common Python install locations on Windows. */
const WINDOWS_PYTHON_PATHS = [
  // Python Launcher (preferred)
  'py',
  'python',
  'python3',
  // Windows Store / MSIX installs (user-level)
  ...['310', '311', '312', '313'].map(v =>
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', `Python${v}`, 'python.exe')
  ),
  // System-level installs
  ...['3.10', '3.11', '3.12', '3.13'].map(v => `C:\\Python${v.replace('.', '')}\\python.exe`),
];

/**
 * Try running `exe --version`, return parsed (major, minor) or null.
 * Handles both "Python 3.11.2" on stdout and on stderr.
 */
async function tryPythonExe(exe) {
  try {
    const { stdout, stderr } = await runCommand(exe, ['--version'], { timeout: 5000 });
    const text = (stdout + stderr).trim();
    const m = text.match(/Python (\d+)\.(\d+)/);
    if (!m) return null;
    return { exe, major: +m[1], minor: +m[2] };
  } catch {
    return null;
  }
}

/**
 * On Windows, `py -3.11 --version` invokes the Python Launcher.
 * Try specific minor versions for better control.
 */
async function tryPyLauncher() {
  for (const minor of [13, 12, 11, 10]) {
    const result = await tryPythonExe('py');
    if (result && (result.major > 3 || (result.major === 3 && result.minor >= 10))) {
      // Launcher found — use it with specific version flag later via venv
      return { exe: 'py', major: result.major, minor: result.minor, launcherFlag: `-3.${minor}` };
    }
  }
  return null;
}

/**
 * Find the best available Python ≥ 3.10.
 * Returns { exe, major, minor, launcherFlag? }
 */
async function findPython() {
  // Try Python Launcher first (Windows-specific, most reliable)
  if (process.platform === 'win32') {
    try {
      const { stdout, stderr } = await runCommand('py', ['--version'], { timeout: 5000 });
      const text = (stdout + stderr).trim();
      const m = text.match(/Python (\d+)\.(\d+)/);
      if (m && (+m[1] > 3 || (+m[1] === 3 && +m[2] >= 10))) {
        return { exe: 'py', major: +m[1], minor: +m[2] };
      }
    } catch { /* not installed */ }
  }

  // Try candidates sequentially
  for (const candidate of WINDOWS_PYTHON_PATHS) {
    if (candidate === 'py') continue; // already tried
    const result = await tryPythonExe(candidate);
    if (result && (result.major > 3 || (result.major === 3 && result.minor >= 10))) {
      return result;
    }
  }

  return null;
}

// ─── PythonManager class ─────────────────────────────────────────────────────

class PythonManager {
  constructor({ onLog, onError } = {}) {
    this.onLog   = onLog   || (() => {});
    this.onError = onError || (() => {});

    this.dataDir  = path.join(app.getPath('appData'), APP_NAME);
    this.venvDir  = path.join(this.dataDir, 'venv');

    // In packaged app, Python source lives in resources/app/
    // In dev mode (electron-app/ is the cwd), source is one level up
    const resourcesApp = path.join(process.resourcesPath || '', 'app');
    this.appSrcDir = fs.existsSync(resourcesApp)
      ? resourcesApp
      : path.join(__dirname, '..');

    this.pythonExe = process.platform === 'win32'
      ? path.join(this.venvDir, 'Scripts', 'python.exe')
      : path.join(this.venvDir, 'bin', 'python');

    this._process = null;
    this._port    = null;
  }

  log(msg)   { this.onLog(msg); }
  error(msg) { this.onError(msg); }

  // ── Step 1: ensure data directory ─────────────────────────────────────────
  ensureDataDir() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.log(`Data directory: ${this.dataDir}`);
  }

  // ── Step 2: seed config.yaml from example if absent ──────────────────────
  ensureConfig() {
    const configDst = path.join(this.dataDir, 'config.yaml');
    if (fs.existsSync(configDst)) return;

    const configSrc = path.join(this.appSrcDir, 'config.example.yaml');
    if (fs.existsSync(configSrc)) {
      fs.copyFileSync(configSrc, configDst);
      this.log('Created config.yaml from example template.');
    } else {
      this.log('No config.example.yaml found — using built-in defaults.');
    }
  }

  // ── Step 3: create venv if missing ───────────────────────────────────────
  async ensureVenv() {
    if (fs.existsSync(this.pythonExe)) {
      this.log('Python virtual environment already exists.');
      return;
    }

    this.log('Locating Python 3.10+ on this system…');
    const py = await findPython();
    if (!py) {
      throw new Error(
        'Python 3.10 or later not found.\n\n' +
        'Please install Python 3.10+ from https://www.python.org/downloads/ ' +
        '(make sure to tick "Add Python to PATH") and relaunch the app.'
      );
    }
    this.log(`Found Python ${py.major}.${py.minor} at: ${py.exe}`);
    this.log('Creating virtual environment…');

    const venvArgs = py.exe === 'py'
      ? ['-m', 'venv', this.venvDir]
      : ['-m', 'venv', this.venvDir];
    const venvExe  = py.exe === 'py' ? 'py' : py.exe;

    await spawnStreaming(venvExe, venvArgs, {}, line => this.log(line));
    this.log('Virtual environment created.');
  }

  // ── Step 4: pip install ───────────────────────────────────────────────────
  async installDeps() {
    const reqFile   = path.join(this.appSrcDir, 'requirements.txt');
    const pipExe    = process.platform === 'win32'
      ? path.join(this.venvDir, 'Scripts', 'pip.exe')
      : path.join(this.venvDir, 'bin', 'pip');
    const stampFile = path.join(this.venvDir, '.deps_installed');

    // Check if deps are already installed (stamp file exists and req.txt hasn't changed)
    if (fs.existsSync(stampFile) && fs.existsSync(reqFile)) {
      const stamp   = fs.statSync(stampFile).mtimeMs;
      const reqMtime = fs.statSync(reqFile).mtimeMs;
      if (stamp >= reqMtime) {
        this.log('Dependencies already installed.');
        return;
      }
    }

    this.log('Installing Python dependencies (this may take several minutes)…');
    this.log('Packages: insightface, onnxruntime, faiss-cpu, gradio, opencv, …');

    const args = ['install', '--upgrade', '-r', reqFile];
    await spawnStreaming(pipExe, args, {}, line => this.log(line));

    fs.writeFileSync(stampFile, Date.now().toString());
    this.log('Dependencies installed successfully.');
  }

  // ── Step 5: initialise database schema if needed ─────────────────────────
  async ensureDatabase() {
    const dbPath     = path.join(this.dataDir, 'face_recognition.db');
    const schemaPath = path.join(this.appSrcDir, 'schema_complete.sql');

    if (fs.existsSync(dbPath)) return;

    if (!fs.existsSync(schemaPath)) {
      this.log('Warning: schema_complete.sql not found — database will be initialised by the app.');
      return;
    }

    this.log('Initialising database schema…');
    const schema = fs.readFileSync(schemaPath, 'utf8');

    // Use Python's sqlite3 module (guaranteed to be available in venv)
    const initScript = `
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.executescript(open(sys.argv[2]).read())
db.close()
print("Database initialised.")
`;
    const tmpScript = path.join(os.tmpdir(), 'face_rec_init_db.py');
    fs.writeFileSync(tmpScript, initScript);

    await spawnStreaming(
      this.pythonExe,
      [tmpScript, dbPath, schemaPath],
      {},
      line => this.log(line)
    );
    this.log('Database ready.');
  }

  // ── Step 6: pick a free port ──────────────────────────────────────────────
  async pickPort() {
    const port = await findFreePort(START_PORT);
    this._port = port;
    this.log(`Using port ${port}`);
    return port;
  }

  // ── Step 7: spawn Python backend ─────────────────────────────────────────
  spawnPython(port) {
    const mainScript = path.join(this.appSrcDir, 'face_rec_ui.py');
    const env = {
      ...process.env,
      FACE_REC_DATA_DIR: this.dataDir,
      FACE_REC_PORT:     String(port),
      // Prevent InsightFace models from landing in cwd
      INSIGHTFACE_HOME:  path.join(this.dataDir, 'insightface'),
      // No interactive prompts
      PYTHONUNBUFFERED:  '1',
    };

    this.log(`Starting Python backend (face_rec_ui.py)…`);

    this._process = spawn(this.pythonExe, [mainScript], {
      cwd: this.appSrcDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this._process.stdout.on('data', d => d.toString().split('\n').forEach(l => { if (l.trim()) this.log(l); }));
    this._process.stderr.on('data', d => d.toString().split('\n').forEach(l => { if (l.trim()) this.log(l); }));

    this._process.on('exit', (code, signal) => {
      this.log(`Python process exited (code=${code}, signal=${signal})`);
    });

    this._process.on('error', err => {
      this.error(`Failed to start Python: ${err.message}`);
    });
  }

  // ── Main entry: orchestrate all steps ────────────────────────────────────
  async start() {
    this.ensureDataDir();
    this.ensureConfig();
    await this.ensureVenv();
    await this.installDeps();
    await this.ensureDatabase();
    const port = await this.pickPort();
    this.spawnPython(port);

    this.log('Waiting for the web interface to become ready…');
    this.log('(First launch may take a few minutes while models download.)');

    await waitForServer(port, READY_TIMEOUT);
    this.log('Ready!');
    return port;
  }

  // ── Clean up ─────────────────────────────────────────────────────────────
  stop() {
    if (this._process) {
      try { this._process.kill(); } catch { /* ignore */ }
      this._process = null;
    }
  }
}

module.exports = { PythonManager };
