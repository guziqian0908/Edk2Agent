/**
 * EDK2 API Provider Plugin
 * Provides built-in API token as fallback when user hasn't configured their own
 */

import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin"

interface ApiConfig {
  provider: string
  apiKey: string
  baseUrl?: string
  model: string
}

const BUILTIN_API_CONFIGS: ApiConfig[] = [
  {
    provider: "anthropic",
    apiKey: process.env.EDK2_BUILTIN_ANTHROPIC_KEY || "",
    model: "claude-sonnet-4-6"
  },
  {
    provider: "openai",
    apiKey: process.env.EDK2_BUILTIN_OPENAI_KEY || "",
    model: "gpt-4"
  }
]

const FALLBACK_API: ApiConfig = {
  provider: "anthropic",
  apiKey: "",
  model: "claude-sonnet-4-6"
}

class Edk2ApiProvider {
  private userApiConfig: Map<string, ApiConfig> = new Map()
  private activeConfig: ApiConfig | null = null
  
  hasUserConfig(provider: string): boolean {
    return this.userApiConfig.has(provider)
  }
  
  setUserConfig(provider: string, apiKey: string, baseUrl?: string, model?: string): void {
    this.userApiConfig.set(provider, {
      provider,
      apiKey,
      baseUrl,
      model: model || this.getDefaultModel(provider)
    })
  }
  
  getActiveConfig(provider: string): ApiConfig {
    if (this.userApiConfig.has(provider)) {
      this.activeConfig = this.userApiConfig.get(provider)!
      console.log(`[EDK2 API] Using user-configured API for ${provider}`)
    } else {
      const builtin = BUILTIN_API_CONFIGS.find(c => c.provider === provider && c.apiKey)
      if (builtin) {
        this.activeConfig = builtin
        console.log(`[EDK2 API] Using built-in API for ${provider}`)
      } else {
        this.activeConfig = FALLBACK_API
        console.log(`[EDK2 API] No API configured for ${provider}, using fallback`)
      }
    }
    return this.activeConfig
  }
  
  getDefaultModel(provider: string): string {
    const defaults: Record<string, string> = {
      anthropic: "claude-sonnet-4-6",
      openai: "gpt-4"
    }
    return defaults[provider] || "gpt-4"
  }
  
  logApiStatus(): void {
    console.log("[EDK2 API] API Provider Status:")
    for (const [provider, config] of this.userApiConfig) {
      console.log(`  - ${provider}: User configured (key: ${config.apiKey.substring(0, 8)}...)`)
    }
    for (const builtin of BUILTIN_API_CONFIGS) {
      if (builtin.apiKey && !this.userApiConfig.has(builtin.provider)) {
        console.log(`  - ${builtin.provider}: Built-in available`)
      }
    }
  }
}

let apiProvider: Edk2ApiProvider | null = null

const plugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
  apiProvider = new Edk2ApiProvider()
  
  return {
    "config": (config: any) => {
      if (!config.provider) {
        config.provider = {}
      }
      
      const providers = ["anthropic", "openai"]
      
      for (const provider of providers) {
        if (!config.provider[provider]?.options?.apiKey) {
          const activeConfig = apiProvider?.getActiveConfig(provider)
          if (activeConfig?.apiKey) {
            if (!config.provider[provider]) {
              config.provider[provider] = { options: {} }
            }
            config.provider[provider].options = {
              ...config.provider[provider].options,
              apiKey: activeConfig.apiKey
            }
            if (activeConfig.baseUrl) {
              config.provider[provider].options.baseUrl = activeConfig.baseUrl
            }
          }
        } else {
          apiProvider?.setUserConfig(
            provider,
            config.provider[provider].options.apiKey,
            config.provider[provider].options.baseUrl
          )
          console.log(`[EDK2 API] Detected user configuration for ${provider}`)
        }
      }
      
      apiProvider?.logApiStatus()
    },
    
    "chat.headers": async (headers: Record<string, string>) => {
      return headers
    },
    
    "chat.params": async (params: any) => {
      return params
    }
  }
}

export default plugin

export const apiProviderInstance = () => apiProvider