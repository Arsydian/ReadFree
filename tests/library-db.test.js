/**
 * Unit Tests - LibraryDB Storage
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const LibraryDB = require('../src/main/store/library-db');

test('LibraryDB handles upsert, query, and search correctly', () => {
  const tmpDir = path.join(os.tmpdir(), `readfree_db_test_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const db = new LibraryDB(tmpDir);

  const book1 = {
    asin: 'B001',
    title: 'The Way of Kings',
    authors: 'Brandon Sanderson',
    series: 'The Stormlight Archive',
    status: 'ready'
  };

  const book2 = {
    asin: 'B002',
    title: 'Project Hail Mary',
    authors: 'Andy Weir',
    series: '',
    status: 'downloaded',
    pdfUrl: 'https://example.com/guide.pdf'
  };

  db.bulkUpsert([book1, book2]);

  // Total count
  assert.strictEqual(db.getBooks().length, 2);

  // Status filter
  const downloaded = db.getBooks({ status: 'downloaded' });
  assert.strictEqual(downloaded.length, 1);
  assert.strictEqual(downloaded[0].asin, 'B002');

  // Search filter
  const searched = db.getBooks({ search: 'sanderson' });
  assert.strictEqual(searched.length, 1);
  assert.strictEqual(searched[0].title, 'The Way of Kings');

  // PDF filter
  const withPdf = db.getBooks({ hasPdf: true });
  assert.strictEqual(withPdf.length, 1);
  assert.strictEqual(withPdf[0].asin, 'B002');

  // Persistence check - reload from disk
  const reloadedDb = new LibraryDB(tmpDir);
  assert.strictEqual(reloadedDb.getBooks().length, 2);

  // Settings update check
  reloadedDb.updateSettings({ marketplace: 'uk' });
  assert.strictEqual(reloadedDb.getSettings().marketplace, 'uk');

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
