/**
 * GitHub Authentication Module
 * Direct HTTP validation without gh CLI dependency
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const AUTH_DIR = path.join(os.homedir(), '.edk2-opencode');
const AUTH_FILE = path.join(AUTH_DIR, 'auth.json');

function ensureAuthDir() {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }
}

function saveAuth(username, token) {
  ensureAuthDir();
  
  const authData = {
    username: username,
    token: token,
    loginAt: new Date().toISOString()
  };
  
  fs.writeFileSync(AUTH_FILE, JSON.stringify(authData, null, 2), 'utf-8');
  
  return authData;
}

function loadAuth() {
  if (!fs.existsSync(AUTH_FILE)) {
    return null;
  }
  
  try {
    const content = fs.readFileSync(AUTH_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    return null;
  }
}

function clearAuth() {
  if (fs.existsSync(AUTH_FILE)) {
    fs.unlinkSync(AUTH_FILE);
  }
}

function requestUser(token, rejectUnauthorized) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: '/user',
      method: 'GET',
      rejectUnauthorized: rejectUnauthorized,
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'edk2-opencode'
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const user = JSON.parse(data);
            resolve({
              valid: true,
              username: user.login,
              message: 'Token is valid'
            });
          } catch (e) {
            resolve({
              valid: false,
              message: 'Failed to parse response'
            });
          }
        } else if (res.statusCode === 401) {
          resolve({
            valid: false,
            message: 'Invalid token or token expired'
          });
        } else if (res.statusCode === 403) {
          resolve({
            valid: false,
            message: 'Token does not have sufficient permissions'
          });
        } else {
          resolve({
            valid: false,
            message: `HTTP ${res.statusCode}: ${data}`
          });
        }
      });
    });
    
    req.on('error', (e) => {
      resolve({
        valid: false,
        message: `Network error: ${e.message}`,
        tlsError: /certificate|CERT_|TLS|SSL/i.test(e.message)
      });
    });
    
    req.setTimeout(10000, () => {
      req.destroy();
      resolve({
        valid: false,
        message: 'Request timeout'
      });
    });
    
    req.end();
  });
}

async function validateToken(token) {
  let result = await requestUser(token, true);
  
  if (!result.valid && result.tlsError) {
    console.warn('[edk2-opencode] WARNING: TLS certificate verification failed (possible corporate proxy/antivirus).');
    console.warn('[edk2-opencode] WARNING: Retrying with certificate verification disabled. Only do this on trusted networks.');
    result = await requestUser(token, false);
  }
  
  return result;
}

function checkAuthStatus() {
  const auth = loadAuth();
  
  if (!auth) {
    return {
      loggedIn: false,
      message: 'Not logged in'
    };
  }
  
  return {
    loggedIn: true,
    username: auth.username,
    loginAt: auth.loginAt,
    message: `Logged in as ${auth.username}`
  };
}

function getAuthForGit() {
  const authData = loadAuth();
  if (!authData) {
    return null;
  }
  return {
    username: authData.username,
    token: authData.token
  };
}

module.exports = {
  saveAuth,
  loadAuth,
  clearAuth,
  validateToken,
  checkAuthStatus,
  getAuthForGit,
  AUTH_FILE,
  AUTH_DIR
};