/**
 * ReadFree - Device Profile & Amazon MAP Registration Specification
 * 
 * Centralizes emulated device profiles, PKCE security challenges,
 * and Amazon Mobile Authentication Platform (MAP) registration formats.
 * 
 * Supports modernized Android (Pixel 8 / Android 14) and iOS profiles
 * to prevent WAF / bot-filter rejection caused by deprecated client versions.
 */

const crypto = require('crypto');

const DEVICE_PROFILES = {
  android: {
    deviceType: 'A10KISP2GWF0E4', // Audible for Android
    appName: 'com.audible.application',
    appVersion: '3.95.0',
    softwareVersion: '39500',
    osVersion: '14',
    deviceModel: 'Pixel 8',
    manufacturer: 'Google',
    userAgent: 'Audible/3.95.0 (Linux; U; Android 14; en_US; Pixel 8 Build/UQ1A.240205.004)'
  },
  ios: {
    deviceType: 'A15PKDT38PJA4R', // Audible for iOS
    appName: 'Audible',
    appVersion: '3.95.0',
    softwareVersion: '39500',
    osVersion: '17.5',
    deviceModel: 'iPhone15,2',
    manufacturer: 'Apple',
    userAgent: 'Audible/3.95.0 (iOS; 17.5; iPhone 15 Pro)'
  }
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
   * @param {'android'|'ios'} [profileName='android']
   * @returns {Object}
   */
  static getProfile(profileName = 'android') {
    return DEVICE_PROFILES[profileName] || DEVICE_PROFILES.android;
  }

  /**
   * Constructs registration payload for https://api.amazon.com/auth/register
   * @param {Object} options
   * @param {string} options.deviceSerial
   * @param {string} options.codeVerifier
   * @param {string} options.authCode
   * @param {'android'|'ios'} [options.profileName='android']
   * @param {string} [options.domain='.amazon.com']
   * @returns {Object}
   */
  static buildRegistrationPayload({ deviceSerial, codeVerifier, authCode, profileName = 'android', domain = '.amazon.com' }) {
    const profile = this.getProfile(profileName);

    return {
      requested_token_type: ['bearer', 'mac_dms'],
      cookies: {
        domain: domain,
        website_cookies: []
      },
      registration_data: {
        domain: 'Device',
        app_version: profile.appVersion,
        device_serial: deviceSerial,
        device_type: profile.deviceType,
        device_name: `ReadFree-${profile.deviceModel}`,
        os_version: profile.osVersion,
        device_model: profile.deviceModel,
        app_name: profile.appName,
        software_version: profile.softwareVersion
      },
      auth_data: {
        client_id: `device:${deviceSerial}`,
        authorization_code: authCode,
        code_verifier: codeVerifier,
        code_algorithm: 'SHA-256'
      },
      requested_extensions: ['device_info', 'customer_info']
    };
  }

  /**
   * Computes SHA256withRSA:1.0 ADP signature for Audible API requests.
   * Format: METHOD\nPATH_WITH_QUERY\nISO8601_DATE\nBODY\nADP_TOKEN
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

    const signer = crypto.createSign('RSA-SHA256');
    signer.update(payloadToSign);
    const signature = signer.sign(privateKeyPem, 'base64');

    return {
      signatureHeader: `${signature}:${isoDate}`,
      timestamp: isoDate
    };
  }
}

module.exports = {
  DeviceProfile,
  DEVICE_PROFILES
};
