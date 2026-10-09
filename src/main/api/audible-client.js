/**
 * ReadFree - Audible API Client
 * 
 * Interacts with Audible's official REST API to:
 * - Query user audiobook library with complete pagination
 * - Extract rich metadata: Title, Authors, Narrators, Series, Runtime, high-res Cover, PDF URL
 * - Request content licensing, DRM vouchers, and direct download links
 */

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
    const profile = DeviceProfile.getProfile('android');
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
   * Requests download and license information for a specific ASIN.
   * @param {string} asin 
   */
  async getDownloadStream(asin) {
    const baseUrl = this.getBaseUrl();
    const licenseUrl = `${baseUrl}/1.0/content/${asin}/licenserequest`;
    const payload = {
      quality: 'High',
      response_groups: 'content_reference,content_url,offline_url,voucher'
    };

    const headers = await this.buildRequestHeaders('POST', licenseUrl, payload);
    headers['Content-Type'] = 'application/json';

    const response = await fetch(licenseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      // If direct license endpoint requires alternate profile, fallback to standard stream
      return {
        streamUrl: `https://content.audible.com/audio/${asin}.aax`,
        voucher: null,
        quality: 'High'
      };
    }

    const data = await response.json();
    return {
      streamUrl: data.content_url || data.offline_url,
      voucher: data.voucher || null,
      quality: data.quality || 'High'
    };
  }
}

module.exports = AudibleClient;
