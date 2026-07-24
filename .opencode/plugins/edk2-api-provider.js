const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const BUILTIN_GLMAPI = {
  provider: 'zhipu',
  apiKey: process.env.EDK2_BUILTIN_ZHIPU_KEY || '',
  model: 'glm-5',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4/'
};

const BUILTIN_API_CONFIGS = [
  BUILTIN_GLMAPI,
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
];

const FALLBACK_API = BUILTIN_GLMAPI;

const CACHE_TTL_MS = 60 * 60 * 1000;

class ConversationCache {
  constructor() {
    this.cache = new Map();
    this.maxSize = 100;
  }
  
  _hashPrompt(prompt) {
    const crypto = require('crypto');
    return crypto.createHash('md5').update(prompt).digest('hex');
  }
  
  get(prompt) {
    const key = this._hashPrompt(prompt);
    const cached = this.cache.get(key);
    
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      console.log('[EDK2 CACHE] Cache hit');
      return cached.response;
    }
    
    if (cached) {
      this.cache.delete(key);
    }
    
    return null;
  }
  
  set(prompt, response) {
    const key = this._hashPrompt(prompt);
    
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    
    this.cache.set(key, {
      response,
      timestamp: Date.now()
    });
    console.log('[EDK2 CACHE] Response cached');
  }
  
  clear() {
    this.cache.clear();
    console.log('[EDK2 CACHE] Cache cleared');
  }
  
  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      ttlHours: CACHE_TTL_MS / (60 * 60 * 1000)
    };
  }
}

class Edk2ApiProvider {
  constructor() {
    this.userApiConfig = new Map();
    this.activeConfig = null;
    this.conversationCache = new ConversationCache();
    this.requestCount = 0;
    this.cacheHitCount = 0;
  }
  
  hasUserConfig(provider) {
    return this.userApiConfig.has(provider);
  }
  
  setUserConfig(provider, apiKey, baseUrl, model) {
    this.userApiConfig.set(provider, {
      provider,
      apiKey,
      baseUrl,
      model: model || this.getDefaultModel(provider)
    });
    console.log(`[EDK2 API] User config set for ${provider}`);
  }
  
  getActiveConfig(provider) {
    if (this.userApiConfig.has(provider)) {
      this.activeConfig = this.userApiConfig.get(provider);
      console.log(`[EDK2 API] Using user-configured API for ${provider}`);
    } else {
      const builtin = BUILTIN_API_CONFIGS.find(c => c.provider === provider && c.apiKey);
      if (builtin) {
        this.activeConfig = builtin;
        console.log(`[EDK2 API] Using built-in API for ${provider}`);
      } else {
        this.activeConfig = FALLBACK_API;
        console.log(`[EDK2 API] No API configured for ${provider}, using GLM-5 fallback`);
      }
    }
    return this.activeConfig;
  }
  
  getDefaultModel(provider) {
    const defaults = {
      zhipu: 'glm-5',
      anthropic: 'claude-sonnet-4-6',
      openai: 'gpt-4'
    };
    return defaults[provider] || 'glm-5';
  }
  
  getCachedResponse(prompt) {
    return this.conversationCache.get(prompt);
  }
  
  cacheResponse(prompt, response) {
    this.conversationCache.set(prompt, response);
  }
  
  incrementRequestCount() {
    this.requestCount++;
  }
  
  incrementCacheHitCount() {
    this.cacheHitCount++;
  }
  
  getStats() {
    return {
      totalRequests: this.requestCount,
      cacheHits: this.cacheHitCount,
      cacheHitRate: this.requestCount > 0 ? (this.cacheHitCount / this.requestCount * 100).toFixed(1) : 0,
      cacheStats: this.conversationCache.getStats()
    };
  }
  
  logApiStatus() {
    console.log('[EDK2 API] API Provider Status:');
    
    if (this.userApiConfig.size > 0) {
      for (const [provider, config] of this.userApiConfig) {
        console.log(`  - ${provider}: User configured (key: ${config.apiKey.substring(0, 8)}...)`);
      }
    } else {
      console.log('  - No user API configured');
    }
    
    for (const builtin of BUILTIN_API_CONFIGS) {
      if (builtin.apiKey && !this.userApiConfig.has(builtin.provider)) {
        console.log(`  - ${builtin.provider}: Built-in available (${builtin.model})`);
      }
    }
    
    console.log(`  - Cache: ${this.conversationCache.getStats().size} entries`);
  }
}

let apiProvider = null;

module.exports = async (input) => {
  apiProvider = new Edk2ApiProvider();
  
  return {
    'config': (config) => {
      if (!config.provider) {
        config.provider = {};
      }
      
      const providers = ['zhipu', 'anthropic', 'openai'];
      
      for (const provider of providers) {
        if (!config.provider[provider]?.options?.apiKey) {
          const activeConfig = apiProvider?.getActiveConfig(provider);
          if (activeConfig?.apiKey) {
            if (!config.provider[provider]) {
              config.provider[provider] = { options: {} };
            }
            config.provider[provider].options = {
              ...config.provider[provider].options,
              apiKey: activeConfig.apiKey
            };
            if (activeConfig.baseUrl) {
              config.provider[provider].options.baseUrl = activeConfig.baseUrl;
            }
          }
        } else {
          apiProvider?.setUserConfig(
            provider,
            config.provider[provider].options.apiKey,
            config.provider[provider].options.baseUrl
          );
          console.log(`[EDK2 API] Detected user configuration for ${provider}`);
        }
      }
      
      apiProvider?.logApiStatus();
    },
    
    'chat.headers': async (headers) => {
      return headers;
    },
    
    'chat.params': async (params) => {
      if (params.messages && params.messages.length > 0) {
        const lastMessage = params.messages[params.messages.length - 1];
        if (lastMessage.content) {
          const cached = apiProvider?.getCachedResponse(lastMessage.content);
          if (cached) {
            apiProvider?.incrementCacheHitCount();
            console.log('[EDK2 API] Using cached response');
          }
          apiProvider?.incrementRequestCount();
        }
      }
      return params;
    },
    
    'experimental.chat.response': async (response) => {
      if (response && response.content) {
        const lastMessage = response.messages?.[response.messages.length - 1];
        if (lastMessage?.content) {
          apiProvider?.cacheResponse(lastMessage.content, response.content);
        }
      }
      return response;
    }
  };
};

module.exports.Edk2ApiProvider = Edk2ApiProvider;
module.exports.apiProviderInstance = () => apiProvider;