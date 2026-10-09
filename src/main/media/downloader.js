/**
 * ReadFree - Audiobook Downloader & Queue Manager
 * 
 * Orchestrates the full lifecycle of an audiobook liberation:
 * 1. Stream & content download with real-time speed & byte tracking
 * 2. High-res cover art retrieval
 * 3. Companion PDF booklet download
 * 4. Audiobookshelf directory structure formatting
 * 5. Lossless M4B decryption & chapter tagging
 * 6. Audiobookshelf metadata.json generation
 * 
 * Exposes simple controls: Progress streaming, Cancel, and Retry.
 */

const fs = require('fs');
const path = require('path');
const AbsOrganizer = require('../organizer/abs-organizer');
const Decryptor = require('./decryptor');

class Downloader {
  /**
   * @param {Object} libraryDB LibraryDB instance
   * @param {Object} tokenManager TokenManager instance
   * @param {Object} audibleClient AudibleClient instance
   * @param {Function} broadcastFn Callback to broadcast events to renderer
   */
  constructor(libraryDB, tokenManager, audibleClient, broadcastFn) {
    this.libraryDB = libraryDB;
    this.tokenManager = tokenManager;
    this.audibleClient = audibleClient;
    this.broadcast = broadcastFn;
    this.activeTasks = new Map(); // asin -> task controller
  }

  /**
   * Emits progress update to renderer process via IPC.
   * @param {string} asin 
   * @param {Object} progressData 
   */
  emitProgress(asin, progressData) {
    if (this.broadcast) {
      this.broadcast({ asin, ...progressData });
    }
  }

  /**
   * Starts downloading and liberating a book.
   * @param {string} asin 
   */
  async startDownload(asin) {
    const book = this.libraryDB.getBook(asin);
    if (!book) throw new Error(`Book not found for ASIN ${asin}`);

    if (this.activeTasks.has(asin)) {
      console.warn(`[Downloader] Download already active for ${asin}`);
      return;
    }

    const abortController = new AbortController();
    this.activeTasks.set(asin, { abortController, status: 'downloading' });
    this.libraryDB.updateBookStatus(asin, 'downloading');

    this.emitProgress(asin, {
      status: 'downloading',
      percentage: 0,
      bytesDownloaded: 0,
      totalBytes: 100 * 1024 * 1024,
      speedText: 'Connecting...',
      title: book.title,
      coverUrl: book.coverUrl
    });

    try {
      const settings = this.libraryDB.getSettings();
      const targetDir = AbsOrganizer.getBookDirectory(settings.outputDir, book);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      // Step 1: Save Cover Image
      let coverPath = null;
      if (book.coverUrl) {
        this.emitProgress(asin, { status: 'downloading', speedText: 'Saving cover art...', percentage: 5 });
        coverPath = await AbsOrganizer.saveCoverImage(targetDir, book.coverUrl);
      }

      // Step 2: Download Companion PDF if enabled
      let pdfPath = null;
      if (settings.downloadPdfs && book.pdfUrl) {
        this.emitProgress(asin, { status: 'downloading', speedText: 'Downloading companion PDF...', percentage: 15 });
        pdfPath = await AbsOrganizer.saveCompanionPdf(targetDir, book.pdfUrl, book.title);
      }

      // Step 3: Ensure Activation Bytes exist (if not already retrieved)
      let activationBytes = this.tokenManager.session?.activationBytes;
      if (!activationBytes || activationBytes === '00000000') {
        this.emitProgress(asin, {
          status: 'downloading',
          percentage: 8,
          speedText: 'Retrieving activation credentials...',
          title: book.title
        });
        try {
          activationBytes = await this.tokenManager.fetchActivationBytes();
        } catch (actErr) {
          console.warn('[Downloader] Activation bytes fetch error, continuing to license request:', actErr.message);
        }
      }

      // Step 4: Request Official Content License & Download URL
      this.emitProgress(asin, {
        status: 'downloading',
        percentage: 12,
        speedText: 'Requesting download license...',
        title: book.title
      });

      const license = await this.audibleClient.getContentLicense(asin);
      const isAaxc = !!(license.voucher && license.voucher.key && license.voucher.iv);
      const ext = isAaxc ? '.temp.aaxc' : '.temp.aax';
      const safeTitle = AbsOrganizer.sanitize(book.title);
      const tempAudioPath = path.join(targetDir, `${safeTitle}${ext}`);
      const finalM4bPath = path.join(targetDir, `${safeTitle}.m4b`);

      // Step 5: Real Audio Stream Download with live byte/speed tracking
      const audioResponse = await fetch(license.offlineUrl, {
        signal: abortController.signal
      });

      if (!audioResponse.ok) {
        throw new Error(`Failed to download audio stream from Audible CDN (${audioResponse.status}): ${audioResponse.statusText}`);
      }

      const totalBytes = license.sizeBytes || parseInt(audioResponse.headers.get('content-length'), 10) || 0;
      let downloadedBytes = 0;
      let lastProgressUpdate = Date.now();
      let lastBytes = 0;

      const fileStream = fs.createWriteStream(tempAudioPath);
      const reader = audioResponse.body.getReader();

      try {
        while (true) {
          if (abortController.signal.aborted) {
            throw new Error('Download cancelled by user.');
          }

          const { done, value } = await reader.read();
          if (done) break;

          fileStream.write(Buffer.from(value));
          downloadedBytes += value.length;

          const now = Date.now();
          if (now - lastProgressUpdate >= 350) {
            const timeDeltaSec = (now - lastProgressUpdate) / 1000;
            const bytesDelta = downloadedBytes - lastBytes;
            const speedBytesSec = timeDeltaSec > 0 ? bytesDelta / timeDeltaSec : 0;
            const speedMbSec = (speedBytesSec / (1024 * 1024)).toFixed(1);
            
            const pct = totalBytes > 0 
              ? Math.min(85, 15 + Math.round((downloadedBytes / totalBytes) * 70))
              : 50;

            this.emitProgress(asin, {
              status: 'downloading',
              percentage: pct,
              bytesDownloaded: downloadedBytes,
              totalBytes: totalBytes || downloadedBytes,
              speedText: `${speedMbSec} MB/s`,
              title: book.title,
              coverUrl: book.coverUrl
            });

            lastProgressUpdate = now;
            lastBytes = downloadedBytes;
          }
        }
      } finally {
        await new Promise((resolve) => fileStream.end(resolve));
      }

      // Step 6: Lossless Decryption & Tagging with FFmpeg
      this.emitProgress(asin, {
        status: 'converting',
        percentage: 88,
        speedText: 'Losslessly decrypting AAC stream into M4B...',
        title: book.title
      });

      const chapters = license.chapterInfo?.chapters || book.chapters || [];

      await Decryptor.decryptToM4b({
        inputPath: tempAudioPath,
        outputPath: finalM4bPath,
        activationBytes,
        voucher: license.voucher,
        book,
        chapters,
        coverPath,
        onProgress: (p) => {
          this.emitProgress(asin, {
            status: 'converting',
            percentage: 88 + Math.round(p.percent * 0.1),
            speedText: 'Writing M4B container & chapters...',
            title: book.title
          });
        }
      });

      // Cleanup temp raw audio file
      try {
        if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
      } catch (_) {}

      // Step 7: Generate Audiobookshelf metadata.json
      if (settings.generateAbsMetadata) {
        AbsOrganizer.writeAbsMetadata(targetDir, book);
      }

      // Step 6: Finalize Database State
      this.libraryDB.updateBookStatus(asin, 'downloaded', {
        m4bPath: finalM4bPath,
        pdfPath: pdfPath || book.pdfPath || null,
        downloadedAt: new Date().toISOString()
      });

      this.activeTasks.delete(asin);

      this.emitProgress(asin, {
        status: 'completed',
        percentage: 100,
        speedText: 'Completed',
        title: book.title,
        m4bPath: finalM4bPath
      });

      console.log(`[Downloader] Completed liberation for ${book.title}`);
    } catch (err) {
      this.activeTasks.delete(asin);
      const isCancelled = err.message.includes('cancelled');
      const finalStatus = isCancelled ? 'ready' : 'failed';
      
      this.libraryDB.updateBookStatus(asin, finalStatus, {
        lastError: isCancelled ? null : err.message
      });

      this.emitProgress(asin, {
        status: finalStatus,
        percentage: 0,
        speedText: isCancelled ? 'Cancelled' : `Error: ${err.message}`,
        title: book.title
      });

      console.error(`[Downloader] Download error for ${book.title}:`, err.message);
    }
  }

  /**
   * Cancels an active download.
   * @param {string} asin 
   */
  cancelDownload(asin) {
    const task = this.activeTasks.get(asin);
    if (task && task.abortController) {
      task.abortController.abort();
      this.activeTasks.delete(asin);
      this.libraryDB.updateBookStatus(asin, 'ready');
      this.emitProgress(asin, {
        status: 'ready',
        percentage: 0,
        speedText: 'Cancelled'
      });
      return true;
    }
    return false;
  }

  /**
   * Retries a failed or cancelled download.
   * @param {string} asin 
   */
  retryDownload(asin) {
    this.cancelDownload(asin);
    return this.startDownload(asin);
  }

  /**
   * Returns list of currently active or failed downloads for queue display.
   */
  getQueue() {
    const allBooks = this.libraryDB.getBooks();
    return allBooks
      .filter(b => b.status === 'downloading' || b.status === 'failed')
      .map(b => ({
        asin: b.asin,
        title: b.title,
        authors: b.authors,
        coverUrl: b.coverUrl,
        status: b.status,
        percentage: b.status === 'downloading' ? 50 : 0
      }));
  }
}

module.exports = Downloader;
