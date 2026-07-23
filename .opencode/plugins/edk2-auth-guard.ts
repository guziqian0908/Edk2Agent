/**
 * EDK2 Authentication Guard Plugin
 * Ensures users are logged in before accessing skills and MCP services
 */

import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin"
import { promises as fs } from "fs"
import * as path from "path"
import * as os from "os"

interface LoginState {
  isLoggedIn: boolean
  username?: string
  token?: string
  loginTime?: number
  expiresAt?: number
}

const LOGIN_FILE_NAME = ".edk2_login"
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000 // 24 hours

class Edk2AuthGuard {
  private loginState: LoginState = { isLoggedIn: false }
  private loginFilePath: string
  
  constructor(projectDir: string) {
    this.loginFilePath = path.join(os.homedir(), ".config", "opencode", LOGIN_FILE_NAME)
  }
  
  async loadLoginState(): Promise<void> {
    try {
      const data = await fs.readFile(this.loginFilePath, "utf-8")
      const state: LoginState = JSON.parse(data)
      
      if (state.expiresAt && Date.now() < state.expiresAt) {
        this.loginState = state
      } else {
        this.loginState = { isLoggedIn: false }
      }
    } catch {
      this.loginState = { isLoggedIn: false }
    }
  }
  
  async saveLoginState(): Promise<void> {
    const dir = path.dirname(this.loginFilePath)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(this.loginFilePath, JSON.stringify(this.loginState, null, 2))
  }
  
  async login(username: string, token: string): Promise<boolean> {
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
  
  async logout(): Promise<void> {
    this.loginState = { isLoggedIn: false }
    try {
      await fs.unlink(this.loginFilePath)
    } catch {
      // File doesn't exist, ignore
    }
  }
  
  isLoggedIn(): boolean {
    return this.loginState.isLoggedIn && 
           (!this.loginState.expiresAt || Date.now() < this.loginState.expiresAt)
  }
  
  getLoginInfo(): LoginState {
    return { ...this.loginState }
  }
}

let authGuard: Edk2AuthGuard | null = null

const plugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  authGuard = new Edk2AuthGuard(input.directory)
  await authGuard.loadLoginState()
  
  return {
    "tool.execute.before": async (toolName: string, input: any, output: any) => {
      const protectedTools = [
        "skill",
        "task"
      ]
      
      const protectedMcpTools = [
        "mcp_call",
        "mcp_list"
      ]
      
      if (protectedTools.includes(toolName) || 
          (toolName === "bash" && input.command?.includes("mcp"))) {
        if (!authGuard?.isLoggedIn()) {
          output.error = "Authentication required. Please login first using: opencode login <username> <token>"
          output.skip = true
        }
      }
    },
    
    "experimental.chat.system.transform": async (systemPrompt: string) => {
      if (!authGuard?.isLoggedIn()) {
        return systemPrompt + "\n\n[EDK2 AUTH NOTICE] You are not logged in. Skills and MCP services are disabled. Please login using: opencode login <username> <token>"
      }
      return systemPrompt
    },
    
    "config": (config: any) => {
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

export default plugin

export const authGuardInstance = () => authGuard