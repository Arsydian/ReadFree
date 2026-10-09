/**
 * ReadFree - Secure IPC Preload Bridge
 * 
 * Exposes a strictly controlled API surface to the glassmorphic renderer
 * using Electron's contextBridge. Ensures full context isolation without
 * allowing renderer direct access to Node.js internals.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Authentication & Session
  auth: {
    login: () => ipcRenderer.invoke('auth:login'),
    logout: () => ipcRenderer.invoke('auth:logout'),
    getStatus: () => ipcRenderer.invoke('auth:get-status'),
    importAuthJson: (data) => ipcRenderer.invoke('auth:import-auth-json', data)
  },

  // Audible Library Management
  library: {
    getBooks: (filters) => ipcRenderer.invoke('library:get-books', filters),
    sync: (options) => ipcRenderer.invoke('library:sync', options),
    forceFullSync: () => ipcRenderer.invoke('library:force-full-sync'),
    getBookDetails: (asin) => ipcRenderer.invoke('library:get-details', asin),
    openBookFolder: (asin) => ipcRenderer.invoke('library:open-folder', asin),
    openPdf: (asin) => ipcRenderer.invoke('library:open-pdf', asin)
  },

  // Download Queue & Conversion Controls
  downloads: {
    start: (asin) => ipcRenderer.invoke('downloads:start', asin),
    cancel: (asin) => ipcRenderer.invoke('downloads:cancel', asin),
    retry: (asin) => ipcRenderer.invoke('downloads:retry', asin),
    getQueue: () => ipcRenderer.invoke('downloads:get-queue'),
    clearCompleted: () => ipcRenderer.invoke('downloads:clear-completed'),
    onProgress: (callback) => {
      const subscription = (_event, data) => callback(data);
      ipcRenderer.on('downloads:progress', subscription);
      return () => ipcRenderer.removeListener('downloads:progress', subscription);
    }
  },

  // Audio Playback & Chapter Inspection
  player: {
    getPlayablePath: (asin) => ipcRenderer.invoke('player:get-path', asin),
    getChapters: (asin) => ipcRenderer.invoke('player:get-chapters', asin)
  },

  // Settings & Configuration
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (newSettings) => ipcRenderer.invoke('settings:update', newSettings),
    chooseOutputDir: () => ipcRenderer.invoke('settings:choose-output-dir'),
    resetDatabase: () => ipcRenderer.invoke('settings:reset-database')
  }
});
