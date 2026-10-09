/**
 * ReadFree - Audiobook Decryptor & M4B Converter Engine
 * 
 * Uses FFmpeg with account activation bytes to losslessly convert and decrypt
 * Audible AAX audio streams into standalone DRM-free .m4b audiobooks.
 * 
 * Embeds:
 * - Studio quality lossless AAC audio (-c copy, no transcoding)
 * - Complete chapter markers via FFmetadata
 * - High-resolution cover art (attached picture atom)
 * - ID3/MP4 metadata tags (Title, Artist, Album, Series, Year, Genre)
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class Decryptor {
  /**
   * Escapes special characters for FFMETADATA1 format (=, ;, #, \, newline).
   * @param {string} str
   * @returns {string}
   */
  static escapeFfmetadata(str) {
    if (!str) return '';
    return str.toString()
      .replace(/\\/g, '\\\\')
      .replace(/=/g, '\\=')
      .replace(/;/g, '\\;')
      .replace(/#/g, '\\#')
      .replace(/\n/g, '\\\n');
  }

  /**
   * Generates FFmetadata formatted string from chapters array.
   * @param {Array<Object>} chapters Array of { title, startTime, duration }
   * @returns {string} FFmetadata contents
   */
  static generateFfmetadata(chapters, book) {
    let content = ';FFMETADATA1\n';
    content += `title=${this.escapeFfmetadata(book.title)}\n`;
    content += `artist=${this.escapeFfmetadata(book.authors)}\n`;
    content += `album=${this.escapeFfmetadata(book.series || book.title)}\n`;
    content += `genre=Audiobook\n\n`;

    if (Array.isArray(chapters) && chapters.length > 0) {
      for (const ch of chapters) {
        const startMs = ch.start_offset_ms !== undefined ? ch.start_offset_ms : Math.round((ch.startTime || 0) * 1000);
        const lengthMs = ch.length_ms !== undefined ? ch.length_ms : Math.round((ch.duration || 0) * 1000);
        const endMs = startMs + lengthMs;
        content += '[CHAPTER]\n';
        content += 'TIMEBASE=1/1000\n';
        content += `START=${startMs}\n`;
        content += `END=${endMs}\n`;
        content += `title=${this.escapeFfmetadata(ch.title || 'Chapter')}\n\n`;
      }
    }

    return content;
  }

  /**
   * Decrypts input AAX/AAXC file to lossless M4B with embedded tags and cover.
   * @param {Object} options
   * @param {string} options.inputPath Path to input encrypted AAX or AAXC stream
   * @param {string} options.outputPath Target .m4b path
   * @param {string} [options.activationBytes] 4-byte hex string (e.g. "0445f805")
   * @param {Object} [options.voucher] AAXC voucher with { key, iv }
   * @param {Object} options.book Metadata record
   * @param {Array<Object>} [options.chapters] Chapter list
   * @param {string} [options.coverPath] Path to cover.jpg
   * @param {Function} [options.onProgress] Progress callback
   * @returns {Promise<string>} Output .m4b path upon success
   */
  static async decryptToM4b(options) {
    const { inputPath, outputPath, activationBytes, voucher, book, chapters, coverPath, onProgress } = options;

    if (!fs.existsSync(inputPath)) {
      throw new Error(`Source audio file not found: ${inputPath}`);
    }

    // Ensure output directory exists
    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    // Write temp FFmetadata file
    const metaFile = path.join(outDir, `_ffmeta_${book.asin}.txt`);
    const chapterList = chapters || book.chapters || [];
    const metaContent = this.generateFfmetadata(chapterList, book);
    fs.writeFileSync(metaFile, metaContent, 'utf8');

    return new Promise((resolve, reject) => {
      // Build FFmpeg command arguments
      const args = ['-y'];

      // Decrypt using either AAXC voucher keys or AAX activation bytes
      if (voucher && voucher.key && voucher.iv) {
        args.push('-audible_key', voucher.key);
        args.push('-audible_iv', voucher.iv);
      } else if (activationBytes && activationBytes !== '00000000') {
        args.push('-activation_bytes', activationBytes);
      }

      // Input audio
      args.push('-i', inputPath);

      // Metadata file input
      args.push('-i', metaFile);

      // Cover art input if available
      let hasCover = false;
      if (coverPath && fs.existsSync(coverPath)) {
        args.push('-i', coverPath);
        hasCover = true;
      }

      // Mapping audio & metadata
      args.push('-map', '0:a');
      args.push('-map_metadata', '1');

      if (Array.isArray(chapterList) && chapterList.length > 0) {
        args.push('-map_chapters', '1');
      }

      if (hasCover) {
        args.push('-map', '2:v');
        args.push('-disposition:v:0', 'attached_pic');
        args.push('-c:v', 'copy');
      }

      // Stream copy audio (-c:a copy gives lossless speed with no re-encoding)
      args.push('-c:a', 'copy');
      
      // MP4 metadata flags
      args.push('-f', 'mp4');
      args.push(outputPath);

      console.log(`[Decryptor] Spawning ffmpeg ${args.join(' ')}`);

      const proc = spawn('ffmpeg', args, {
        windowsHide: true
      });

      let stderrLog = '';

      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderrLog += text;
        
        // Parse time progression from ffmpeg output for progress reporting
        const timeMatch = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (timeMatch && onProgress) {
          const hours = parseInt(timeMatch[1], 10);
          const mins = parseInt(timeMatch[2], 10);
          const secs = parseFloat(timeMatch[3]);
          const currentSeconds = (hours * 3600) + (mins * 60) + secs;
          const totalSeconds = book.runtimeSeconds || 3600;
          const percent = Math.min(100, Math.round((currentSeconds / totalSeconds) * 100));
          onProgress({ percent, currentSeconds, totalSeconds });
        }
      });

      proc.on('close', (code) => {
        // Clean up temp metadata file
        try {
          if (fs.existsSync(metaFile)) fs.unlinkSync(metaFile);
        } catch (_) {}

        if (code === 0) {
          console.log(`[Decryptor] Successfully created DRM-free M4B: ${outputPath}`);
          resolve(outputPath);
        } else {
          reject(new Error(`FFmpeg decryption/conversion failed (code ${code}): ${stderrLog.slice(-500)}`));
        }
      });

      proc.on('error', (err) => {
        try {
          if (fs.existsSync(metaFile)) fs.unlinkSync(metaFile);
        } catch (_) {}
        reject(new Error(`Failed to spawn FFmpeg: ${err.message}`));
      });
    });
  }
}

module.exports = Decryptor;
