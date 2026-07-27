const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const PACKAGE_ROOT = path.dirname(__dirname);

function log(message) {
  console.log(`[edk2-opencode] ${message}`);
}

function ensureConfigDir() {
  const configDir = path.join(os.homedir(), '.config', 'opencode');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
    log(`Created config directory: ${configDir}`);
  }
  return configDir;
}

function setupPythonDeps() {
  const ragServiceDir = path.join(PACKAGE_ROOT, 'rag-service');
  const reqFile = path.join(ragServiceDir, 'requirements.txt');
  
  if (fs.existsSync(reqFile)) {
    log('Installing Python dependencies for RAG service...');
    
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const venvDir = path.join(ragServiceDir, 'venv');
    
    if (!fs.existsSync(venvDir)) {
      log('Creating Python virtual environment...');
      try {
        execSync(`${pythonCmd} -m venv "${venvDir}"`, { stdio: 'inherit' });
      } catch (err) {
        log('Warning: Failed to create venv, using system Python');
      }
    }
    
    const pipCmd = process.platform === 'win32' 
      ? path.join(venvDir, 'Scripts', 'pip')
      : path.join(venvDir, 'bin', 'pip');
    
    const actualPip = fs.existsSync(pipCmd) ? pipCmd : 'pip';
    
    try {
      execSync(`"${actualPip}" install -r "${reqFile}"`, { stdio: 'inherit' });
      log('Python dependencies installed');
    } catch (err) {
      log('Warning: Failed to install Python deps. RAG service may not work.');
    }
  }
}

function checkPrebuiltVectors() {
  const prebuiltDir = path.join(PACKAGE_ROOT, 'prebuilt-vectors');
  const chromaDb = path.join(prebuiltDir, 'chroma_db');
  
  if (fs.existsSync(chromaDb)) {
    log('Prebuilt vectors detected - RAG service ready');
    return true;
  }
  
  log('No prebuilt vectors found - will download on first use');
  return false;
}

function main() {
  log('Post-install setup starting...');
  
  ensureConfigDir();
  
  if (process.env.EDK2_SKIP_PYTHON_SETUP !== 'true') {
    setupPythonDeps();
  }
  
  checkPrebuiltVectors();
  
  log('');
  log('Setup complete! Run with: npx edk2-opencode');
  log('');
  log('Quick Start:');
  log('  1. Login:     npx edk2-opencode login <username> <token>');
  log('  2. Start:     npx edk2-opencode');
  log('  3. Initialize: npx edk2-opencode --init');
  log('');
}

main();