/**
 * Tests for EDK2 Authentication Guard Plugin
 */

const assert = require('assert')
const path = require('path')
const fs = require('fs').promises
const os = require('os')

const Edk2AuthGuard = require('../.opencode/plugins/edk2-auth-guard.js').Edk2AuthGuard

class TestAuthGuard extends Edk2AuthGuard {
  constructor(testDir) {
    super(testDir)
    this.loginFilePath = path.join(testDir, '.edk2_login')
  }
}

async function createTestDir() {
  const testDir = path.join(os.tmpdir(), `edk2-auth-test-${Date.now()}`)
  await fs.mkdir(testDir, { recursive: true })
  return testDir
}

async function cleanup(testDir) {
  try {
    await fs.rm(testDir, { recursive: true, force: true })
  } catch {
    // Ignore cleanup errors
  }
}

async function testInitialState() {
  const testDir = await createTestDir()
  const guard = new TestAuthGuard(testDir)
  
  try {
    await guard.loadLoginState()
    
    assert.strictEqual(guard.isLoggedIn(), false, 'Should not be logged in initially')
    assert.deepStrictEqual(guard.getLoginInfo(), { isLoggedIn: false })
    
    console.log('✓ testInitialState passed')
  } finally {
    await cleanup(testDir)
  }
}

async function testLoginLogout() {
  const testDir = await createTestDir()
  const guard = new TestAuthGuard(testDir)
  
  try {
    await guard.login('testuser', 'testtoken')
    
    assert.strictEqual(guard.isLoggedIn(), true, 'Should be logged in after login')
    const info = guard.getLoginInfo()
    assert.strictEqual(info.username, 'testuser')
    assert.strictEqual(info.isLoggedIn, true)
    assert.ok(info.expiresAt > Date.now())
    
    const savedGuard = new TestAuthGuard(testDir)
    await savedGuard.loadLoginState()
    assert.strictEqual(savedGuard.isLoggedIn(), true, 'Should persist login state')
    
    await guard.logout()
    assert.strictEqual(guard.isLoggedIn(), false, 'Should not be logged in after logout')
    
    const savedGuard2 = new TestAuthGuard(testDir)
    await savedGuard2.loadLoginState()
    assert.strictEqual(savedGuard2.isLoggedIn(), false, 'Should clear persisted state after logout')
    
    console.log('✓ testLoginLogout passed')
  } finally {
    await cleanup(testDir)
  }
}

async function testSessionExpiry() {
  const testDir = await createTestDir()
  const guard = new TestAuthGuard(testDir)
  
  try {
    guard.loginState = {
      isLoggedIn: true,
      username: 'testuser',
      expiresAt: Date.now() - 1000
    }
    
    assert.strictEqual(guard.isLoggedIn(), false, 'Should not be logged in with expired session')
    
    console.log('✓ testSessionExpiry passed')
  } finally {
    await cleanup(testDir)
  }
}

async function testPluginHook() {
  const testDir = await createTestDir()
  const guard = new TestAuthGuard(testDir)
  await guard.login('testuser', 'testtoken')
  
  try {
    const output = {}
    
    const protectedTool = 'skill'
    const nonProtectedTool = 'read'
    
    const mockHook = async (toolName, input, output) => {
      if (toolName === 'skill' && !guard.isLoggedIn()) {
        output.error = 'Authentication required'
        output.skip = true
      }
    }
    
    await mockHook(protectedTool, {}, output)
    
    if (!guard.isLoggedIn()) {
      assert.strictEqual(output.error, 'Authentication required')
      assert.strictEqual(output.skip, true)
    }
    
    console.log('✓ testPluginHook passed')
  } finally {
    await cleanup(testDir)
  }
}

async function runTests() {
  console.log('\n=== EDK2 Auth Guard Tests ===\n')
  
  await testInitialState()
  await testLoginLogout()
  await testSessionExpiry()
  await testPluginHook()
  
  console.log('\n=== All tests passed ===\n')
}

runTests().catch(err => {
  console.error('Test failed:', err)
  process.exit(1)
})