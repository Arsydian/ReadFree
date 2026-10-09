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
    pdfUrl: 'https://m.media-amazon.com/images/companion/guide.pdf'
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

test('LibraryDB permanently blocks and purges placeholder and demo books', () => {
  const tmpDir = path.join(os.tmpdir(), `readfree_placeholder_guard_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const db = new LibraryDB(tmpDir);

  const legacyPlaceholderBooks = [
    {
      asin: 'B08G9W28Z1',
      title: 'Project Hail Mary',
      pdfUrl: 'https://example.com/project-hail-mary-diagrams.pdf',
      chapters: [{ title: 'Chapter 1: Awakening', startTime: 0, duration: 1800 }]
    },
    {
      asin: 'B002V55724',
      title: 'The Way of Kings',
      m4bPath: 'D:\\Audiobooks\\Brandon Sanderson\\The Stormlight Archive\\The Way of Kings\\The Way of Kings.m4b',
      chapters: [{ title: 'Prelude to the Stormlight Archive', startTime: 0, duration: 920 }]
    },
    {
      asin: 'B07978PHHB',
      title: 'Dungeon Crawler Carl',
      summary: 'The apocalypse will be televised! Welcome to the World Dungeon.',
      chapters: [{ title: 'Floor 1 - The Descent', startTime: 0, duration: 1500 }]
    },
    {
      asin: 'B08FGF6HQB',
      title: 'The Sandman: Act I',
      pdfUrl: 'https://example.com/sandman-script.pdf',
      chapters: [{ title: 'Episode 1: Sleep of the Just', startTime: 0, duration: 2400 }]
    }
  ];

  // 1. Verify upsertBook blocks individual placeholder books
  for (const placeholder of legacyPlaceholderBooks) {
    const success = db.upsertBook(placeholder);
    assert.strictEqual(success, false, `Should reject placeholder book ${placeholder.asin}`);
    assert.strictEqual(db.getBook(placeholder.asin), null);
  }

  // 2. Verify bulkUpsert drops placeholders
  db.bulkUpsert(legacyPlaceholderBooks);
  assert.strictEqual(db.getBooks().length, 0, 'Database should remain empty when bulkUpserting only placeholders');

  // 3. Verify isDemo and generic example.com books are blocked
  assert.strictEqual(db.upsertBook({ asin: 'B_DEMO', title: 'Test Demo', isDemo: true }), false);
  assert.strictEqual(db.upsertBook({ asin: 'B_MOCK', title: 'Test Mock', pdfUrl: 'https://example.com/test.pdf' }), false);

  // 4. Verify disk sanitization: if a database file with placeholder books is loaded, it is purged automatically
  const corruptedDbFile = path.join(tmpDir, 'readfree_library.json');
  fs.writeFileSync(corruptedDbFile, JSON.stringify(legacyPlaceholderBooks), 'utf8');

  const reloaded = new LibraryDB(tmpDir);
  assert.strictEqual(reloaded.getBooks().length, 0, 'Reloading database file with placeholder books must purge them');

  // Verify the cleaned state was written back to disk
  const persistedRaw = JSON.parse(fs.readFileSync(corruptedDbFile, 'utf8'));
  assert.strictEqual(persistedRaw.length, 0, 'Persisted JSON file must contain 0 books after sanitization');

  // 5. Verify legitimate Audible books are permitted
  const legitimateBook = {
    asin: 'B08G9W28Z1', // Same ASIN but genuine Audible API payload
    title: 'Project Hail Mary',
    authors: 'Andy Weir',
    narrators: 'Ray Porter',
    coverUrl: 'https://m.media-amazon.com/images/I/51p5gBfVqVL._SL500_.jpg',
    purchaseDate: '2026-10-09T10:00:00.000Z',
    runtimeSeconds: 57660,
    status: 'ready'
  };
  assert.strictEqual(db.upsertBook(legitimateBook), true, 'Legitimate Audible book with genuine metadata should be allowed');
  assert.strictEqual(db.getBooks().length, 1);

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
