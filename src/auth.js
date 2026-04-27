'use strict';

const fs = require('fs');
const path = require('path');
const { PublicClientApplication } = require('@azure/msal-node');

const CACHE_FILE = path.resolve(__dirname, '..', 'msal-cache.json');
const TOKEN_FILE = path.resolve(__dirname, '..', '.access-token');

const SCOPES = ['Notes.Create', 'Notes.ReadWrite', 'Notes.Read', 'User.Read'];

// Personal Microsoft accounts tenant
const AUTHORITY = 'https://login.microsoftonline.com/consumers';

// Default client ID: Microsoft Azure CLI public client (supports device-code on personal accounts).
// Users can override via MSAL_CLIENT_ID env var if they register their own Azure AD app.
const DEFAULT_CLIENT_ID = process.env.MSAL_CLIENT_ID || '04b07795-8ddb-461a-bbee-02f9e1bf7b46';

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

async function getAuthenticatedToken({ noInteractive = false } = {}) {
  const app = buildMsalApp();
  const accounts = await app.getTokenCache().getAllAccounts();

  if (accounts.length > 0) {
    try {
      const result = await app.acquireTokenSilent({ scopes: SCOPES, account: accounts[0] });
      console.log('[auth] Silent acquire success');
      return result.accessToken;
    } catch (err) {
      const isInvalidGrant =
        err.name === 'InteractionRequiredAuthError' ||
        err.errorCode === 'invalid_grant' ||
        err.error === 'invalid_grant' ||
        (typeof err.message === 'string' && err.message.includes('invalid_grant'));

      if (isInvalidGrant) {
        console.log('[auth] Token expired (invalid_grant) — clearing cache, will re-authenticate via device-code');
        try { fs.unlinkSync(CACHE_FILE); } catch { /* already gone */ }
      } else {
        console.log(`[auth] Silent acquire failed (${err.name}), falling back to device-code`);
      }
    }
  }

  if (noInteractive) {
    throw new Error(
      'Authentication required but no interactive terminal available. ' +
      'Run: node src/index.js --auth  (then retry this command)'
    );
  }

  return runAuthFlow();
}

async function runAuthFlow() {
  const app = buildMsalApp();

  console.log('[auth] Device-code flow initiated');
  const result = await app.acquireTokenByDeviceCode({
    scopes: SCOPES,
    deviceCodeCallback: (response) => {
      console.log('\n' + response.message + '\n');
    },
  });

  console.log('[auth] Token acquired via device-code');
  return result.accessToken;
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

module.exports = { getAuthenticatedToken, runAuthFlow, getTokenFromFile, TOKEN_FILE };
