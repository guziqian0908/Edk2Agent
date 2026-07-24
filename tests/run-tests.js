#!/usr/bin/env node

/**
 * EDK2 Custom OpenCode Tool - Test Runner
 */

const { spawn } = require('child_process')
const path = require('path')

const tests = [
  'test-auth-guard.js',
  'test-api-provider.js'
]

async function runTest(testFile) {
  return new Promise((resolve, reject) => {
    console.log(`\nRunning: ${testFile}`)
    console.log('='.repeat(50))
    
    const proc = spawn('node', [testFile], {
      cwd: __dirname,
      stdio: 'inherit'
    })
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Test ${testFile} failed with code ${code}`))
      }
    })
    
    proc.on('error', reject)
  })
}

async function runAll() {
  console.log('\n' + '='.repeat(50))
  console.log('EDK2 Custom OpenCode Tool - Test Suite')
  console.log('='.repeat(50))
  
  let passed = 0
  let failed = 0
  
  for (const test of tests) {
    try {
      await runTest(test)
      passed++
    } catch (err) {
      console.error(`\n❌ ${test} failed:`, err.message)
      failed++
    }
  }
  
  console.log('\n' + '='.repeat(50))
  console.log('Test Summary')
  console.log('='.repeat(50))
  console.log(`Passed: ${passed}/${tests.length}`)
  console.log(`Failed: ${failed}/${tests.length}`)
  
  if (failed > 0) {
    process.exit(1)
  }
}

runAll().catch(err => {
  console.error('Test runner error:', err)
  process.exit(1)
})