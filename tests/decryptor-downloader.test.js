/**
 * Unit Tests - Decryptor key selection & Downloader source retention
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Decryptor = require('../src/main/media/decryptor');
const Downloader = require('../src/main/media/downloader');

const KEY = '0123456789abcdef0123456789abcdef';
const IV = 'fedcba9876543210fedcba9876543210';

test('Decryptor.buildKeyArgs uses voucher key/iv for AAXC', () => {
  const args = Decryptor.buildKeyArgs({ inputPath: 'Book.aaxc', voucher: { key: KEY, iv: IV }, activationBytes: '0445f805' });
  assert.deepStrictEqual(args, ['-audible_key', KEY, '-audible_iv', IV]);
});

test('Decryptor.buildKeyArgs refuses activation bytes for AAXC (prevents corrupt M4B)', () => {
  const result = Decryptor.buildKeyArgs({ inputPath: 'Book.aaxc', voucher: null, activationBytes: '0445f805' });
  assert.ok(result instanceof Error);
  const bad = Decryptor.buildKeyArgs({ inputPath: 'Book.aaxc', voucher: { key: 'zz', iv: IV } });
  assert.ok(bad instanceof Error);
});

test('Decryptor.buildKeyArgs uses activation bytes only for AAX', () => {
  assert.deepStrictEqual(
    Decryptor.buildKeyArgs({ inputPath: 'Book.aax', activationBytes: '0445f805' }),
    ['-activation_bytes', '0445f805']
  );
  assert.ok(Decryptor.buildKeyArgs({ inputPath: 'Book.aax', activationBytes: '00000000' }) instanceof Error);
  assert.ok(Decryptor.buildKeyArgs({ inputPath: 'Book.aax', activationBytes: null }) instanceof Error);
});

test('Downloader.findRetainedSource reuses only complete, size-verified encrypted sources', () => {
  const dir = path.join(os.tmpdir(), `readfree_retain_${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const paths = Downloader.getPaths(dir, 'Redwood');

  // Nothing on disk
  assert.strictEqual(Downloader.findRetainedSource(paths, 'B0GGNKSBRQ'), null);

  fs.writeFileSync(paths.aaxc, Buffer.alloc(2048, 1));
  fs.writeFileSync(paths.licenseJson, JSON.stringify({
    asin: 'B0GGNKSBRQ', format: 'aaxc', voucher: { key: KEY, iv: IV }, sizeBytes: 2048
  }));

  const found = Downloader.findRetainedSource(paths, 'B0GGNKSBRQ');
  assert.ok(found);
  assert.strictEqual(found.encryptedPath, paths.aaxc);
  assert.strictEqual(found.license.voucher.key, KEY);

  // Different ASIN is rejected
  assert.strictEqual(Downloader.findRetainedSource(paths, 'B000000000'), null);

  // Truncated file is rejected
  fs.writeFileSync(paths.aaxc, Buffer.alloc(1000, 1));
  assert.strictEqual(Downloader.findRetainedSource(paths, 'B0GGNKSBRQ'), null);

  fs.rmSync(dir, { recursive: true, force: true });
});
