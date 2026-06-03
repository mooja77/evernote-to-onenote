const test = require('node:test');
const assert = require('node:assert');
const { createTokenProvider } = require('../src/auth-core.js');

// A fake MSAL-like app so the test needs no network.
function fakeApp({ silentToken = null, account = { homeAccountId: 'a' } } = {}) {
  return {
    getTokenCache: () => ({ getAllAccounts: async () => (account ? [account] : []) }),
    acquireTokenSilent: async () => {
      if (silentToken) return { accessToken: silentToken };
      const e = new Error('no token'); e.name = 'InteractionRequiredAuthError'; throw e;
    },
  };
}

test('returns the silent token without calling acquireInteractive', async () => {
  let interactiveCalls = 0;
  const getToken = createTokenProvider({
    buildApp: () => fakeApp({ silentToken: 'SILENT' }),
    scopes: ['Notes.Create'],
    acquireInteractive: async () => { interactiveCalls++; return 'INTERACTIVE'; },
  });
  assert.strictEqual(await getToken(), 'SILENT');
  assert.strictEqual(interactiveCalls, 0);
});

test('falls back to acquireInteractive when silent fails', async () => {
  const getToken = createTokenProvider({
    buildApp: () => fakeApp({ silentToken: null, account: null }),
    scopes: ['Notes.Create'],
    acquireInteractive: async () => 'INTERACTIVE',
  });
  assert.strictEqual(await getToken(), 'INTERACTIVE');
});

test('throws when noInteractive and silent fails', async () => {
  const getToken = createTokenProvider({
    buildApp: () => fakeApp({ silentToken: null, account: null }),
    scopes: ['Notes.Create'],
    acquireInteractive: async () => 'INTERACTIVE',
    noInteractive: true,
  });
  await assert.rejects(() => getToken(), /interactive/i);
});
