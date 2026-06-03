'use strict';

// Auth-agnostic token provider for the engine. Owns silent acquisition and
// the MSAL app lifecycle; the *interactive* flow (device-code, browser-PKCE,
// …) is injected by the front-end via `acquireInteractive`. Never opens a
// browser, prints a code, or chooses an authority/client — that is front-end
// policy passed in as config.

/**
 * @param {object}   cfg
 * @param {Function} cfg.buildApp          () => MSAL PublicClientApplication (or compatible)
 * @param {string[]} cfg.scopes
 * @param {Function} cfg.acquireInteractive async (app, scopes) => accessToken
 * @param {boolean}  [cfg.noInteractive]   if true, never run interactive; throw instead
 * @returns {(forceRefresh?: boolean) => Promise<string>} getToken
 */
function createTokenProvider({ buildApp, scopes, acquireInteractive, noInteractive = false }) {
  let app;
  function app_() { return (app ||= buildApp()); }

  return async function getToken(forceRefresh = false) {
    const a = app_();
    const accounts = await a.getTokenCache().getAllAccounts();
    if (accounts && accounts.length > 0) {
      try {
        const res = await a.acquireTokenSilent({ account: accounts[0], scopes, forceRefresh });
        if (res && res.accessToken) return res.accessToken;
      } catch (_err) {
        // fall through to interactive / throw
      }
    }
    if (noInteractive) {
      throw new Error('Authentication required but interactive sign-in is disabled.');
    }
    return acquireInteractive(a, scopes);
  };
}

module.exports = { createTokenProvider };
