/**
 * Unit Tests - TokenManager
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const TokenManager = require('../src/main/auth/token-manager');

test('TokenManager stores session, calculates auth status, and clears', () => {
  const tmpDir = path.join(os.tmpdir(), `readfree_tok_test_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const manager = new TokenManager(tmpDir);

  // Initially unauthenticated
  assert.strictEqual(manager.isAuthenticated(), false);
  assert.strictEqual(manager.getSessionInfo().isAuthenticated, false);

  // Set session
  manager.setSession({
    accessToken: 'test_token_123',
    refreshToken: 'test_refresh_456',
    expiresAt: Date.now() + 3600000,
    marketplace: 'us',
    userName: 'John Doe',
    activationBytes: '11223344'
  });

  assert.strictEqual(manager.isAuthenticated(), true);
  const info = manager.getSessionInfo();
  assert.strictEqual(info.userName, 'John Doe');
  assert.strictEqual(info.activationBytes, '11223344');

  // Persistence reload
  const reloaded = new TokenManager(tmpDir);
  assert.strictEqual(reloaded.isAuthenticated(), true);
  assert.strictEqual(reloaded.getSessionInfo().userName, 'John Doe');

  // Clear / Logout
  reloaded.clear();
  assert.strictEqual(reloaded.isAuthenticated(), false);

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
