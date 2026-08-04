/**
 * EDK2 Knowledge Base Daemon Manager
 *
 * Manages the shared HTTP MCP daemon (edk2-kb):
 *   - Ensures a single healthy daemon is running (auto-start, auto-heal)
 *   - Discovers the dynamic endpoint from daemon.json
 *   - start / stop / status lifecycle
 *   - Direct search convenience for the CLI
 *
 * Multiple OpenCode instances share the same daemon via the persisted
 * endpoint, so there are no fixed ports and no duplicated servers.
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const PACKAGE_ROOT = path.dirname(__dirname);
const DEFAULT_KB_DIR = path.join(PACKAGE_ROOT, 'edk2-kb');

const USER_KB_DIR = path.join(os.homedir(), '.edk2-opencode', 'kb');

function getKbDir() {
  return fs.existsSync(USER_KB_DIR) ? USER_KB_DIR : DEFAULT_KB_DIR;
}

function getVenvPython(kbDir) {
  const venvDir = path.join(kbDir, 'venv');
  if (process.platform === 'win32') {
    const p = path.join(venvDir, 'Scripts', 'python.exe');
    if (fs.existsSync(p)) return p;
  } else {
    const p = path.join(venvDir, 'bin', 'python');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function getPythonCommand() {
  const commands = process.platform === 'win32'
    ? ['python', 'py', 'python3']
    : ['python3', 'python'];
  for (const cmd of commands) {
    try {
      execSync(`${cmd} --version`, { stdio: 'ignore' });
      return cmd;
    } catch {}
  }
  return null;
}

function resolvePython(kbDir) {
  return getVenvPython(kbDir) || getPythonCommand();
}

function stateFile(kbDir) {
  return path.join(kbDir, 'daemon.json');
}

function pidFile(kbDir) {
  return path.join(kbDir, 'daemon.pid');
}

function stopFlagFile(kbDir) {
  return path.join(kbDir, 'daemon.stop');
}

function lockFile(kbDir) {
  return path.join(kbDir, 'daemon.lock');
}

function logFile(kbDir) {
  return path.join(kbDir, 'logs', 'mcp-supervisor.log');
}

function serverScript() {
  return path.join(PACKAGE_ROOT, 'edk2-kb', 'mcp_server.py');
}

function runnerScript() {
  return path.join(PACKAGE_ROOT, 'edk2-kb', 'daemon_runner.py');
}

function readState(kbDir) {
  const file = stateFile(kbDir);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function removeStale(kbDir) {
  for (const f of [stateFile(kbDir), pidFile(kbDir), stopFlagFile(kbDir), lockFile(kbDir)]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {}
  }
}

function httpGetJson(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(data); } catch {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode, body });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, statusCode: 0, body: null, error: 'timeout' }); });
    req.on('error', (err) => { resolve({ ok: false, statusCode: 0, body: null, error: err.message }); });
  });
}

function httpPostJson(url, payload, timeoutMs) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request(url, {
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, statusCode: 0, body: null, error: 'timeout' }); });
    req.on('error', (err) => { resolve({ ok: false, statusCode: 0, body: null, error: err.message }); });
    req.end(body);
  });
}

async function checkHealth(url, timeoutMs = 2000) {
  return httpGetJson(`${url}/health`, timeoutMs);
}

async function isHealthy(url, timeoutMs = 2000) {
  const res = await checkHealth(url, timeoutMs);
  return res.ok;
}

function spawnDetached(cmd, args, cwd, env) {
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...(env || {}) },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

async function startDaemon(kbDir, { waitMs = 60000 } = {}) {
  const python = resolvePython(kbDir);
  if (!python) throw new Error('Python not found. Install Python 3.8+.');

  // If an existing daemon is already healthy, reuse it.
  const existing = readState(kbDir);
  if (existing && existing.url && await isHealthy(existing.url)) {
    return existing;
  }

  // Kill any stale watchdog, then clean up stale state files.
  const stalePid = existing && existing.watchdog_pid;
  if (stalePid && !(existing.url && await isHealthy(existing.url))) {
    try { killPidTree(stalePid); } catch {}
  }
  removeStale(kbDir);

  const args = [
    runnerScript(),
    '--state-file', stateFile(kbDir),
    '--server-script', serverScript(),
    '--pid-file', pidFile(kbDir),
    '--log-file', logFile(kbDir),
    '--stop-flag', stopFlagFile(kbDir),
    '--lock-file', lockFile(kbDir),
    '--data-dir', kbDir,
  ];
  spawnDetached(python, args, kbDir, { PYTHONIOENCODING: 'utf-8' });

  const deadline = Date.now() + waitMs;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = readState(kbDir);
    if (lastState && lastState.url) {
      const health = await checkHealth(lastState.url);
      if (health.ok) {
        return { ...lastState, ready: !!(health.body && health.body.ready) };
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(
    `Knowledge base daemon failed to start within ${waitMs / 1000}s. ` +
    `Check logs: ${logFile(kbDir)}`);
}

async function stopDaemon(kbDir, { waitMs = 15000 } = {}) {
  const existing = readState(kbDir);

  // Graceful: write the stop flag so the watchdog shuts the server down.
  try {
    fs.writeFileSync(stopFlagFile(kbDir), 'stop', 'utf-8');
  } catch {}

  const watchdogPid = existing && existing.watchdog_pid;
  const deadline = Date.now() + waitMs;

  // Wait for the daemon to disappear.
  while (Date.now() < deadline) {
    const st = readState(kbDir);
    if (!st || !st.url || !(await isHealthy(st.url))) {
      removeStale(kbDir);
      return true;
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  // Fallback: force kill the process tree.
  if (watchdogPid) {
    try { killPidTree(watchdogPid); } catch {}
  }
  removeStale(kbDir);
  return false;
}

function killPidTree(pid) {
  const cmd = process.platform === 'win32'
    ? `taskkill /PID ${pid} /T /F`
    : `kill -9 -${pid}`;
  execSync(cmd, { stdio: 'ignore' });
}

async function status(kbDir) {
  const existing = readState(kbDir);
  if (!existing || !existing.url) {
    return { running: false, message: 'Daemon not running' };
  }
  const health = await checkHealth(existing.url);
  if (!health.ok) {
    return {
      running: false,
      message: `Daemon endpoint ${existing.url} is not responding`,
      state: existing,
    };
  }
  return {
    running: true,
    ready: !!(health.body && health.body.ready),
    url: existing.url,
    port: existing.port,
    pid: existing.pid,
    watchdog_pid: existing.watchdog_pid,
    started_at: existing.started_at,
    version: existing.version,
    health: health.body,
  };
}

async function ensureRunning(kbDir) {
  const existing = readState(kbDir);
  if (existing && existing.url && await isHealthy(existing.url)) {
    return existing;
  }
  return startDaemon(kbDir);
}

async function search(query, topK = 5, source = 'all') {
  const kbDir = getKbDir();
  const state = await ensureRunning(kbDir);
  const res = await httpPostJson(
    `${state.url}/search`, { query, top_k: topK, source }, 120000);
  if (!res.ok) {
    throw new Error(`Search request failed (HTTP ${res.statusCode}): ${res.body && res.body.error || res.error || 'unknown error'}`);
  }
  return res.body;
}

module.exports = {
  getKbDir,
  getVenvPython,
  getPythonCommand,
  resolvePython,
  readState,
  startDaemon,
  stopDaemon,
  status,
  ensureRunning,
  search,
  isHealthy,
  stateFile,
  pidFile,
  lockFile,
  logFile,
  serverScript,
  runnerScript,
};
