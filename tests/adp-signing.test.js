const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DeviceProfile } = require('../src/main/auth/device-profile');
const TokenManager = require('../src/main/auth/token-manager');

test('DeviceProfile generates valid device serial and PKCE parameters', () => {
  const serial = DeviceProfile.generateDeviceSerial();
  assert.strictEqual(typeof serial, 'string');
  assert.strictEqual(serial.length, 32);
  assert.match(serial, /^[0-9A-F]{32}$/);

  const { codeVerifier, codeChallenge } = DeviceProfile.generatePkce();
  assert.strictEqual(typeof codeVerifier, 'string');
  assert.strictEqual(typeof codeChallenge, 'string');

  const expectedChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  assert.strictEqual(codeChallenge, expectedChallenge);
});

test('DeviceProfile creates accurate Amazon MAP registration payload', () => {
  const serial = 'ABC123DEF4567890ABC123DEF4567890';
  const payload = DeviceProfile.buildRegistrationPayload({
    deviceSerial: serial,
    codeVerifier: 'test-verifier-string',
    authCode: 'test-auth-code',
    marketplace: 'uk'
  });

  const expectedClientId = Buffer.from(`${serial}#A2CZJZGLK2JJVM`).toString('hex');

  assert.deepStrictEqual(payload.requested_token_type, ['bearer', 'mac_dms', 'website_cookies', 'store_authentication_cookie']);
  assert.strictEqual(payload.cookies.domain, '.amazon.co.uk');
  assert.strictEqual(payload.registration_data.device_type, 'A2CZJZGLK2JJVM');
  assert.strictEqual(payload.registration_data.app_name, 'Audible');
  assert.strictEqual(payload.registration_data.device_serial, serial);
  assert.strictEqual(payload.auth_data.client_id, expectedClientId);
  assert.strictEqual(payload.auth_data.client_domain, 'DeviceLegacy');
  assert.strictEqual(payload.auth_data.authorization_code, 'test-auth-code');
  assert.strictEqual(payload.auth_data.code_verifier, 'test-verifier-string');
  assert.strictEqual(payload.auth_data.code_algorithm, 'SHA-256');
});

test('DeviceProfile builds OAuth URL with oa2 namespace and hex device client_id', () => {
  const serial = 'ABC123DEF4567890ABC123DEF4567890';
  const url = new URL(DeviceProfile.buildOAuthUrl({ deviceSerial: serial, codeChallenge: 'challenge123', marketplace: 'us' }));
  const p = url.searchParams;

  assert.strictEqual(url.origin + url.pathname, 'https://www.amazon.com/ap/signin');
  // Without this namespace Amazon ignores openid.oa2.* and returns no authorization code
  assert.strictEqual(p.get('openid.ns.oa2'), 'http://www.amazon.com/ap/ext/oauth/2');
  assert.strictEqual(p.get('openid.oa2.client_id'), `device:${Buffer.from(`${serial}#A2CZJZGLK2JJVM`).toString('hex')}`);
  assert.strictEqual(p.get('openid.oa2.response_type'), 'code');
  assert.strictEqual(p.get('openid.oa2.code_challenge'), 'challenge123');
  assert.strictEqual(p.get('openid.oa2.code_challenge_method'), 'S256');
  assert.strictEqual(p.get('openid.return_to'), 'https://www.amazon.com/ap/maplanding');
  assert.strictEqual(p.get('openid.assoc_handle'), 'amzn_audible_ios_us');
  assert.strictEqual(p.get('pageId'), 'amzn_audible_ios');
  assert.strictEqual(p.get('marketPlaceId'), 'AF2M0KC94RCEA');
});

test('DeviceProfile.parseLoginRedirect only completes on real maplanding redirect', () => {
  // Intermediate OTP page that references return_to must NOT complete the flow
  const otpPage = 'https://www.amazon.com/ap/mfa?openid.return_to=https://www.amazon.com/ap/maplanding&arb=abc';
  assert.deepStrictEqual(DeviceProfile.parseLoginRedirect(otpPage), { state: 'pending' });

  const signin = 'https://www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fwww.amazon.com%2Fap%2Fmaplanding';
  assert.deepStrictEqual(DeviceProfile.parseLoginRedirect(signin), { state: 'pending' });

  // Non-Amazon host with the same path is ignored
  assert.deepStrictEqual(DeviceProfile.parseLoginRedirect('https://evil.example/ap/maplanding?openid.oa2.authorization_code=x'), { state: 'pending' });

  const ok = 'https://www.amazon.co.uk/ap/maplanding?openid.oa2.authorization_code=ANcode123&openid.mode=id_res';
  assert.deepStrictEqual(DeviceProfile.parseLoginRedirect(ok), { state: 'code', code: 'ANcode123' });

  const cancelled = DeviceProfile.parseLoginRedirect('https://www.amazon.com/ap/maplanding?openid.mode=cancel');
  assert.strictEqual(cancelled.state, 'error');
});

test('DeviceProfile cryptographically signs ADP requests using SHA256withRSA', () => {
  // Generate real 2048-bit RSA keypair for signature verification
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  const adpToken = 'adp_token_mock_test_12345';
  const method = 'GET';
  const pathWithQuery = '/1.0/library?num_results=50&page=1';
  const timestamp = '2026-10-09T16:00:00.000Z';

  const { signatureHeader, timestamp: retTimestamp } = DeviceProfile.signAdpRequest({
    method,
    pathWithQuery,
    body: '',
    adpToken,
    privateKeyPem: privateKey,
    timestamp
  });

  assert.strictEqual(retTimestamp, timestamp);
  assert.ok(signatureHeader.includes(':'));

  const colonIdx = signatureHeader.indexOf(':');
  const sigBase64 = signatureHeader.substring(0, colonIdx);
  const sigTime = signatureHeader.substring(colonIdx + 1);
  assert.strictEqual(sigTime, timestamp);

  // Verify the signature against the public key
  const expectedPayload = `${method}\n${pathWithQuery}\n${timestamp}\n\n${adpToken}`;
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(expectedPayload);
  const isValid = verifier.verify(publicKey, sigBase64, 'base64');

  assert.strictEqual(isValid, true, 'ADP signature must be cryptographically valid');
});

test('TokenManager imports mkb79/audible and Libation auth.json formats correctly', () => {
  const tmpDir = path.join(__dirname, 'tmp_token_test');
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const tm = new TokenManager(tmpDir);

    // Initial state: not authenticated
    assert.strictEqual(tm.isAuthenticated(), false);

    // Sample mkb79/audible auth.json structure
    const sampleMkb79 = {
      adp_token: 'adp_sample_mkb79_xyz',
      device_private_key: '-----BEGIN RSA PRIVATE KEY-----\nMIIEogIBAAKCAQEA0...\n-----END RSA PRIVATE KEY-----',
      access_token: 'Atna|sample_access_token_123',
      refresh_token: 'Atnr|sample_refresh_token_456',
      device_serial: 'SERIAL12345',
      locale_code: 'us',
      activation_bytes: 'aabbccdd',
      customer_info: {
        name: 'Test Audible User'
      }
    };

    const sessionInfo = tm.importAuthJson(sampleMkb79);
    assert.strictEqual(sessionInfo.isAuthenticated, true);
    assert.strictEqual(sessionInfo.hasAdpCredentials, true);
    assert.strictEqual(sessionInfo.userName, 'Test Audible User');
    assert.strictEqual(sessionInfo.activationBytes, 'aabbccdd');

    // Reload from disk to verify persistence
    const tmReloaded = new TokenManager(tmpDir);
    assert.strictEqual(tmReloaded.isAuthenticated(), true);
    assert.strictEqual(tmReloaded.hasAdpCredentials(), true);
    assert.strictEqual(tmReloaded.session.adpToken, 'adp_sample_mkb79_xyz');
    assert.strictEqual(tmReloaded.session.activationBytes, 'aabbccdd');

    // Clear session
    tmReloaded.clear();
    assert.strictEqual(tmReloaded.isAuthenticated(), false);
  } finally {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
});
