'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { ProgressBar, describeError, fmtTime } = require('../src/ui');
const CLI = path.join(__dirname, '..', 'src', 'index.js');
const fix = (name) => path.join(__dirname, 'fixtures', name);

function run(args, opts = {}) {
  const { env = {} } = opts;
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ONENOTE_ACCESS_TOKEN: '', MSAL_NO_INTERACTIVE: '1', ...env },
    timeout: 15000,
  });
}

function makeTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `enex-ui-${label}-`));
}

// ─── fmtTime ─────────────────────────────────────────────────────────────────

describe('fmtTime', () => {
  test('formats sub-minute seconds', () => {
    assert.equal(fmtTime(45), '00:45');
  });

  test('formats minutes and seconds', () => {
    assert.equal(fmtTime(90), '01:30');
  });

  test('pads single-digit seconds', () => {
    assert.equal(fmtTime(65), '01:05');
  });

  test('handles zero', () => {
    assert.equal(fmtTime(0), '00:00');
  });

  test('handles negative (clamps to zero)', () => {
    assert.equal(fmtTime(-5), '00:00');
  });
});

// ─── ProgressBar ─────────────────────────────────────────────────────────────

describe('ProgressBar', () => {
  test('tick increments done count', () => {
    const bar = new ProgressBar(10, { quiet: true });
    bar.tick();
    bar.tick();
    assert.equal(bar.done, 2);
  });

  test('quiet mode suppresses stdout output', () => {
    const captured = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s) => { captured.push(s); return true; };
    try {
      const bar = new ProgressBar(5, { quiet: true });
      bar.tick();
      bar.tick();
    } finally {
      process.stdout.write = orig;
    }
    assert.equal(captured.length, 0, 'quiet mode should not write to stdout');
  });

  test('non-quiet mode writes a progress line on tick', () => {
    const captured = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s) => { captured.push(s); return true; };
    try {
      const bar = new ProgressBar(5, { quiet: false });
      bar.tick();
    } finally {
      process.stdout.write = orig;
    }
    assert.ok(captured.length > 0, 'should have written progress output');
    const output = captured.join('');
    assert.match(output, /1\/5/);
    assert.match(output, /elapsed/);
  });

  test('progress bar fills to 20 chars', () => {
    const captured = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s) => { captured.push(s); return true; };
    try {
      const bar = new ProgressBar(4, { quiet: false });
      bar.tick(); bar.tick(); bar.tick(); bar.tick();
    } finally {
      process.stdout.write = orig;
    }
    const output = captured.join('');
    // Full bar at 4/4 should be all filled blocks
    assert.match(output, /████████████████████/);
  });

  test('total=0 does not throw', () => {
    const bar = new ProgressBar(0, { quiet: true });
    assert.doesNotThrow(() => bar.tick());
  });
});

// ─── describeError ───────────────────────────────────────────────────────────

describe('describeError', () => {
  test('401 error suggests --auth', () => {
    const hint = describeError(new Error('OneNote API 401 after token refresh — authentication failed'));
    assert.ok(hint, 'should return a hint');
    assert.match(hint, /--auth/);
  });

  test('429 / rate-limit error suggests --resume', () => {
    const hint = describeError(new Error('OneNote API rate limit exceeded after 5 retries'));
    assert.ok(hint, 'should return a hint');
    assert.match(hint, /--resume/);
  });

  test('507 / storage full suggests OneDrive cleanup', () => {
    const hint = describeError(new Error('OneDrive storage full (507 Insufficient Storage)'));
    assert.ok(hint, 'should return a hint');
    assert.match(hint, /OneDrive/i);
  });

  test('ENOENT suggests checking path', () => {
    const err = new Error('no such file');
    err.code = 'ENOENT';
    const hint = describeError(err);
    assert.ok(hint, 'should return a hint');
    assert.match(hint, /path/i);
  });

  test('503 suggests retrying later', () => {
    const hint = describeError(new Error('OneNote API 503 after max retries'));
    assert.ok(hint, 'should return a hint');
    assert.match(hint, /retry/i);
  });

  test('unrecognised error returns null', () => {
    const hint = describeError(new Error('something completely unrecognised'));
    assert.equal(hint, null);
  });
});

// ─── --quiet flag (CLI integration) ──────────────────────────────────────────

describe('CLI --quiet flag', () => {
  test('--quiet suppresses per-note → lines in output-html mode', () => {
    const tmpDir = makeTempDir('quiet');
    const { status, stdout, stderr } = run(['--output-html', tmpDir, '--quiet', fix('single-note.enex')]);
    assert.equal(status, 0, `stderr: ${stderr}`);
    // Note-start lines look like "  → [file N/N: ...]" — distinct from the title "Evernote → OneNote"
    assert.ok(!stdout.includes('→ [file'), 'should not contain note-start → [file lines');
  });

  test('--quiet still shows Done summary', () => {
    const tmpDir = makeTempDir('quiet-summary');
    const { status, stdout } = run(['--output-html', tmpDir, '--quiet', fix('single-note.enex')]);
    assert.equal(status, 0);
    assert.match(stdout, /Done/);
    assert.match(stdout, /Imported/);
  });

  test('--quiet suppresses ✓ Saved lines in output-html mode', () => {
    const tmpDir = makeTempDir('quiet-saved');
    const { status, stdout } = run(['--output-html', tmpDir, '--quiet', fix('single-note.enex')]);
    assert.equal(status, 0);
    assert.ok(!stdout.includes('✓ Saved'), 'should not contain ✓ Saved lines');
  });

  test('--quiet appears in --help output', () => {
    const { status, stdout } = run(['--help']);
    assert.equal(status, 0);
    assert.match(stdout, /--quiet/);
  });

  test('without --quiet, note-start lines ARE present in output-html mode', () => {
    const tmpDir = makeTempDir('noisy');
    const { status, stdout } = run(['--output-html', tmpDir, fix('single-note.enex')]);
    assert.equal(status, 0);
    assert.match(stdout, /→ \[file/);
  });
});
