/**
 * ReadFree - Audible API Client
 * 
 * Interacts with Audible's official REST API to:
 * - Query user audiobook library with complete pagination
 * - Extract rich metadata: Title, Authors, Narrators, Series, Runtime, high-res Cover, PDF URL
 * - Request content licensing, DRM vouchers, and direct download links
 */

const crypto = require('crypto');
const { DeviceProfile } = require('../auth/device-profile');

const MARKETPLACE_API_HOSTS = {
  us: 'https://api.audible.com',
  uk: 'https://api.audible.co.uk',
  ca: 'https://api.audible.ca',
  de: 'https://api.audible.de',
  au: 'https://api.audible.com.au',
  fr: 'https://api.audible.fr'
};

class AudibleClient {
  /**
   * @param {Object} tokenManager TokenManager instance
   */
  constructor(tokenManager) {
    this.tokenManager = tokenManager;
  }

  /**
   * Resolves the base API URL for the configured marketplace.
   */
  getBaseUrl() {
    const market = this.tokenManager.session?.marketplace || 'us';
    return MARKETPLACE_API_HOSTS[market] || MARKETPLACE_API_HOSTS.us;
  }

  /**
   * Constructs authenticated request headers using ADP cryptographic signing
   * if device credentials exist, or OAuth Bearer token as fallback.
   * 
   * @param {string} method HTTP method ('GET', 'POST')
   * @param {string} fullUrl Complete URL with query parameters
   * @param {string|Object} [body=''] Request payload
   * @returns {Promise<Object>} Headers dictionary
   */
  async buildRequestHeaders(method, fullUrl, body = '') {
    const profile = DeviceProfile.getProfile();
    const adpToken = this.tokenManager.session?.adpToken;
    const privateKeyPem = this.tokenManager.session?.devicePrivateKey;
    const accessToken = await this.tokenManager.getValidAccessToken();

    const headers = {
      'User-Agent': profile.userAgent,
      'Accept': 'application/json'
    };

    if (adpToken && privateKeyPem) {
      const urlObj = new URL(fullUrl);
      const pathWithQuery = urlObj.pathname + urlObj.search;
      const { signatureHeader } = DeviceProfile.signAdpRequest({
        method,
        pathWithQuery,
        body,
        adpToken,
        privateKeyPem
      });

      headers['x-adp-token'] = adpToken;
      headers['x-adp-alg'] = 'SHA256withRSA:1.0';
      headers['x-adp-signature'] = signatureHeader;
    }

    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }

    return headers;
  }

  /**
   * Formats duration in seconds into a friendly human-readable string.
   * @param {number} runtimeSeconds 
   * @returns {string} e.g. "11 hrs 42 mins"
   */
  formatDuration(runtimeSeconds) {
    if (runtimeSeconds === null || runtimeSeconds === undefined || isNaN(runtimeSeconds)) return 'Unknown';
    if (runtimeSeconds === 0) return '0 mins';
    const hrs = Math.floor(runtimeSeconds / 3600);
    const mins = Math.floor((runtimeSeconds % 3600) / 60);
    const minStr = mins === 1 ? '1 min' : `${mins} mins`;
    if (hrs === 0) return minStr;
    return `${hrs} hrs ${minStr}`;
  }

  /**
   * Normalizes an item from Audible's API response into a standard book record.
   * @param {Object} item Raw API object
   * @returns {Object} Normalized book object
   */
  parseBookItem(item) {
    const asin = item.asin || item.sku || 'UNKNOWN';
    const title = item.title || item.product_name || 'Untitled Audiobook';
    
    // Extract Authors
    let authors = 'Unknown Author';
    if (Array.isArray(item.authors) && item.authors.length > 0) {
      authors = item.authors.map(a => a.name).filter(Boolean).join(', ');
    }

    // Extract Narrators
    let narrators = 'Unknown Narrator';
    if (Array.isArray(item.narrators) && item.narrators.length > 0) {
      narrators = item.narrators.map(n => n.name).filter(Boolean).join(', ');
    }

    // Extract Series & Sequence
    let series = '';
    let seriesSequence = '';
    if (Array.isArray(item.series) && item.series.length > 0) {
      series = item.series[0].title || '';
      seriesSequence = item.series[0].sequence || '';
    }

    // Runtime & Duration
    const runtimeSeconds = item.runtime_length_min ? item.runtime_length_min * 60 : (item.runtime_length_sec || 0);
    const durationFormatted = this.formatDuration(runtimeSeconds);

    // High-Resolution Cover Art
    let coverUrl = '';
    if (item.product_images) {
      coverUrl = item.product_images['1000'] || 
                 item.product_images['500'] || 
                 item.product_images['2400'] || 
                 item.product_images[Object.keys(item.product_images)[0]] || '';
    }

    // Companion PDF
    let pdfUrl = null;
    if (item.companion_material && item.companion_material.pdf_url) {
      pdfUrl = item.companion_material.pdf_url;
    } else if (item.relationships && Array.isArray(item.relationships)) {
      const companion = item.relationships.find(r => r.relationship_type === 'CompanionMaterial');
      if (companion && companion.content_url) {
        pdfUrl = companion.content_url;
      }
    }

    // Purchase Date
    const purchaseDate = item.purchase_date || item.origin_date || new Date().toISOString();

    return {
      asin,
      title,
      authors,
      narrators,
      series,
      seriesSequence,
      runtimeSeconds,
      durationFormatted,
      coverUrl,
      pdfUrl,
      purchaseDate,
      releaseDate: item.release_date || '',
      summary: item.summary || item.merchandising_summary || '',
      status: 'ready'
    };
  }

  /**
   * Fetches the entire library with pagination.
   * @param {Object} [options]
   * @param {number} [options.numResults=50] Page size
   * @param {Function} [options.onPageFetched] Progress callback
   * @returns {Promise<Array<Object>>}
   */
  async fetchLibrary(options = {}) {
    if (!this.tokenManager.isAuthenticated()) {
      throw new Error('Not authenticated. Please sign in to your Audible account or import auth.json.');
    }

    const pageSize = options.numResults || 50;
    const allBooks = [];
    let page = 1;
    let totalPages = 1;
    const baseUrl = this.getBaseUrl();

    try {
      do {
        const queryParams = new URLSearchParams({
          response_groups: 'product_desc,contributors,media,series,relationships,product_attrs',
          num_results: pageSize.toString(),
          page: page.toString(),
          sort_by: '-PurchaseDate'
        });

        const url = `${baseUrl}/1.0/library?${queryParams.toString()}`;
        console.log(`[AudibleClient] Fetching library page ${page}: ${url}`);

        const headers = await this.buildRequestHeaders('GET', url);

        const response = await fetch(url, {
          method: 'GET',
          headers
        });

        if (!response.ok) {
          const errText = await response.text();
          let errDetail = `Audible API returned ${response.status}: ${errText}`;
          if (response.status === 401 || response.status === 403) {
            errDetail += ' (Device authorization expired or invalid. Please re-authenticate or re-import auth.json)';
          }
          throw new Error(errDetail);
        }

        const data = await response.json();
        const items = data.items || data.library_items || [];
        
        for (const item of items) {
          allBooks.push(this.parseBookItem(item));
        }

        if (data.total_pages) {
          totalPages = data.total_pages;
        } else if (items.length < pageSize) {
          break;
        }

        if (options.onPageFetched) {
          options.onPageFetched({ page, totalPages, fetchedCount: allBooks.length });
        }

        page++;
      } while (page <= totalPages);

      return allBooks;
    } catch (err) {
      console.error('[AudibleClient] Error fetching library from API:', err);
      throw err;
    }
  }

  /**
   * Decrypts the AES-128-CBC voucher returned in an AAXC license response.
   * Matches the cryptographic algorithm from mkb79/audible and Libation:
   * SHA256(deviceType + deviceSerial + customerId + asin) -> key (first 16B), iv (last 16B).
   * 
   * @param {string} licenseResponse Base64 encoded encrypted voucher
   * @param {string} asin Audiobook ASIN
   * @returns {{ key: string, iv: string } | null}
   */
  decryptVoucher(licenseResponse, asin) {
    if (!licenseResponse) return null;
    try {
      const session = this.tokenManager.session || {};
      const deviceType = session.deviceType || DeviceProfile.getProfile().deviceType;
      const deviceSerial = session.deviceSerial || this.tokenManager.getDeviceSerial();
      const customerId = session.userId || session.customerId;

      if (!customerId) {
        return null;
      }

      const bufStr = `${deviceType}${deviceSerial}${customerId}${asin}`;
      const digest = crypto.createHash('sha256').update(bufStr, 'ascii').digest();
      const key = digest.subarray(0, 16);
      const iv = digest.subarray(16, 32);

      const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
      decipher.setAutoPadding(false);
      const b64Voucher = Buffer.from(licenseResponse, 'base64');
      const decrypted = Buffer.concat([decipher.update(b64Voucher), decipher.final()]);

      let end = decrypted.length;
      while (end > 0 && decrypted[end - 1] === 0) end--;
      const plaintext = decrypted.subarray(0, end).toString('utf8');

      try {
        const parsed = JSON.parse(plaintext);
        if (parsed.key && parsed.iv) {
          return { key: parsed.key, iv: parsed.iv };
        }
      } catch (_) {
        const match = plaintext.match(/^{\s*"key"\s*:\s*"([^"]+)"\s*,\s*"iv"\s*:\s*"([^"]+)"/);
        if (match) {
          return { key: match[1], iv: match[2] };
        }
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Requests an official content download license and decryption metadata for an audiobook.
   * Calls Audible's /1.0/content/{asin}/licenserequest with ADP signature.
   * 
   * @param {string} asin Audible product ASIN
   * @returns {Promise<{
   *   offlineUrl: string,
   *   format: string,
   *   codec: string,
   *   sizeBytes: number,
   *   voucher: { key: string, iv: string } | null,
   *   chapterInfo: Object | null,
   *   pdfUrl: string | null
   * }>}
   */
  async getContentLicense(asin) {
    const baseUrl = this.getBaseUrl();
    const licenseUrl = `${baseUrl}/1.0/content/${asin}/licenserequest`;
    const payload = {
      supported_media_features: {
        drm_types: ['Adrm', 'Mpeg'],
        codecs: ['mp4a.40.2'],
        chapter_titles_type: 'Tree',
        previews: false,
        catalog_samples: false
      },
      consumption_type: 'Download',
      quality: 'High',
      spatial: false,
      response_groups: 'last_position_heard,pdf_url,content_reference,chapter_info'
    };

    const payloadStr = JSON.stringify(payload);
    const headers = await this.buildRequestHeaders('POST', licenseUrl, payloadStr);
    headers['Content-Type'] = 'application/json';

    const response = await fetch(licenseUrl, {
      method: 'POST',
      headers,
      body: payloadStr
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Content license request failed (${response.status}): ${errText}`);
    }

    const data = await response.json();
    const license = data.content_license;
    if (!license || license.status_code !== 'Granted') {
      const reason = license?.message || license?.status_code || JSON.stringify(data);
      throw new Error(`Audible content license was not granted: ${reason}`);
    }

    const metadata = license.content_metadata || {};
    const ref = metadata.content_reference || {};
    const offlineUrl = metadata.content_url?.offline_url;

    if (!offlineUrl) {
      throw new Error(`No offline download URL returned in Audible content license for ASIN ${asin}`);
    }

    // Per Libation (DownloadOptions.cs) and mkb79/audible: a licenserequest that carries an
    // encrypted `license_response` voucher delivers an AAXC file (16-byte key + 16-byte IV).
    // Audible reports drm_type "Adrm" for these, so drm_type can NOT be used to detect AAXC.
    // Activation bytes do NOT decrypt AAXC; FFmpeg will silently emit still-encrypted frames.
    let voucher = null;
    if (license.license_response) {
      if (!this.tokenManager.session?.userId && typeof this.tokenManager.ensureUserProfile === 'function') {
        await this.tokenManager.ensureUserProfile();
      }
      voucher = this.decryptVoucher(license.license_response, asin);
      if (!voucher || !/^[0-9a-f]{32}$/i.test(voucher.key) || !/^[0-9a-f]{32}$/i.test(voucher.iv)) {
        throw new Error(
          `AAXC voucher for ${asin} could not be decrypted (missing or invalid account user_id/device data). ` +
          'Aborting before download to avoid producing a corrupt M4B. Please sign out and sign in again.'
        );
      }
    }

    return {
      offlineUrl,
      format: ref.content_format || 'AAX',
      codec: ref.codec || 'mp4a.40.2',
      sizeBytes: ref.content_size_in_bytes || 0,
      voucher,
      chapterInfo: metadata.chapter_info || null,
      pdfUrl: license.pdf_url || metadata.content_reference?.pdf_url || null
    };
  }

  /**
   * Compatibility wrapper for getContentLicense.
   * @param {string} asin
   */
  async getDownloadStream(asin) {
    const license = await this.getContentLicense(asin);
    return {
      streamUrl: license.offlineUrl,
      voucher: license.voucher,
      quality: 'High'
    };
  }
}

module.exports = AudibleClient;
