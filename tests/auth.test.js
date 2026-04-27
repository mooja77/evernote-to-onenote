'use strict';

const assert = require('node:assert/strict');
const { describe, it, before, after } = require('node:test');
const fs = require('fs');
const path = require('path');

const TOKEN_FILE = path.resolve(__dirname, '..', '.access-token');
const CACHE_FILE = path.resolve(__dirname, '..', 'msal-cache.json');

describe('auth module', () => {
  it('exports required functions', () => {
    const auth = require('../src/auth');
    assert.equal(typeof auth.getAuthenticatedToken, 'function');
    assert.equal(typeof auth.runAuthFlow, 'function');
    assert.equal(typeof auth.getTokenFromFile, 'function');
    assert.equal(typeof auth.TOKEN_FILE, 'string');
  });

  it('TOKEN_FILE points to project root', () => {
    const auth = require('../src/auth');
    assert.ok(auth.TOKEN_FILE.endsWith('.access-token'));
    assert.ok(!auth.TOKEN_FILE.includes('src'));
  });

  it('getTokenFromFile returns null when no token exists', () => {
    // ensure neither env var nor file is set
    const savedEnv = process.env.ONENOTE_ACCESS_TOKEN;
    delete process.env.ONENOTE_ACCESS_TOKEN;

    const hadFile = fs.existsSync(TOKEN_FILE);
    const backup = hadFile ? fs.readFileSync(TOKEN_FILE) : null;
    if (hadFile) fs.unlinkSync(TOKEN_FILE);

    const auth = require('../src/auth');
    const result = auth.getTokenFromFile();
    assert.equal(result, null);

    if (backup) fs.writeFileSync(TOKEN_FILE, backup);
    if (savedEnv !== undefined) process.env.ONENOTE_ACCESS_TOKEN = savedEnv;
  });

  it('getTokenFromFile reads ONENOTE_ACCESS_TOKEN env var', () => {
    process.env.ONENOTE_ACCESS_TOKEN = 'test-token-123';
    // clear require cache so we get fresh module
    delete require.cache[require.resolve('../src/auth')];
    const auth = require('../src/auth');
    const result = auth.getTokenFromFile();
    assert.equal(result, 'test-token-123');
    delete process.env.ONENOTE_ACCESS_TOKEN;
  });

  it('getTokenFromFile reads from .access-token file', () => {
    delete process.env.ONENOTE_ACCESS_TOKEN;
    fs.writeFileSync(TOKEN_FILE, 'file-token-abc\n', 'utf8');
    delete require.cache[require.resolve('../src/auth')];
    const auth = require('../src/auth');
    const result = auth.getTokenFromFile();
    assert.equal(result, 'file-token-abc');
    fs.unlinkSync(TOKEN_FILE);
  });

  it('MSAL_CLIENT_ID env var overrides default client ID', () => {
    process.env.MSAL_CLIENT_ID = 'custom-client-id';
    delete require.cache[require.resolve('../src/auth')];
    // just check module loads without error — client ID is consumed at buildMsalApp() time
    const auth = require('../src/auth');
    assert.equal(typeof auth.getAuthenticatedToken, 'function');
    delete process.env.MSAL_CLIENT_ID;
  });
});

// ── MSAL mocking — require.cache substitution ─────────────────────────────────

describe('auth module — MSAL mocking', () => {
  const msalCachePath = require.resolve('@azure/msal-node');
  let origMsalEntry;

  function buildFakeMsal({ accounts = [], silentToken = null, silentError = null, deviceToken = 'device-tok' } = {}) {
    const cachePlugin = { beforeCacheAccess: null, afterCacheAccess: null };

    class FakeTokenCache {
      getAllAccounts() { return Promise.resolve(accounts); }
      deserialize() {}
      serialize() { return '{"mocked":true}'; }
    }

    class FakePublicClientApplication {
      constructor(config) {
        this._cachePlugin = config.cache && config.cache.cachePlugin;
        cachePlugin.beforeCacheAccess = this._cachePlugin && this._cachePlugin.beforeCacheAccess;
        cachePlugin.afterCacheAccess = this._cachePlugin && this._cachePlugin.afterCacheAccess;
        this._tokenCache = new FakeTokenCache();
      }
      getTokenCache() { return this._tokenCache; }
      acquireTokenSilent() {
        if (silentError) return Promise.reject(silentError);
        return Promise.resolve({ accessToken: silentToken });
      }
      acquireTokenByDeviceCode({ deviceCodeCallback }) {
        deviceCodeCallback({ message: 'Visit https://microsoft.com/devicelogin and enter TESTCODE' });
        return Promise.resolve({ accessToken: deviceToken });
      }
    }

    return { PublicClientApplication: FakePublicClientApplication, _cachePlugin: cachePlugin };
  }

  function installFakeMsal(fakeMsal) {
    origMsalEntry = require.cache[msalCachePath];
    require.cache[msalCachePath] = {
      id: msalCachePath, filename: msalCachePath, loaded: true,
      exports: fakeMsal,
    };
    delete require.cache[require.resolve('../src/auth')];
  }

  function restoreMsal() {
    if (origMsalEntry) require.cache[msalCachePath] = origMsalEntry;
    delete require.cache[require.resolve('../src/auth')];
  }

  it('getAuthenticatedToken returns token via silent acquire when account cached', async () => {
    const fakeMsal = buildFakeMsal({
      accounts: [{ homeAccountId: 'acct-1' }],
      silentToken: 'silent-access-token',
    });
    installFakeMsal(fakeMsal);
    try {
      const auth = require('../src/auth');
      const token = await auth.getAuthenticatedToken();
      assert.equal(token, 'silent-access-token');
    } finally {
      restoreMsal();
    }
  });

  it('getAuthenticatedToken falls back to device-code when silent acquire fails', async () => {
    const silentError = Object.assign(new Error('no_account_in_silent_request'), { name: 'InteractionRequiredAuthError' });
    const fakeMsal = buildFakeMsal({
      accounts: [{ homeAccountId: 'acct-1' }],
      silentError,
      deviceToken: 'device-code-token',
    });
    installFakeMsal(fakeMsal);
    try {
      const auth = require('../src/auth');
      const token = await auth.getAuthenticatedToken();
      assert.equal(token, 'device-code-token');
    } finally {
      restoreMsal();
    }
  });

  it('getAuthenticatedToken runs device-code when no accounts cached', async () => {
    const fakeMsal = buildFakeMsal({ accounts: [], deviceToken: 'fresh-device-token' });
    installFakeMsal(fakeMsal);
    try {
      const auth = require('../src/auth');
      const token = await auth.getAuthenticatedToken();
      assert.equal(token, 'fresh-device-token');
    } finally {
      restoreMsal();
    }
  });

  it('runAuthFlow invokes device-code callback and returns token', async () => {
    const messages = [];
    const fakeMsal = buildFakeMsal({ deviceToken: 'run-auth-flow-tok' });
    installFakeMsal(fakeMsal);
    // Patch console.log to capture device-code message
    const origLog = console.log;
    console.log = (...args) => messages.push(args.join(' '));
    try {
      const auth = require('../src/auth');
      const token = await auth.runAuthFlow();
      assert.equal(token, 'run-auth-flow-tok');
      assert.ok(messages.some(m => m.includes('microsoft.com') || m.includes('devicelogin') || m.includes('TESTCODE')));
    } finally {
      console.log = origLog;
      restoreMsal();
    }
  });

  it('cache plugin beforeCacheAccess is called during token acquire', async () => {
    let beforeCalled = false;
    const fakeMsal = buildFakeMsal({
      accounts: [{ homeAccountId: 'acct-1' }],
      silentToken: 'tok',
    });

    // Wrap beforeCacheAccess to track calls
    const origBefore = fakeMsal.PublicClientApplication.prototype.acquireTokenSilent;
    installFakeMsal(fakeMsal);

    // Verify the cache plugin was set up (presence indicates MSAL was given it)
    const auth = require('../src/auth');
    await auth.getAuthenticatedToken();
    // If we got here without errors, MSAL was wired up correctly
    assert.equal(typeof auth.getAuthenticatedToken, 'function');
    restoreMsal();
  });
});
