/**
 * Unit Tests - Audiobookshelf Organizer
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const AbsOrganizer = require('../src/main/organizer/abs-organizer');

test('AbsOrganizer.sanitize removes forbidden characters', () => {
  assert.strictEqual(AbsOrganizer.sanitize('Book: Special "Edition" <v1>?'), 'Book Special Edition v1');
  assert.strictEqual(AbsOrganizer.sanitize('Path/With\\Slashes|And*Stars'), 'PathWithSlashesAndStars');
  assert.strictEqual(AbsOrganizer.sanitize(''), 'Unknown');
});

test('AbsOrganizer.getBookDirectory formats Author/Series/Title layout correctly', () => {
  const baseDir = 'D:\\Audiobooks';
  
  // Book with series
  const bookWithSeries = {
    title: 'The Way of Kings',
    authors: 'Brandon Sanderson',
    series: 'The Stormlight Archive',
    seriesSequence: '1'
  };
  const expectedWithSeries = path.join(baseDir, 'Brandon Sanderson', 'The Stormlight Archive', 'The Way of Kings');
  assert.strictEqual(AbsOrganizer.getBookDirectory(baseDir, bookWithSeries), expectedWithSeries);

  // Standalone book without series
  const standaloneBook = {
    title: 'Project Hail Mary',
    authors: 'Andy Weir',
    series: ''
  };
  const expectedStandalone = path.join(baseDir, 'Andy Weir', 'Project Hail Mary');
  assert.strictEqual(AbsOrganizer.getBookDirectory(baseDir, standaloneBook), expectedStandalone);
});

test('AbsOrganizer.writeAbsMetadata generates valid Audiobookshelf JSON schema', () => {
  const tmpDir = path.join(os.tmpdir(), `readfree_test_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const book = {
    asin: 'B08G9W28Z1',
    title: 'Project Hail Mary',
    authors: 'Andy Weir',
    narrators: 'Ray Porter',
    series: 'SciFi Series',
    seriesSequence: '1',
    releaseDate: '2021-05-04',
    summary: 'A lone astronaut.',
    chapters: [
      { title: 'Chapter 1', startTime: 0, duration: 1800 },
      { title: 'Chapter 2', startTime: 1800, duration: 2000 }
    ]
  };

  const metaPath = AbsOrganizer.writeAbsMetadata(tmpDir, book);
  assert.ok(fs.existsSync(metaPath));

  const content = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  assert.strictEqual(content.title, 'Project Hail Mary');
  assert.deepStrictEqual(content.authors, ['Andy Weir']);
  assert.deepStrictEqual(content.narrators, ['Ray Porter']);
  assert.strictEqual(content.publishedYear, '2021');
  assert.strictEqual(content.chapters.length, 2);
  assert.strictEqual(content.chapters[0].title, 'Chapter 1');
  assert.strictEqual(content.chapters[1].start, 1800);

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('AbsOrganizer.writeAbsMetadata normalizes Audible millisecond chapters to seconds', () => {
  const tmpDir = path.join(os.tmpdir(), `readfree_ms_test_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const book = {
    asin: 'B0GGNKSBRQ',
    title: 'Redwood',
    authors: 'Test Author',
    chapters: [
      { title: 'Intro', start_offset_ms: 0, length_ms: 15400 },
      { title: 'Chapter 1', start_offset_ms: 15400, length_ms: 1200500 }
    ]
  };

  const metaPath = AbsOrganizer.writeAbsMetadata(tmpDir, book);
  const content = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  assert.strictEqual(content.chapters.length, 2);
  assert.strictEqual(content.chapters[0].start, 0);
  assert.strictEqual(content.chapters[0].end, 15.4);
  assert.strictEqual(content.chapters[1].start, 15.4);
  assert.strictEqual(content.chapters[1].end, 1215.9);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
