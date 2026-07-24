const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const LOGIN_FILE_NAME = '.edk2_login';
const CACHE_DIR_NAME = 'edk2-cache';
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

class Edk2AuthGuard {
  constructor(projectDir) {
    this.loginState = { isLoggedIn: false };
    this.configDir = path.join(os.homedir(), '.config', 'opencode');
    this.loginFilePath = path.join(this.configDir, LOGIN_FILE_NAME);
    this.cacheDir = path.join(this.configDir, CACHE_DIR_NAME);
    this.initialized = false;
  }
  
  async init() {
    if (this.initialized) return;
    
    await this.loadLoginState();
    await this.cleanExpiredCache();
    this.initialized = true;
  }
  
  async loadLoginState() {
    try {
      const data = await fs.readFile(this.loginFilePath, 'utf-8');
      const state = JSON.parse(data);
      
      if (state.expiresAt && Date.now() < state.expiresAt) {
        this.loginState = state;
        console.log(`[EDK2 AUTH] Session restored: ${state.username}`);
      } else {
        this.loginState = { isLoggedIn: false };
        console.log('[EDK2 AUTH] Session expired');
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[EDK2 AUTH] Error loading state:', err.message);
      }
      this.loginState = { isLoggedIn: false };
    }
  }
  
  async saveLoginState() {
    try {
      await fs.mkdir(this.configDir, { recursive: true });
      await fs.writeFile(this.loginFilePath, JSON.stringify(this.loginState, null, 2));
      console.log('[EDK2 AUTH] Session saved');
    } catch (err) {
      console.error('[EDK2 AUTH] Error saving state:', err.message);
    }
  }
  
  async login(username, token) {
    this.loginState = {
      isLoggedIn: true,
      username,
      token: this._hashToken(token),
      loginTime: Date.now(),
      expiresAt: Date.now() + SESSION_DURATION_MS
    };
    await this.saveLoginState();
    return true;
  }
  
  async logout() {
    this.loginState = { isLoggedIn: false };
    
    try {
      await fs.unlink(this.loginFilePath);
      console.log('[EDK2 AUTH] Session cleared');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[EDK2 AUTH] Error clearing session:', err.message);
      }
    }
    
    await this.clearCache();
  }
  
  async clearCache() {
    try {
      const files = await fs.readdir(this.cacheDir);
      for (const file of files) {
        await fs.rm(path.join(this.cacheDir, file), { recursive: true });
      }
      console.log('[EDK2 AUTH] Cache cleared');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[EDK2 AUTH] Error clearing cache:', err.message);
      }
    }
  }
  
  async cleanExpiredCache() {
    try {
      const files = await fs.readdir(this.cacheDir);
      const now = Date.now();
      
      for (const file of files) {
        const filePath = path.join(this.cacheDir, file);
        try {
          const stat = await fs.stat(filePath);
          if (now - stat.mtimeMs > CACHE_MAX_AGE_MS) {
            await fs.rm(filePath, { recursive: true });
            console.log(`[EDK2 AUTH] Cleaned expired cache: ${file}`);
          }
        } catch {}
      }
    } catch {}
  }
  
  isLoggedIn() {
    return this.loginState.isLoggedIn && 
           this.loginState.expiresAt && 
           Date.now() < this.loginState.expiresAt;
  }
  
  getLoginInfo() {
    const info = { ...this.loginState };
    delete info.token;
    
    if (info.expiresAt) {
      info.remainingHours = Math.max(0, Math.round((info.expiresAt - Date.now()) / (60 * 60 * 1000)));
    }
    
    return info;
  }
  
  _hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex').substring(0, 16);
  }
  
  shouldBlockAccess(toolName) {
    const protectedTools = ['skill', 'task', 'mcp'];
    return protectedTools.includes(toolName) && !this.isLoggedIn();
  }
}

let authGuard = null;

module.exports = async (input) => {
  authGuard = new Edk2AuthGuard(input.directory);
  await authGuard.init();
  
  return {
    'tool.execute.before': async (toolName, toolInput, output) => {
      if (authGuard?.shouldBlockAccess(toolName)) {
        output.error = '[EDK2 AUTH] Authentication required. Please login first.';
        output.error += '\n\nRun: opencode login <username> <token>';
        output.error += '\nOr use: /login <username> <token>';
        output.skip = true;
        console.log(`[EDK2 AUTH] Blocked unauthorized access to: ${toolName}`);
      }
    },
    
    'experimental.chat.system.transform': async (systemPrompt) => {
      if (!authGuard?.isLoggedIn()) {
        const notice = '\n\n[EDK2 AUTH NOTICE]\n' +
          'You are NOT logged in. Skills and MCP services are DISABLED.\n' +
          'To enable all features, login using:\n' +
          '  /login <username> <token>\n' +
          '  or\n' +
          '  opencode login <username> <token>';
        return systemPrompt + notice;
      }
      return systemPrompt;
    },
    
    'config': (config) => {
      if (!authGuard?.isLoggedIn()) {
        if (config.mcp) {
          Object.keys(config.mcp).forEach(key => {
            config.mcp[key].enabled = false;
          });
          console.log('[EDK2 AUTH] MCP services disabled (not logged in)');
        }
        
        if (config.skills) {
          config.skills.enabled = false;
          console.log('[EDK2 AUTH] Skills disabled (not logged in)');
        }
      }
    },
    
    'experimental.mcp.call.before': async (serverName, method, params) => {
      if (!authGuard?.isLoggedIn()) {
        console.log(`[EDK2 AUTH] Blocked MCP call to ${serverName}`);
        throw new Error('[EDK2 AUTH] Authentication required for MCP access');
      }
    },
    
    'chat.headers': async (headers) => {
      if (!authGuard?.isLoggedIn()) {
        headers['X-EDK2-Auth-Status'] = 'unauthenticated';
      } else {
        headers['X-EDK2-Auth-Status'] = 'authenticated';
        headers['X-EDK2-User'] = authGuard.loginState.username;
      }
      return headers;
    }
  };
};

module.exports.Edk2AuthGuard = Edk2AuthGuard;
module.exports.authGuardInstance = () => authGuard;