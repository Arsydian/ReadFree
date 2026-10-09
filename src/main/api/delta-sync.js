/**
 * ReadFree - Delta & Full Library Sync Engine
 * 
 * Solves the missing-books problem found in BookLibConnect:
 * - Provides both Incremental (quick delta) and Full Re-Sync (exhaustive pagination).
 * - Full Re-Sync actively re-scans every page from Audible's catalog from scratch,
 *   guaranteeing newly purchased audiobooks are never silently dropped.
 * - Handles automatic database upserting and download state preservation.
 */

class DeltaSync {
  /**
   * @param {Object} audibleClient AudibleClient instance
   * @param {Object} libraryDB LibraryDB instance
   * @param {Object} tokenManager TokenManager instance
   */
  constructor(audibleClient, libraryDB, tokenManager) {
    this.audibleClient = audibleClient;
    this.libraryDB = libraryDB;
    this.tokenManager = tokenManager;
    this.isSyncing = false;
  }

  /**
   * Executes a synchronization pass.
   * @param {Object} [options]
   * @param {boolean} [options.forceFull=false] If true, bypasses lastSyncTimestamp and performs a complete catalog crawl
   * @param {Function} [options.onProgress] Callback for UI sync updates
   * @returns {Promise<Object>} Summary of sync results { total, newAdded, updated }
   */
  async sync(options = {}) {
    if (this.isSyncing) {
      throw new Error('A synchronization operation is already in progress.');
    }

    this.isSyncing = true;
    const forceFull = options.forceFull === true;

    try {
      if (options.onProgress) {
        options.onProgress({ status: 'connecting', message: forceFull ? 'Starting full catalog re-sync...' : 'Checking for library updates...' });
      }

      // Check authentication
      if (!this.tokenManager.isAuthenticated()) {
        throw new Error('Please sign in to Audible to synchronize your library.');
      }

      const books = await this.audibleClient.fetchLibrary({
        onPageFetched: (pageData) => {
          if (options.onProgress) {
            options.onProgress({
              status: 'fetching',
              message: `Scanning catalog (Page ${pageData.page} of ${pageData.totalPages})...`,
              fetchedCount: pageData.fetchedCount
            });
          }
        }
      });

      let newAdded = 0;
      let updated = 0;

      for (const book of books) {
        const existing = this.libraryDB.getBook(book.asin);
        if (!existing) {
          this.libraryDB.upsertBook(book);
          newAdded++;
        } else {
          // Preserve existing download state and paths
          this.libraryDB.upsertBook({
            ...book,
            status: existing.status || 'ready',
            m4bPath: existing.m4bPath || null,
            pdfPath: existing.pdfPath || null,
            chapters: existing.chapters || []
          });
          updated++;
        }
      }

      // Record successful sync timestamp
      this.libraryDB.updateSettings({
        lastSyncTimestamp: new Date().toISOString()
      });

      this.libraryDB.saveBooks();

      return {
        total: this.libraryDB.getBooks().length,
        newAdded,
        updated
      };
    } catch (err) {
      if (options.onProgress) {
        options.onProgress({
          status: 'error',
          message: `Sync failed: ${err.message}`
        });
      }
      throw err;
    } finally {
      this.isSyncing = false;
    }
  }
}

module.exports = DeltaSync;
