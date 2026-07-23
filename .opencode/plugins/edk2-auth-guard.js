/**
 * EDK2 Authentication Guard Plugin (JavaScript version)
 * Ensures users are logged in before accessing skills and MCP services
 */

const fs = require('fs').promises
const path = require('path')
const os = require('os')

const LOGIN_FILE_NAME = '.edk2_login'
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000 // 24 hours

class Edk2AuthGuard {
  constructor(projectDir) {
    this.loginState = { isLoggedIn: false }
    this.loginFilePath = path.join(os.homedir(), '.config', 'opencode', LOGIN_FILE_NAME)
  }
  
  async loadLoginState() {
    try {
      const data = await fs.readFile(this.loginFilePath, 'utf-8')
      const state = JSON.parse(data)
      
      if (state.expiresAt && Date.now() < state.expiresAt) {
        this.loginState = state
      } else {
        this.loginState = { isLoggedIn: false }
      }
    } catch {
      this.loginState = { isLoggedIn: false }
    }
  }
  
  async saveLoginState() {
    const dir = path.dirname(this.loginFilePath)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(this.loginFilePath, JSON.stringify(this.loginState, null, 2))
  }
  
  async login(username, token) {
    this.loginState = {
      isLoggedIn: true,
      username,
      token,
      loginTime: Date.now(),
      expiresAt: Date.now() + SESSION_DURATION_MS
    }
    await this.saveLoginState()
    return true
  }
  
  async logout() {
    this.loginState = { isLoggedIn: false }
    try {
      await fs.unlink(this.loginFilePath)
    } catch {
      // File doesn't exist, ignore
    }
  }
  
  isLoggedIn() {
    return this.loginState.isLoggedIn && 
           (!this.loginState.expiresAt || Date.now() < this.loginState.expiresAt)
  }
  
  getLoginInfo() {
    return { ...this.loginState }
  }
}

let authGuard = null

module.exports = async (input) => {
  authGuard = new Edk2AuthGuard(input.directory)
  await authGuard.loadLoginState()
  
  return {
    'tool.execute.before': async (toolName, toolInput, output) => {
      const protectedTools = ['skill', 'task']
      
      if (protectedTools.includes(toolName)) {
        if (!authGuard?.isLoggedIn()) {
          output.error = 'Authentication required. Please login first using: opencode login <username> <token>'
          output.skip = true
        }
      }
    },
    
    'experimental.chat.system.transform': async (systemPrompt) => {
      if (!authGuard?.isLoggedIn()) {
        return systemPrompt + '\n\n[EDK2 AUTH NOTICE] You are not logged in. Skills and MCP services are disabled. Please login using the login command.'
      }
      return systemPrompt
    },
    
    'config': (config) => {
      if (!authGuard?.isLoggedIn()) {
        if (config.mcp) {
          Object.keys(config.mcp).forEach(key => {
            config.mcp[key].enabled = false
          })
        }
      }
    }
  }
}

module.exports.Edk2AuthGuard = Edk2AuthGuard
module.exports.authGuardInstance = () => authGuard