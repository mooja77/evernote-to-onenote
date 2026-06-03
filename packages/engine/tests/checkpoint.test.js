'use strict';
/**
 * v1.3.0 — chunked-upload resume tests for progress.js helpers.
 *
 * Covers markAttachmentInProgress / getActiveUploadSession /
 * markAttachmentCompleted: the primitives that let the importer resume
 * a OneDrive chunked upload after a network drop without re-transmitting
 * the bytes already accepted.
 *
 * The actual >25MB OneDrive upload-session integration in
 * onenote-client.js is a follow-up PR; this test suite covers the
 * checkpoint mechanics in isolation.
 */
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

let tmpDir;
let originalCwd;

function freshProgress() {
  // Force a clean require so changes to PROGRESS_FILE (cwd-relative) are picked up.
  delete require.cache[require.resolve('../src/progress')];
  return require('../src/progress');
}

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enex-checkpoint-'));
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('v1.3.0 — markAttachmentInProgress + getActiveUploadSession round-trip', () => {
  test('records session and retrieves it', () => {
    const { loadProgress, markAttachmentInProgress, getActiveUploadSession } = freshProgress();
    const p = loadProgress();
    const ok = markAttachmentInProgress(p, 'a.enex', 'note-1', {
      hash: 'abc',
      filename: 'pic.png',
      uploadSessionUrl: 'https://onedrive/upload/session-1',
      uploadedBytes: 1024,
      uploadSessionExpiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    assert.equal(ok, true);
    const session = getActiveUploadSession(p, 'a.enex', 'note-1', 'abc');
    assert.ok(session);
    assert.equal(session.uploadSessionUrl, 'https://onedrive/upload/session-1');
    assert.equal(session.uploadedBytes, 1024);
    assert.equal(session.filename, 'pic.png');
  });

  test('uploadedBytes defaults to 0 when omitted', () => {
    const { loadProgress, markAttachmentInProgress, getActiveUploadSession } = freshProgress();
    const p = loadProgress();
    markAttachmentInProgress(p, 'a.enex', 'note-1', {
      hash: 'abc',
      uploadSessionUrl: 'https://x/y',
    });
    const session = getActiveUploadSession(p, 'a.enex', 'note-1', 'abc');
    assert.equal(session.uploadedBytes, 0);
  });
});

describe('v1.3.0 — markAttachmentInProgress validation', () => {
  test('throws when hash is missing', () => {
    const { loadProgress, markAttachmentInProgress } = freshProgress();
    const p = loadProgress();
    assert.throws(
      () => markAttachmentInProgress(p, 'a.enex', 'k', { uploadSessionUrl: 'https://x/y' }),
      /attachment\.hash is required/i,
    );
  });

  test('throws when uploadSessionUrl is missing', () => {
    const { loadProgress, markAttachmentInProgress } = freshProgress();
    const p = loadProgress();
    assert.throws(
      () => markAttachmentInProgress(p, 'a.enex', 'k', { hash: 'abc' }),
      /uploadSessionUrl is required/i,
    );
  });
});

describe('v1.3.0 — markAttachmentInProgress no-regress on completed notes', () => {
  test('refuses to record if parent note is already imported', () => {
    const { loadProgress, markImported, markAttachmentInProgress, getActiveUploadSession } = freshProgress();
    const p = loadProgress();
    markImported(p, 'a.enex', 'note-1', 'page-id');
    const ok = markAttachmentInProgress(p, 'a.enex', 'note-1', {
      hash: 'abc',
      uploadSessionUrl: 'https://x/y',
    });
    assert.equal(ok, false);
    const session = getActiveUploadSession(p, 'a.enex', 'note-1', 'abc');
    assert.equal(session, null);
  });
});

describe('v1.3.0 — markAttachmentInProgress idempotency', () => {
  test('re-recording the same key advances bytes but preserves startedAt', () => {
    const { loadProgress, markAttachmentInProgress, inProgressKey } = freshProgress();
    const p = loadProgress();
    markAttachmentInProgress(p, 'a.enex', 'k', {
      hash: 'h1', uploadSessionUrl: 'https://x/y', uploadedBytes: 100,
    });
    const startedAt1 = p.inProgressUploads[inProgressKey('a.enex', 'k', 'h1')].startedAt;
    // wait a tick so the timestamps differ
    const wait = Date.now() + 5;
    while (Date.now() < wait) {} // eslint-disable-line no-empty
    markAttachmentInProgress(p, 'a.enex', 'k', {
      hash: 'h1', uploadSessionUrl: 'https://x/y', uploadedBytes: 200,
    });
    const entry = p.inProgressUploads[inProgressKey('a.enex', 'k', 'h1')];
    assert.equal(entry.uploadedBytes, 200);
    assert.equal(entry.startedAt, startedAt1, 'startedAt should not change');
    assert.notEqual(entry.updatedAt, startedAt1, 'updatedAt should advance');
  });
});

describe('v1.3.0 — getActiveUploadSession edge cases', () => {
  test('returns null when no entry exists', () => {
    const { loadProgress, getActiveUploadSession } = freshProgress();
    const p = loadProgress();
    assert.equal(getActiveUploadSession(p, 'a.enex', 'k', 'h'), null);
  });

  test('returns null when expiry has passed', () => {
    const { loadProgress, markAttachmentInProgress, getActiveUploadSession } = freshProgress();
    const p = loadProgress();
    markAttachmentInProgress(p, 'a.enex', 'k', {
      hash: 'h',
      uploadSessionUrl: 'https://x/y',
      uploadedBytes: 50,
      uploadSessionExpiresAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    });
    // Use an injected `now` past the expiry
    const session = getActiveUploadSession(p, 'a.enex', 'k', 'h', new Date('2026-12-31T00:00:00Z'));
    assert.equal(session, null);
  });

  test('returns the entry when expiry is in the future', () => {
    const { loadProgress, markAttachmentInProgress, getActiveUploadSession } = freshProgress();
    const p = loadProgress();
    markAttachmentInProgress(p, 'a.enex', 'k', {
      hash: 'h',
      uploadSessionUrl: 'https://x/y',
      uploadedBytes: 50,
      uploadSessionExpiresAt: new Date('2099-01-01T00:00:00Z').toISOString(),
    });
    const session = getActiveUploadSession(p, 'a.enex', 'k', 'h', new Date('2026-06-01T00:00:00Z'));
    assert.ok(session);
    assert.equal(session.uploadedBytes, 50);
  });

  test('returns null when parent note is already imported', () => {
    const { loadProgress, markImported, markAttachmentInProgress, getActiveUploadSession } = freshProgress();
    const p = loadProgress();
    // Order matters: in-progress first, then mark imported (simulating
    // a code path that finalises the note via a different code branch
    // and forgets to clear the upload session).
    markAttachmentInProgress(p, 'a.enex', 'k', {
      hash: 'h', uploadSessionUrl: 'https://x/y',
    });
    markImported(p, 'a.enex', 'k', 'page-id');
    const session = getActiveUploadSession(p, 'a.enex', 'k', 'h');
    assert.equal(session, null, 'stale in-progress entry should not be returned');
  });

  test('handles malformed expiry gracefully (returns the entry)', () => {
    const { loadProgress, markAttachmentInProgress, getActiveUploadSession } = freshProgress();
    const p = loadProgress();
    markAttachmentInProgress(p, 'a.enex', 'k', {
      hash: 'h',
      uploadSessionUrl: 'https://x/y',
      uploadSessionExpiresAt: 'not-a-date',
    });
    // Date.parse returns NaN for malformed input; helper should fall through
    // and return the entry rather than crash or treat as expired.
    const session = getActiveUploadSession(p, 'a.enex', 'k', 'h');
    assert.ok(session);
  });
});

describe('v1.3.0 — markAttachmentCompleted', () => {
  test('removes the in-progress entry', () => {
    const { loadProgress, markAttachmentInProgress, markAttachmentCompleted, getActiveUploadSession } = freshProgress();
    const p = loadProgress();
    markAttachmentInProgress(p, 'a.enex', 'k', {
      hash: 'h', uploadSessionUrl: 'https://x/y',
    });
    assert.ok(getActiveUploadSession(p, 'a.enex', 'k', 'h'));
    const removed = markAttachmentCompleted(p, 'a.enex', 'k', 'h');
    assert.equal(removed, true);
    assert.equal(getActiveUploadSession(p, 'a.enex', 'k', 'h'), null);
  });

  test('returns false when no entry exists (no-op)', () => {
    const { loadProgress, markAttachmentCompleted } = freshProgress();
    const p = loadProgress();
    assert.equal(markAttachmentCompleted(p, 'a.enex', 'k', 'nonexistent'), false);
  });
});

describe('v1.3.0 — schema backward-compatibility', () => {
  test('v2 progress.json (no inProgressUploads) loads cleanly with empty map', () => {
    const v2 = {
      version: 2,
      files: {
        'a.enex': { notebook_id: null, section_ids: [], imported: {} },
      },
    };
    fs.writeFileSync(path.join(tmpDir, 'progress.json'), JSON.stringify(v2), 'utf8');
    const { loadProgress } = freshProgress();
    const p = loadProgress();
    assert.equal(p.version, 2);
    assert.deepEqual(p.inProgressUploads, {});
    assert.ok(p.files['a.enex']);
  });

  test('save+load preserves in-progress upload state', () => {
    const { loadProgress, markAttachmentInProgress, saveProgress } = freshProgress();
    const p = loadProgress();
    markAttachmentInProgress(p, 'a.enex', 'k', {
      hash: 'h', uploadSessionUrl: 'https://x/y', uploadedBytes: 999,
    });
    saveProgress(p);
    const { loadProgress: load2, getActiveUploadSession } = freshProgress();
    const p2 = load2();
    const session = getActiveUploadSession(p2, 'a.enex', 'k', 'h');
    assert.ok(session);
    assert.equal(session.uploadedBytes, 999);
  });
});

describe('v1.3.0 — inProgressKey is deterministic', () => {
  test('same inputs produce same key', () => {
    const { inProgressKey } = freshProgress();
    assert.equal(inProgressKey('a', 'b', 'c'), inProgressKey('a', 'b', 'c'));
  });

  test('different inputs produce different keys', () => {
    const { inProgressKey } = freshProgress();
    const k1 = inProgressKey('a', 'b', 'c');
    assert.notEqual(k1, inProgressKey('a', 'b', 'd'));
    assert.notEqual(k1, inProgressKey('a', 'x', 'c'));
    assert.notEqual(k1, inProgressKey('z', 'b', 'c'));
  });
});
