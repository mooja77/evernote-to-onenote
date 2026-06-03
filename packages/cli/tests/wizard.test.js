'use strict';
/**
 * v1.3.0 wizard + reauth tests.
 *
 * Tests the new `--wizard` flag (alias for `--guided`), the `wizard`
 * positional (alias for `setup`), and the `--reauth` flow that clears
 * stored Microsoft sign-in files before re-running auth.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CLI = path.join(__dirname, '..', 'src', 'index.js');
const PROJECT_ROOT = path.resolve(__dirname, '..');

function run(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ONENOTE_ACCESS_TOKEN: '', MSAL_NO_INTERACTIVE: '1', ...(opts.env || {}) },
    timeout: 15000,
    cwd: opts.cwd,
  });
}

describe('CLI — --help mentions --wizard and --reauth (v1.3.0)', () => {
  test('--help text mentions --wizard as preferred guided-mode name', () => {
    const { stdout, status } = run(['--help']);
    assert.equal(status, 0);
    assert.match(stdout, /--wizard\b/);
  });

  test('--help text mentions --reauth', () => {
    const { stdout } = run(['--help']);
    assert.match(stdout, /--reauth\b/);
  });

  test('--help text mentions `wizard` positional alias', () => {
    const { stdout } = run(['--help']);
    assert.match(stdout, /\bwizard\b/);
  });
});

describe('CLI — --wizard flag dispatch', () => {
  test('--wizard flag is recognised (does not error as unknown option)', () => {
    // --no-interactive bypasses the interactive prompt path; we just check
    // the program doesn't crash on the unknown flag.
    const { stderr, status } = run(['--wizard', '--no-interactive']);
    // Either exits 0 (info dump) or shows usage hints on stderr; in neither
    // case should it complain about an unknown argument.
    assert.doesNotMatch(stderr, /unknown.*--wizard/i);
    assert.doesNotMatch(stderr, /unrecognized.*--wizard/i);
    assert.ok([0, 1].includes(status), `expected exit 0 or 1, got ${status}`);
  });

  test('`wizard` positional treated like `setup`', () => {
    const { stderr, status } = run(['wizard', '--no-interactive']);
    // Same surface as `setup` — should not complain about an unknown command.
    assert.doesNotMatch(stderr, /unknown command/i);
    assert.doesNotMatch(stderr, /unrecognized.*wizard/i);
    assert.ok([0, 1].includes(status), `expected exit 0 or 1, got ${status}`);
  });
});

describe('clearStoredAuthFiles helper', () => {
  // We test the exported helper directly — running --reauth end-to-end would
  // touch the real auth file paths next to the project root and affect
  // developer environments. The helper takes no args, so we manipulate the
  // actual paths in a controlled way: snapshot existing files (if any),
  // create dummies, run, assert, restore.

  const TARGET_FILES = [
    path.join(PROJECT_ROOT, '.access-token'),
    path.join(PROJECT_ROOT, 'msal-cache.json'),
  ];

  function snapshotAndClear() {
    const snapshot = {};
    for (const f of TARGET_FILES) {
      if (fs.existsSync(f)) {
        snapshot[f] = fs.readFileSync(f);
        fs.unlinkSync(f);
      }
    }
    return snapshot;
  }

  function restore(snapshot) {
    for (const [f, data] of Object.entries(snapshot)) {
      fs.writeFileSync(f, data);
    }
  }

  test('deletes both stored auth files when both exist', () => {
    const snapshot = snapshotAndClear();
    try {
      // Set up dummy files
      for (const f of TARGET_FILES) {
        fs.writeFileSync(f, 'dummy');
      }
      const { clearStoredAuthFiles } = require('../src/index.js');
      const cleared = clearStoredAuthFiles();
      assert.deepEqual(cleared.sort(), ['.access-token', 'msal-cache.json']);
      for (const f of TARGET_FILES) {
        assert.equal(fs.existsSync(f), false, `${path.basename(f)} should be deleted`);
      }
    } finally {
      // Belt-and-braces: clean up any dummies we left behind, then restore.
      for (const f of TARGET_FILES) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
      restore(snapshot);
    }
  });

  test('returns empty list when no stored auth files exist', () => {
    const snapshot = snapshotAndClear();
    try {
      const { clearStoredAuthFiles } = require('../src/index.js');
      const cleared = clearStoredAuthFiles();
      assert.deepEqual(cleared, []);
    } finally {
      restore(snapshot);
    }
  });

  test('returns only the files that actually existed', () => {
    const snapshot = snapshotAndClear();
    try {
      // Create only one of the two
      fs.writeFileSync(TARGET_FILES[0], 'dummy');
      const { clearStoredAuthFiles } = require('../src/index.js');
      const cleared = clearStoredAuthFiles();
      assert.deepEqual(cleared, ['.access-token']);
      assert.equal(fs.existsSync(TARGET_FILES[0]), false);
    } finally {
      for (const f of TARGET_FILES) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
      restore(snapshot);
    }
  });
});
