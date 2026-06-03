'use strict';

// Preload — the only bridge between the renderer and the main process.
// contextIsolation is on and nodeIntegration is off, so the renderer sees
// exactly this `window.api` surface and nothing else.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Auth
  authStatus: () => ipcRenderer.invoke('auth:status'),
  signIn: () => ipcRenderer.invoke('auth:signIn'),
  signOut: () => ipcRenderer.invoke('auth:signOut'),

  // Open the user's OneNote in their browser
  openOneNote: () => ipcRenderer.invoke('app:openOneNote'),

  // File picker
  pickEnex: () => ipcRenderer.invoke('files:pickEnex'),

  // OneNote
  listNotebooks: () => ipcRenderer.invoke('onenote:notebooks'),
  createSection: (args) => ipcRenderer.invoke('onenote:createSection', args),

  // Import
  startImport: (args) => ipcRenderer.invoke('import:start', args),
  cancelImport: () => ipcRenderer.invoke('import:cancel'),
  onImportProgress: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('import:progress', h);
    return () => ipcRenderer.removeListener('import:progress', h);
  },
});
