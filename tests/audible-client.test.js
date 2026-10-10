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

test('AudibleClient decryptVoucher decrypts AES-128-CBC license vouchers accurately', () => {
  const crypto = require('crypto');
  const mockTokenManager = {
    session: {
      marketplace: 'us',
      deviceType: 'A2CZJZGLK2JJVM',
      deviceSerial: 'TEST_SERIAL_1234',
      userId: 'test_cust_id'
    },
    getDeviceSerial: () => 'TEST_SERIAL_1234'
  };

  const client = new AudibleClient(mockTokenManager);
  const asin = 'B0TESTASIN1';

  // Construct test fixture matching the reference algorithm
  const bufStr = 'A2CZJZGLK2JJVMTEST_SERIAL_1234test_cust_idB0TESTASIN1';
  const digest = crypto.createHash('sha256').update(bufStr, 'ascii').digest();
  const k = digest.subarray(0, 16);
  const v = digest.subarray(16, 32);

  const rawJson = JSON.stringify({ key: '0123456789abcdef0123456789abcdef', iv: 'fedcba9876543210fedcba9876543210' });
  const padLen = 16 - (rawJson.length % 16);
  const paddedBuf = Buffer.concat([Buffer.from(rawJson, 'utf8'), Buffer.alloc(padLen === 16 ? 0 : padLen, 0)]);

  const cipher = crypto.createCipheriv('aes-128-cbc', k, v);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(paddedBuf), cipher.final()]);
  const b64 = encrypted.toString('base64');

  const result = client.decryptVoucher(b64, asin);
  assert.ok(result);
  assert.strictEqual(result.key, '0123456789abcdef0123456789abcdef');
  assert.strictEqual(result.iv, 'fedcba9876543210fedcba9876543210');
});

test('AudibleClient decryptVoucher returns null safely when customerId is missing or voucher is non-AAXC', () => {
  const mockTokenManager = {
    session: {
      marketplace: 'us',
      deviceType: 'A2CZJZGLK2JJVM',
      deviceSerial: 'TEST_SERIAL_1234'
      // No userId / customerId
    },
    getDeviceSerial: () => 'TEST_SERIAL_1234'
  };

  const client = new AudibleClient(mockTokenManager);
  assert.strictEqual(client.decryptVoucher('some_encrypted_string', 'B0TESTASIN1'), null);
  assert.strictEqual(client.decryptVoucher(null, 'B0TESTASIN1'), null);

  // Even with customerId, invalid or non-JSON payloads return null gracefully
  mockTokenManager.session.userId = 'test_cust_id';
  assert.strictEqual(client.decryptVoucher('bm90X3ZhbGlkX2Flcw==', 'B0TESTASIN1'), null);
});

test('AudibleClient getContentLicense aborts when an AAXC voucher cannot be decrypted', async () => {
  const mockTokenManager = {
    session: { marketplace: 'us', deviceType: 'A2CZJZGLK2JJVM', deviceSerial: 'S' },
    getDeviceSerial: () => 'S',
    ensureUserProfile: async () => {}
  };
  const client = new AudibleClient(mockTokenManager);
  client.buildRequestHeaders = async () => ({});

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      content_license: {
        status_code: 'Granted',
        drm_type: 'Adrm',
        license_response: 'bm90X3ZhbGlkX2Flcw==',
        content_metadata: { content_url: { offline_url: 'https://example.invalid/book.aaxc' } }
      }
    })
  });

  try {
    await assert.rejects(() => client.getContentLicense('B0TESTASIN1'), /AAXC voucher/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('AudibleClient getContentLicense respects requested quality option', async () => {
  const mockTokenManager = {
    session: { marketplace: 'us', deviceType: 'A2CZJZGLK2JJVM', deviceSerial: 'S' },
    getDeviceSerial: () => 'S'
  };
  const client = new AudibleClient(mockTokenManager);
  client.buildRequestHeaders = async () => ({});

  let capturedPayloads = [];
  const originalFetch = global.fetch;
  global.fetch = async (_url, opts) => {
    capturedPayloads.push(JSON.parse(opts.body));
    return {
      ok: true,
      json: async () => ({
        content_license: {
          status_code: 'Granted',
          drm_type: 'Adrm',
          content_metadata: { content_url: { offline_url: 'https://example.invalid/book.aax' } }
        }
      })
    };
  };

  try {
    // 1. Default quality is High
    const lic1 = await client.getContentLicense('B0TESTASIN1');
    assert.strictEqual(capturedPayloads[0].quality, 'High');
    assert.strictEqual(lic1.quality, 'High');

    // 2. Explicit Normal quality
    const lic2 = await client.getContentLicense('B0TESTASIN1', { quality: 'Normal' });
    assert.strictEqual(capturedPayloads[1].quality, 'Normal');
    assert.strictEqual(lic2.quality, 'Normal');
  } finally {
    global.fetch = originalFetch;
  }
});

test('AudibleClient fetchLibrary paginates completely across multiple pages', async () => {
  const mockTokenManager = {
    isAuthenticated: () => true,
    session: { marketplace: 'us' }
  };
  const client = new AudibleClient(mockTokenManager);
  client.buildRequestHeaders = async () => ({});

  const requestedUrls = [];
  const originalFetch = global.fetch;

  // Mock API returning 3 pages (total 5 items with pageSize 2):
  // Page 1: 2 items, total_results: 5
  // Page 2: 2 items, total_results: 5
  // Page 3: 1 item, total_results: 5
  global.fetch = async (url) => {
    requestedUrls.push(url);
    const parsedUrl = new URL(url);
    const page = parseInt(parsedUrl.searchParams.get('page'), 10);
    
    let items = [];
    if (page === 1) {
      items = [
        { asin: 'B001', title: 'Book 1', authors: [{ name: 'Author A' }] },
        { asin: 'B002', title: 'Book 2', authors: [{ name: 'Author B' }] }
      ];
    } else if (page === 2) {
      items = [
        { asin: 'B003', title: 'Book 3', authors: [{ name: 'Author C' }] },
        { asin: 'B004', title: 'Book 4', authors: [{ name: 'Author D' }] }
      ];
    } else if (page === 3) {
      items = [
        { asin: 'B005', title: 'Book 5', authors: [{ name: 'Author E' }] }
      ];
    }

    return {
      ok: true,
      json: async () => ({
        items,
        total_results: 5
      })
    };
  };

  try {
    const progressUpdates = [];
    const books = await client.fetchLibrary({
      numResults: 2,
      onPageFetched: (p) => progressUpdates.push(p)
    });

    assert.strictEqual(books.length, 5);
    assert.strictEqual(books[0].asin, 'B001');
    assert.strictEqual(books[4].asin, 'B005');
    assert.strictEqual(requestedUrls.length, 3);
    assert.ok(requestedUrls[0].includes('page=1'));
    assert.ok(requestedUrls[1].includes('page=2'));
    assert.ok(requestedUrls[2].includes('page=3'));
    assert.strictEqual(progressUpdates.length, 3);
    assert.strictEqual(progressUpdates[2].fetchedCount, 5);
  } finally {
    global.fetch = originalFetch;
  }
});

test('AudibleClient fetchLibrary paginates successfully when API provides no total count metadata', async () => {
  const mockTokenManager = {
    isAuthenticated: () => true,
    session: { marketplace: 'us' }
  };
  const client = new AudibleClient(mockTokenManager);
  client.buildRequestHeaders = async () => ({});

  const requestedUrls = [];
  const originalFetch = global.fetch;

  // Page 1 returns full page of 2 items (no total metadata)
  // Page 2 returns 1 item (< pageSize), signaling end
  global.fetch = async (url) => {
    requestedUrls.push(url);
    const parsedUrl = new URL(url);
    const page = parseInt(parsedUrl.searchParams.get('page'), 10);
    
    const items = page === 1 
      ? [{ asin: 'B101', title: 'B1' }, { asin: 'B102', title: 'B2' }]
      : [{ asin: 'B103', title: 'B3' }];

    return {
      ok: true,
      json: async () => ({ items })
    };
  };

  try {
    const books = await client.fetchLibrary({ numResults: 2 });
    assert.strictEqual(books.length, 3);
    assert.strictEqual(requestedUrls.length, 2);
  } finally {
    global.fetch = originalFetch;
  }
});


