/**
 * ReadFree - Audible Token & Session Manager
 * 
 * Securely persists and refreshes OAuth session tokens, device identity,
 * and Audible account activation bytes.
 * 
 * Handles automatic refresh token rotation when access tokens expire,
 * preventing silent synchronization stalls and authentication dropouts.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { DeviceProfile } = require('./device-profile');

class TokenManager {
  /**
   * Initializes token manager and loads existing session if present.
   * @param {string} [customPath] Custom path for session file
   */
  constructor(customPath) {
    const baseDir = customPath || (app ? app.getPath('userData') : path.join(process.cwd(), 'userData'));
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }

    this.sessionFile = path.join(baseDir, 'auth_session.json');
    this.session = null;
    this.load();

    // Ensure persistent device serial exists
    if (!this.session) {
      this.session = {
        deviceSerial: DeviceProfile.generateDeviceSerial()
      };
      this.save();
    } else if (!this.session.deviceSerial) {
      this.session.deviceSerial = DeviceProfile.generateDeviceSerial();
      this.save();
    }
  }

  /**
   * Loads cached session data from disk.
   */
  load() {
    try {
      if (fs.existsSync(this.sessionFile)) {
        const raw = fs.readFileSync(this.sessionFile, 'utf8');
        this.session = JSON.parse(raw);
      }
    } catch (err) {
      console.error('[TokenManager] Error loading session file:', err);
      this.session = null;
    }
  }

  /**
   * Persists session data safely.
   */
  save() {
    try {
      if (!this.session) {
        if (fs.existsSync(this.sessionFile)) {
          fs.unlinkSync(this.sessionFile);
        }
        return;
      }
      fs.writeFileSync(this.sessionFile, JSON.stringify(this.session, null, 2), 'utf8');
    } catch (err) {
      console.error('[TokenManager] Failed to save session:', err);
    }
  }

  /**
   * Checks if user is authenticated with valid credentials.
   * @returns {boolean}
   */
  isAuthenticated() {
    if (!this.session) return false;
    // Considered authenticated if we have valid ADP device credentials or bearer access token
    return !!((this.session.adpToken && this.session.devicePrivateKey) || this.session.accessToken || this.session.refreshToken);
  }

  /**
   * Checks if ADP cryptographic signing credentials are available.
   * @returns {boolean}
   */
  hasAdpCredentials() {
    return !!(this.session && this.session.adpToken && this.session.devicePrivateKey);
  }

  /**
   * Retrieves persistent device serial for this installation.
   * @returns {string}
   */
  getDeviceSerial() {
    if (!this.session || !this.session.deviceSerial) {
      const serial = DeviceProfile.generateDeviceSerial();
      if (!this.session) this.session = {};
      this.session.deviceSerial = serial;
      this.save();
    }
    return this.session.deviceSerial;
  }

  /**
   * Retrieves active access token, refreshing if close to expiry.
   * @returns {Promise<string|null>}
   */
  async getValidAccessToken() {
    if (!this.session) return null;

    // Check if token expires within 5 minutes
    const now = Date.now();
    const expiry = this.session.expiresAt || 0;
    
    if (now >= (expiry - 300000) && this.session.refreshToken) {
      console.log('[TokenManager] Access token nearing expiration, performing refresh...');
      await this.refreshTokens();
    }

    return this.session.accessToken || null;
  }

  /**
   * Refreshes the OAuth access token using Amazon's token endpoint.
   */
  async refreshTokens() {
    if (!this.session || !this.session.refreshToken) {
      throw new Error('No refresh token available to renew session.');
    }

    try {
      const profile = DeviceProfile.getProfile();
      const market = DeviceProfile.getMarketplace(this.session.marketplace || 'us');
      const response = await fetch(`https://api.amazon.${market.domain}/auth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          app_name: profile.appName,
          app_version: profile.appVersion,
          source_token: this.session.refreshToken,
          requested_token_type: 'access_token',
          source_token_type: 'refresh_token'
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Token refresh failed (${response.status}): ${errText}`);
      }

      const data = await response.json();
      
      this.session.accessToken = data.access_token;
      if (data.refresh_token) {
        this.session.refreshToken = data.refresh_token;
      }
      this.session.expiresAt = Date.now() + ((data.expires_in || 3600) * 1000);
      this.save();
      console.log('[TokenManager] Token successfully refreshed.');
    } catch (err) {
      console.error('[TokenManager] Failed to refresh token:', err);
      throw err;
    }
  }

  /**
   * Fetches the user's Audible activation bytes from Audible's license server
   * using authenticated ADP request signing.
   * @returns {Promise<string>} 8-character hex activation bytes
   */
  async fetchActivationBytes() {
    if (!this.session?.adpToken || !this.session?.devicePrivateKey) {
      throw new Error('Cannot fetch activation bytes without ADP credentials.');
    }

    const pathWithQuery = '/license/token?action=register&player_manuf=Audible,iPhone&player_model=iPhone';
    const profile = DeviceProfile.getProfile();
    const signed = DeviceProfile.signAdpRequest({
      method: 'GET',
      pathWithQuery,
      body: '',
      adpToken: this.session.adpToken,
      privateKeyPem: this.session.devicePrivateKey
    });

    const headers = {
      'User-Agent': profile.userAgent,
      'x-adp-token': this.session.adpToken,
      'x-adp-alg': 'SHA256withRSA:1.0',
      'x-adp-signature': signed.signatureHeader
    };

    const accessToken = await this.getValidAccessToken();
    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }

    const response = await fetch(`https://www.audible.com${pathWithQuery}`, {
      method: 'GET',
      headers
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch activation bytes (${response.status}): ${response.statusText}`);
    }

    const arrayBuf = await response.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    const ACTIVATION_BLOB_SZ = 0x238; // 568 bytes

    if (buf.length < ACTIVATION_BLOB_SZ) {
      throw new Error(`Audible activation response too short: ${buf.length} bytes`);
    }

    const actBytes = buf.readUInt32LE(buf.length - ACTIVATION_BLOB_SZ);
    const hex = actBytes.toString(16).padStart(8, '0');

    this.session.activationBytes = hex;
    this.save();
    console.log('[TokenManager] Successfully retrieved activation bytes:', hex);
    return hex;
  }

  /**
   * Sets new session tokens.
   * @param {Object} sessionData 
   */
  setSession(sessionData) {
    this.session = {
      deviceSerial: sessionData.deviceSerial || this.getDeviceSerial(),
      adpToken: sessionData.adpToken || this.session?.adpToken || null,
      devicePrivateKey: sessionData.devicePrivateKey || this.session?.devicePrivateKey || null,
      deviceType: sessionData.deviceType || this.session?.deviceType || DeviceProfile.getProfile().deviceType,
      accessToken: sessionData.accessToken || this.session?.accessToken || null,
      refreshToken: sessionData.refreshToken || this.session?.refreshToken || null,
      expiresAt: sessionData.expiresAt || (Date.now() + 3600000 * 24 * 30),
      activationBytes: sessionData.activationBytes || this.session?.activationBytes || '00000000',
      marketplace: sessionData.marketplace || this.session?.marketplace || 'us',
      userId: sessionData.userId || this.session?.userId || null,
      userName: sessionData.userName || this.session?.userName || 'Audible Listener',
      userEmail: sessionData.userEmail || this.session?.userEmail || ''
    };
    this.save();
  }

  /**
   * Imports session credentials from an external auth.json (e.g. mkb79/audible-cli or Libation).
   * @param {string|Object} input File path or parsed JSON object
   * @returns {Object} Session info
   */
  importAuthJson(input) {
    let data = input;
    if (typeof input === 'string') {
      if (fs.existsSync(input)) {
        const raw = fs.readFileSync(input, 'utf8');
        data = JSON.parse(raw);
      } else {
        // Try parsing string directly as JSON
        data = JSON.parse(input);
      }
    }

    if (!data || typeof data !== 'object') {
      throw new Error('Invalid auth.json format.');
    }

    // Extract fields compatible with mkb79/audible and Libation
    const adpToken = data.adp_token || data.AdpToken || data.mac_dms?.adp_token || null;
    const devicePrivateKey = data.device_private_key || data.PrivateKey || data.mac_dms?.device_private_key || null;
    const accessToken = data.access_token || data.AccessToken || data.bearer?.access_token || null;
    const refreshToken = data.refresh_token || data.RefreshToken || data.bearer?.refresh_token || null;
    const deviceSerial = data.device_serial || data.DeviceSerial || data.registration_data?.device_serial || this.getDeviceSerial();
    const marketplace = (data.locale_code || data.locale || data.marketplace || data.Marketplace || 'us').toLowerCase();
    const activationBytes = data.activation_bytes || data.ActivationBytes || data.activationBytes || '00000000';
    const userId = data.customer_info?.user_id || data.user_id || data.customerId || data.CustomerId || data.amazonAccountId || data.AmazonAccountId || null;
    const userName = data.customer_info?.name || data.name || data.userName || data.UserName || 'Audible Listener';
    const userEmail = data.customer_info?.email || data.email || data.userEmail || '';

    if (!adpToken && !accessToken) {
      throw new Error('Import failed: File contains neither adp_token nor access_token credentials.');
    }

    this.setSession({
      adpToken,
      devicePrivateKey,
      accessToken,
      refreshToken,
      deviceSerial,
      marketplace,
      activationBytes,
      userId,
      userName,
      userEmail
    });

    console.log('[TokenManager] Successfully imported external credentials for marketplace:', marketplace);
    return this.getSessionInfo();
  }

  /**
   * Returns current session metadata for UI display.
   */
  getSessionInfo() {
    if (!this.session || !this.isAuthenticated()) {
      return {
        isAuthenticated: false,
        userName: 'Not Connected',
        marketplace: 'us',
        hasAdpCredentials: false
      };
    }

    return {
      isAuthenticated: true,
      userName: this.session.userName || 'Audible Listener',
      marketplace: this.session.marketplace || 'us',
      activationBytes: this.session.activationBytes || '00000000',
      hasAdpCredentials: this.hasAdpCredentials(),
      deviceSerial: this.session.deviceSerial,
      userId: this.session.userId || null
    };
  }

  /**
   * Clears session (Logout), preserving persistent device serial.
   */
  clear() {
    const serial = this.session?.deviceSerial || DeviceProfile.generateDeviceSerial();
    this.session = {
      deviceSerial: serial
    };
    this.save();
  }
}

module.exports = TokenManager;
