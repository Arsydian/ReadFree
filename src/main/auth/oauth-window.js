/**
 * ReadFree - Amazon / Audible OAuth Login Window
 * 
 * Manages an isolated Electron browser window for logging into Amazon/Audible.
 * 
 * Implements real Amazon Mobile Authentication Platform (MAP) PKCE authorization
 * and device registration (/auth/register), capturing authentic ADP tokens and
 * RSA private keys for cryptographic request signing.
 */

const { BrowserWindow, session } = require('electron');
const { DeviceProfile } = require('./device-profile');

class OAuthWindow {
  /**
   * @param {Object} tokenManager TokenManager instance
   * @param {BrowserWindow} [parentWindow] Parent window for modal presentation
   */
  constructor(tokenManager, parentWindow) {
    this.tokenManager = tokenManager;
    this.parentWindow = parentWindow;
    this.authWindow = null;
  }

  /**
   * Seeds the iOS app's initial cookies into the auth session to reduce CAPTCHAs.
   * @param {Electron.Session} authSession
   * @param {string} domain e.g. 'com'
   */
  async seedInitCookies(authSession, domain) {
    const cookies = DeviceProfile.buildInitCookies();
    for (const [name, value] of Object.entries(cookies)) {
      try {
        await authSession.cookies.set({
          url: `https://www.amazon.${domain}`,
          domain: `.amazon.${domain}`,
          name,
          value,
          secure: true
        });
      } catch (err) {
        console.warn(`[OAuthWindow] Could not set init cookie ${name}:`, err.message);
      }
    }
  }

  /**
   * Exchanges the authorization code for device credentials via Amazon MAP.
   * @returns {Promise<Object>} Parsed `response.success` object
   */
  async registerDevice({ authCode, codeVerifier, deviceSerial, marketplace }) {
    const market = DeviceProfile.getMarketplace(marketplace);
    const regPayload = DeviceProfile.buildRegistrationPayload({
      deviceSerial,
      codeVerifier,
      authCode,
      marketplace
    });

    const regEndpoint = `https://api.amazon.${market.domain}/auth/register`;
    console.log(`[OAuthWindow] Sending registration request to ${regEndpoint}...`);

    const regResponse = await fetch(regEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(regPayload)
    });

    const rawBody = await regResponse.text();
    let regData;
    try {
      regData = JSON.parse(rawBody);
    } catch (_) {
      throw new Error(`Device registration failed (${regResponse.status}): non-JSON response`);
    }

    if (!regResponse.ok || regData.response?.error) {
      const errMsg = regData.response?.error?.message || regData.error_description || JSON.stringify(regData);
      throw new Error(`Device registration failed (${regResponse.status}): ${errMsg}`);
    }

    const success = regData.response?.success;
    if (!success?.tokens?.mac_dms?.adp_token || !success?.tokens?.mac_dms?.device_private_key) {
      throw new Error('Amazon did not return required mac_dms ADP tokens or private key.');
    }
    return success;
  }

  /**
   * Launches the authentication browser window.
   * @param {string} [marketplace='us'] Selected marketplace
   * @returns {Promise<Object>} Session info upon successful auth
   */
  async openLogin(marketplace = 'us') {
    const market = DeviceProfile.getMarketplace(marketplace);
    const profile = DeviceProfile.getProfile();
    const deviceSerial = this.tokenManager.getDeviceSerial();
    const { codeVerifier, codeChallenge } = DeviceProfile.generatePkce();
    const authUrl = DeviceProfile.buildOAuthUrl({ deviceSerial, codeChallenge, marketplace });

    // Dedicated isolated session for the Amazon login flow
    const authSession = session.fromPartition('persist:audible-auth');
    await this.seedInitCookies(authSession, market.domain);

    return new Promise((resolve, reject) => {
      this.authWindow = new BrowserWindow({
        width: 580,
        height: 720,
        title: 'Sign in with Amazon for Audible',
        parent: this.parentWindow,
        modal: true,
        show: true,
        webPreferences: {
          session: authSession,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webviewTag: false
        }
      });

      // Security: Disallow child windows/popups from untrusted remote Amazon login flow
      this.authWindow.webContents.setWindowOpenHandler(() => {
        return { action: 'deny' };
      });

      let completed = false;

      const finish = (err, result) => {
        if (this.authWindow && !this.authWindow.isDestroyed()) {
          this.authWindow.close();
        }
        if (err) reject(err); else resolve(result);
      };

      // Inspect every navigation; only the real /ap/maplanding landing completes the flow.
      // Intermediate OTP / CVF / approval pages are left alone.
      const handleNavigation = async (event, url) => {
        if (completed) return;

        const result = DeviceProfile.parseLoginRedirect(url);
        if (result.state === 'pending') return;

        completed = true;
        // maplanding is not a real page (it 404s); stop the browser from loading it
        if (event && typeof event.preventDefault === 'function') {
          event.preventDefault();
        }

        if (result.state === 'error') {
          console.error('[OAuthWindow] Authentication error:', result.message);
          finish(new Error(result.message));
          return;
        }

        try {
          console.log('[OAuthWindow] Authorization code received. Initiating Amazon MAP device registration...');
          const success = await this.registerDevice({
            authCode: result.code,
            codeVerifier,
            deviceSerial,
            marketplace
          });

          const bearer = success.tokens.bearer;
          const macDms = success.tokens.mac_dms;
          const custInfo = success.extensions?.customer_info;

          console.log('[OAuthWindow] Device registration successful. Storing ADP session tokens...');

          this.tokenManager.setSession({
            deviceSerial,
            deviceType: profile.deviceType,
            adpToken: macDms.adp_token,
            devicePrivateKey: macDms.device_private_key,
            accessToken: bearer?.access_token || null,
            refreshToken: bearer?.refresh_token || null,
            expiresAt: Date.now() + ((parseInt(bearer?.expires_in, 10) || 3600) * 1000),
            marketplace,
            userName: custInfo?.name || 'Audible Member'
          });

          finish(null, this.tokenManager.getSessionInfo());
        } catch (err) {
          console.error('[OAuthWindow] Authentication error:', err);
          finish(err);
        }
      };

      this.authWindow.webContents.on('will-navigate', (event, url) => handleNavigation(event, url));
      this.authWindow.webContents.on('will-redirect', (event, url) => handleNavigation(event, url));
      // Fallback for navigations that bypass will-* events (e.g. server-side redirects already committed)
      this.authWindow.webContents.on('did-navigate', (_event, url) => handleNavigation(null, url));

      this.authWindow.on('closed', () => {
        this.authWindow = null;
        if (!completed) {
          completed = true;
          // Closed without completing: resolve with existing status
          resolve(this.tokenManager.getSessionInfo());
        }
      });

      this.authWindow.loadURL(authUrl, { userAgent: profile.loginUserAgent });
    });
  }
}

module.exports = OAuthWindow;
