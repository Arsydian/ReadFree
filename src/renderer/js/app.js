/**
 * ReadFree - Master Application Controller
 * 
 * Coordinates:
 * - View routing and active navigation state
 * - Authentication status tracking and Amazon login trigger
 * - Global toast notification dispatcher
 * - Component lifecycle initialization
 */

import { LibraryView } from './views/library-view.js';
import { DownloadView } from './views/download-view.js';
import { SettingsView } from './views/settings-view.js';
import { MiniPlayer } from './player/mini-player.js';

class App {
  constructor() {
    this.currentViewId = 'libraryView';
    this.toastContainer = document.getElementById('toastContainer');
    this.statusDot = document.getElementById('statusDot');
    this.statusText = document.getElementById('statusText');
    this.userNameLabel = document.getElementById('userNameLabel');
    this.userMarketLabel = document.getElementById('userMarketLabel');
    this.userAvatar = document.getElementById('userAvatar');
    this.btnAuthAction = document.getElementById('btnAuthAction');

    // Initialize Sub-Controllers
    this.player = new MiniPlayer(this);
    this.libraryView = new LibraryView(this);
    this.downloadView = new DownloadView(this);
    this.settingsView = new SettingsView(this);

    this.initNavigation();
    this.initAuth();
  }

  async init() {
    try {
      if (window.api?.app?.getVersion) {
        const version = await window.api.app.getVersion();
        const versionBadge = document.querySelector('.titlebar-badge');
        if (versionBadge && version) {
          versionBadge.textContent = `v${version}`;
        }
      }
    } catch (e) {
      console.warn('Could not retrieve app version:', e);
    }
    await this.updateAuthStatus();
    await this.settingsView.loadSettings();
    await this.libraryView.loadBooks();
  }

  initNavigation() {
    const navItems = document.querySelectorAll('.sidebar-nav .nav-item');
    navItems.forEach(item => {
      item.addEventListener('click', () => {
        const viewId = item.dataset.view;
        this.switchToView(viewId);
      });
    });
  }

  switchToView(viewId) {
    if (this.currentViewId === viewId) return;

    // Update Nav item classes
    document.querySelectorAll('.sidebar-nav .nav-item').forEach(item => {
      if (item.dataset.view === viewId) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });

    // Update Views
    document.querySelectorAll('.view-container').forEach(view => {
      if (view.id === viewId) {
        view.classList.add('active');
      } else {
        view.classList.remove('active');
      }
    });

    this.currentViewId = viewId;
  }

  initAuth() {
    this.btnAuthAction.addEventListener('click', async () => {
      const status = await window.api.auth.getStatus();
      if (status.isAuthenticated) {
        // Logout
        if (confirm('Do you want to sign out of your Audible account?')) {
          await window.api.auth.logout();
          await this.updateAuthStatus();
          this.showToast('Signed out of Audible', 'info');
        }
      } else {
        // Login
        this.btnAuthAction.disabled = true;
        this.btnAuthAction.textContent = 'Connecting...';
        this.showToast('Opening Amazon / Audible login window...', 'info');

        try {
          const res = await window.api.auth.login();
          if (res.success) {
            await this.updateAuthStatus();
            this.showToast('Successfully authenticated with Audible!', 'success');
            // Trigger automatic sync
            await this.libraryView.triggerSync(false);
          } else {
            this.showToast(`Login notice: ${res.error || 'Window closed'}`, 'warning');
          }
        } catch (err) {
          this.showToast(`Authentication error: ${err.message}`, 'error');
        } finally {
          this.btnAuthAction.disabled = false;
        }
      }
    });
  }

  async updateAuthStatus() {
    try {
      const info = await window.api.auth.getStatus();
      if (info.isAuthenticated) {
        this.statusDot.className = 'status-dot connected';
        this.statusText.textContent = 'Connected';
        this.userNameLabel.textContent = info.userName || 'Audible Member';
        this.userMarketLabel.textContent = `Audible.${info.marketplace || 'com'}`;
        this.userAvatar.textContent = (info.userName || 'A').charAt(0).toUpperCase();
        this.btnAuthAction.textContent = 'Sign Out';
        this.btnAuthAction.className = 'btn btn-glass btn-sm';
      } else {
        this.statusDot.className = 'status-dot';
        this.statusText.textContent = 'Not Connected';
        this.userNameLabel.textContent = 'Not Connected';
        this.userMarketLabel.textContent = 'Local Library';
        this.userAvatar.textContent = '?';
        this.btnAuthAction.textContent = 'Sign In to Audible';
        this.btnAuthAction.className = 'btn btn-primary btn-sm';
      }
    } catch (err) {
      console.error('Failed to get auth status:', err);
    }
  }

  updateAccountMarketplace(market) {
    this.userMarketLabel.textContent = `Audible.${market}`;
  }

  showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = 'toast';

    let icon = 'ℹ️';
    if (type === 'success') icon = '✓';
    if (type === 'warning') icon = '⚠️';
    if (type === 'error') icon = '✕';

    toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
    this.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3800);
  }
}

// Instantiate application safely regardless of document ready state
function startApp() {
  if (!window.app) {
    window.app = new App();
    window.app.init().catch(err => console.error('[App] Init error:', err));
  }
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', startApp);
} else {
  startApp();
}
