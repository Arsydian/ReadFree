/**
 * ReadFree - Library View Controller
 * 
 * Manages rendering the audiobook grid, filtering, searching, sorting,
 * and dispatching download or playback actions.
 */

export class LibraryView {
  constructor(app) {
    this.app = app;
    this.booksGrid = document.getElementById('booksGrid');
    this.emptyState = document.getElementById('emptyLibraryState');
    this.searchInput = document.getElementById('librarySearchInput');
    this.sortSelect = document.getElementById('librarySortSelect');
    this.filterPills = document.getElementById('filterPillsContainer');
    this.btnSync = document.getElementById('btnSyncLibrary');
    this.btnForceSync = document.getElementById('btnForceFullSync');
    this.btnEmptySync = document.getElementById('btnEmptySync');
    this.countBadge = document.getElementById('libraryCountBadge');

    this.currentFilter = 'all';
    this.currentSearch = '';
    this.currentSort = 'recent';
    this.books = [];

    this.initEvents();
  }

  initEvents() {
    // Search input with debounce
    let searchTimeout = null;
    this.searchInput.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        this.currentSearch = e.target.value.toLowerCase().trim();
        this.render();
      }, 150);
    });

    // Sort select
    this.sortSelect.addEventListener('change', (e) => {
      this.currentSort = e.target.value;
      this.render();
    });

    // Filter pills
    this.filterPills.addEventListener('click', (e) => {
      const pill = e.target.closest('.pill-item');
      if (!pill) return;
      this.filterPills.querySelectorAll('.pill-item').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      this.currentFilter = pill.dataset.filter;
      this.render();
    });

    // Sync button (incremental / fast check)
    this.btnSync.addEventListener('click', async () => {
      await this.triggerSync(false);
    });

    // Full Re-Sync button (fixes missing / new books)
    this.btnForceSync.addEventListener('click', async () => {
      await this.triggerSync(true);
    });

    this.btnEmptySync.addEventListener('click', async () => {
      await this.triggerSync(false);
    });
  }

  async loadBooks() {
    try {
      this.books = await window.api.library.getBooks();
      this.countBadge.textContent = this.books.length;
      this.render();
    } catch (err) {
      console.error('Failed to load books:', err);
    }
  }

  async triggerSync(forceFull = false) {
    const btn = forceFull ? this.btnForceSync : this.btnSync;
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span style="display:inline-block;animation:spin 1s linear infinite;">↻</span> ${forceFull ? 'Full Syncing...' : 'Syncing...'}`;

    this.app.showToast(forceFull ? 'Starting comprehensive full library crawl...' : 'Checking Audible for new books...', 'info');

    try {
      const res = forceFull 
        ? await window.api.library.forceFullSync() 
        : await window.api.library.sync();

      if (res.success) {
        await this.loadBooks();
        this.app.showToast(`Sync complete! Found ${res.result.newAdded} new books (${res.result.total} total).`, 'success');
      } else {
        this.app.showToast(`Sync notice: ${res.error || 'Check login session.'}`, 'warning');
      }
    } catch (err) {
      this.app.showToast(`Sync error: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalText;
    }
  }

  getFilteredAndSortedBooks() {
    let list = [...this.books];

    // Status / Category Filter
    if (this.currentFilter === 'ready') {
      list = list.filter(b => b.status !== 'downloaded');
    } else if (this.currentFilter === 'downloaded') {
      list = list.filter(b => b.status === 'downloaded');
    } else if (this.currentFilter === 'has_pdf') {
      list = list.filter(b => !!b.pdfUrl);
    }

    // Search Query
    if (this.currentSearch) {
      list = list.filter(b => 
        (b.title && b.title.toLowerCase().includes(this.currentSearch)) ||
        (b.authors && b.authors.toLowerCase().includes(this.currentSearch)) ||
        (b.series && b.series.toLowerCase().includes(this.currentSearch))
      );
    }

    // Sort
    if (this.currentSort === 'title_asc') {
      list.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    } else if (this.currentSort === 'author_asc') {
      list.sort((a, b) => (a.authors || '').localeCompare(b.authors || ''));
    } else if (this.currentSort === 'duration_desc') {
      list.sort((a, b) => (b.runtimeSeconds || 0) - (a.runtimeSeconds || 0));
    } else {
      // Recent / purchase date
      list.sort((a, b) => new Date(b.purchaseDate || 0) - new Date(a.purchaseDate || 0));
    }

    return list;
  }

  render() {
    const list = this.getFilteredAndSortedBooks();

    if (list.length === 0) {
      this.booksGrid.style.display = 'none';
      this.emptyState.style.display = 'flex';
      return;
    }

    this.booksGrid.style.display = 'grid';
    this.emptyState.style.display = 'none';

    this.booksGrid.innerHTML = list.map(book => {
      const isDownloaded = book.status === 'downloaded';
      const isDownloading = book.status === 'downloading';

      let statusBadge = '';
      if (isDownloaded) {
        statusBadge = `<span class="badge badge-status-downloaded">✓ M4B Ready</span>`;
      } else if (isDownloading) {
        statusBadge = `<span class="badge badge-status-downloading">Downloading...</span>`;
      } else {
        statusBadge = `<span class="badge badge-status-ready">In Cloud</span>`;
      }

      const pdfBadge = book.pdfUrl ? `<span class="badge badge-pdf" title="Companion PDF booklet available">PDF</span>` : '';
      const durationBadge = `<span class="badge badge-duration">${book.durationFormatted || ''}</span>`;

      return `
        <div class="book-card" data-asin="${book.asin}">
          <div class="book-cover-container">
            <img src="${book.coverUrl || '../../assets/cover-placeholder.svg'}" alt="${book.title}" class="book-cover-img" loading="lazy">
            <div class="book-overlay-badges">
              <div>${statusBadge}</div>
              <div style="display:flex;gap:4px;">${pdfBadge}${durationBadge}</div>
            </div>
            ${isDownloaded ? `
              <div class="quick-play-overlay">
                <button class="btn-play-circle btn-card-play" title="Play preview">
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <polygon points="5 3 19 12 5 21 5 3"/>
                  </svg>
                </button>
              </div>
            ` : ''}
          </div>

          <div class="book-details">
            <div class="book-title" title="${book.title}">${book.title}</div>
            <div class="book-author" title="${book.authors}">${book.authors}</div>
            ${book.series ? `<div class="book-series" title="${book.series} ${book.seriesSequence ? '#' + book.seriesSequence : ''}">${book.series} ${book.seriesSequence ? '#' + book.seriesSequence : ''}</div>` : ''}
            <div class="book-narrator" title="Narrated by ${book.narrators}">Narrated by ${book.narrators}</div>

            <div class="book-actions-row">
              ${isDownloaded ? `
                <button class="btn btn-glass btn-sm btn-action-folder" title="Show in folder">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                  </svg>
                  <span>Folder</span>
                </button>
                ${book.pdfPath ? `
                  <button class="btn btn-glass btn-sm btn-action-pdf" title="Open companion PDF">PDF</button>
                ` : ''}
              ` : `
                <button class="btn btn-primary btn-sm btn-action-download" ${isDownloading ? 'disabled' : ''}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                  <span>${isDownloading ? 'Queued' : 'Download M4B'}</span>
                </button>
              `}
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Attach card event listeners
    this.booksGrid.querySelectorAll('.book-card').forEach(card => {
      const asin = card.dataset.asin;
      const book = this.books.find(b => b.asin === asin);

      // Play button
      const playBtn = card.querySelector('.btn-card-play');
      if (playBtn) {
        playBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.app.player.playBook(book);
        });
      }

      // Download button
      const downloadBtn = card.querySelector('.btn-action-download');
      if (downloadBtn) {
        downloadBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          downloadBtn.disabled = true;
          downloadBtn.textContent = 'Starting...';
          await window.api.downloads.start(asin);
          this.app.showToast(`Started download for "${book.title}"`, 'info');
          this.app.switchToView('downloadsView');
        });
      }

      // Show in Folder button
      const folderBtn = card.querySelector('.btn-action-folder');
      if (folderBtn) {
        folderBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await window.api.library.openBookFolder(asin);
        });
      }

      // Open PDF button
      const pdfBtn = card.querySelector('.btn-action-pdf');
      if (pdfBtn) {
        pdfBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await window.api.library.openPdf(asin);
        });
      }
    });
  }
}
