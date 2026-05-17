'use strict';

const fs = require('fs');
const path = require('path');
const { PublicClientApplication } = require('@azure/msal-node');

// Desktop build: the Electron main process sets E2O_MSAL_CACHE to a path
// under app.getPath('userData'). Falls back to the package dir otherwise.
const CACHE_FILE = process.env.E2O_MSAL_CACHE || path.resolve(__dirname, '..', 'msal-cache.json');
const TOKEN_FILE = path.resolve(__dirname, '..', '.access-token');

const SCOPES = ['Notes.Create', 'Notes.ReadWrite', 'Notes.Read', 'User.Read'];

// `common` — personal Microsoft accounts plus work/school accounts.
const AUTHORITY = 'https://login.microsoftonline.com/common';

// Client ID of OUR Microsoft Entra app registration (shared with the
// Evernote->OneNote web app). Sign-in uses the authorization-code flow with
// PKCE: the app opens the user's normal browser, they sign in there exactly
// as on any website, and MSAL catches the result on a localhost loopback
// port. For that to work the registration needs, under "Mobile and desktop
// applications", the redirect URI `http://localhost`.
// Override via MSAL_CLIENT_ID to use your own registration.
const DEFAULT_CLIENT_ID = process.env.MSAL_CLIENT_ID || '824932cc-71a6-463e-918b-9623d7d0ca66';

// Pages shown in the user's browser tab once the redirect lands.
const SUCCESS_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Signed in</title></head>
<body style="font-family:'Segoe UI',Arial,sans-serif;text-align:center;padding:48px;color:#0f172a">
<h2>You're signed in</h2>
<p>Return to the <strong>Evernote to OneNote</strong> app &mdash; it has continued automatically.</p>
<p style="color:#64748b">You can close this tab.</p>
</body></html>`;

const ERROR_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Sign-in problem</title></head>
<body style="font-family:'Segoe UI',Arial,sans-serif;text-align:center;padding:48px;color:#0f172a">
<h2>Sign-in didn't complete</h2>
<p>Close this tab, then click <strong>Sign in with Microsoft</strong> in the app to try again.</p>
</body></html>`;

// If no MSAL_CLIENT_ID env var is set, detect the client ID from the cache file.
// This handles users who authenticated with a different client ID in a prior session.
function detectClientId() {
  if (process.env.MSAL_CLIENT_ID) return process.env.MSAL_CLIENT_ID;
  if (!fs.existsSync(CACHE_FILE)) return DEFAULT_CLIENT_ID;
  try {
    const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const clients = new Set([
      ...Object.values(cache.RefreshToken || {}).map(t => t.client_id),
      ...Object.values(cache.AccessToken || {}).map(t => t.client_id),
    ].filter(Boolean));
    if (clients.size === 1) return [...clients][0];
  } catch { /* malformed cache — fall through */ }
  return DEFAULT_CLIENT_ID;
}

function buildMsalApp() {
  const config = {
    auth: {
      clientId: detectClientId(),
      authority: AUTHORITY,
    },
    cache: {
      cachePlugin: buildCachePlugin(),
    },
  };
  return new PublicClientApplication(config);
}

function buildCachePlugin() {
  return {
    beforeCacheAccess: async (cacheContext) => {
      if (fs.existsSync(CACHE_FILE)) {
        try {
          cacheContext.tokenCache.deserialize(fs.readFileSync(CACHE_FILE, 'utf8'));
        } catch {
          // Corrupted or unreadable cache — MSAL will start fresh and re-authenticate
        }
      }
    },
    afterCacheAccess: async (cacheContext) => {
      if (cacheContext.cacheHasChanged) {
        const tmp = CACHE_FILE + '.tmp';
        try {
          fs.writeFileSync(tmp, cacheContext.tokenCache.serialize(), 'utf8');
          fs.renameSync(tmp, CACHE_FILE);
        } catch (err) {
          console.warn(`[auth] Failed to persist token cache: ${err.message}`);
          try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        }
      }
    },
  };
}

// Returns a bearer token. With a valid saved session this is silent. Otherwise,
// unless `noInteractive` is set, it runs the interactive browser sign-in —
// which needs an `openBrowser(url)` callback to open the system browser.
async function getAuthenticatedToken({ noInteractive = false, openBrowser } = {}) {
  const app = buildMsalApp();
  const accounts = await app.getTokenCache().getAllAccounts();

  if (accounts.length > 0) {
    try {
      const result = await app.acquireTokenSilent({ scopes: SCOPES, account: accounts[0] });
      return result.accessToken;
    } catch (err) {
      const isInvalidGrant =
        err.name === 'InteractionRequiredAuthError' ||
        err.errorCode === 'invalid_grant' ||
        err.error === 'invalid_grant' ||
        (typeof err.message === 'string' && err.message.includes('invalid_grant'));

      if (isInvalidGrant) {
        // Saved login expired — drop the cache and re-authenticate interactively.
        try { fs.unlinkSync(CACHE_FILE); } catch { /* already gone */ }
      }
      // Other silent failures also fall through to the interactive flow below.
    }
  }

  if (noInteractive) {
    throw new Error('Not signed in. Open the app and sign in with Microsoft first.');
  }

  return runAuthFlow(openBrowser);
}

// Interactive sign-in: authorization-code flow with PKCE. MSAL starts a
// loopback listener, hands us the authorize URL to open in the system
// browser, and resolves once the browser redirects back.
async function runAuthFlow(openBrowser) {
  if (typeof openBrowser !== 'function') {
    throw new Error('Interactive sign-in needs a browser opener.');
  }
  const app = buildMsalApp();
  const result = await app.acquireTokenInteractive({
    scopes: SCOPES,
    openBrowser: async (url) => { await openBrowser(url); },
    successTemplate: SUCCESS_HTML,
    errorTemplate: ERROR_HTML,
  });
  return result.accessToken;
}

// The currently signed-in account (first cached), or null. Used by the UI
// to show "Signed in as …". Never throws.
async function getSignedInAccount() {
  try {
    const app = buildMsalApp();
    const accounts = await app.getTokenCache().getAllAccounts();
    if (!accounts || accounts.length === 0) return null;
    const a = accounts[0];
    return { username: a.username || '', name: a.name || '' };
  } catch {
    return null;
  }
}

// Legacy fallback for ONENOTE_ACCESS_TOKEN env var
function getTokenFromFile() {
  if (process.env.ONENOTE_ACCESS_TOKEN) {
    return process.env.ONENOTE_ACCESS_TOKEN;
  }
  if (fs.existsSync(TOKEN_FILE)) {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  }
  return null;
}

module.exports = { getAuthenticatedToken, runAuthFlow, getSignedInAccount, getTokenFromFile, TOKEN_FILE };
