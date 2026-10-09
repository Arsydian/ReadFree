/**
 * ReadFree - Audiobookshelf (ABS) Organizer
 * 
 * Enforces the standardized Audiobookshelf folder and file layout:
 *   {OutputDir}/{Author}/{Series}/{Title}/
 *     ├── {Title}.m4b
 *     ├── cover.jpg
 *     ├── metadata.json
 *     └── {Title}.pdf  (Companion booklet, if available)
 * 
 * Generates official Audiobookshelf-compliant metadata.json files with
 * chapters, authors, narrator, series, and publication year tags.
 */

const fs = require('fs');
const path = require('path');

class AbsOrganizer {
  /**
   * Sanitizes string values to remove characters illegal in Windows and Unix filesystems.
   * @param {string} str 
   * @returns {string} Safe directory/filename
   */
  static sanitize(str) {
    if (!str) return 'Unknown';
    // Remove characters: < > : " / \ | ? *
    return str
      .replace(/[<>:"/\\|?*]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Computes the Audiobookshelf folder path for a given book record.
   * Format: OutputDir / Author / Series / Title
   * @param {string} baseOutputDir Root library directory
   * @param {Object} book Book metadata
   * @returns {string} Absolute directory path
   */
  static getBookDirectory(baseOutputDir, book) {
    const authorSafe = this.sanitize(book.authors?.split(',')[0] || 'Unknown Author');
    const seriesSafe = book.series ? this.sanitize(book.series) : '';
    const titleSafe = this.sanitize(book.title || 'Untitled');

    if (seriesSafe) {
      return path.join(baseOutputDir, authorSafe, seriesSafe, titleSafe);
    }
    return path.join(baseOutputDir, authorSafe, titleSafe);
  }

  /**
   * Generates and writes the Audiobookshelf `metadata.json` file inside the book directory.
   * @param {string} bookDir Book directory
   * @param {Object} book Book metadata
   * @returns {string} Path to written metadata.json
   */
  static writeAbsMetadata(bookDir, book) {
    if (!fs.existsSync(bookDir)) {
      fs.mkdirSync(bookDir, { recursive: true });
    }

    // Extract year from release or purchase date
    let publishedYear = '';
    if (book.releaseDate) {
      publishedYear = book.releaseDate.split('-')[0];
    } else if (book.purchaseDate) {
      publishedYear = book.purchaseDate.split('-')[0];
    }

    const absData = {
      title: book.title,
      subtitle: book.subtitle || null,
      authors: book.authors ? book.authors.split(',').map(s => s.trim()) : [],
      narrators: book.narrators ? book.narrators.split(',').map(s => s.trim()) : [],
      series: book.series ? [{ sequence: book.seriesSequence || '1', name: book.series }] : [],
      genres: ['Audiobook'],
      publishedYear: publishedYear || null,
      publishedDate: book.releaseDate || null,
      publisher: 'Audible Studios',
      description: book.summary || '',
      isbn: null,
      asin: book.asin,
      language: 'English',
      explicit: false,
      chapters: Array.isArray(book.chapters) ? book.chapters.map((ch, idx) => ({
        id: idx + 1,
        start: ch.startTime || 0,
        end: (ch.startTime || 0) + (ch.duration || 0),
        title: ch.title || `Chapter ${idx + 1}`
      })) : []
    };

    const targetPath = path.join(bookDir, 'metadata.json');
    fs.writeFileSync(targetPath, JSON.stringify(absData, null, 2), 'utf8');
    return targetPath;
  }

  /**
   * Downloads high-resolution cover artwork and saves as cover.jpg in the book folder.
   * @param {string} bookDir Target folder
   * @param {string} coverUrl Image URL
   * @param {string} [userAgent] Optional User-Agent header
   * @returns {Promise<string|null>} Path to saved cover.jpg
   */
  static async saveCoverImage(bookDir, coverUrl, userAgent = null) {
    if (!coverUrl) return null;
    if (!fs.existsSync(bookDir)) {
      fs.mkdirSync(bookDir, { recursive: true });
    }

    const coverPath = path.join(bookDir, 'cover.jpg');
    try {
      const headers = userAgent ? { 'User-Agent': userAgent } : {};
      const response = await fetch(coverUrl, { headers });
      if (!response.ok) return null;
      const buffer = await response.arrayBuffer();
      fs.writeFileSync(coverPath, Buffer.from(buffer));
      return coverPath;
    } catch (err) {
      console.warn(`[AbsOrganizer] Failed to save cover image for ${bookDir}:`, err);
      return null;
    }
  }

  /**
   * Downloads companion PDF booklet to the book directory.
   * @param {string} bookDir Target folder
   * @param {string} pdfUrl PDF URL
   * @param {string} title Safe title for filename
   * @param {string} [userAgent] Optional User-Agent header
   * @returns {Promise<string|null>} Path to saved PDF
   */
  static async saveCompanionPdf(bookDir, pdfUrl, title, userAgent = null) {
    if (!pdfUrl) return null;
    if (!fs.existsSync(bookDir)) {
      fs.mkdirSync(bookDir, { recursive: true });
    }

    const safeFilename = `${this.sanitize(title)} - Companion.pdf`;
    const pdfPath = path.join(bookDir, safeFilename);

    try {
      const headers = userAgent ? { 'User-Agent': userAgent } : {};
      const response = await fetch(pdfUrl, { headers });
      if (!response.ok) return null;
      const buffer = await response.arrayBuffer();
      fs.writeFileSync(pdfPath, Buffer.from(buffer));
      return pdfPath;
    } catch (err) {
      console.warn(`[AbsOrganizer] Failed to download companion PDF:`, err);
      return null;
    }
  }
}

module.exports = AbsOrganizer;
