#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');

const REGISTRY = process.env.NPM_REGISTRY || 'http://localhost:4873';

console.log('========================================');
console.log('Publishing to Internal npm Registry');
console.log('========================================');
console.log(`Registry: ${REGISTRY}`);
console.log('');

try {
  console.log('[1/3] Checking authentication...');
  try {
    const whoami = execSync(`npm whoami --registry ${REGISTRY}`, { encoding: 'utf-8' }).trim();
    console.log(`[OK] Logged in as: ${whoami}`);
  } catch {
    console.log('[INFO] Not logged in, attempting to authenticate...');
    console.log('[INFO] Please run: npm adduser --registry ' + REGISTRY);
    process.exit(1);
  }

  console.log('');
  console.log('[2/3] Publishing package...');
  execSync(`npm publish --registry ${REGISTRY}`, { stdio: 'inherit' });
  
  console.log('');
  console.log('[3/3] Verifying package...');
  const pkg = require('../package.json');
  console.log(`[OK] Published ${pkg.name}@${pkg.version}`);
  
  console.log('');
  console.log('========================================');
  console.log('Publish Complete');
  console.log('========================================');
  console.log('');
  console.log('Users can now install with:');
  console.log(`  npm config set registry ${REGISTRY}`);
  console.log(`  npm install -g ${pkg.name}`);
  console.log('');
  console.log('Or use npx:');
  console.log(`  npx ${pkg.name}`);
  console.log('');
  
} catch (err) {
  console.error('[ERROR] Publish failed:', err.message);
  process.exit(1);
}