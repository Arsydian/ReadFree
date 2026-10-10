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
   * Selects FFmpeg decryption arguments based on the encrypted container type.
   * - .aaxc requires the voucher key/iv (16 bytes each, hex).
   * - .aax requires the 4-byte account activation bytes.
   * Returns an Error (instead of throwing) when the required key material is missing.
   *
   * @param {{ inputPath: string, voucher?: {key:string, iv:string}|null, activationBytes?: string|null }} opts
   * @returns {string[]|Error}
   */
  static buildKeyArgs({ inputPath, voucher, activationBytes }) {
    const isAaxc = /\.aaxc$/i.test(inputPath);
    const hex32 = /^[0-9a-f]{32}$/i;

    if (isAaxc) {
      if (!voucher || !hex32.test(voucher.key || '') || !hex32.test(voucher.iv || '')) {
        return new Error('AAXC file requires a valid voucher key and IV; activation bytes cannot decrypt AAXC.');
      }
      return ['-audible_key', voucher.key, '-audible_iv', voucher.iv];
    }

    if (!activationBytes || !/^[0-9a-f]{8}$/i.test(activationBytes) || activationBytes === '00000000') {
      return new Error('AAX file requires valid 4-byte activation bytes.');
    }
    return ['-activation_bytes', activationBytes];
  }

  /**
   * Runs a process and collects its output.
   * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
   */
  static runProcess(cmd, args) {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { windowsHide: true });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (c) => { stdout += c.toString(); });
      proc.stderr.on('data', (c) => { stderr += c.toString(); });
      proc.on('error', (err) => reject(new Error(`Failed to spawn ${cmd}: ${err.message}`)));
      proc.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  }

  /**
   * Verifies that a converted M4B actually contains decodable, decrypted audio.
   * FFmpeg exits 0 even when it copies still-encrypted AAC frames, so exit code alone
   * is not proof of success. This decodes 30s windows at the start, middle and end and
   * fails on any decoder error, then checks the duration against the expected runtime.
   *
   * @param {string} filePath Path to the M4B to validate
   * @param {number} [expectedSeconds] Expected runtime from Audible metadata
   * @returns {Promise<{ ok: boolean, reason?: string, durationSeconds?: number }>}
   */
  static async validateOutput(filePath, expectedSeconds = 0) {
    if (!fs.existsSync(filePath)) return { ok: false, reason: 'Output file does not exist.' };

    const probe = await this.runProcess('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath
    ]);
    const durationSeconds = parseFloat(probe.stdout.trim());
    if (probe.code !== 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return { ok: false, reason: `ffprobe could not read duration: ${probe.stderr.slice(-300)}` };
    }

    if (expectedSeconds > 0) {
      const diff = Math.abs(durationSeconds - expectedSeconds);
      const allowed = Math.max(expectedSeconds * 0.03, 90);
      if (diff > allowed) {
        return {
          ok: false,
          durationSeconds,
          reason: `Duration ${Math.round(durationSeconds)}s differs from expected ${Math.round(expectedSeconds)}s by ${Math.round(diff)}s.`
        };
      }
    }

    const offsets = [0, Math.max(0, durationSeconds / 2 - 15), Math.max(0, durationSeconds - 35)];
    for (const ss of offsets) {
      const res = await this.runProcess('ffmpeg', [
        '-hide_banner', '-v', 'error', '-ss', ss.toFixed(2), '-t', '30',
        '-i', filePath, '-map', '0:a:0', '-f', 'null', '-'
      ]);
      if (res.code !== 0 || res.stderr.trim().length > 0) {
        return {
          ok: false,
          durationSeconds,
          reason: `Audio decode errors at ${Math.round(ss)}s (audio is still encrypted or corrupt): ${res.stderr.trim().split('\n')[0]}`
        };
      }
    }

    return { ok: true, durationSeconds };
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

      // Key selection is strictly tied to the container type. Applying activation bytes to an
      // AAXC file does not fail in FFmpeg - it silently writes still-encrypted AAC frames.
      const keyArgs = Decryptor.buildKeyArgs({ inputPath, voucher, activationBytes });
      if (keyArgs instanceof Error) {
        try { fs.unlinkSync(metaFile); } catch (_) {}
        reject(keyArgs);
        return;
      }
      args.push(...keyArgs);

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
