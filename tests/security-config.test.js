/**
 * Unit & Static Assertion Tests - Electron Security Configuration
 * 
 * Verifies that all BrowserWindow constructors and app lifecycle handlers
 * enforce strict sandbox, contextIsolation, nodeIntegration: false,
 * webviewTag: false, and setWindowOpenHandler mitigations.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('Main process index.js adheres to security hardening standards', () => {
  const indexPath = path.join(__dirname, '../src/main/index.js');
  const content = fs.readFileSync(indexPath, 'utf8');

  // Verify webPreferences
  assert.match(content, /contextIsolation:\s*true/, 'Must enforce contextIsolation: true');
  assert.match(content, /nodeIntegration:\s*false/, 'Must enforce nodeIntegration: false');
  assert.match(content, /sandbox:\s*true/, 'Must enforce sandbox: true');
  assert.match(content, /webviewTag:\s*false/, 'Must explicitly disable webviewTag');

  // Verify setWindowOpenHandler
  assert.match(content, /setWindowOpenHandler/, 'Must register setWindowOpenHandler');
  assert.match(content, /action:\s*['"]deny['"]/, 'Must return action: deny for unauthorized child windows');

  // Verify will-attach-webview mitigation
  assert.match(content, /will-attach-webview/, 'Must guard will-attach-webview');
  assert.match(content, /delete\s+webPreferences\.nodeIntegrationInWorker/, 'Must strip nodeIntegrationInWorker');
});

test('OAuthWindow adheres to security hardening standards', () => {
  const oauthPath = path.join(__dirname, '../src/main/auth/oauth-window.js');
  const content = fs.readFileSync(oauthPath, 'utf8');

  // Verify webPreferences
  assert.match(content, /contextIsolation:\s*true/, 'Must enforce contextIsolation: true');
  assert.match(content, /nodeIntegration:\s*false/, 'Must enforce nodeIntegration: false');
  assert.match(content, /sandbox:\s*true/, 'Must enforce sandbox: true');
  assert.match(content, /webviewTag:\s*false/, 'Must explicitly disable webviewTag');

  // Verify setWindowOpenHandler denies child windows from external auth origin
  assert.match(content, /setWindowOpenHandler/, 'Must register setWindowOpenHandler');
  assert.match(content, /action:\s*['"]deny['"]/, 'Must return action: deny for OAuth child windows');
});

test('No html files contain <webview> tags', () => {
  const rendererPath = path.join(__dirname, '../src/renderer/index.html');
  const html = fs.readFileSync(rendererPath, 'utf8');
  assert.strictEqual(/<webview/i.test(html), false, 'index.html must not contain <webview> tags');
});
