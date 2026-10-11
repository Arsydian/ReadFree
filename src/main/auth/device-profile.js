/**
 * ReadFree - Device Profile & Amazon MAP Registration Specification
 * 
 * Centralizes the emulated device profile, marketplace locale table, PKCE
 * challenges, OAuth sign-in URL construction, and Amazon Mobile Authentication
 * Platform (MAP) registration formats.
 * 
 * Wire formats mirror the reference implementation mkb79/audible
 * (src/audible/login.py, register.py, auth.py, localization.py):
 * - client_id = hex(serial + "#" + deviceType), sent as "device:<hex>" in the OAuth URL
 * - openid.ns.oa2 namespace MUST be present or Amazon ignores all openid.oa2.* params
 *   and redirects to /ap/maplanding without an authorization code.
 */

const crypto = require('crypto');

/**
 * Audible iOS app identity. The device type A2CZJZGLK2JJVM is the identifier
 * Amazon issues to the Audible iPhone app; the client_id suffix and the
 * registration device_type must match it exactly.
 *
 * appVersion/softwareVersion are pinned to the build verified by mkb79/audible
 * (3.56.2 / 35602678). The software_version encodes a real app build, so it is
 * not bumped to an unverifiable value.
 */
const DEVICE_PROFILES = {
  ios: {
    deviceType: 'A2CZJZGLK2JJVM',
    appName: 'Audible',
    bundleId: 'com.audible.iphone',
    appVersion: '3.56.2',
    softwareVersion: '35602678',
    osVersion: '15.0.0',
    deviceModel: 'iPhone',
    deviceName: '%FIRST_NAME%%FIRST_NAME_POSSESSIVE_STRING%%DUPE_STRATEGY_1ST%Audible for iPhone',
    userAgent: 'Audible/3.56.2 (iPhone; iOS 15.0; Scale/3.00)',
    loginUserAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
  }
};

const DEFAULT_PROFILE = 'ios';

/**
 * Marketplace locale table (from mkb79/audible localization.py).
 */
const MARKETPLACES = {
  us: { countryCode: 'us', domain: 'com', marketPlaceId: 'AF2M0KC94RCEA' },
  uk: { countryCode: 'uk', domain: 'co.uk', marketPlaceId: 'A2I9A3Q2GNFNGQ' },
  ca: { countryCode: 'ca', domain: 'ca', marketPlaceId: 'A2CQZ5RBY40XE' },
  de: { countryCode: 'de', domain: 'de', marketPlaceId: 'AN7V1F1VY261K' },
  fr: { countryCode: 'fr', domain: 'fr', marketPlaceId: 'A2728XDNODOQ8T' },
  au: { countryCode: 'au', domain: 'com.au', marketPlaceId: 'AN7EY7DTAW63G' },
  it: { countryCode: 'it', domain: 'it', marketPlaceId: 'A2N7FU2W2BU2ZC' },
  es: { countryCode: 'es', domain: 'es', marketPlaceId: 'ALMIKO4SZCSAR' },
  in: { countryCode: 'in', domain: 'in', marketPlaceId: 'AJO3FBRUE6J4S' },
  jp: { countryCode: 'jp', domain: 'co.jp', marketPlaceId: 'A1QAP3MOU4173J' },
  br: { countryCode: 'br', domain: 'com.br', marketPlaceId: 'A10J1VAYUDTYRN' }
};

class DeviceProfile {
  /**
   * Generates a persistent installation-unique device serial number (32-character hex).
   * @returns {string}
   */
  static generateDeviceSerial() {
    return crypto.randomBytes(16).toString('hex').toUpperCase();
  }

  /**
   * Generates PKCE code_verifier and code_challenge (S256).
   * @returns {{ codeVerifier: string, codeChallenge: string }}
   */
  static generatePkce() {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    return { codeVerifier, codeChallenge };
  }

  /**
   * Retrieves active profile configuration.
   * @param {string} [profileName='ios']
   * @returns {Object}
   */
  static getProfile(profileName = DEFAULT_PROFILE) {
    return DEVICE_PROFILES[profileName] || DEVICE_PROFILES[DEFAULT_PROFILE];
  }

  /**
   * Retrieves marketplace locale info.
   * @param {string} [marketplace='us']
   * @returns {{ countryCode: string, domain: string, marketPlaceId: string }}
   */
  static getMarketplace(marketplace = 'us') {
    return MARKETPLACES[marketplace] || MARKETPLACES.us;
  }

  /**
   * Builds the Amazon OAuth client_id: hex-encoded "<serial>#<deviceType>".
   * @param {string} deviceSerial
   * @param {string} [profileName]
   * @returns {string}
   */
  static buildClientId(deviceSerial, profileName = DEFAULT_PROFILE) {
    const profile = this.getProfile(profileName);
    return Buffer.from(`${deviceSerial}#${profile.deviceType}`, 'utf8').toString('hex');
  }

  /**
   * Builds the Amazon sign-in URL that authorizes this app as an Audible device.
   * @param {Object} options
   * @param {string} options.deviceSerial
   * @param {string} options.codeChallenge PKCE S256 challenge
   * @param {string} [options.marketplace='us']
   * @returns {string}
   */
  static buildOAuthUrl({ deviceSerial, codeChallenge, marketplace = 'us' }) {
    const market = this.getMarketplace(marketplace);
    const clientId = this.buildClientId(deviceSerial);

    const params = new URLSearchParams({
      'openid.oa2.response_type': 'code',
      'openid.oa2.code_challenge_method': 'S256',
      'openid.oa2.code_challenge': codeChallenge,
      'openid.return_to': `https://www.amazon.${market.domain}/ap/maplanding`,
      'openid.assoc_handle': `amzn_audible_ios_${market.countryCode}`,
      'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
      'pageId': 'amzn_audible_ios',
      'accountStatusPolicy': 'P1',
      'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
      'openid.mode': 'checkid_setup',
      'openid.ns.oa2': 'http://www.amazon.com/ap/ext/oauth/2',
      'openid.oa2.client_id': `device:${clientId}`,
      'openid.ns.pape': 'http://specs.openid.net/extensions/pape/1.0',
      'marketPlaceId': market.marketPlaceId,
      'openid.oa2.scope': 'device_auth_access',
      'forceMobileLayout': 'true',
      'openid.ns': 'http://specs.openid.net/auth/2.0',
      'openid.pape.max_auth_age': '0'
    });

    return `https://www.amazon.${market.domain}/ap/signin?${params.toString()}`;
  }

  /**
   * Builds initial cookies (frc, map-md, amzn-app-id) the Audible iOS app sends.
   * Reduces CAPTCHA challenges during sign-in.
   * @returns {Object<string,string>}
   */
  static buildInitCookies(profileName = DEFAULT_PROFILE) {
    const profile = this.getProfile(profileName);
    const frc = crypto.randomBytes(313).toString('base64').replace(/=+$/, '');
    const mapMd = Buffer.from(JSON.stringify({
      device_user_dictionary: [],
      device_registration_data: { software_version: profile.softwareVersion },
      app_identifier: { app_version: profile.appVersion, bundle_id: profile.bundleId }
    })).toString('base64').replace(/=+$/, '');

    return {
      'frc': frc,
      'map-md': mapMd,
      'amzn-app-id': 'MAPiOSLib/6.0/ToHideRetailLink'
    };
  }

  /**
   * Inspects a navigation URL during sign-in.
   * Only the real /ap/maplanding landing path counts as completion; intermediate
   * pages (OTP, CVF, approval) that merely reference return_to are ignored.
   *
   * @param {string} url
   * @returns {{ state: 'pending' } | { state: 'code', code: string } | { state: 'error', message: string }}
   */
  static parseLoginRedirect(url) {
    let urlObj;
    try {
      urlObj = new URL(url);
    } catch (_) {
      return { state: 'pending' };
    }

    // Only the real maplanding landing path completes the flow
    const pathname = urlObj.pathname.replace(/\/+$/, '');
    if (pathname !== '/ap/maplanding') {
      return { state: 'pending' };
    }

    if (!/(^|\.)(amazon|audible)\./i.test(urlObj.hostname)) {
      return { state: 'pending' };
    }

    const code = urlObj.searchParams.get('openid.oa2.authorization_code') || urlObj.searchParams.get('authorization_code');
    if (code) {
      return { state: 'code', code };
    }

    if (urlObj.searchParams.get('openid.mode') === 'cancel') {
      return { state: 'error', message: 'Sign-in was cancelled or denied by Amazon.' };
    }

    const amazonError = urlObj.searchParams.get('openid.oa2.error') || urlObj.searchParams.get('error');
    const detail = amazonError ? ` Amazon returned: ${amazonError}.` : '';
    return { state: 'error', message: `Amazon finished sign-in without an authorization code.${detail}` };
  }

  /**
   * Constructs registration payload for https://api.amazon.<domain>/auth/register
   * @param {Object} options
   * @param {string} options.deviceSerial
   * @param {string} options.codeVerifier
   * @param {string} options.authCode
   * @param {string} [options.marketplace='us']
   * @returns {Object}
   */
  static buildRegistrationPayload({ deviceSerial, codeVerifier, authCode, marketplace = 'us' }) {
    const profile = this.getProfile();
    const market = this.getMarketplace(marketplace);

    return {
      requested_token_type: ['bearer', 'mac_dms', 'website_cookies', 'store_authentication_cookie'],
      cookies: {
        website_cookies: [],
        domain: `.amazon.${market.domain}`
      },
      registration_data: {
        domain: 'Device',
        app_version: profile.appVersion,
        device_serial: deviceSerial,
        device_type: profile.deviceType,
        device_name: profile.deviceName,
        os_version: profile.osVersion,
        software_version: profile.softwareVersion,
        device_model: profile.deviceModel,
        app_name: profile.appName
      },
      auth_data: {
        client_id: this.buildClientId(deviceSerial),
        authorization_code: authCode,
        code_verifier: codeVerifier,
        code_algorithm: 'SHA-256',
        client_domain: 'DeviceLegacy'
      },
      requested_extensions: ['device_info', 'customer_info']
    };
  }

  /**
   * Computes SHA256withRSA:1.0 ADP digital signature for Audible API requests.
   * Format: METHOD\nPATH_WITH_QUERY\nISO8601_DATE\nBODY\nADP_TOKEN
   * 
   * NOTE: This is an asymmetric digital signature over an HTTP request payload required by
   * Amazon's Audible Device Messaging Service (DMS/ADP) protocol (x-adp-alg: SHA256withRSA:1.0),
   * NOT a password hash. It cannot use bcrypt/scrypt/argon2 as Amazon's servers verify
   * incoming requests with standard RSA-SHA256 against the registered device public key.
   * 
   * @param {Object} params
   * @param {string} params.method e.g. 'GET', 'POST'
   * @param {string} params.pathWithQuery e.g. '/1.0/library?num_results=50'
   * @param {string} [params.body=''] JSON string or empty
   * @param {string} params.adpToken MAC DMS token from registration
   * @param {string} params.privateKeyPem 2048-bit RSA Private Key PEM
   * @param {string} [params.timestamp] ISO8601 UTC date string
   * @returns {{ signatureHeader: string, timestamp: string }}
   */
  static signAdpRequest({ method, pathWithQuery, body = '', adpToken, privateKeyPem, timestamp }) {
    if (!adpToken || !privateKeyPem) {
      throw new Error('ADP signing requires both adpToken and privateKeyPem');
    }

    const isoDate = timestamp || new Date().toISOString();
    const bodyStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : '';

    const payloadToSign = `${method.toUpperCase()}\n${pathWithQuery}\n${isoDate}\n${bodyStr}\n${adpToken}`;

    // Modern one-shot digital signature creation via crypto.sign
    const signature = crypto.sign('RSA-SHA256', Buffer.from(payloadToSign, 'utf8'), privateKeyPem).toString('base64');

    return {
      signatureHeader: `${signature}:${isoDate}`,
      timestamp: isoDate
    };
  }
}

module.exports = {
  DeviceProfile,
  DEVICE_PROFILES,
  MARKETPLACES
};
