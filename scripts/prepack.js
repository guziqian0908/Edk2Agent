const fs = require('fs');
const path = require('path');

const PACKAGE_ROOT = path.dirname(__dirname);

function log(message) {
  console.log(`[prepack] ${message}`);
}

function ensureDirectories() {
  const dirs = [
    'bin',
    'lib',
    '.opencode',
    'rag-service',
    'prebuilt-vectors'
  ];
  
  for (const dir of dirs) {
    const fullPath = path.join(PACKAGE_ROOT, dir);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
      log(`Created: ${dir}`);
    }
  }
}

function copyReadme() {
  const readme = path.join(PACKAGE_ROOT, 'README.md');
  if (!fs.existsSync(readme)) {
    log('Warning: README.md not found');
  }
}

function main() {
  log('Preparing package...');
  
  ensureDirectories();
  copyReadme();
  
  log('Package ready for publishing');
}

main();