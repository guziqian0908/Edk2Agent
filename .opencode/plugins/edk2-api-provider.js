/**
 * EDK2 API Provider Plugin (JavaScript version)
 * Provides built-in API token as fallback when user hasn't configured their own
 */

const BUILTIN_API_CONFIGS = [
  {
    provider: 'anthropic',
    apiKey: process.env.EDK2_BUILTIN_ANTHROPIC_KEY || '',
    model: 'claude-sonnet-4-6'
  },
  {
    provider: 'openai',
    apiKey: process.env.EDK2_BUILTIN_OPENAI_KEY || '',
    model: 'gpt-4'
  }
]

const FALLBACK_API = {
  provider: 'anthropic',
  apiKey: '',
  model: 'claude-sonnet-4-6'
}

class Edk2ApiProvider {
  constructor() {
    this.userApiConfig = new Map()
    this.activeConfig = null
  }
  
  hasUserConfig(provider) {
    return this.userApiConfig.has(provider)
  }
  
  setUserConfig(provider, apiKey, baseUrl, model) {
    this.userApiConfig.set(provider, {
      provider,
      apiKey,
      baseUrl,
      model: model || this.getDefaultModel(provider)
    })
  }
  
  getActiveConfig(provider) {
    if (this.userApiConfig.has(provider)) {
      this.activeConfig = this.userApiConfig.get(provider)
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
  
  getDefaultModel(provider) {
    const defaults = {
      anthropic: 'claude-sonnet-4-6',
      openai: 'gpt-4'
    }
    return defaults[provider] || 'gpt-4'
  }
  
  logApiStatus() {
    console.log('[EDK2 API] API Provider Status:')
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

let apiProvider = null

module.exports = async (input) => {
  apiProvider = new Edk2ApiProvider()
  
  return {
    'config': (config) => {
      if (!config.provider) {
        config.provider = {}
      }
      
      const providers = ['anthropic', 'openai']
      
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
    
    'chat.headers': async (headers) => {
      return headers
    },
    
    'chat.params': async (params) => {
      return params
    }
  }
}

module.exports.Edk2ApiProvider = Edk2ApiProvider
module.exports.apiProviderInstance = () => apiProvider