#!/usr/bin/env node

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const crypto = require('crypto');

const PACKAGE_ROOT = path.dirname(__dirname);
const OPENCODE_BIN = path.join(PACKAGE_ROOT, 'node_modules', 'opencode-ai', 'bin', 'opencode');

function validateGitHubToken(token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: '/user',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'edk2-opencode/1.0.0',
        'Accept': 'application/vnd.github+json'
      },
      rejectUnauthorized: true
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const user = JSON.parse(data);
            resolve({
              valid: true,
              username: user.login,
              userId: user.id
            });
          } catch (e) {
            reject(new Error('Invalid response from GitHub'));
          }
        } else if (res.statusCode === 401) {
          resolve({ valid: false, error: 'Invalid token' });
        } else if (res.statusCode === 403) {
          resolve({ valid: false, error: 'Token lacks required permissions' });
        } else {
          resolve({ valid: false, error: `GitHub API error: ${res.statusCode}` });
        }
      });
    });

    req.on('error', (e) => {
      reject(new Error(`Network error: ${e.message}`));
    });

    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Request timeout (15s)'));
    });

    req.end();
  });
}

function validateGitHubTokenViaCli(token) {
  return new Promise((resolve, reject) => {
    const { exec } = require('child_process');
    
    exec(
      `gh api user -H "Authorization: Bearer ${token}"`,
      { timeout: 15000 },
      (error, stdout, stderr) => {
        if (error) {
          if (stderr.includes('HTTP 401') || stderr.includes('401') || stderr.includes('403')) {
            resolve({ valid: false, error: 'Invalid token or insufficient permissions' });
          } else {
            resolve({ valid: false, error: `gh CLI error: ${stderr || error.message}` });
          }
          return;
        }
        
        try {
          const user = JSON.parse(stdout);
          if (user.login && user.id) {
            resolve({
              valid: true,
              username: user.login,
              userId: user.id
            });
          } else {
            resolve({ valid: false, error: 'Unexpected response format' });
          }
        } catch (e) {
          resolve({ valid: false, error: 'Failed to parse gh CLI response' });
        }
      }
    );
  });
}

async function validateToken(token) {
  try {
    return await validateGitHubToken(token);
  } catch (httpsError) {
    console.log('[INFO] Direct API failed, trying gh CLI...');
    try {
      return await validateGitHubTokenViaCli(token);
    } catch (cliError) {
      throw new Error(`Both validation methods failed. HTTPS: ${httpsError.message}`);
    }
  }
}

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
  console.log('║  Version: 1.0.0                                              ║');
  console.log('║  Skills:  edk2-pr-workflow, ovmf-build                        ║');
  console.log('║  MCP:     edk2-rag (RAG knowledge base)                       ║');
  console.log('║  API:     Built-in GLM-5 fallback                             ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Quick Start:');
  console.log('  1. Create GitHub Token: https://github.com/settings/tokens');
  console.log('  2. Login:     edk2-opencode login <github_username> <token>');
  console.log('  3. Check:     edk2-opencode status');
  console.log('  4. Start:     edk2-opencode');
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
    handleLogin(args).catch(err => {
      console.error('[ERROR]', err.message);
      process.exit(1);
    });
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

async function handleLogin(args) {
  const username = args[1];
  const token = args[2];
  
  if (!username || !token) {
    console.error('[ERROR] Usage: edk2-opencode login <username> <github_token>');
    console.error('');
    console.error('To create a GitHub Personal Access Token:');
    console.error('  1. Go to: https://github.com/settings/tokens');
    console.error('  2. Click "Generate new token (classic)"');
    console.error('  3. Select scopes: repo, read:user');
    console.error('  4. Copy the generated token');
    process.exit(1);
  }
  
  console.log('[INFO] Validating GitHub token...');
  
  try {
    const result = await validateToken(token);
    
    if (!result.valid) {
      console.error(`[ERROR] GitHub token validation failed: ${result.error}`);
      console.error('');
      console.error('Please ensure:');
      console.error('  - Token is a valid GitHub Personal Access Token');
      console.error('  - Token has not expired');
      console.error('  - Token has required scopes: repo, read:user');
      process.exit(1);
    }
    
    if (result.username.toLowerCase() !== username.toLowerCase()) {
      console.error(`[ERROR] Username mismatch!`);
      console.error(`  Expected: ${username}`);
      console.error(`  Token belongs to: ${result.username}`);
      console.error('');
      console.error('Please use the correct username that matches your GitHub account.');
      process.exit(1);
    }
    
    const { loginFile } = ensureConfig();
    const loginData = {
      isLoggedIn: true,
      username: result.username,
      userId: result.userId,
      tokenHash: crypto.createHash('sha256').update(token).digest('hex').substring(0, 16),
      loginTime: Date.now(),
      expiresAt: Date.now() + (24 * 60 * 60 * 1000),
      authMethod: 'github'
    };
    
    fs.writeFileSync(loginFile, JSON.stringify(loginData, null, 2));
    
    console.log(`[SUCCESS] Logged in as ${result.username}`);
    console.log('[INFO] Session valid for 24 hours');
    console.log('');
    console.log('Available features:');
    console.log('  ✓ edk2-pr-workflow skill');
    console.log('  ✓ ovmf-build skill');
    console.log('  ✓ edk2-rag MCP service');
    
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    console.error('');
    console.error('Please check your network connection and try again.');
    process.exit(1);
  }
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
    console.log('');
    console.log('To login, you need a GitHub Personal Access Token:');
    console.log('  1. Go to: https://github.com/settings/tokens');
    console.log('  2. Click "Generate new token (classic)"');
    console.log('  3. Select scopes: repo, read:user');
    console.log('  4. Run: edk2-opencode login <username> <token>');
    return;
  }
  
  try {
    const data = JSON.parse(fs.readFileSync(loginFile, 'utf-8'));
    
    if (data.isLoggedIn && data.expiresAt > Date.now()) {
      const hoursLeft = Math.round((data.expiresAt - Date.now()) / (60 * 60 * 1000));
      console.log(`[STATUS] Logged in as ${data.username}`);
      console.log(`[AUTH]   Method: ${data.authMethod || 'local'}`);
      console.log(`[TIME]   Session expires in ${hoursLeft} hours`);
      console.log('');
      console.log('Features enabled:');
      console.log('  ✓ edk2-pr-workflow skill');
      console.log('  ✓ ovmf-build skill');
      console.log('  ✓ edk2-rag MCP service');
    } else {
      console.log('[STATUS] Session expired');
      console.log('');
      console.log('Run: edk2-opencode login <username> <token>');
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
  
  if (fs.existsSync(prebuiltVectors)) {
    console.log('[INFO] Using prebuilt vectors');
    return;
  }
  
  console.log('[INFO] Building vector index (this may take a few minutes)...');
  
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
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