# ReadFree 🎧

> **Clean, modern, glassmorphic Audible library backup & Audiobookshelf organizer.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.1.2-cyan.svg)](package.json)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-emerald.svg)](#)

---

## Why ReadFree?

Older tools like **BookLibConnect** frequently stop detecting new audiobooks due to silent OAuth token expiration, stale delta cursors, and local SQLite database locks. **Libation** provides robust DRM liberation but uses utilitarian desktop forms rather than modern aesthetics.

**ReadFree** was built from scratch to combine:
1. **Never-Miss-A-Book Sync Engine:** Both instant incremental checks and an explicit **Force Full Re-Sync** that crawls your entire Audible catalog from page 1, ensuring newly added books, pre-orders, and updated editions are always captured.
2. **State-of-the-Art Glassmorphism:** An ultra-modern obsidian canvas featuring frosted glass panels (`backdrop-filter: blur(20px)`), ambient gradient backdrops, luminous borders, and fluid micro-animations.
3. **Audiobookshelf (ABS) First:** Automatic organization into `Author/Series/Title/Title.m4b`, alongside companion PDF booklets, high-res cover art, and official `metadata.json` for instant plug-and-play self-hosting.
4. **Built-in Mini-Player & Chapter Scrubber:** Verify and listen to your liberated audiobooks directly inside the application, complete with 15s skip, chapter list navigator, and scrub bar.
5. **Simple Download Management:** Clear progress cards with speed indicator, percentage, Cancel, and Retry buttons.

---

## Architecture Overview

```
ReadFree/
├── src/
│   ├── main/                       # Electron Main Process (System & Audio Engine)
│   │   ├── index.js                # App lifecycle & secure IPC endpoints
│   │   ├── auth/                   # Amazon/Audible OAuth window & token manager
│   │   ├── api/                    # Audible REST client & Delta/Full Sync engine
│   │   ├── media/                  # Downloader, FFmpeg decryptor & tagger
│   │   ├── organizer/              # Audiobookshelf directory formatter & metadata.json
│   │   └── store/                  # Atomic JSON local database
│   ├── preload/                    # Context-isolated secure IPC bridge
│   └── renderer/                   # Glassmorphic Frontend (HTML/CSS/ES Modules)
│       ├── css/                    # Glass design tokens, layout, components, player
│       └── js/                     # View controllers & docked audio player
└── tests/                          # Automated unit test suite
```

---

## Audiobookshelf Directory Layout

ReadFree structures your audio library ready for Audiobookshelf, Plex, or local media players:

```
D:\Audiobooks\
└── Brandon Sanderson\
    └── The Stormlight Archive\
        └── The Way of Kings\
            ├── The Way of Kings.m4b        # Lossless M4B with chapter markers & tags
            ├── cover.jpg                   # High-resolution uncompressed artwork
            ├── metadata.json               # Audiobookshelf schema with chapters & authors
            └── The Way of Kings - Companion.pdf  # Supplementary PDF booklet (if provided)
```

---

## Quick Start

### Prerequisites
- [Node.js](https://nodejs.org/) (v18 or newer recommended, tested on v24)
- [FFmpeg](https://ffmpeg.org/) (installed and accessible in PATH for M4B remuxing)

### Installation
```bash
# Clone the repository
git clone https://github.com/your-username/ReadFree.git
cd ReadFree

# Install dependencies
npm install
```

### Running the Application
```bash
# Launch the desktop app
npm start
```

### Packaging a Single .exe Installer
```bash
# Build the single-file NSIS installer (.exe)
npm run dist

# Or build a standalone portable executable (.exe)
npm run dist:portable
```
The output installer will be placed in the `dist/` directory:
- `dist/ReadFree-Setup-1.1.1.exe` (Standalone setup installer)
- `dist/ReadFree-1.1.1.exe` (Portable executable)

### Running Unit Tests
```bash
npm test
```

---

## Authentication Note

When you click **Sign In to Audible**, an isolated browser window opens directly to Amazon's sign-in page. ReadFree captures authorization tokens and activation bytes for your account without ever seeing, handling, or storing your raw Amazon password.

---

## License

This project is licensed under the [MIT License](LICENSE).
