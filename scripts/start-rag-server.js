#!/usr/bin/env node

const { spawn, exec } = require('child_process');
const path = require('path');
const http = require('http');

const RAG_HOST = process.env.RAG_HOST || '0.0.0.0';
const RAG_PORT = process.env.RAG_PORT || 8080;
const RAG_SERVICE_DIR = path.join(__dirname, '..', 'rag-service');

function checkPython() {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'python --version' : 'python3 --version';
    exec(cmd, (error) => {
      resolve(!error);
    });
  });
}

function checkServerRunning() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost',
      port: RAG_PORT,
      path: '/health',
      method: 'GET',
      timeout: 2000
    }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function main() {
  console.log('========================================');
  console.log('EDK2 RAG Service - Centralized Mode');
  console.log('========================================');
  console.log('');
  
  const running = await checkServerRunning();
  if (running) {
    console.log(`[INFO] RAG service already running on port ${RAG_PORT}`);
    console.log(`[INFO] Health check: http://localhost:${RAG_PORT}/health`);
    process.exit(0);
  }
  
  const pythonOk = await checkPython();
  if (!pythonOk) {
    console.error('[ERROR] Python is required to run RAG service');
    console.error('[ERROR] Please install Python 3.8+');
    process.exit(1);
  }
  
  console.log(`[INFO] Starting RAG service on ${RAG_HOST}:${RAG_PORT}`);
  console.log('');
  
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  const script = path.join(RAG_SERVICE_DIR, 'run_http_server.py');
  
  const child = spawn(pythonCmd, [script, '--host', RAG_HOST, '--port', RAG_PORT], {
    cwd: RAG_SERVICE_DIR,
    stdio: 'inherit',
    shell: true
  });
  
  child.on('error', (err) => {
    console.error('[ERROR] Failed to start RAG service:', err.message);
    process.exit(1);
  });
  
  child.on('exit', (code) => {
    process.exit(code || 0);
  });
}

main();