/**
 * ReadFree - Local Database & Settings Store
 * 
 * Manages persistent state for:
 * - Audiobook catalog metadata (ASIN, title, author, narrators, chapters, PDFs)
 * - Per-book download & conversion status
 * - User preferences (output directory, ABS layout toggle, marketplace)
 * 
 * Uses atomic JSON writes with in-memory caching to guarantee zero database
 * corruption or locks across restarts.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class LibraryDB {
  // Known legacy placeholder ASINs from initial demo seeds
  static PLACEHOLDER_ASINS = new Set([
    'B08G9W28Z1',
    'B002V55724',
    'B07978PHHB',
    'B08FGF6HQB'
  ]);

  /**
   * Identifies whether a book record is a placeholder or demo mock book.
   * Ensures mock seed data can never be introduced or persisted.
   * @param {Object} book 
   * @returns {boolean}
   */
  static isPlaceholder(book) {
    if (!book || typeof book !== 'object') return false;
    if (book.isDemo === true || book.isPlaceholder === true) return true;

    // Detect mock URLs or synthetic test directory paths
    if (typeof book.pdfUrl === 'string' && book.pdfUrl.includes('example.com')) {
      return true;
    }
    if (typeof book.m4bPath === 'string' && (book.m4bPath.includes('Brandon Sanderson\\The Stormlight Archive') || book.m4bPath.includes('example.com'))) {
      return true;
    }

    // Detect known demo ASINs when populated with synthetic mock chapters or summaries
    if (LibraryDB.PLACEHOLDER_ASINS.has(book.asin)) {
      if (Array.isArray(book.chapters) && book.chapters.some(c => 
        c && c.title && (
          c.title === 'Chapter 1: Awakening' ||
          c.title === 'Prelude to the Stormlight Archive' ||
          c.title === 'Floor 1 - The Descent' ||
          c.title === 'Episode 1: Sleep of the Just'
        )
      )) {
        return true;
      }
      if (book.summary && (
        book.summary.includes('The apocalypse will be televised!') ||
        book.summary.includes('Lord Morpheus, is captured')
      )) {
        return true;
      }
    }

    return false;
  }

  /**
   * Initializes the database instance and loads persisted records.
   * @param {string} [customPath] Optional custom directory for storage (defaults to userData)
   */
  constructor(customPath) {
    const baseDir = customPath || (app ? app.getPath('userData') : path.join(process.cwd(), 'userData'));
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }

    this.dbFile = path.join(baseDir, 'readfree_library.json');
    this.settingsFile = path.join(baseDir, 'readfree_settings.json');

    this.books = new Map();
    this.settings = {
      outputDir: path.join(app ? app.getPath('music') : process.cwd(), 'Audiobooks'),
      organizeAbs: true,
      generateAbsMetadata: true,
      downloadPdfs: true,
      marketplace: 'us',
      lastSyncTimestamp: null
    };

    this.load();
    this.purgePlaceholders();
  }

  /**
   * Loads books and settings from disk.
   */
  load() {
    try {
      if (fs.existsSync(this.dbFile)) {
        const raw = fs.readFileSync(this.dbFile, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          let hasPlaceholders = false;
          data.forEach(book => {
            if (LibraryDB.isPlaceholder(book)) {
              hasPlaceholders = true;
            } else {
              this.books.set(book.asin, book);
            }
          });
          if (hasPlaceholders) {
            console.log('[LibraryDB] Purged legacy placeholder books from database file.');
            this.saveBooks();
          }
        }
      }
    } catch (err) {
      console.error('[LibraryDB] Error reading library database file:', err);
    }

    try {
      if (fs.existsSync(this.settingsFile)) {
        const raw = fs.readFileSync(this.settingsFile, 'utf8');
        const data = JSON.parse(raw);
        this.settings = { ...this.settings, ...data };
      }
    } catch (err) {
      console.error('[LibraryDB] Error reading settings file:', err);
    }
  }

  /**
   * Explicitly purges all placeholder and demo books from memory and disk.
   * @returns {number} Count of purged books
   */
  purgePlaceholders() {
    let purgedCount = 0;
    for (const [asin, book] of this.books.entries()) {
      if (LibraryDB.isPlaceholder(book)) {
        this.books.delete(asin);
        purgedCount++;
      }
    }
    if (purgedCount > 0) {
      this.saveBooks();
      console.log(`[LibraryDB] Purged ${purgedCount} placeholder books from library.`);
    }
    return purgedCount;
  }

  /**
   * Atomically saves books to disk using a temporary file.
   */
  saveBooks() {
    try {
      const data = JSON.stringify(Array.from(this.books.values()), null, 2);
      const tmpFile = `${this.dbFile}.tmp`;
      fs.writeFileSync(tmpFile, data, 'utf8');
      fs.renameSync(tmpFile, this.dbFile);
    } catch (err) {
      console.error('[LibraryDB] Failed to atomically save books:', err);
    }
  }

  /**
   * Atomically saves settings to disk.
   */
  saveSettings() {
    try {
      const data = JSON.stringify(this.settings, null, 2);
      const tmpFile = `${this.settingsFile}.tmp`;
      fs.writeFileSync(tmpFile, data, 'utf8');
      fs.renameSync(tmpFile, this.settingsFile);
    } catch (err) {
      console.error('[LibraryDB] Failed to atomically save settings:', err);
    }
  }

  /**
   * Upserts a book into the database.
   * Rejects and prevents placeholder / demo books.
   * @param {Object} book Book metadata
   * @returns {boolean} True if upserted, false if blocked
   */
  upsertBook(book) {
    if (!book || !book.asin) return false;
    if (LibraryDB.isPlaceholder(book)) {
      console.warn(`[LibraryDB] Blocked attempt to add placeholder book: ${book.asin} - ${book.title}`);
      return false;
    }

    const existing = this.books.get(book.asin) || {};
    const merged = {
      ...existing,
      ...book,
      updatedAt: new Date().toISOString()
    };
    this.books.set(book.asin, merged);
    return true;
  }

  /**
   * Bulk upserts books and writes to disk.
   * Filters out any placeholder books.
   * @param {Array<Object>} bookList List of book records
   */
  bulkUpsert(bookList) {
    if (!Array.isArray(bookList)) return;
    let anySaved = false;
    for (const b of bookList) {
      if (this.upsertBook(b)) {
        anySaved = true;
      }
    }
    if (anySaved) {
      this.saveBooks();
    }
  }

  /**
   * Retrieves all books, optionally filtered.
   * @param {Object} [filter] Filter options { status, search, hasPdf }
   * @returns {Array<Object>}
   */
  getBooks(filter = {}) {
    let list = Array.from(this.books.values());

    if (filter.status === 'downloaded') {
      list = list.filter(b => b.status === 'downloaded');
    } else if (filter.status === 'ready') {
      list = list.filter(b => b.status !== 'downloaded');
    }

    if (filter.hasPdf) {
      list = list.filter(b => !!b.pdfUrl);
    }

    if (filter.search) {
      const q = filter.search.toLowerCase().trim();
      list = list.filter(b => 
        (b.title && b.title.toLowerCase().includes(q)) ||
        (b.authors && b.authors.toLowerCase().includes(q)) ||
        (b.series && b.series.toLowerCase().includes(q))
      );
    }

    return list;
  }

  /**
   * Retrieves a single book by ASIN.
   * @param {string} asin Audible standard identification number
   */
  getBook(asin) {
    return this.books.get(asin) || null;
  }

  /**
   * Updates the download/liberation status of a book.
   * @param {string} asin 
   * @param {string} status 'ready' | 'downloading' | 'downloaded' | 'failed'
   * @param {Object} [extra] extra properties such as m4bPath, error, progress
   */
  updateBookStatus(asin, status, extra = {}) {
    const b = this.books.get(asin);
    if (b) {
      b.status = status;
      Object.assign(b, extra);
      this.saveBooks();
    }
  }

  /**
   * Gets current settings.
   */
  getSettings() {
    return { ...this.settings };
  }

  /**
   * Updates application settings.
   * @param {Object} newSettings Partial settings update
   */
  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    this.saveSettings();
    return this.settings;
  }

  /**
   * Resets local catalog database, forcing a clean slate.
   */
  resetCatalog() {
    this.books.clear();
    this.settings.lastSyncTimestamp = null;
    this.saveBooks();
    this.saveSettings();
  }
}

module.exports = LibraryDB;
