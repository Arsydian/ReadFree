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
const path = require('path');
const { DeviceProfile } = require('./device-profile');

// Audible Marketplace Domains & Client Parameters
const MARKETPLACE_DOMAINS = {
  us: { amazon: 'www.amazon.com', audible: 'api.audible.com', countryCode: 'US' },
  uk: { amazon: 'www.amazon.co.uk', audible: 'api.audible.co.uk', countryCode: 'GB' },
  ca: { amazon: 'www.amazon.ca', audible: 'api.audible.ca', countryCode: 'CA' },
  de: { amazon: 'www.amazon.de', audible: 'api.audible.de', countryCode: 'DE' },
  au: { amazon: 'www.amazon.com.au', audible: 'api.audible.com.au', countryCode: 'AU' },
  fr: { amazon: 'www.amazon.fr', audible: 'api.audible.fr', countryCode: 'FR' }
};

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
   * Launches the authentication browser window.
   * @param {string} [marketplace='us'] Selected marketplace
   * @returns {Promise<Object>} Session info upon successful auth
   */
  async openLogin(marketplace = 'us') {
    const market = MARKETPLACE_DOMAINS[marketplace] || MARKETPLACE_DOMAINS.us;
    const deviceSerial = this.tokenManager.getDeviceSerial();
    const { codeVerifier, codeChallenge } = DeviceProfile.generatePkce();

    // Build the OAuth Login URL with modern PKCE parameters
    const returnTo = `https://${market.amazon}/ap/maplanding`;
    const authParams = new URLSearchParams({
      'openid.oa2.response_type': 'code',
      'openid.oa2.code_challenge': codeChallenge,
      'openid.oa2.code_challenge_method': 'S256',
      'openid.oa2.scope': 'device_auth_access',
      'openid.oa2.client_id': `device:${deviceSerial}`,
      'openid.return_to': returnTo,
      'openid.assoc_handle': `amzn_audible_ios_${market.countryCode.toLowerCase()}`,
      'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
      'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
      'openid.mode': 'checkid_setup',
      'openid.ns': 'http://specs.openid.net/auth/2.0',
      'openid.pape.max_auth_age': '0'
    });

    const authUrl = `https://${market.amazon}/ap/signin?${authParams.toString()}`;

    return new Promise((resolve, reject) => {
      // Create dedicated isolated session for clean login
      const authSession = session.fromPartition('persist:audible-auth');

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

      // Listen for navigation and redirection
      const handleNavigation = async (url) => {
        if (completed) return;

        // Check if redirected to the maplanding authorization handler
        if (url.includes('/ap/maplanding') || url.includes('openid.oa2.authorization_code')) {
          completed = true;
          try {
            const urlObj = new URL(url);
            const authCode = urlObj.searchParams.get('openid.oa2.authorization_code');
            if (!authCode) {
              throw new Error('No authorization code found in redirect URL.');
            }

            console.log('[OAuthWindow] Authorization code received. Initiating Amazon MAP device registration...');

            const domainStr = `.${market.amazon.replace('www.', '')}`;

            // Build registration payload for Amazon MAP
            const regPayload = DeviceProfile.buildRegistrationPayload({
              deviceSerial,
              codeVerifier,
              authCode,
              profileName: 'android',
              domain: domainStr
            });

            // Execute Amazon MAP registration
            const regEndpoint = 'https://api.amazon.com/auth/register';
            console.log(`[OAuthWindow] Sending registration request to ${regEndpoint}...`);

            const regResponse = await fetch(regEndpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
              },
              body: JSON.stringify(regPayload)
            });

            const regData = await regResponse.json();

            if (!regResponse.ok || regData.response?.error) {
              const errMsg = regData.response?.error?.message || regData.error_description || JSON.stringify(regData);
              throw new Error(`Device registration failed (${regResponse.status}): ${errMsg}`);
            }

            const success = regData.response?.success;
            const bearer = success?.tokens?.bearer;
            const macDms = success?.tokens?.mac_dms;
            const custInfo = success?.extensions?.customer_info;

            if (!macDms?.adp_token || !macDms?.device_private_key) {
              throw new Error('Amazon did not return required mac_dms ADP tokens or private key.');
            }

            console.log('[OAuthWindow] Device registration successful. Storing ADP session tokens...');

            // Construct registered session credentials
            const sessionData = {
              deviceSerial,
              adpToken: macDms.adp_token,
              devicePrivateKey: macDms.device_private_key,
              accessToken: bearer?.access_token || null,
              refreshToken: bearer?.refresh_token || null,
              expiresAt: Date.now() + ((parseInt(bearer?.expires_in, 10) || 3600) * 1000),
              marketplace: marketplace,
              userName: custInfo?.name || 'Audible Member',
              activationBytes: '1a2b3c4d'
            };

            this.tokenManager.setSession(sessionData);

            if (this.authWindow && !this.authWindow.isDestroyed()) {
              this.authWindow.close();
            }

            resolve(this.tokenManager.getSessionInfo());
          } catch (err) {
            console.error('[OAuthWindow] Authentication error:', err);
            if (this.authWindow && !this.authWindow.isDestroyed()) {
              this.authWindow.close();
            }
            reject(err);
          }
        }
      };

      this.authWindow.webContents.on('will-navigate', (_event, url) => {
        handleNavigation(url);
      });

      this.authWindow.webContents.on('will-redirect', (_event, url) => {
        handleNavigation(url);
      });

      this.authWindow.on('closed', () => {
        this.authWindow = null;
        if (!completed) {
          // If closed without completing, resolve with existing status
          resolve(this.tokenManager.getSessionInfo());
        }
      });

      this.authWindow.loadURL(authUrl);
    });
  }
}

module.exports = OAuthWindow;

