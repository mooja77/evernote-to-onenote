'use strict';

// Electron main process. Owns the window, the engine, and the IPC surface
// the renderer (the wizard GUI) talks to.

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');

// The engine reads these env vars at require-time to decide where to keep the
// MSAL token cache and the resume ledger — so they MUST be set before any
// engine module is required below. userData = %APPDATA%/Evernote to OneNote.
const userDataDir = app.getPath('userData');
try { fs.mkdirSync(userDataDir, { recursive: true }); } catch { /* exists */ }
process.env.E2O_MSAL_CACHE = path.join(userDataDir, 'msal-cache.json');
process.env.E2O_PROGRESS_FILE = path.join(userDataDir, 'progress.json');

const auth = require('./lib/auth');
const { OneNoteClient } = require('./lib/onenote-client');
const { runImport } = require('./import-runner');
const { runParallel, createGlobalBackoff } = require('./lib/parallel');

let mainWindow = null;
let importCancelRequested = false;
let importing = false;

// A bearer-token provider for the OneNote client + import runner. Silent only
// (the user has already signed in by the time this is used); MSAL refreshes
// an expired token from the cached refresh token automatically.
function getToken() {
  return auth.getAuthenticatedToken({ noInteractive: true });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 720,
    minWidth: 640,
    minHeight: 560,
    title: 'Evernote to OneNote',
    backgroundColor: '#f8fafc',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Guard against closing the window mid-import.
  mainWindow.on('close', (e) => {
    if (!importing) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['Keep importing', 'Stop and close'],
      defaultId: 0,
      cancelId: 0,
      title: 'Import in progress',
      message: 'An import is still running.',
      detail: 'If you close now the import stops. You can run it again later — notes already imported are skipped.',
    });
    if (choice === 0) e.preventDefault();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Standard on Windows/Linux: quit when the last window closes.
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC: authentication ──────────────────────────────────────────────────

// Is there a usable saved Microsoft session? Returns the account too, so the
// UI can show "Signed in as …".
ipcMain.handle('auth:status', async () => {
  try {
    await auth.getAuthenticatedToken({ noInteractive: true });
    return { signedIn: true, account: await auth.getSignedInAccount() };
  } catch {
    return { signedIn: false };
  }
});

// Start the interactive sign-in. MSAL opens the user's system browser to the
// Microsoft sign-in page (authorization-code flow with PKCE) and catches the
// result on a localhost loopback port; this call resolves once that completes.
ipcMain.handle('auth:signIn', async () => {
  try {
    await auth.getAuthenticatedToken({
      openBrowser: async (url) => { await shell.openExternal(url); },
    });
    return { signedIn: true, account: await auth.getSignedInAccount() };
  } catch (err) {
    return { signedIn: false, error: err.message };
  }
});

ipcMain.handle('auth:signOut', async () => {
  try { fs.unlinkSync(process.env.E2O_MSAL_CACHE); } catch { /* already gone */ }
  return { signedIn: false };
});

// Open the user's OneNote in their browser — used from the Done screen.
ipcMain.handle('app:openOneNote', async () => {
  await shell.openExternal('https://www.onenote.com/notebooks');
});

// ── IPC: file picker ─────────────────────────────────────────────────────

ipcMain.handle('files:pickEnex', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose your Evernote export',
    properties: ['openFile'],
    filters: [{ name: 'Evernote export', extensions: ['enex'] }],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  const filePath = res.filePaths[0];
  let sizeBytes = 0;
  try { sizeBytes = fs.statSync(filePath).size; } catch { /* ignore */ }
  return { path: filePath, name: path.basename(filePath), sizeBytes };
});

// ── IPC: OneNote notebooks/sections ──────────────────────────────────────

ipcMain.handle('onenote:notebooks', async () => {
  const client = new OneNoteClient({ getToken });
  const notebooks = await client.listNotebooks();
  // Fetch each notebook's sections in parallel (bounded concurrency). Done
  // sequentially this is one API call per notebook and can take a minute on
  // a large account — the step-3 spinner looked frozen.
  const backoff = createGlobalBackoff();
  const sectionLists = await runParallel(notebooks, 5, backoff, async (nb) => {
    try {
      return await client.listSections(nb.id);
    } catch {
      return []; // a notebook we can't read — show it with no sections
    }
  });
  return notebooks.map((nb, i) => ({
    id: nb.id,
    name: nb.displayName || '(untitled notebook)',
    sections: (sectionLists[i] || []).map((s) => ({
      id: s.id,
      name: s.displayName || '(untitled section)',
    })),
  }));
});

// Create a new section in a notebook — so a user whose notebook has no
// sections (or who simply wants a fresh one) is not stuck.
ipcMain.handle('onenote:createSection', async (_e, { notebookId, name }) => {
  const client = new OneNoteClient({ getToken });
  const sec = await client.createSection(notebookId, name);
  return { id: sec.id, name: sec.displayName || name };
});

// ── IPC: the import ──────────────────────────────────────────────────────

ipcMain.handle('import:start', async (_e, { enexPath, sectionId, force }) => {
  importCancelRequested = false;
  importing = true;
  try {
    const summary = await runImport({
      enexPath,
      sectionId,
      force: !!force,
      getToken,
      shouldCancel: () => importCancelRequested,
      onProgress: (evt) => {
        if (mainWindow) mainWindow.webContents.send('import:progress', evt);
      },
    });
    return { ok: true, summary };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    importing = false;
  }
});

ipcMain.handle('import:cancel', async () => {
  importCancelRequested = true;
  return { cancelling: true };
});
