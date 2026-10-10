/**
 * ReadFree - Glassmorphic Mini-Player & Chapter Inspector
 * 
 * Provides an integrated audio player for inspecting and previewing
 * downloaded M4B audiobooks:
 * - Scrubber seek bar with hover thumb and glow trail
 * - Transport controls (Play/Pause, +/- 15s jump)
 * - Chapter inspector drawer with real-time active chapter tracking
 * - Smooth volume management
 */

export class MiniPlayer {
  constructor(app) {
    this.app = app;
    this.audio = document.getElementById('globalAudioElement');
    this.dock = document.getElementById('miniPlayerDock');
    this.thumbImg = document.getElementById('playerThumb');
    this.thumbPlaceholder = document.getElementById('playerThumbPlaceholder');
    this.titleLabel = document.getElementById('playerTitle');
    this.authorLabel = document.getElementById('playerAuthor');
    this.currentChapterLabel = document.getElementById('playerCurrentChapter');
    
    // Transport Controls
    this.btnMasterPlay = document.getElementById('btnPlayerMasterPlay');
    this.playIcon = document.getElementById('playerPlayIcon');
    this.btnBack15 = document.getElementById('btnPlayerBack15');
    this.btnFwd15 = document.getElementById('btnPlayerFwd15');

    // Scrubber
    this.currentTimeLabel = document.getElementById('playerCurrentTime');
    this.totalTimeLabel = document.getElementById('playerTotalTime');
    this.seekBar = document.getElementById('playerSeekBar');
    this.seekFill = document.getElementById('playerSeekFill');

    // Volume
    this.volumeSlider = document.getElementById('playerVolumeSlider');
    this.btnMute = document.getElementById('btnVolumeMute');

    // Chapter Inspector
    this.btnToggleChapters = document.getElementById('btnToggleChapters');
    this.chaptersPopover = document.getElementById('chapterInspectorPopover');
    this.chapterList = document.getElementById('chapterListContainer');
    this.btnCloseChapters = document.getElementById('btnCloseChapters');

    this.currentBook = null;
    this.chapters = [];

    this.initEvents();
  }

  formatTime(totalSeconds) {
    if (!totalSeconds || isNaN(totalSeconds)) return '00:00:00';
    const hrs = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = Math.floor(totalSeconds % 60);
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  initEvents() {
    // Play / Pause Master
    this.btnMasterPlay.addEventListener('click', () => {
      this.togglePlay();
    });

    // -15s jump
    this.btnBack15.addEventListener('click', () => {
      this.seekRelative(-15);
    });

    // +15s jump
    this.btnFwd15.addEventListener('click', () => {
      this.seekRelative(15);
    });

    // Scrubber click/drag
    this.seekBar.addEventListener('click', (e) => {
      const rect = this.seekBar.getBoundingClientRect();
      const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const targetDuration = this.getDuration();
      this.seekTo(pos * targetDuration);
    });

    // Volume Slider
    this.volumeSlider.addEventListener('input', (e) => {
      const vol = parseFloat(e.target.value);
      this.audio.volume = vol;
    });

    // Chapter Inspector Toggle
    this.btnToggleChapters.addEventListener('click', (e) => {
      e.stopPropagation();
      this.chaptersPopover.classList.toggle('hidden');
    });

    this.btnCloseChapters.addEventListener('click', () => {
      this.chaptersPopover.classList.add('hidden');
    });

    // Close chapters on outside click
    document.addEventListener('click', (e) => {
      if (!this.chaptersPopover.contains(e.target) && !this.btnToggleChapters.contains(e.target)) {
        this.chaptersPopover.classList.add('hidden');
      }
    });

    // Audio Element event listeners
    this.audio.addEventListener('timeupdate', () => {
      this.updateProgress(this.audio.currentTime, this.audio.duration);
    });

    this.audio.addEventListener('ended', () => {
      this.setPlayingState(false);
    });
  }

  getDuration() {
    return this.audio.duration && !isNaN(this.audio.duration) 
      ? this.audio.duration 
      : (this.currentBook?.runtimeSeconds || 0);
  }

  getCurrentTime() {
    return this.audio.src ? this.audio.currentTime : 0;
  }

  seekRelative(deltaSeconds) {
    const cur = this.getCurrentTime();
    const dur = this.getDuration();
    this.seekTo(Math.max(0, Math.min(dur, cur + deltaSeconds)));
  }

  seekTo(targetSeconds) {
    if (this.audio.src) {
      this.audio.currentTime = targetSeconds;
    }
  }

  togglePlay() {
    if (!this.currentBook) return;

    if (this.audio.src) {
      if (this.audio.paused) {
        this.audio.play().catch(err => {
          this.setPlayingState(false);
          this.app.showToast(`Playback error: ${err.message}`, 'error');
        });
        this.setPlayingState(true);
      } else {
        this.audio.pause();
        this.setPlayingState(false);
      }
    } else {
      this.app.showToast('No audio file loaded. Please download this audiobook first.', 'warning');
    }
  }

  setPlayingState(isPlaying) {
    if (isPlaying) {
      this.playIcon.innerHTML = `<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>`;
    } else {
      this.playIcon.innerHTML = `<polygon points="5 3 19 12 5 21 5 3"/>`;
    }
  }

  async playBook(book) {
    this.currentBook = book;
    this.titleLabel.textContent = book.title;
    this.authorLabel.textContent = book.authors;

    if (book.coverUrl) {
      this.thumbImg.src = book.coverUrl;
      this.thumbImg.style.display = 'block';
      this.thumbPlaceholder.style.display = 'none';
    } else {
      this.thumbImg.style.display = 'none';
      this.thumbPlaceholder.style.display = 'block';
    }

    // Load chapters
    this.chapters = book.chapters || [
      { title: 'Chapter 1', startTime: 0, duration: 1800 }
    ];

    this.renderChapters();

    // Check if playable audio file exists
    const audioPath = await window.api.player.getPlayablePath(book.asin);
    if (audioPath) {
      this.audio.src = `file://${audioPath.replace(/\\/g, '/')}`;
      try {
        await this.audio.play();
        this.setPlayingState(true);
        this.updateProgress(0, this.audio.duration || book.runtimeSeconds);
        this.app.showToast(`Now Playing: ${book.title}`, 'info');
      } catch (err) {
        console.error('Audio playback error:', err);
        this.setPlayingState(false);
        this.app.showToast(`Unable to play audio: ${err.message}`, 'error');
      }
    } else {
      this.audio.src = '';
      this.setPlayingState(false);
      this.updateProgress(0, book.runtimeSeconds || 0);
      this.app.showToast(`Cannot play "${book.title}": Audio file not found on disk. Please download it first.`, 'warning');
    }
  }

  updateProgress(currentTime, duration) {
    const dur = duration || this.getDuration();
    const cur = currentTime || 0;
    const pct = dur > 0 ? (cur / dur) * 100 : 0;

    this.seekFill.style.width = `${pct}%`;
    this.currentTimeLabel.textContent = this.formatTime(cur);
    this.totalTimeLabel.textContent = this.formatTime(dur);

    // Active Chapter Identification
    const activeChap = this.chapters.find(ch => 
      cur >= ch.startTime && cur < (ch.startTime + (ch.duration || 3600))
    );

    if (activeChap) {
      this.currentChapterLabel.textContent = activeChap.title;
    } else if (this.chapters.length > 0) {
      this.currentChapterLabel.textContent = this.chapters[0].title;
    }

    this.highlightActiveChapterItem(activeChap);
  }

  highlightActiveChapterItem(activeChap) {
    if (!activeChap) return;
    this.chapterList.querySelectorAll('.chapter-item').forEach(el => {
      if (el.dataset.title === activeChap.title) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    });
  }

  renderChapters() {
    this.chapterList.innerHTML = this.chapters.map((ch, idx) => `
      <div class="chapter-item" data-title="${ch.title}" data-start="${ch.startTime}">
        <span>${idx + 1}. ${ch.title}</span>
        <span class="chapter-item-time">${this.formatTime(ch.startTime)}</span>
      </div>
    `).join('');

    this.chapterList.querySelectorAll('.chapter-item').forEach(el => {
      el.addEventListener('click', () => {
        const start = parseFloat(el.dataset.start);
        this.seekTo(start);
        this.togglePlay();
        this.chaptersPopover.classList.add('hidden');
      });
    });
  }
}
