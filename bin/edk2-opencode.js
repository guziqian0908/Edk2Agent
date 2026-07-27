#!/usr/bin/env node

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PACKAGE_ROOT = path.dirname(__dirname);
const OPENCODE_BIN = path.join(PACKAGE_ROOT, 'node_modules', '@opencode-ai', 'opencode', 'bin', 'opencode');

function checkPython() {
  try {
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    execSync(`${pythonCmd} --version`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function checkOpenCode() {
  return fs.existsSync(OPENCODE_BIN);
}

function showWelcome() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║         EDK2-OpenCode - EDK2 Development Assistant          ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  const pkg = require('../package.json');
  console.log('║  Version: ' + pkg.version.padEnd(46) + '║');
  console.log('║  Skills:  edk2-pr-workflow, ovmf-build                        ║');
  console.log('║  MCP:     edk2-rag (RAG knowledge base)                       ║');
  console.log('║  API:     Built-in GLM-5 fallback                             ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Quick Start:');
  console.log('  1. Login:     edk2-opencode login <username> <token>');
  console.log('  2. Check:     edk2-opencode status');
  console.log('  3. Start:     edk2-opencode');
  console.log('');
}

function ensureConfig() {
  const configDir = path.join(os.homedir(), '.config', 'opencode');
  const loginFile = path.join(configDir, '.edk2_login');
  
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  
  return { configDir, loginFile };
}

function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    showWelcome();
    console.log('Usage:');
    console.log('  edk2-opencode                    Start OpenCode');
    console.log('  edk2-opencode login <user> <tok> Login with credentials');
    console.log('  edk2-opencode logout             Logout and clear cache');
    console.log('  edk2-opencode status             Show login status');
    console.log('  edk2-opencode --init             Initialize RAG service');
    console.log('  edk2-opencode --update-kb        Update knowledge base');
    console.log('');
    process.exit(0);
  }
  
  if (args.includes('--version') || args.includes('-v')) {
    const pkg = require('../package.json');
    console.log(`edk2-opencode v${pkg.version}`);
    process.exit(0);
  }
  
  if (!checkPython()) {
    console.error('[ERROR] Python 3.8+ is required for RAG service.');
    console.error('Please install Python: https://www.python.org/downloads/');
    process.exit(1);
  }
  
  ensureConfig();
  
  if (args[0] === 'login') {
    handleLogin(args);
    return;
  }
  
  if (args[0] === 'logout') {
    handleLogout();
    return;
  }
  
  if (args[0] === 'status') {
    handleStatus();
    return;
  }
  
  if (args.includes('--init')) {
    handleInit();
    return;
  }
  
  if (args.includes('--update-kb')) {
    handleUpdateKB();
    return;
  }
  
  showWelcome();
  
  const env = {
    ...process.env,
    OPENCODE_CONFIG: path.join(PACKAGE_ROOT, 'opencode.json'),
    EDK2_PACKAGE_ROOT: PACKAGE_ROOT
  };
  
  const opencodeArgs = ['--config', path.join(PACKAGE_ROOT, 'opencode.json')];
  
  const child = spawn('npx', ['opencode-ai', ...opencodeArgs], {
    cwd: PACKAGE_ROOT,
    env,
    stdio: 'inherit',
    shell: true
  });
  
  child.on('error', (err) => {
    console.error('[ERROR] Failed to start OpenCode:', err.message);
    process.exit(1);
  });
  
  child.on('exit', (code) => {
    process.exit(code || 0);
  });
}

function handleLogin(args) {
  const username = args[1];
  const token = args[2];
  
  if (!username || !token) {
    console.error('[ERROR] Usage: edk2-opencode login <username> <token>');
    process.exit(1);
  }
  
  const { loginFile } = ensureConfig();
  const loginData = {
    isLoggedIn: true,
    username,
    token,
    loginTime: Date.now(),
    expiresAt: Date.now() + (24 * 60 * 60 * 1000)
  };
  
  fs.writeFileSync(loginFile, JSON.stringify(loginData, null, 2));
  console.log(`[SUCCESS] Logged in as ${username}`);
  console.log('[INFO] Session valid for 24 hours');
}

function handleLogout() {
  const { loginFile } = ensureConfig();
  const cacheDir = path.join(os.homedir(), '.config', 'opencode', 'edk2-cache');
  
  if (fs.existsSync(loginFile)) {
    fs.unlinkSync(loginFile);
    console.log('[SUCCESS] Logged out');
  }
  
  if (fs.existsSync(cacheDir)) {
    fs.rmSync(cacheDir, { recursive: true });
    console.log('[SUCCESS] Cache cleared');
  }
}

function handleStatus() {
  const { loginFile } = ensureConfig();
  
  if (!fs.existsSync(loginFile)) {
    console.log('[STATUS] Not logged in');
    console.log('[INFO] Run: edk2-opencode login <username> <token>');
    return;
  }
  
  try {
    const data = JSON.parse(fs.readFileSync(loginFile, 'utf-8'));
    
    if (data.isLoggedIn && data.expiresAt > Date.now()) {
      const hoursLeft = Math.round((data.expiresAt - Date.now()) / (60 * 60 * 1000));
      console.log(`[STATUS] Logged in as ${data.username}`);
      console.log(`[INFO] Session expires in ${hoursLeft} hours`);
    } else {
      console.log('[STATUS] Session expired');
      console.log('[INFO] Run: edk2-opencode login <username> <token>');
    }
  } catch {
    console.log('[STATUS] Invalid session file');
    console.log('[INFO] Run: edk2-opencode login <username> <token>');
  }
}

function handleInit() {
  console.log('[INFO] Initializing RAG service...');
  
  const ragServiceDir = path.join(PACKAGE_ROOT, 'rag-service');
  const prebuiltVectors = path.join(PACKAGE_ROOT, 'prebuilt-vectors');
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  
  if (fs.existsSync(prebuiltVectors)) {
    console.log('[INFO] Using prebuilt vectors');
    return;
  }
  
  // Install Python dependencies
  console.log('[INFO] Installing Python dependencies...');
  const requirementsFile = path.join(ragServiceDir, 'requirements.txt');
  
  try {
    execSync(`${pythonCmd} -m pip install -r "${requirementsFile}" --quiet`, {
      stdio: 'inherit'
    });
    console.log('[SUCCESS] Python dependencies installed');
  } catch (err) {
    console.warn('[WARN] Failed to install Python dependencies, continuing anyway...');
  }
  
  console.log('[INFO] Building vector index (this may take a few minutes)...');
  
  const script = path.join(ragServiceDir, 'run_server.py');
  
  try {
    execSync(`${pythonCmd} "${script}" --fetch-docs --build-index`, {
      cwd: ragServiceDir,
      stdio: 'inherit'
    });
    console.log('[SUCCESS] RAG service initialized');
  } catch (err) {
    console.error('[ERROR] Failed to initialize RAG service:', err.message);
    process.exit(1);
  }
}

function handleUpdateKB() {
  console.log('[INFO] Updating knowledge base...');
  
  const ragServiceDir = path.join(PACKAGE_ROOT, 'rag-service');
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  const script = path.join(ragServiceDir, 'run_server.py');
  
  try {
    execSync(`${pythonCmd} "${script}" --fetch-docs --build-index --force-update`, {
      cwd: ragServiceDir,
      stdio: 'inherit'
    });
    console.log('[SUCCESS] Knowledge base updated');
  } catch (err) {
    console.error('[ERROR] Failed to update knowledge base:', err.message);
    process.exit(1);
  }
}

main();