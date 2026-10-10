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
 *
 * Source retention model (mirrors Libation's "RetainAaxFile" + .key sidecar):
 *   {Title}.aaxc / {Title}.aax   Complete encrypted download, never deleted automatically
 *   {Title}.license.json         Voucher key/iv (or activation bytes), chapters, size
 *   {Title}.aaxc.part            In-flight download; renamed only after size verification
 *   {Title}.converting.m4b       FFmpeg output; promoted to {Title}.m4b only after validation
 * A retry re-uses a verified encrypted source + license sidecar without contacting Amazon.
 */

const fs = require('fs');
const path = require('path');
const AbsOrganizer = require('../organizer/abs-organizer');
const Decryptor = require('./decryptor');
const { DeviceProfile } = require('../auth/device-profile');

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
   * Computes all on-disk paths used for a book liberation.
   * @param {string} targetDir
   * @param {string} title
   */
  static getPaths(targetDir, title) {
    const safeTitle = AbsOrganizer.sanitize(title);
    return {
      safeTitle,
      aaxc: path.join(targetDir, `${safeTitle}.aaxc`),
      aax: path.join(targetDir, `${safeTitle}.aax`),
      licenseJson: path.join(targetDir, `${safeTitle}.license.json`),
      workingM4b: path.join(targetDir, `${safeTitle}.converting.m4b`),
      finalM4b: path.join(targetDir, `${safeTitle}.m4b`)
    };
  }

  /**
   * Returns a previously downloaded, size-verified encrypted source and its license
   * sidecar, or null if none is usable.
   * @param {ReturnType<typeof Downloader.getPaths>} paths
   * @param {string} asin
   * @param {string} [requestedQuality] Optional requested quality ('High' | 'Normal')
   */
  static findRetainedSource(paths, asin, requestedQuality = null) {
    try {
      if (!fs.existsSync(paths.licenseJson)) return null;
      const lic = JSON.parse(fs.readFileSync(paths.licenseJson, 'utf8'));
      if (lic.asin !== asin) return null;

      // If user changed audio quality preference, re-download at the requested quality
      if (requestedQuality && lic.quality && lic.quality !== requestedQuality) {
        return null;
      }

      const encryptedPath = lic.format === 'aaxc' ? paths.aaxc : paths.aax;
      if (!fs.existsSync(encryptedPath)) return null;

      const size = fs.statSync(encryptedPath).size;
      if (!lic.sizeBytes || size !== lic.sizeBytes) return null;

      return { encryptedPath, license: lic };
    } catch (_) {
      return null;
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

    let partPath = null;
    let paths = null;
    let encryptedPath = null;
    const profile = DeviceProfile.getProfile();
    const userAgent = profile?.userAgent || 'Audible/3.56.2 (iPhone; iOS 15.0; Scale/3.00)';

    try {
      const settings = this.libraryDB.getSettings();
      const targetDir = AbsOrganizer.getBookDirectory(settings.outputDir, book);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      paths = Downloader.getPaths(targetDir, book.title);

      // Step 1: Save Cover Image (skip if already present)
      let coverPath = path.join(targetDir, 'cover.jpg');
      if (!fs.existsSync(coverPath)) {
        coverPath = null;
        if (book.coverUrl) {
          this.emitProgress(asin, { status: 'downloading', speedText: 'Saving cover art...', percentage: 5 });
          coverPath = await AbsOrganizer.saveCoverImage(targetDir, book.coverUrl, userAgent);
        }
      }

      // Step 2: Re-use a retained encrypted source if one exists (no Amazon requests needed)
      let licenseRecord;
      let pdfPath = book.pdfPath || null;
      const requestedQuality = settings.audioQuality === 'Normal' ? 'Normal' : 'High';
      const retained = Downloader.findRetainedSource(paths, asin, requestedQuality);

      if (retained) {
        console.log(`[Downloader] Re-using retained encrypted source (${retained.license.quality || 'default'} quality): ${retained.encryptedPath}`);
        encryptedPath = retained.encryptedPath;
        licenseRecord = retained.license;
        this.emitProgress(asin, {
          status: 'downloading',
          percentage: 85,
          speedText: 'Using previously downloaded encrypted file...',
          title: book.title
        });
      } else {
        // Step 3: Request Official Content License & Download URL with user-selected quality
        this.emitProgress(asin, {
          status: 'downloading',
          percentage: 10,
          speedText: `Requesting ${requestedQuality === 'Normal' ? 'Standard' : 'Highest'} quality download license...`,
          title: book.title
        });

        const license = await this.audibleClient.getContentLicense(asin, { quality: requestedQuality });
        const isAaxc = !!license.voucher;

        // Activation bytes are only meaningful for legacy AAX (no voucher)
        let activationBytes = null;
        if (!isAaxc) {
          activationBytes = this.tokenManager.session?.activationBytes;
          if (!activationBytes || activationBytes === '00000000') {
            this.emitProgress(asin, { status: 'downloading', percentage: 12, speedText: 'Retrieving activation credentials...', title: book.title });
            activationBytes = await this.tokenManager.fetchActivationBytes();
          }
        }

        encryptedPath = isAaxc ? paths.aaxc : paths.aax;
        partPath = `${encryptedPath}.part`;

        // Step 4: Download Companion PDF if enabled (from library metadata or license)
        const pdfTargetUrl = book.pdfUrl || license.pdfUrl;
        if (settings.downloadPdfs && pdfTargetUrl) {
          this.emitProgress(asin, { status: 'downloading', speedText: 'Downloading companion PDF...', percentage: 14 });
          pdfPath = (await AbsOrganizer.saveCompanionPdf(targetDir, pdfTargetUrl, book.title, userAgent)) || pdfPath;
        }

        // Step 5: Stream the complete encrypted file to disk (.part), then verify & rename
        const audioResponse = await fetch(license.offlineUrl, {
          headers: { 'User-Agent': userAgent },
          signal: abortController.signal
        });

        if (!audioResponse.ok) {
          throw new Error(`Failed to download audio stream from Audible CDN (${audioResponse.status}): ${audioResponse.statusText}`);
        }

        const headerLength = parseInt(audioResponse.headers.get('content-length'), 10) || 0;
        const totalBytes = headerLength || license.sizeBytes || 0;
        let downloadedBytes = 0;
        let lastProgressUpdate = Date.now();
        let lastBytes = 0;

        const fileStream = fs.createWriteStream(partPath);
        const reader = audioResponse.body.getReader();

        try {
          while (true) {
            if (abortController.signal.aborted) {
              throw new Error('Download cancelled by user.');
            }

            const { done, value } = await reader.read();
            if (done) break;

            if (!fileStream.write(Buffer.from(value))) {
              await new Promise((resolve) => fileStream.once('drain', resolve));
            }
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

        const writtenBytes = fs.statSync(partPath).size;
        if (headerLength && writtenBytes !== headerLength) {
          throw new Error(`Incomplete download: received ${writtenBytes} of ${headerLength} bytes.`);
        }

        if (fs.existsSync(encryptedPath)) fs.unlinkSync(encryptedPath);
        fs.renameSync(partPath, encryptedPath);
        partPath = null;

        // Persist decryption material next to the encrypted file (like Libation's .key file)
        licenseRecord = {
          asin,
          format: isAaxc ? 'aaxc' : 'aax',
          quality: requestedQuality,
          voucher: isAaxc ? { key: license.voucher.key, iv: license.voucher.iv } : null,
          activationBytes: isAaxc ? null : activationBytes,
          chapterInfo: license.chapterInfo || null,
          sizeBytes: writtenBytes,
          codec: license.codec,
          downloadedAt: new Date().toISOString()
        };
        fs.writeFileSync(paths.licenseJson, JSON.stringify(licenseRecord, null, 2), 'utf8');
        console.log(`[Downloader] Encrypted source saved: ${encryptedPath} (${writtenBytes} bytes, ${licenseRecord.format})`);
      }

      // Step 6: Lossless Decryption & Tagging with FFmpeg into a working file
      this.emitProgress(asin, {
        status: 'converting',
        percentage: 88,
        speedText: 'Losslessly decrypting AAC stream into M4B...',
        title: book.title
      });

      const rawChapters = licenseRecord.chapterInfo?.chapters || book.chapters || [];
      const normalizedChapters = Array.isArray(rawChapters) ? rawChapters.map(ch => ({
        title: ch.title || 'Chapter',
        startTime: ch.start_offset_ms !== undefined ? (ch.start_offset_ms / 1000) : (ch.startTime || 0),
        duration: ch.length_ms !== undefined ? (ch.length_ms / 1000) : (ch.duration || 0),
        start_offset_ms: ch.start_offset_ms !== undefined ? ch.start_offset_ms : Math.round((ch.startTime || 0) * 1000),
        length_ms: ch.length_ms !== undefined ? ch.length_ms : Math.round((ch.duration || 0) * 1000)
      })) : [];

      book.chapters = normalizedChapters;

      if (fs.existsSync(paths.workingM4b)) fs.unlinkSync(paths.workingM4b);

      await Decryptor.decryptToM4b({
        inputPath: encryptedPath,
        outputPath: paths.workingM4b,
        activationBytes: licenseRecord.activationBytes,
        voucher: licenseRecord.voucher,
        book,
        chapters: normalizedChapters,
        coverPath,
        onProgress: (p) => {
          this.emitProgress(asin, {
            status: 'converting',
            percentage: 88 + Math.round(p.percent * 0.08),
            speedText: 'Writing M4B container & chapters...',
            title: book.title
          });
        }
      });

      // Step 7: Validate decrypted audio before promoting the output
      this.emitProgress(asin, {
        status: 'converting',
        percentage: 97,
        speedText: 'Verifying decrypted audio...',
        title: book.title
      });

      const chapterTotalSec = normalizedChapters.reduce((sum, ch) => sum + (ch.duration || 0), 0);
      const expectedSeconds = chapterTotalSec || book.runtimeSeconds || 0;
      const check = await Decryptor.validateOutput(paths.workingM4b, expectedSeconds);
      if (!check.ok) {
        try { fs.unlinkSync(paths.workingM4b); } catch (_) {}
        throw new Error(`Decrypted M4B failed verification: ${check.reason} Encrypted source kept at ${encryptedPath}`);
      }

      if (fs.existsSync(paths.finalM4b)) fs.unlinkSync(paths.finalM4b);
      fs.renameSync(paths.workingM4b, paths.finalM4b);
      console.log(`[Downloader] Verified M4B (${Math.round(check.durationSeconds)}s): ${paths.finalM4b}`);

      // Step 8: Generate Audiobookshelf metadata.json
      if (settings.generateAbsMetadata) {
        AbsOrganizer.writeAbsMetadata(targetDir, book);
      }

      // Step 9: Finalize Database State
      this.libraryDB.updateBookStatus(asin, 'downloaded', {
        m4bPath: paths.finalM4b,
        encryptedPath,
        pdfPath: pdfPath || null,
        chapters: normalizedChapters,
        audioQuality: requestedQuality,
        downloadedAt: new Date().toISOString(),
        lastError: null
      });

      this.activeTasks.delete(asin);

      this.emitProgress(asin, {
        status: 'completed',
        percentage: 100,
        speedText: 'Completed',
        title: book.title,
        m4bPath: paths.finalM4b
      });

      console.log(`[Downloader] Completed liberation for ${book.title}`);
    } catch (err) {
      this.activeTasks.delete(asin);

      // Only incomplete artifacts are removed. A complete encrypted source and its
      // license sidecar are always retained so conversion can be retried offline.
      if (partPath && fs.existsSync(partPath)) {
        try { fs.unlinkSync(partPath); } catch (_) {}
      }
      if (paths && fs.existsSync(paths.workingM4b)) {
        try { fs.unlinkSync(paths.workingM4b); } catch (_) {}
      }

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
