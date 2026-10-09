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
   * Checks if user is authenticated with a valid or refreshable session.
   * @returns {boolean}
   */
  isAuthenticated() {
    return !!(this.session && (this.session.accessToken || this.session.refreshToken));
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
      const response = await fetch('https://api.amazon.com/auth/o2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          app_name: 'Audible',
          grant_type: 'refresh_token',
          refresh_token: this.session.refreshToken
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
   * Sets new session tokens.
   * @param {Object} sessionData 
   */
  setSession(sessionData) {
    this.session = {
      accessToken: sessionData.accessToken,
      refreshToken: sessionData.refreshToken,
      expiresAt: sessionData.expiresAt || (Date.now() + 3600000),
      activationBytes: sessionData.activationBytes || this.session?.activationBytes || '00000000',
      marketplace: sessionData.marketplace || 'us',
      userName: sessionData.userName || 'Audible Listener',
      userEmail: sessionData.userEmail || ''
    };
    this.save();
  }

  /**
   * Returns current session metadata for UI display.
   */
  getSessionInfo() {
    if (!this.session) {
      return {
        isAuthenticated: false,
        userName: 'Not Connected',
        marketplace: 'us'
      };
    }

    return {
      isAuthenticated: true,
      userName: this.session.userName,
      marketplace: this.session.marketplace,
      activationBytes: this.session.activationBytes
    };
  }

  /**
   * Clears session (Logout).
   */
  clear() {
    this.session = null;
    this.save();
  }
}

module.exports = TokenManager;
