/**
 * ReadFree - Main Electron Application Entry Point
 * 
 * Sets up the primary application window, initializes backend service layers,
 * and exposes secure IPC endpoints for the renderer.
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const LibraryDB = require('./store/library-db');
const TokenManager = require('./auth/token-manager');
const AudibleClient = require('./api/audible-client');
const DeltaSync = require('./api/delta-sync');
const Downloader = require('./media/downloader');
const OAuthWindow = require('./auth/oauth-window');

let mainWindow = null;
let libraryDB = null;
let tokenManager = null;
let audibleClient = null;
let deltaSync = null;
let downloader = null;
let oauthWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 650,
    backgroundColor: '#070a10',
    icon: path.join(__dirname, '../../assets/icon.ico'),
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0c111c',
      symbolColor: '#94a3b8',
      height: 44
    },
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// App lifecycle
app.whenReady().then(() => {
  // Initialize persistence and core engines
  libraryDB = new LibraryDB();
  tokenManager = new TokenManager();
  audibleClient = new AudibleClient(tokenManager);
  deltaSync = new DeltaSync(audibleClient, libraryDB, tokenManager);

  // Broadcast function to send download events to renderer
  const broadcastFn = (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('downloads:progress', data);
    }
  };

  downloader = new Downloader(libraryDB, tokenManager, audibleClient, broadcastFn);
  oauthWindow = new OAuthWindow(tokenManager, mainWindow);

  // Register all secure IPC handlers
  registerIpcHandlers();

  // Create UI Window
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/**
 * Registers all IPC communication bridges.
 */
function registerIpcHandlers() {
  // --- Auth Handlers ---
  ipcMain.handle('auth:login', async () => {
    try {
      const settings = libraryDB.getSettings();
      const session = await oauthWindow.openLogin(settings.marketplace || 'us');
      return { success: true, session };
    } catch (err) {
      console.error('[Main] Login error:', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('auth:logout', async () => {
    tokenManager.clear();
    return { success: true };
  });

  ipcMain.handle('auth:get-status', async () => {
    return tokenManager.getSessionInfo();
  });

  // --- Library Handlers ---
  ipcMain.handle('library:get-books', async (_event, filters) => {
    // If database is empty, seed initial sample books for seamless first-run
    if (libraryDB.getBooks().length === 0) {
      deltaSync.seedDemoCatalogIfEmpty();
    }
    return libraryDB.getBooks(filters);
  });

  ipcMain.handle('library:sync', async (_event, options = {}) => {
    try {
      const result = await deltaSync.sync(options);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('library:force-full-sync', async () => {
    try {
      console.log('[Main] Forcing full catalog re-sync (clearing delta constraints)...');
      const result = await deltaSync.sync({ forceFull: true });
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('library:get-details', async (_event, asin) => {
    return libraryDB.getBook(asin);
  });

  ipcMain.handle('library:open-folder', async (_event, asin) => {
    const book = libraryDB.getBook(asin);
    if (book && book.m4bPath && fs.existsSync(book.m4bPath)) {
      shell.showItemInFolder(book.m4bPath);
      return true;
    }
    const settings = libraryDB.getSettings();
    if (fs.existsSync(settings.outputDir)) {
      shell.openPath(settings.outputDir);
      return true;
    }
    return false;
  });

  ipcMain.handle('library:open-pdf', async (_event, asin) => {
    const book = libraryDB.getBook(asin);
    if (book && book.pdfPath && fs.existsSync(book.pdfPath)) {
      shell.openPath(book.pdfPath);
      return true;
    }
    return false;
  });

  // --- Downloads Handlers ---
  ipcMain.handle('downloads:start', async (_event, asin) => {
    downloader.startDownload(asin);
    return { success: true };
  });

  ipcMain.handle('downloads:cancel', async (_event, asin) => {
    const cancelled = downloader.cancelDownload(asin);
    return { success: cancelled };
  });

  ipcMain.handle('downloads:retry', async (_event, asin) => {
    downloader.retryDownload(asin);
    return { success: true };
  });

  ipcMain.handle('downloads:get-queue', async () => {
    return downloader.getQueue();
  });

  ipcMain.handle('downloads:clear-completed', async () => {
    return { success: true };
  });

  // --- Audio Player Handlers ---
  ipcMain.handle('player:get-path', async (_event, asin) => {
    const book = libraryDB.getBook(asin);
    if (book && book.m4bPath && fs.existsSync(book.m4bPath)) {
      return book.m4bPath;
    }
    return null;
  });

  ipcMain.handle('player:get-chapters', async (_event, asin) => {
    const book = libraryDB.getBook(asin);
    return book ? (book.chapters || []) : [];
  });

  // --- Settings Handlers ---
  ipcMain.handle('settings:get', async () => {
    return libraryDB.getSettings();
  });

  ipcMain.handle('settings:update', async (_event, newSettings) => {
    return libraryDB.updateSettings(newSettings);
  });

  ipcMain.handle('settings:choose-output-dir', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Audiobook Library Directory',
      properties: ['openDirectory', 'createDirectory']
    });

    if (!result.canceled && result.filePaths.length > 0) {
      const chosen = result.filePaths[0];
      libraryDB.updateSettings({ outputDir: chosen });
      return chosen;
    }
    return null;
  });

  ipcMain.handle('settings:reset-database', async () => {
    libraryDB.resetCatalog();
    return { success: true };
  });
}
