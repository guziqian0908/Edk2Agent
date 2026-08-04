const fs = require('fs');
const path = require('path');
const os = require('os');

const PACKAGE_ROOT = path.dirname(__dirname);

function log(msg) {
  console.log(`[edk2-opencode] ${msg}`);
}

function main() {
  log('');
  log('╔═══════════════════════════════════════════════════════════════╗');
  log('║     EDK2-OpenCode v6.0.0 - Knowledge Base MCP Daemon          ║');
  log('╚═══════════════════════════════════════════════════════════════╝');
  log('');
  log('Quick Start:');
  log('  1. npx edk2-opencode --init-edk2-wiki    # Initialize knowledge base');
  log('  2. npx edk2-opencode                     # Start assistant (auto-starts MCP daemon)');
  log('');
  log('MCP Service: shared HTTP daemon, dynamic port, auto-restart');
  log('Data Sources:');
  log('  - TianoCore Wiki (offline cache)');
  log('  - tianocore-docs repository');
  log('  - ChromaDB vector index');
  log('');
}

main();
