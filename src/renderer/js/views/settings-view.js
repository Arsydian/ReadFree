/**
 * ReadFree - Settings View Controller
 * 
 * Manages user preferences:
 * - Output library path selection
 * - Audiobookshelf folder organization toggle
 * - Companion PDF download toggle
 * - Marketplace switching
 * - Forced Full Re-Sync trigger
 * - Database reset
 */

export class SettingsView {
  constructor(app) {
    this.app = app;
    this.dirLabel = document.getElementById('currentOutputDirLabel');
    this.btnChooseDir = document.getElementById('btnChooseOutputDir');
    this.toggleAbsLayout = document.getElementById('toggleAbsLayout');
    this.toggleAbsMetadata = document.getElementById('toggleAbsMetadata');
    this.toggleDownloadPdfs = document.getElementById('toggleDownloadPdfs');
    this.marketplaceSelect = document.getElementById('settingMarketplaceSelect');
    this.btnForceSync = document.getElementById('btnSettingsForceSync');
    this.btnResetDb = document.getElementById('btnResetDatabase');
    this.btnImportAuth = document.getElementById('btnImportAuthJson');

    this.initEvents();
  }

  async loadSettings() {
    try {
      const settings = await window.api.settings.get();
      this.dirLabel.textContent = settings.outputDir || 'No directory selected';
      this.toggleAbsLayout.checked = settings.organizeAbs !== false;
      this.toggleAbsMetadata.checked = settings.generateAbsMetadata !== false;
      this.toggleDownloadPdfs.checked = settings.downloadPdfs !== false;
      this.marketplaceSelect.value = settings.marketplace || 'us';
    } catch (err) {
      console.error('Failed to load settings:', err);
    }
  }

  initEvents() {
    // Choose Directory
    this.btnChooseDir.addEventListener('click', async () => {
      const chosen = await window.api.settings.chooseOutputDir();
      if (chosen) {
        this.dirLabel.textContent = chosen;
        this.app.showToast('Updated download directory', 'success');
      }
    });

    // ABS Layout toggle
    this.toggleAbsLayout.addEventListener('change', async (e) => {
      await window.api.settings.update({ organizeAbs: e.target.checked });
      this.app.showToast('Updated folder organization preference', 'info');
    });

    // ABS Metadata toggle
    this.toggleAbsMetadata.addEventListener('change', async (e) => {
      await window.api.settings.update({ generateAbsMetadata: e.target.checked });
      this.app.showToast('Updated metadata.json preference', 'info');
    });

    // Companion PDF toggle
    this.toggleDownloadPdfs.addEventListener('change', async (e) => {
      await window.api.settings.update({ downloadPdfs: e.target.checked });
      this.app.showToast('Updated PDF booklet preference', 'info');
    });

    // Marketplace change
    this.marketplaceSelect.addEventListener('change', async (e) => {
      await window.api.settings.update({ marketplace: e.target.value });
      this.app.updateAccountMarketplace(e.target.value);
      this.app.showToast(`Switched marketplace to ${e.target.options[e.target.selectedIndex].text}`, 'info');
    });

    // Import auth.json
    if (this.btnImportAuth) {
      this.btnImportAuth.addEventListener('click', async () => {
        try {
          const res = await window.api.auth.importAuthJson();
          if (res && res.success) {
            this.app.showToast('Imported Audible session successfully!', 'success');
            await this.app.checkAuthStatus();
            await this.loadSettings();
          } else if (res && !res.canceled) {
            this.app.showToast(`Import failed: ${res.error || 'Unknown error'}`, 'error');
          }
        } catch (err) {
          this.app.showToast(`Import error: ${err.message}`, 'error');
        }
      });
    }

    // Full Re-Sync button
    this.btnForceSync.addEventListener('click', async () => {
      this.app.switchToView('libraryView');
      await this.app.libraryView.triggerSync(true);
    });

    // Reset Database
    this.btnResetDb.addEventListener('click', async () => {
      if (confirm('Are you sure you want to reset the local database? Your downloaded audiobook files will remain safe.')) {
        await window.api.settings.resetDatabase();
        await this.app.libraryView.loadBooks();
        this.app.showToast('Local database cleared successfully', 'success');
      }
    });
  }
}
