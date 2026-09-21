'use strict';

// Electron main process. Owns the window, the engine, and the IPC surface
// the renderer (the wizard GUI) talks to.

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');

// The engine reads these env vars at require-time to decide where to keep the
// MSAL token cache and the resume ledger — so they MUST be set before any
// engine module is required below. userData = %APPDATA%/Evernote to OneNote.
const userDataDir = app.getPath('userData');
try { fs.mkdirSync(userDataDir, { recursive: true }); } catch { /* exists */ }
process.env.E2O_MSAL_CACHE = path.join(userDataDir, 'msal-cache.json');
process.env.E2O_PROGRESS_FILE = path.join(userDataDir, 'progress.json');

const auth = require('./auth-desktop');
const { OneNoteClient, runParallel, createGlobalBackoff } = require('evernote-onenote-engine');
const { runImport } = require('./import-runner');

let mainWindow = null;
let importCancelRequested = false;
let importing = false;

function assertTrustedRenderer(event) {
  const expected = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
  const actual = event.senderFrame && event.senderFrame.url;
  if (actual !== expected) throw new Error('Rejected IPC request from an untrusted renderer.');
}

// A bearer-token provider for the OneNote client + import runner. Silent only
// (the user has already signed in by the time this is used); MSAL refreshes
// an expired token from the cached refresh token automatically.
function getToken() {
  return auth.getAuthenticatedToken({ noInteractive: true });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 760,
    height: 824,
    minWidth: 680,
    minHeight: 660,
    title: 'Evernote to OneNote',
    backgroundColor: '#eef1f6',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
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

// External destinations are fixed here rather than accepting an arbitrary URL
// from the renderer. This keeps the sandboxed help surface useful without
// turning it into a general-purpose navigation bridge.
const RESOURCE_URLS = Object.freeze({
  help: 'https://github.com/mooja77/evernote-to-onenote/blob/main/docs/HELP.md',
  cli: 'https://github.com/mooja77/evernote-to-onenote/tree/main/packages/cli#readme',
  example: 'https://raw.githubusercontent.com/mooja77/evernote-to-onenote/main/examples/safe-example.enex',
  support: 'https://github.com/mooja77/evernote-to-onenote/issues/new?template=bug_report.md',
  feature: 'https://github.com/mooja77/evernote-to-onenote/issues/new?template=feature_request.md',
  walkthrough: 'https://github.com/mooja77/evernote-to-onenote/blob/main/docs/WALKTHROUGH.md',
});

ipcMain.handle('app:openResource', async (event, key) => {
  assertTrustedRenderer(event);
  const url = RESOURCE_URLS[key];
  if (!url) throw new Error('Unknown help destination.');
  await shell.openExternal(url);
  return { opened: true };
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
ipcMain.handle('onenote:createSection', async (event, args = {}) => {
  assertTrustedRenderer(event);
  const { notebookId, name } = args;
  if (typeof notebookId !== 'string' || !notebookId.trim()) throw new Error('A valid notebook is required.');
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 50) {
    throw new Error('Section name must be between 1 and 50 characters.');
  }
  const client = new OneNoteClient({ getToken });
  const cleanName = name.trim();
  const sec = await client.createSection(notebookId, cleanName);
  return { id: sec.id, name: sec.displayName || cleanName };
});

// ── IPC: the import ──────────────────────────────────────────────────────

ipcMain.handle('import:start', async (event, args = {}) => {
  assertTrustedRenderer(event);
  const { enexPath, sectionId, force } = args;
  if (importing) return { ok: false, error: 'An import is already running.' };
  if (typeof enexPath !== 'string' || path.extname(enexPath).toLowerCase() !== '.enex' || !fs.existsSync(enexPath)) {
    return { ok: false, error: 'Choose a valid Evernote .enex export file.' };
  }
  if (typeof sectionId !== 'string' || !sectionId.trim()) {
    return { ok: false, error: 'Choose a valid OneNote section.' };
  }
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
