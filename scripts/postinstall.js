const fs = require('fs');
const path = require('path');

const PACKAGE_ROOT = path.dirname(__dirname);

function log(message) {
  console.log(`[edk2-opencode] ${message}`);
}

function ensureConfigDir() {
  const os = require('os');
  const configDir = path.join(os.homedir(), '.config', 'opencode');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
    log(`Created config directory: ${configDir}`);
  }
  return configDir;
}

function main() {
  log('Post-install setup starting...');
  
  ensureConfigDir();
  
  // Skip Python setup by default (too slow for postinstall)
  if (process.env.EDK2_SKIP_PYTHON_SETUP !== 'false') {
    log('Skipping Python setup (set EDK2_SKIP_PYTHON_SETUP=false to enable)');
  }
  
  log('');
  log('Setup complete! Run with: npx @yourcompany/edk2-opencode');
  log('');
  log('Quick Start:');
  log('  1. Login:     npx @yourcompany/edk2-opencode login <username> <token>');
  log('  2. Start:     npx @yourcompany/edk2-opencode');
  log('');
}

main();