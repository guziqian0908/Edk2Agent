#!/usr/bin/env node

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PACKAGE_ROOT = path.dirname(__dirname);
const USER_KB_DIR = path.join(os.homedir(), '.edk2-opencode', 'kb');
const KB_DIR = fs.existsSync(USER_KB_DIR) ? USER_KB_DIR : path.join(PACKAGE_ROOT, 'edk2-kb');

const pkg = require('../package.json');
const auth = require('../lib/auth');
const daemon = require('../lib/daemon');

function log(msg) {
  console.log(`[edk2-opencode] ${msg}`);
}

function error(msg) {
  console.error(`[ERROR] ${msg}`);
}

function showWelcome() {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║     EDK2-OpenCode - EDK2 Knowledge Base (MCP Daemon)          ║');
  console.log('╠═══════════════════════════════════════════════════════════════╣');
  console.log(`║  Version: ${pkg.version.padEnd(53)}║`);
  console.log('║  Mode:    MCP Daemon (shared HTTP service, dynamic port)      ║');
  console.log('║  Skills:  edk2-pr-workflow, ovmf-build                         ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Commands:');
  console.log('  login <username> <token>  Login with GitHub credentials');
  console.log('  logout                    Logout and clear credentials');
  console.log('  --init-edk2-wiki          Initialize EDK2 knowledge base');
  console.log('  --init-edk2-wiki --update Update knowledge base (incremental)');
  console.log('  --status                  Show status (auth + knowledge base daemon)');
  console.log('  --search <query>          Search EDK2 knowledge base');
  console.log('  eval-query <query>        Compare old vs current retrieval for a query');
  console.log('  daemon start|stop|status|restart|logs   Manage the KB MCP daemon');
  console.log('  --help                    Show this help');
  console.log('  --version                 Show version');
  console.log('');
  console.log('Usage:');
  console.log('  1. Login:     npx edk2-opencode login <user> <token>');
  console.log('  2. Initialize: npx edk2-opencode --init-edk2-wiki');
  console.log('  3. Run:       npx edk2-opencode');
  console.log('');
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

function getVenvPython() {
  const venvDir = path.join(KB_DIR, 'venv');
  if (process.platform === 'win32') {
    const winPython = path.join(venvDir, 'Scripts', 'python.exe');
    if (fs.existsSync(winPython)) return winPython;
  } else {
    const unixPython = path.join(venvDir, 'bin', 'python');
    if (fs.existsSync(unixPython)) return unixPython;
  }
  return null;
}

function checkKnowledgeBase() {
  const wikiData = path.join(KB_DIR, 'data', 'tianocore-wiki');
  const docsData = path.join(KB_DIR, 'data', 'tianocore-docs');
  const weknoraData = path.join(KB_DIR, 'data', 'weknora');
  const chromaData = path.join(KB_DIR, 'data', 'chroma_db');
  
  return fs.existsSync(wikiData) || fs.existsSync(docsData) || fs.existsSync(weknoraData) || fs.existsSync(chromaData);
}

async function handleLogin(username, token) {
  if (!username || !token) {
    error('Usage: npx edk2-opencode login <username> <token>');
    error('');
    error('To create a GitHub token:');
    error('  1. Go to https://github.com/settings/tokens');
    error('  2. Click "Generate new token (classic)"');
    error('  3. Select scopes: repo');
    error('  4. Copy the token');
    process.exit(1);
  }
  
  log(`Validating token for ${username}...`);
  
  const result = await auth.validateToken(token);
  
  if (!result.valid) {
    error(`Token validation failed: ${result.message}`);
    error('');
    error('Please check:');
    error('  1. Token is correct and not expired');
    error('  2. Token has "repo" scope');
    process.exit(1);
  }
  
  if (result.username && result.username !== username) {
    error(`Username mismatch. Token belongs to "${result.username}", not "${username}"`);
    process.exit(1);
  }
  
  const authData = auth.saveAuth(username, token);
  
  log('');
  log('✓ Login successful!');
  log(`  Username: ${authData.username}`);
  log(`  Login at: ${authData.loginAt}`);
  log('');
  log('You can now use edk2-opencode.');
}

function handleLogout() {
  const status = auth.checkAuthStatus();
  
  if (!status.loggedIn) {
    log('Already logged out.');
    return;
  }
  
  auth.clearAuth();
  
  log('');
  log('✓ Logged out successfully.');
  log('');
  log('To login again: npx edk2-opencode login <username> <token>');
}

async function handleStatus() {
  console.log('');
  console.log('=== Authentication Status ===');
  console.log('');
  
  const authStatus = auth.checkAuthStatus();
  
  if (authStatus.loggedIn) {
    console.log(`  Status: Logged in`);
    console.log(`  Username: ${authStatus.username}`);
    console.log(`  Login at: ${authStatus.loginAt}`);
  } else {
    console.log('  Status: Not logged in');
    console.log('');
    console.log('  To login: npx edk2-opencode login <username> <token>');
  }
  
  console.log('');
  console.log('=== Knowledge Base Status ===');
  console.log('');
  console.log(`  KB Directory: ${KB_DIR}`);
  
  const venvPython = daemon.getVenvPython(KB_DIR);
  console.log(`  Venv Python: ${venvPython || 'Not initialized'}`);
  
  const wikiData = path.join(KB_DIR, 'data', 'tianocore-wiki');
  const docsData = path.join(KB_DIR, 'data', 'tianocore-docs');
  const chromaData = path.join(KB_DIR, 'data', 'chroma_db');
  
  console.log(`  TianoCore Wiki: ${fs.existsSync(wikiData) ? 'Downloaded' : 'Not downloaded'}`);
  console.log(`  TianoCore Docs: ${fs.existsSync(docsData) ? 'Downloaded' : 'Not downloaded'}`);
  console.log(`  ChromaDB Index: ${fs.existsSync(chromaData) ? 'Built' : 'Not built'}`);
  console.log('');
  console.log('  Mode: MCP Daemon (shared HTTP service, dynamic port)');
  console.log('');
  
  console.log('=== Knowledge Base Daemon ===');
  console.log('');
  const daemonStatus = await daemon.status(KB_DIR);
  if (daemonStatus.running) {
    console.log(`  Status: Running`);
    console.log(`  URL: ${daemonStatus.url}`);
    console.log(`  Port: ${daemonStatus.port}`);
    console.log(`  PID: ${daemonStatus.pid}`);
    console.log(`  Watchdog PID: ${daemonStatus.watchdog_pid}`);
    console.log(`  Ready: ${daemonStatus.ready ? 'yes' : 'no (index still loading)'}`);
    if (daemonStatus.health && daemonStatus.health.indexed_documents !== undefined) {
      console.log(`  Indexed Documents: ${daemonStatus.health.indexed_documents}`);
    }
    console.log(`  Started: ${daemonStatus.started_at}`);
  } else {
    console.log(`  Status: Not running (${daemonStatus.message || 'start with: npx edk2-opencode daemon start'})`);
  }
  console.log('');
}

async function handleInitEdk2Wiki(updateMode = false) {
  log(updateMode ? 'Updating EDK2 Knowledge Base (incremental mode)...' : 'Initializing EDK2 Knowledge Base (full mode)...');
  log('');
  log('This will:');
  log('  1. Create Python virtual environment');
  log('  2. Install ChromaDB and dependencies');
  if (updateMode) {
    log('  3. Sync updated/new pages from TianoCore Wiki');
    log('  4. Update all tianocore-docs repositories');
    log('  5. Incrementally update vector index');
  } else {
    log('  3. Download TianoCore Wiki (full site)');
    log('  4. Clone all tianocore-docs repositories');
    log('  5. Build complete vector index');
  }
  log('');
  log('Estimated time: ' + (updateMode ? '5-10 minutes' : '10-30 minutes') + ' depending on network speed');
  log('');
  
  const pythonCmd = getPythonCommand();
  if (!pythonCmd) {
    error('Python 3.8+ is required. Please install Python first.');
    error('Download from: https://www.python.org/downloads/');
    process.exit(1);
  }
  
  const packageKbDir = path.join(PACKAGE_ROOT, 'edk2-kb');
  const targetKbDir = USER_KB_DIR;
  
  if (!fs.existsSync(targetKbDir)) {
    log(`Creating knowledge base directory: ${targetKbDir}`);
    fs.mkdirSync(targetKbDir, { recursive: true });
  }
  
  const reqFile = path.join(packageKbDir, 'requirements.txt');
  const targetReqFile = path.join(targetKbDir, 'requirements.txt');
  if (fs.existsSync(reqFile) && !fs.existsSync(targetReqFile)) {
    fs.copyFileSync(reqFile, targetReqFile);
  }
  
  const fetchersDir = path.join(targetKbDir, 'fetchers');
  if (!fs.existsSync(fetchersDir)) {
    fs.mkdirSync(fetchersDir, { recursive: true });
  }
  const srcInitScript = path.join(packageKbDir, 'fetchers', 'init_kb.py');
  const dstInitScript = path.join(fetchersDir, 'init_kb.py');
  if (fs.existsSync(srcInitScript)) {
    fs.copyFileSync(srcInitScript, dstInitScript);
  }
  
  const srcEmbeddedScript = path.join(packageKbDir, 'embedded_search.py');
  const dstEmbeddedScript = path.join(targetKbDir, 'embedded_search.py');
  if (fs.existsSync(srcEmbeddedScript)) {
    fs.copyFileSync(srcEmbeddedScript, dstEmbeddedScript);
  }
  
  const srcSearchEngineScript = path.join(packageKbDir, 'search_engine.py');
  const dstSearchEngineScript = path.join(targetKbDir, 'search_engine.py');
  if (fs.existsSync(srcSearchEngineScript)) {
    fs.copyFileSync(srcSearchEngineScript, dstSearchEngineScript);
  }
  
  const venvDir = path.join(targetKbDir, 'venv');
  
  if (!fs.existsSync(venvDir)) {
    log('[1/5] Creating Python virtual environment...');
    try {
      execSync(`${pythonCmd} -m venv "${venvDir}"`, { stdio: 'inherit' });
    } catch (err) {
      error(`Failed to create venv: ${err.message}`);
      process.exit(1);
    }
  } else {
    log('[1/5] Virtual environment already exists');
  }
  
  const pipCmd = process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'pip')
    : path.join(venvDir, 'bin', 'pip');
  
  log('[2/5] Installing dependencies...');
  try {
    execSync(`"${pipCmd}" install -r "${targetReqFile}" --disable-pip-version-check`, {
      cwd: targetKbDir,
      stdio: 'inherit',
      timeout: 600000
    });
  } catch (err) {
    error(`Failed to install dependencies: ${err.message}`);
    process.exit(1);
  }
  
  const venvPython = getVenvPython();
  const initScript = path.join(fetchersDir, 'init_kb.py');
  
  const modeFlag = updateMode ? '--update' : '';
  
  log('[3/5] ' + (updateMode ? 'Syncing TianoCore Wiki changes...' : 'Downloading TianoCore Wiki...'));
  log('[4/5] ' + (updateMode ? 'Updating tianocore-docs...' : 'Cloning tianocore-docs...'));  log('[5/5] ' + (updateMode ? 'Incrementally updating vector index...' : 'Building vector index...'));
  
  try {
    execSync(`"${venvPython}" "${initScript}" ${modeFlag}`, {
      cwd: targetKbDir,
      stdio: 'inherit',
      timeout: 1800000
    });
  } catch (err) {
    error(`Failed to ${updateMode ? 'update' : 'initialize'} knowledge base: ${err.message}`);
    process.exit(1);
  }
  
  log('');
  log('SUCCESS: EDK2 Knowledge Base ' + (updateMode ? 'updated!' : 'initialized!'));
  log(`Knowledge base stored at: ${targetKbDir}`);
  log('');
  log('Now run: npx edk2-opencode');
}

async function handleSearch(query) {
  log(`Searching for: "${query}"...`);
  log('Ensuring knowledge base daemon is running...');

  try {
    const result = await daemon.search(query, 5);
    console.log('');
    console.log('Search Results:');
    console.log('');
    
    if (result.results && result.results.length > 0) {
      result.results.forEach((r, i) => {
        console.log(`[${i + 1}] ${r.title}`);
        console.log(`    Source: ${r.source_display || r.source}`);
        console.log(`    Score: ${r.score}`);
        console.log(`    Snippet: ${r.snippet.substring(0, 200)}...`);
        console.log('');
      });
    } else {
      console.log('No results found.');
    }
  } catch (e) {
    error(`Search failed: ${e.message}`);
    process.exit(1);
  }
}

async function handleDaemon(command) {
  const kbDir = daemon.getKbDir();

  switch (command) {
    case 'start': {
      log('Starting knowledge base daemon...');
      const state = await daemon.startDaemon(kbDir);
      log(`Daemon running at ${state.url}`);
      if (!state.ready) {
        log('Index is still loading in the background - ready shortly.');
      }
      break;
    }
    
    case 'stop': {
      log('Stopping knowledge base daemon...');
      await daemon.stopDaemon(kbDir);
      log('Daemon stopped.');
      break;
    }
    
    case 'restart': {
      log('Restarting knowledge base daemon...');
      await daemon.stopDaemon(kbDir);
      const state = await daemon.startDaemon(kbDir);
      log(`Daemon restarted at ${state.url}`);
      break;
    }
    
    case 'status': {
      const s = await daemon.status(kbDir);
      console.log('');
      console.log('=== Knowledge Base Daemon ===');
      console.log('');
      if (s.running) {
        console.log(`  Status: Running`);
        console.log(`  URL: ${s.url}`);
        console.log(`  Port: ${s.port}`);
        console.log(`  PID: ${s.pid}`);
        console.log(`  Watchdog PID: ${s.watchdog_pid}`);
        console.log(`  Ready: ${s.ready ? 'yes' : 'no (index still loading)'}`);
        if (s.health && s.health.indexed_documents !== undefined) {
          console.log(`  Indexed Documents: ${s.health.indexed_documents}`);
        }
        console.log(`  Started: ${s.started_at}`);
      } else {
        console.log(`  Status: Not running (${s.message || 'start with: npx edk2-opencode daemon start'})`);
      }
      console.log('');
      break;
    }
    
    case 'logs': {
      const logPath = daemon.logFile(kbDir);
      if (!fs.existsSync(logPath)) {
        log('No supervisor logs yet. Start the daemon first.');
        break;
      }
      const content = fs.readFileSync(logPath, 'utf-8');
      console.log(content.slice(-8000));
      break;
    }
    
    default:
      error('Unknown daemon command.');
      error('Usage: npx edk2-opencode daemon <start|stop|restart|status|logs>');
      process.exit(1);
  }
}

async function handleEvalQuery(args) {
  const queries = [];
  let dataDir = null;
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === '--data-dir') {
      dataDir = args[++i];
    } else if (t === '--query') {
      queries.push(args[++i]);
    } else if (!t.startsWith('-')) {
      queries.push(t);
    }
  }

  if (queries.length === 0) {
    error('Usage: npx edk2-opencode eval-query "<query>" [--data-dir <kb data dir>]');
    process.exit(2);
  }

  const resolvedDataDir = dataDir || path.join(KB_DIR, 'data');
  if (!fs.existsSync(resolvedDataDir)) {
    error(`Knowledge base data not found at: ${resolvedDataDir}`);
    error('Run: npx edk2-opencode --init-edk2-wiki');
    process.exit(1);
  }

  const compareScript = path.join(PACKAGE_ROOT, 'edk2-kb', 'eval', 'compare_query.py');
  if (!fs.existsSync(compareScript)) {
    error('compare_query.py not found:', compareScript);
    process.exit(1);
  }

  const python = getVenvPython() || getPythonCommand();
  if (!python) {
    error('Python not found. Install Python 3.8+ or set EDK2_KB_PYTHON.');
    process.exit(1);
  }

  const scriptArgs = [compareScript, '--data-dir', resolvedDataDir];
  for (const q of queries) {
    scriptArgs.push('--query', q);
  }

  log(`Python   : ${python}`);
  log(`Data dir : ${resolvedDataDir}`);
  log('');

  return new Promise((resolve) => {
    const child = spawn(python, scriptArgs, { stdio: 'inherit' });
    child.on('error', (err) => {
      error(`Failed to run comparison: ${err.message}`);
      resolve(1);
    });
    child.on('exit', (code) => resolve(code == null ? 1 : code));
  });
}

async function startOpencode() {
  const configPath = path.join(USER_CWD, 'opencode.json');

  let daemonState = null;
  try {
    daemonState = await daemon.ensureRunning(KB_DIR);
    log(`Knowledge base MCP server ready at ${daemonState.url}`);
  } catch (e) {
    error(`Failed to start knowledge base daemon: ${e.message}`);
    process.exit(1);
  }

  const config = generateConfig(daemonState);
  const correctSkillsPath = path.join(PACKAGE_ROOT, '.opencode', 'skills');

  let needsWrite = false;
  if (!fs.existsSync(configPath)) {
    needsWrite = true;
  } else {
    try {
      const existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      
      const hasValidSkills = existingConfig.skills && 
                              existingConfig.skills.paths && 
                              existingConfig.skills.paths.some(p => {
                                return p.includes('edk2-opencode') && fs.existsSync(p);
                              });
      
      if (!hasValidSkills) {
        needsWrite = true;
        log('Existing skills path is invalid or does not exist.');
      }
      
      const expectedMcpUrl = daemonState ? `${daemonState.url}/mcp` : null;
      const hasCorrectMcp = !expectedMcpUrl || (
        existingConfig.mcp &&
        existingConfig.mcp['edk2-kb'] &&
        existingConfig.mcp['edk2-kb'].url === expectedMcpUrl
      );
      if (expectedMcpUrl && !hasCorrectMcp) {
        needsWrite = true;
        log(`Updating MCP server endpoint to ${expectedMcpUrl}`);
      }
    } catch {
      needsWrite = true;
    }
  }
  
  if (needsWrite) {
    log('Creating/updating opencode.json with EDK2 skills + MCP server...');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }
  
  log('Starting OpenCode with knowledge base MCP server...');
  log(`Skills directory: ${correctSkillsPath}`);
  
  const env = {
    ...process.env,
    EDK2_PACKAGE_ROOT: PACKAGE_ROOT,
    EDK2_KB_DIR: KB_DIR,
    EDK2_KB_URL: daemonState.url
  };
  
  const child = spawn('npx', ['opencode-ai'], {
    cwd: USER_CWD,
    env,
    stdio: 'inherit',
    shell: true
  });
  
  child.on('error', (err) => {
    error(`Failed to start: ${err.message}`);
    process.exit(1);
  });
  
  child.on('exit', (code) => {
    process.exit(code || 0);
  });
}

function generateConfig(daemonState) {
  const config = {
    "$schema": "https://opencode.ai/config.json",
    "username": "edk2-developer",
    "default_agent": "general",
    "logLevel": "INFO",
    "skills": {
      "paths": [path.join(PACKAGE_ROOT, '.opencode', 'skills')]
    },
    "permission": {
      "edit": "ask",
      "bash": { "git *": "allow", "*": "ask" },
      "external_directory": { ".": "allow", "*": "ask" },
      "webfetch": "deny",
      "websearch": "deny"
    },
    "instructions": [path.join(PACKAGE_ROOT, "AGENTS.md")]
  };
  
  if (daemonState && daemonState.url) {
    config.mcp = {
      "edk2-kb": {
        "type": "remote",
        "url": `${daemonState.url}/mcp`,
        "oauth": false,
        "enabled": true,
        "timeout": 30000
      }
    };
  }
  
  return config;
}

const USER_CWD = process.cwd();

async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    showWelcome();
    process.exit(0);
  }
  
  if (args.includes('--version') || args.includes('-v')) {
    console.log(`edk2-opencode v${pkg.version}`);
    process.exit(0);
  }
  
  if (args[0] === 'login') {
    await handleLogin(args[1], args[2]);
    process.exit(0);
  }
  
  if (args[0] === 'logout') {
    handleLogout();
    process.exit(0);
  }
  
  if (args.includes('--init-edk2-wiki')) {
    const authStatus = auth.checkAuthStatus();
    if (!authStatus.loggedIn) {
      error('Please login first.');
      error('Run: npx edk2-opencode login <username> <token>');
      process.exit(1);
    }
    
    const updateMode = args.includes('--update');
    await handleInitEdk2Wiki(updateMode);
    process.exit(0);
  }
  
  if (args.includes('--status')) {
    await handleStatus();
    process.exit(0);
  }
  
  if (args[0] === 'daemon') {
    if (!args[1]) {
      error('Usage: npx edk2-opencode daemon <start|stop|restart|status|logs>');
      process.exit(1);
    }
    await handleDaemon(args[1]);
    process.exit(0);
  }

  if (args[0] === 'eval-query') {
    process.exit(await handleEvalQuery(args.slice(1)));
  }
  
  const searchIndex = args.indexOf('--search');
  if (searchIndex !== -1 && args[searchIndex + 1]) {
    await handleSearch(args[searchIndex + 1]);
    process.exit(0);
  }
  
  showWelcome();
  
  const authStatus = auth.checkAuthStatus();
  if (!authStatus.loggedIn) {
    error('Please login first.');
    error('Run: npx edk2-opencode login <username> <token>');
    error('');
    error('To create a GitHub token:');
    error('  1. Go to https://github.com/settings/tokens');
    error('  2. Click "Generate new token (classic)"');
    error('  3. Select scope: repo');
    error('  4. Copy the token');
    process.exit(1);
  }
  
  if (!checkKnowledgeBase()) {
    log('Knowledge base not initialized.');
    log('Run: npx edk2-opencode --init-edk2-wiki');
    process.exit(1);
  }
  
  await startOpencode();
}

main();