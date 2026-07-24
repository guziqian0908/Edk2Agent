/**
 * Tests for EDK2 API Provider Plugin
 */

const assert = require('assert')
const Edk2ApiProvider = require('../.opencode/plugins/edk2-api-provider.js').Edk2ApiProvider

function testInitialSetup() {
  const provider = new Edk2ApiProvider()
  
  assert.strictEqual(provider.hasUserConfig('anthropic'), false)
  assert.strictEqual(provider.hasUserConfig('openai'), false)
  
  console.log('✓ testInitialSetup passed')
}

function testSetUserConfig() {
  const provider = new Edk2ApiProvider()
  
  provider.setUserConfig('anthropic', 'sk-test-key-123', 'https://api.example.com')
  
  assert.strictEqual(provider.hasUserConfig('anthropic'), true)
  assert.strictEqual(provider.hasUserConfig('openai'), false)
  
  const config = provider.getActiveConfig('anthropic')
  assert.strictEqual(config.apiKey, 'sk-test-key-123')
  assert.strictEqual(config.baseUrl, 'https://api.example.com')
  
  console.log('✓ testSetUserConfig passed')
}

function testApiPriority() {
  const provider = new Edk2ApiProvider()
  
  process.env.EDK2_BUILTIN_ANTHROPIC_KEY = 'builtin-test-key'
  
  const configWithoutUser = provider.getActiveConfig('anthropic')
  
  provider.setUserConfig('anthropic', 'user-test-key')
  const configWithUser = provider.getActiveConfig('anthropic')
  
  assert.strictEqual(configWithUser.apiKey, 'user-test-key', 'User config should take priority')
  
  delete process.env.EDK2_BUILTIN_ANTHROPIC_KEY
  
  console.log('✓ testApiPriority passed')
}

function testDefaultModel() {
  const provider = new Edk2ApiProvider()
  
  assert.strictEqual(provider.getDefaultModel('anthropic'), 'claude-sonnet-4-6')
  assert.strictEqual(provider.getDefaultModel('openai'), 'gpt-4')
  assert.strictEqual(provider.getDefaultModel('zhipu'), 'glm-5')
  assert.strictEqual(provider.getDefaultModel('unknown'), 'glm-5')
  
  console.log('✓ testDefaultModel passed')
}

function testLogApiStatus() {
  const provider = new Edk2ApiProvider()
  
  provider.setUserConfig('anthropic', 'sk-ant-test123')
  
  console.log('\n--- Testing logApiStatus output ---')
  provider.logApiStatus()
  console.log('--- End logApiStatus ---\n')
  
  console.log('✓ testLogApiStatus passed')
}

function testConfigHook() {
  const provider = new Edk2ApiProvider()
  
  process.env.EDK2_BUILTIN_ANTHROPIC_KEY = 'builtin-key-12345'
  
  provider.setUserConfig('openai', 'user-openai-key')
  
  const anthropicConfig = provider.getActiveConfig('anthropic')
  assert.ok(anthropicConfig, 'Should have anthropic config')
  
  const openaiConfig = provider.getActiveConfig('openai')
  assert.strictEqual(openaiConfig.apiKey, 'user-openai-key')
  
  delete process.env.EDK2_BUILTIN_ANTHROPIC_KEY
  
  console.log('✓ testConfigHook passed')
}

function runTests() {
  console.log('\n=== EDK2 API Provider Tests ===\n')
  
  testInitialSetup()
  testSetUserConfig()
  testApiPriority()
  testDefaultModel()
  testLogApiStatus()
  testConfigHook()
  
  console.log('\n=== All tests passed ===\n')
}

runTests()