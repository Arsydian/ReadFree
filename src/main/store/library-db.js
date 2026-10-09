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
          data.forEach(book => this.books.set(book.asin, book));
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
   * @param {Object} book Book metadata
   */
  upsertBook(book) {
    const existing = this.books.get(book.asin) || {};
    const merged = {
      ...existing,
      ...book,
      updatedAt: new Date().toISOString()
    };
    this.books.set(book.asin, merged);
  }

  /**
   * Bulk upserts books and writes to disk.
   * @param {Array<Object>} bookList List of book records
   */
  bulkUpsert(bookList) {
    for (const b of bookList) {
      this.upsertBook(b);
    }
    this.saveBooks();
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
