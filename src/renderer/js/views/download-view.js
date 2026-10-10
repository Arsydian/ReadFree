/**
 * ReadFree - Download Queue View Controller
 * 
 * Manages rendering the active and queued downloads:
 * - Real-time progress bar and percentage updates
 * - Live speed indicators
 * - Direct Cancel and Retry controls
 */

export class DownloadView {
  constructor(app) {
    this.app = app;
    this.container = document.getElementById('downloadsList');
    this.emptyState = document.getElementById('emptyDownloadsState');
    this.badge = document.getElementById('activeDownloadsBadge');
    this.btnClear = document.getElementById('btnClearCompletedDownloads');

    this.activeDownloads = new Map(); // asin -> download data

    this.initEvents();
    this.loadQueue();
  }

  async loadQueue() {
    try {
      if (window.api?.downloads?.getQueue) {
        const queue = await window.api.downloads.getQueue();
        if (Array.isArray(queue)) {
          queue.forEach(item => {
            if (!this.activeDownloads.has(item.asin)) {
              this.activeDownloads.set(item.asin, item);
            }
          });
          this.render();
        }
      }
    } catch (e) {
      console.warn('[DownloadView] Failed to load queue:', e);
    }
  }

  initEvents() {
    this.btnClear.addEventListener('click', async () => {
      // Remove completed, cancelled, or failed items
      for (const [asin, data] of this.activeDownloads.entries()) {
        if (data.status === 'completed' || data.status === 'ready' || data.status === 'failed') {
          this.activeDownloads.delete(asin);
        }
      }
      if (window.api?.downloads?.clearCompleted) {
        await window.api.downloads.clearCompleted();
      }
      this.render();
      if (this.app.libraryView) {
        this.app.libraryView.loadBooks();
      }
    });

    // Listen to real-time download events from preload bridge
    window.api.downloads.onProgress((data) => {
      this.handleProgressUpdate(data);
    });
  }

  handleProgressUpdate(data) {
    const existing = this.activeDownloads.get(data.asin) || {};
    this.activeDownloads.set(data.asin, { ...existing, ...data });
    
    // If completed, refresh library list
    if (data.status === 'completed') {
      this.app.libraryView.loadBooks();
      this.app.showToast(`Completed: ${data.title || 'Audiobook'} is DRM-free!`, 'success');
    }

    this.render();
  }

  updateBadge() {
    let activeCount = 0;
    for (const d of this.activeDownloads.values()) {
      if (d.status === 'downloading' || d.status === 'converting') {
        activeCount++;
      }
    }

    if (activeCount > 0) {
      this.badge.style.display = 'inline-block';
      this.badge.textContent = activeCount;
    } else {
      this.badge.style.display = 'none';
    }
  }

  render() {
    this.updateBadge();
    const items = Array.from(this.activeDownloads.values());

    if (items.length === 0) {
      this.container.style.display = 'none';
      this.emptyState.style.display = 'flex';
      return;
    }

    this.container.style.display = 'flex';
    this.emptyState.style.display = 'none';

    this.container.innerHTML = items.map(item => {
      const isCompleted = item.status === 'completed';
      const isFailed = item.status === 'failed';
      const isDownloading = item.status === 'downloading' || item.status === 'converting';

      let statusColor = '#3b82f6';
      if (isCompleted) statusColor = '#10b981';
      if (isFailed) statusColor = '#f43f5e';

      return `
        <div class="download-card" data-asin="${item.asin}">
          <img src="${item.coverUrl || '../../assets/cover-placeholder.svg'}" alt="" class="download-thumbnail">
          
          <div class="download-info">
            <div class="download-header">
              <span class="download-title">${item.title || 'Audiobook'}</span>
              <span class="download-stats" style="color: ${statusColor};">
                ${isCompleted ? '100%' : `${item.percentage || 0}%`}
              </span>
            </div>

            <div class="progress-bar-container">
              <div class="progress-fill ${isCompleted ? 'completed' : ''} ${isFailed ? 'failed' : ''}" 
                   style="width: ${item.percentage || 0}%;"></div>
            </div>

            <div class="download-meta-sub">
              <span>${item.speedText || (isCompleted ? 'Decrypted M4B ready' : 'Processing...')}</span>
              <span>${item.status ? item.status.toUpperCase() : ''}</span>
            </div>
          </div>

          <div class="download-actions">
            ${isDownloading ? `
              <button class="btn btn-danger btn-sm btn-cancel-download" title="Cancel download">Cancel</button>
            ` : ''}

            ${isFailed ? `
              <button class="btn btn-primary btn-sm btn-retry-download" title="Retry download">Retry</button>
              <button class="btn btn-glass btn-sm btn-dismiss-download" title="Dismiss failed download">Dismiss</button>
            ` : ''}

            ${isCompleted ? `
              <button class="btn btn-glass btn-sm btn-folder-download" title="Show file in folder">Open</button>
              <button class="btn btn-glass btn-sm btn-dismiss-download" title="Remove from queue">Dismiss</button>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');

    // Attach listeners
    this.container.querySelectorAll('.download-card').forEach(card => {
      const asin = card.dataset.asin;

      const cancelBtn = card.querySelector('.btn-cancel-download');
      if (cancelBtn) {
        cancelBtn.addEventListener('click', async () => {
          await window.api.downloads.cancel(asin);
          this.activeDownloads.delete(asin);
          this.render();
          this.app.showToast('Download cancelled', 'warning');
        });
      }

      const retryBtn = card.querySelector('.btn-retry-download');
      if (retryBtn) {
        retryBtn.addEventListener('click', async () => {
          await window.api.downloads.retry(asin);
          this.app.showToast('Retrying download...', 'info');
        });
      }

      const dismissBtn = card.querySelector('.btn-dismiss-download');
      if (dismissBtn) {
        dismissBtn.addEventListener('click', async () => {
          this.activeDownloads.delete(asin);
          if (window.api?.downloads?.dismiss) {
            await window.api.downloads.dismiss(asin);
          }
          this.render();
          if (this.app.libraryView) {
            this.app.libraryView.loadBooks();
          }
        });
      }

      const openBtn = card.querySelector('.btn-folder-download');
      if (openBtn) {
        openBtn.addEventListener('click', async () => {
          await window.api.library.openBookFolder(asin);
        });
      }
    });
  }
}
