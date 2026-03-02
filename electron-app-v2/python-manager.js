/**
 * python-manager.js (v2)
 *
 * Same as electron-app/python-manager.js but targets fastapi_app.py
 * instead of face_rec_ui.py.
 *
 * The only substantive change is the MAIN_SCRIPT constant and the
 * ready-check URL (FastAPI returns 200 on /, Gradio returns 200 too,
 * so the HTTP poll logic is unchanged).
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

const APP_NAME      = 'CrispLens';
const MAIN_SCRIPT   = 'fastapi_app.py';   // ← only change vs electron-app/
const START_PORT    = parseInt(process.env.FACE_REC_PORT || '7865', 10);
const READY_TIMEOUT = 300_000; // 5 minutes of inactivity
const POLL_INTERVAL = 2_000;

// ─── helpers ─────────────────────────────────────────────────────────────────

function runCommand(exe, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { ...opts, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

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

/**
 * Wait for the server to become ready.
 * @param {number} port 
 * @param {number} baseTimeout Max time to wait without ANY activity/progress
 * @param {Function} getActivity Optional function returning timestamp of last activity
 */
function waitForServer(port, baseTimeout = READY_TIMEOUT, getActivity = null) {
  return new Promise((resolve, reject) => {
    let lastActivity = getActivity ? getActivity() : Date.now();

    function poll() {
      if (getActivity) {
        const currentActivity = getActivity();
        if (currentActivity > lastActivity) {
          lastActivity = currentActivity;
        }
      }

      if (Date.now() - lastActivity > baseTimeout) {
        return reject(new Error(
          `Backend startup timed out after ${Math.round(baseTimeout/1000)}s of inactivity.\n` +
          'Check the logs for errors during model download or initialization.'
        ));
      }

      // Poll /api/health — always returns 200 JSON, never intercepted by static files
      const req = http.get(`http://127.0.0.1:${port}/api/health`, res => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else setTimeout(poll, POLL_INTERVAL);
      });
      
      req.on('error', () => setTimeout(poll, POLL_INTERVAL));
      req.setTimeout(POLL_INTERVAL); // Don't let the request itself hang
    }
    poll();
  });
}

// ─── Python detection ────────────────────────────────────────────────────────

const WINDOWS_PYTHON_PATHS = [
  'py', 'python', 'python3',
  ...['310', '311', '312', '313'].map(v =>
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', `Python${v}`, 'python.exe')
  ),
  ...['3.10', '3.11', '3.12', '3.13'].map(v => `C:\\Python${v.replace('.', '')}\\python.exe`),
];

const UNIX_PYTHON_PATHS = [
  'python3', 'python3.12', 'python3.11', 'python3.10', 'python',
  '/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3'
];

async function tryPythonExe(exe) {
  try {
    const { stdout, stderr } = await runCommand(exe, ['--version'], { timeout: 5000 });
    const text = (stdout + stderr).trim();
    const m = text.match(/Python (\d+)\.(\d+)/);
    if (!m) return null;
    return { exe, major: +m[1], minor: +m[2] };
  } catch { return null; }
}

async function findPython() {
  const candidates = process.platform === 'win32' ? WINDOWS_PYTHON_PATHS : UNIX_PYTHON_PATHS;
  
  if (process.platform === 'win32') {
    try {
      const { stdout, stderr } = await runCommand('py', ['--version'], { timeout: 5000 });
      const text = (stdout + stderr).trim();
      const m = text.match(/Python (\d+)\.(\d+)/);
      if (m && (+m[1] > 3 || (+m[1] === 3 && +m[2] >= 10))) return { exe: 'py', major: +m[1], minor: +m[2] };
    } catch { /* not installed */ }
  }

  for (const candidate of candidates) {
    if (candidate === 'py') continue;
    const result = await tryPythonExe(candidate);
    if (result && (result.major > 3 || (result.major === 3 && result.minor >= 10))) return result;
  }
  return null;
}

// ─── PythonManager class ─────────────────────────────────────────────────────

class PythonManager {
  constructor({ onLog, onError, config = {} } = {}) {
    this.onLog   = onLog   || (() => {});
    this.onError = onError || (() => {});

    // Data directory: use wizard-configured path or app default
    this.dataDir = (config.dataDir && config.dataDir.trim())
      ? config.dataDir.trim()
      : path.join(app.getPath('appData'), APP_NAME);
    this.venvDir  = path.join(this.dataDir, 'venv');

    // Extended config from wizard
    this.dbPathConfig     = config.dbPath      || null;
    this.reuseExistingDb  = config.reuseExistingDb || false;
    this.adminUser        = config.adminUser    || '';
    this.adminPass        = config.adminPass    || '';  // only in memory, never written to disk
    this.workers          = config.workers      || 1;
    this.pythonPathConfig = config.pythonPath   || null; // override base Python for venv creation
    this._configPort      = config.port ? parseInt(config.port, 10) : null;

    // app.isPackaged is true only in a built DMG/installer — safe way to detect
    const resourcesApp = path.join(process.resourcesPath || '', 'app');
    this.appSrcDir = (app.isPackaged && fs.existsSync(resourcesApp))
      ? resourcesApp
      : path.join(__dirname, '..');

    this.pythonExe = process.platform === 'win32'
      ? path.join(this.venvDir, 'Scripts', 'python.exe')
      : path.join(this.venvDir, 'bin', 'python');

    this._process = null;
    this._port    = null;
    this.lastActivity = Date.now();
  }

  log(msg)   { 
    this.lastActivity = Date.now();
    this.onLog(msg); 
  }
  error(msg) { 
    this.lastActivity = Date.now();
    this.onError(msg); 
  }

  ensureDataDir() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.log(`Data directory: ${this.dataDir}`);
  }

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

  async ensureVenv() {
    if (fs.existsSync(this.pythonExe)) {
      this.log('Python virtual environment already exists.');
      return;
    }
    let py;
    if (this.pythonPathConfig && this.pythonPathConfig.trim()) {
      this.log(`Using configured Python: ${this.pythonPathConfig}`);
      py = { exe: this.pythonPathConfig.trim(), major: 3, minor: 10 };
    } else {
      this.log('Locating Python 3.10+ on this system…');
      py = await findPython();
    }
    if (!py) {
      throw new Error(
        'Python 3.10 or later not found.\n\n' +
        'Please install Python 3.10+ from https://www.python.org/downloads/ and relaunch.\n' +
        'Or configure the Python path in Settings → Server Configuration.'
      );
    }
    this.log(`Found Python ${py.major}.${py.minor} at: ${py.exe}`);
    this.log('Creating virtual environment…');
    try {
      // --without-pip can be faster if we use ensurepip later, but default is usually fine.
      // We use the basic command and diagnose failures.
      await spawnStreaming(py.exe, ['-m', 'venv', this.venvDir], {}, line => this.log(line));
      this.log('Virtual environment created.');
    } catch (err) {
      this.error(`Failed to create virtual environment: ${err.message}`);
      if (process.platform !== 'win32') {
        this.log('Hint: On Linux, you might need to install the venv module: sudo apt install python3-venv');
      }
      throw err;
    }
  }

  async ensurePip() {
    this.log('Ensuring pip is available in virtual environment…');
    try {
      // Check if pip is already there
      await runCommand(this.pythonExe, ['-m', 'pip', '--version'], { timeout: 10000 });
    } catch (err) {
      this.log('pip not found in venv, attempting to bootstrap with ensurepip…');
      try {
        await spawnStreaming(this.pythonExe, ['-m', 'ensurepip', '--upgrade'], {}, line => this.log(line));
      } catch (e2) {
        this.error(`Failed to bootstrap pip: ${e2.message}`);
        this.log('Hint: Try installing pip manually in the system Python first.');
        throw e2;
      }
    }
  }

  async installDeps() {
    const reqFile   = path.join(this.appSrcDir, 'requirements.txt');
    const pipExe    = process.platform === 'win32'
      ? path.join(this.venvDir, 'Scripts', 'pip.exe')
      : path.join(this.venvDir, 'bin', 'pip');
    const stampFile = path.join(this.venvDir, '.deps_installed');

    if (fs.existsSync(stampFile) && fs.existsSync(reqFile)) {
      const stamp    = fs.statSync(stampFile).mtimeMs;
      const reqMtime = fs.statSync(reqFile).mtimeMs;
      if (stamp >= reqMtime) { this.log('Dependencies already installed.'); return; }
    }

    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.log(`Installing Python dependencies (attempt ${attempt}/${maxRetries}, this may take several minutes)…`);
        // Using --prefer-binary to avoid slow/failing local compilations on systems without build tools
        await spawnStreaming(pipExe, ['install', '--upgrade', '--prefer-binary', '-r', reqFile], {}, line => this.log(line));
        fs.writeFileSync(stampFile, Date.now().toString());
        this.log('Dependencies installed successfully.');
        return;
      } catch (err) {
        this.error(`Dependency installation failed (attempt ${attempt}): ${err.message}`);
        if (attempt === maxRetries) {
          this.log('Installation failed after multiple attempts. Please check your internet connection.');
          throw err;
        }
        this.log('Retrying in 5 seconds...');
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  async ensureDatabase() {
    if (this.reuseExistingDb) {
      this.log('Reusing existing database (schema init skipped).');
      return;
    }
    const dbPath = this.dbPathConfig && path.isAbsolute(this.dbPathConfig)
      ? this.dbPathConfig
      : path.join(this.dataDir, this.dbPathConfig || 'face_recognition.db');
    const schemaPath = path.join(this.appSrcDir, 'schema_complete.sql');
    if (fs.existsSync(dbPath)) return;
    if (!fs.existsSync(schemaPath)) {
      this.log('Warning: schema_complete.sql not found — database will be initialised by the app.');
      return;
    }
    this.log('Initialising database schema…');
    const initScript = `
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.executescript(open(sys.argv[2]).read())
db.close()
print("Database initialised.")
`;
    const tmpScript = path.join(os.tmpdir(), 'face_rec_v2_init_db.py');
    fs.writeFileSync(tmpScript, initScript);
    await spawnStreaming(this.pythonExe, [tmpScript, dbPath, schemaPath], {}, line => this.log(line));
    this.log('Database ready.');
  }

  async pickPort() {
    const port = await findFreePort(this._configPort || START_PORT);
    this._port = port;
    this.log(`Using port ${port}`);
    return port;
  }

  spawnPython(port) {
    const mainScript = path.join(this.appSrcDir, MAIN_SCRIPT);

    // Resolve DB path (absolute or relative to dataDir)
    const dbAbsPath = this.dbPathConfig
      ? (path.isAbsolute(this.dbPathConfig)
          ? this.dbPathConfig
          : path.join(this.dataDir, this.dbPathConfig))
      : null;

    const env = {
      ...process.env,
      FACE_REC_DATA_DIR:  this.dataDir,
      FACE_REC_PORT:      String(port),
      FACE_REC_WORKERS:   String(this.workers),
      FACE_REC_LOG_LEVEL: 'DEBUG',
      INSIGHTFACE_HOME:   path.join(this.dataDir, 'insightface'),
      PYTHONUNBUFFERED:   '1',
      ...(dbAbsPath            ? { FACE_REC_DB_PATH:   dbAbsPath        } : {}),
      ...(this.adminUser       ? { CRISP_ADMIN_USER:   this.adminUser   } : {}),
      ...(this.adminPass       ? { CRISP_ADMIN_PASS:   this.adminPass   } : {}),
    };

    this.log(`Starting Python backend (${MAIN_SCRIPT})…`);

    this._process = spawn(this.pythonExe, [mainScript], {
      cwd: this.appSrcDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this._process.stdout.on('data', d => d.toString().split('\n').forEach(l => { if (l.trim()) this.log(l); }));
    this._process.stderr.on('data', d => d.toString().split('\n').forEach(l => { if (l.trim()) this.log(l); }));
    this._process.on('exit', (code, signal) => { this.log(`Python process exited (code=${code}, signal=${signal})`); });
    this._process.on('error', err => { this.error(`Failed to start Python: ${err.message}`); });
  }

  async start() {
    this.ensureDataDir();
    this.ensureConfig();
    await this.ensureVenv();
    await this.ensurePip();
    await this.installDeps();
    await this.ensureDatabase();
    const port = await this.pickPort();
    this.spawnPython(port);

    this.log('Waiting for the API server to become ready…');
    this.log('(First launch may take a few minutes while models download.)');
    
    // Use dynamic timeout based on activity (logs)
    await waitForServer(port, READY_TIMEOUT, () => this.lastActivity);
    
    this.log('Ready!');
    return port;
  }

  stop() {
    if (this._process) {
      try { this._process.kill(); } catch { /* ignore */ }
      this._process = null;
    }
  }
}

module.exports = { PythonManager };
