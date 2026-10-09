/**
 * Unit Tests - Audible Client Parser
 */

const test = require('node:test');
const assert = require('node:assert');
const AudibleClient = require('../src/main/api/audible-client');

test('AudibleClient formatDuration formats seconds correctly', () => {
  const client = new AudibleClient({ session: { marketplace: 'us' } });

  assert.strictEqual(client.formatDuration(0), '0 mins');
  assert.strictEqual(client.formatDuration(1800), '30 mins');
  assert.strictEqual(client.formatDuration(3600), '1 hrs 0 mins');
  assert.strictEqual(client.formatDuration(57660), '16 hrs 1 min');
  assert.strictEqual(client.formatDuration(null), 'Unknown');
});

test('AudibleClient parseBookItem normalizes raw Audible API item', () => {
  const client = new AudibleClient({ session: { marketplace: 'us' } });

  const rawItem = {
    asin: 'B08G9W28Z1',
    title: 'Project Hail Mary',
    authors: [{ name: 'Andy Weir' }],
    narrators: [{ name: 'Ray Porter' }],
    series: [{ title: 'Cosmic Trilogy', sequence: '1' }],
    runtime_length_min: 961,
    product_images: {
      '500': 'https://image.com/500.jpg',
      '1000': 'https://image.com/1000.jpg'
    },
    companion_material: {
      pdf_url: 'https://example.com/companion.pdf'
    },
    purchase_date: '2021-06-01T12:00:00Z',
    release_date: '2021-05-04',
    summary: 'A thrilling mission.'
  };

  const parsed = client.parseBookItem(rawItem);

  assert.strictEqual(parsed.asin, 'B08G9W28Z1');
  assert.strictEqual(parsed.title, 'Project Hail Mary');
  assert.strictEqual(parsed.authors, 'Andy Weir');
  assert.strictEqual(parsed.narrators, 'Ray Porter');
  assert.strictEqual(parsed.series, 'Cosmic Trilogy');
  assert.strictEqual(parsed.seriesSequence, '1');
  assert.strictEqual(parsed.runtimeSeconds, 57660);
  assert.strictEqual(parsed.durationFormatted, '16 hrs 1 min');
  assert.strictEqual(parsed.coverUrl, 'https://image.com/1000.jpg');
  assert.strictEqual(parsed.pdfUrl, 'https://example.com/companion.pdf');
  assert.strictEqual(parsed.status, 'ready');
});

test('AudibleClient buildRequestHeaders attaches valid ADP headers and modern User-Agent', async () => {
  const crypto = require('crypto');
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  const mockTokenManager = {
    session: {
      marketplace: 'us',
      adpToken: 'test_adp_token_xyz',
      devicePrivateKey: privateKey
    },
    getValidAccessToken: async () => 'test_access_token_123'
  };

  const client = new AudibleClient(mockTokenManager);
  const headers = await client.buildRequestHeaders('GET', 'https://api.audible.com/1.0/library?num_results=50');

  assert.strictEqual(headers['x-adp-token'], 'test_adp_token_xyz');
  assert.strictEqual(headers['x-adp-alg'], 'SHA256withRSA:1.0');
  assert.ok(headers['x-adp-signature'].includes(':'));
  assert.strictEqual(headers['Authorization'], 'Bearer test_access_token_123');
  assert.match(headers['User-Agent'], /Audible\/3\.56\.2/);
});

