'use strict';

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const PROGRESS_FILE = path.resolve('progress.json');
const GRAPH_PAGES_BASE = 'https://graph.microsoft.com/v1.0/me/onenote/pages';
// v1.3.0 added inProgressUploads as an optional field; schema version
// stays at 2 because the field is purely additive — v1.2.4 readers
// silently ignore unknown top-level keys.
const PROGRESS_SCHEMA_VERSION = 2;

function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) return emptyProgress();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  } catch {
    console.warn('  ⚠ progress.json could not be read (corrupt or truncated). Starting fresh.');
    console.warn('    If you had a partial import, run --verify after the next import to reconcile.');
    return emptyProgress();
  }

  // Schema sanity checks — guard against partially-written or hand-edited files.
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    console.warn('  ⚠ progress.json has unexpected structure. Starting fresh.');
    return emptyProgress();
  }

  if (!raw.version || raw.version < 2) {
    return _migrateV1(raw);
  }

  // Ensure files map is present and is an object.
  if (!raw.files || typeof raw.files !== 'object' || Array.isArray(raw.files)) {
    console.warn('  ⚠ progress.json is missing the files map. Starting fresh.');
    return emptyProgress();
  }

  // v1.3.0: ensure inProgressUploads exists. Older v2 files don't have it.
  // We don't bump version on read — we lazy-add the field so saving
  // continues to write {version: 3, ...} after any successful import run.
  if (!raw.inProgressUploads || typeof raw.inProgressUploads !== 'object' || Array.isArray(raw.inProgressUploads)) {
    raw.inProgressUploads = {};
  }
  return raw;
}

function emptyProgress() {
  return { version: PROGRESS_SCHEMA_VERSION, files: {}, inProgressUploads: {} };
}

// v1: { [filename]: { imported: [key, key, ...] } }
// v2: { version: 2, files: { [filename]: { notebook_id, section_ids, imported: { [key]: { onenote_page_id, timestamp } } } } }
// v3: v2 + { inProgressUploads: { [key]: { uploadSessionUrl, uploadedBytes, uploadSessionExpiresAt?, filename?, startedAt } } }
function _migrateV1(v1) {
  const files = {};
  for (const [filename, fileData] of Object.entries(v1)) {
    if (typeof fileData !== 'object' || fileData === null) continue;
    const imported = {};
    if (Array.isArray(fileData.imported)) {
      for (const key of fileData.imported) {
        imported[key] = { onenote_page_id: null, timestamp: null };
      }
    }
    files[filename] = { notebook_id: null, section_ids: [], imported };
  }
  return { version: PROGRESS_SCHEMA_VERSION, files, inProgressUploads: {} };
}

function saveProgress(progress) {
  const tmp = PROGRESS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(progress, null, 2), 'utf8');
  fs.renameSync(tmp, PROGRESS_FILE);
}

function markImported(progress, filename, noteKey, pageId) {
  if (!progress.files[filename]) {
    progress.files[filename] = { notebook_id: null, section_ids: [], imported: {} };
  }
  progress.files[filename].imported[noteKey] = {
    onenote_page_id: pageId || null,
    timestamp: new Date().toISOString(),
  };
}

function isImported(progress, filename, noteKey) {
  return !!(
    progress.files[filename] &&
    progress.files[filename].imported &&
    progress.files[filename].imported[noteKey]
  );
}

// ─── v1.3.0: in-progress chunked upload tracking ───────────────────────────
//
// OneDrive's large-file upload API issues a per-file session URL that
// accepts byte-range PUTs over ~24 hours. If a network drop happens
// mid-upload the importer must reuse this URL to continue at uploadedBytes,
// not open a fresh session (which would re-transmit the bytes OneDrive
// already accepted). v1.2.4 had no concept of this — a kill mid-chunk
// forced the next run to re-upload the entire attachment from byte 0.
//
// These helpers operate on a separate `inProgressUploads` map keyed by
// `${filename}|${noteKey}|${attachmentHash}`. Concern is intentionally
// separate from per-note `imported` state because attachment uploads
// happen BEFORE the note is finalised; treating them as belongs-to a
// not-yet-imported note would conflate two semantics.
//
// The actual >25MB OneDrive chunked-upload integration is a follow-up
// PR — these primitives are landed first so the schema migration and
// the test surface are reviewable in isolation.

function inProgressKey(filename, noteKey, hash) {
  return `${filename}|${noteKey}|${hash}`;
}

/**
 * Record that a chunked upload is in progress for `attachment.hash`.
 * Idempotent: re-recording the same key with newer byte progress just
 * overwrites the entry. Refuses to record progress if `markImported`
 * has already marked the parent note completed for this filename+noteKey
 * pair (guards against late stale callbacks resurrecting in-progress
 * state on a finished note).
 *
 * @param progress  The loaded progress object
 * @param filename  ENEX file name
 * @param noteKey   Note identifier (matching markImported)
 * @param attachment {hash, filename?, uploadSessionUrl, uploadedBytes, uploadSessionExpiresAt?}
 * @returns boolean — true if recorded, false if blocked by note already imported
 */
function markAttachmentInProgress(progress, filename, noteKey, attachment) {
  if (!attachment || !attachment.hash) {
    throw new Error('markAttachmentInProgress: attachment.hash is required');
  }
  if (typeof attachment.uploadSessionUrl !== 'string' || !attachment.uploadSessionUrl) {
    throw new Error('markAttachmentInProgress: attachment.uploadSessionUrl is required');
  }
  // No-regress guard: if the parent note is already marked imported, the
  // upload was finalised in some other code path. Don't overwrite.
  if (isImported(progress, filename, noteKey)) {
    return false;
  }
  if (!progress.inProgressUploads) progress.inProgressUploads = {};
  const key = inProgressKey(filename, noteKey, attachment.hash);
  progress.inProgressUploads[key] = {
    uploadSessionUrl: attachment.uploadSessionUrl,
    uploadedBytes: typeof attachment.uploadedBytes === 'number' ? attachment.uploadedBytes : 0,
    uploadSessionExpiresAt: attachment.uploadSessionExpiresAt || null,
    filename: attachment.filename || null,
    startedAt: progress.inProgressUploads[key]?.startedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return true;
}

/**
 * Look up the active upload session for a given attachment hash, or null
 * if there is no resumable session.
 *
 * Returns null in any of these cases:
 *   - no entry exists for this key
 *   - the entry is missing uploadSessionUrl
 *   - the entry's expiry has passed (caller must open a fresh session)
 *   - the parent note is already marked imported (upload was finalised
 *     elsewhere and this in-progress entry is stale)
 *
 * @param progress  The loaded progress object
 * @param filename  ENEX file name
 * @param noteKey   Note identifier
 * @param hash      Attachment hash
 * @param now       Optional clock injection (Date) for testability
 * @returns {{uploadSessionUrl, uploadedBytes, uploadSessionExpiresAt?, filename?}|null}
 */
function getActiveUploadSession(progress, filename, noteKey, hash, now = new Date()) {
  if (!progress || !progress.inProgressUploads) return null;
  const entry = progress.inProgressUploads[inProgressKey(filename, noteKey, hash)];
  if (!entry) return null;
  if (!entry.uploadSessionUrl) return null;
  if (isImported(progress, filename, noteKey)) return null;
  if (entry.uploadSessionExpiresAt) {
    const expiresAt = Date.parse(entry.uploadSessionExpiresAt);
    if (!Number.isNaN(expiresAt) && expiresAt <= now.getTime()) return null;
  }
  return {
    uploadSessionUrl: entry.uploadSessionUrl,
    uploadedBytes: entry.uploadedBytes || 0,
    uploadSessionExpiresAt: entry.uploadSessionExpiresAt || undefined,
    filename: entry.filename || undefined,
  };
}

/**
 * Clear the in-progress upload entry for a completed attachment. Call
 * after the chunked upload has finished and the OneDrive item exists.
 * Idempotent — calling on a non-existent key is a no-op.
 *
 * @returns boolean — true if an entry was removed
 */
function markAttachmentCompleted(progress, filename, noteKey, hash) {
  if (!progress || !progress.inProgressUploads) return false;
  const key = inProgressKey(filename, noteKey, hash);
  if (!(key in progress.inProgressUploads)) return false;
  delete progress.inProgressUploads[key];
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────

// Returns one of:
//   'exists'  — HEAD returned 2xx, page still in OneNote
//   'missing' — HEAD returned 404, page genuinely gone, re-import
//   'unknown' — auth failure, network error, timeout, 5xx — DO NOT re-import.
//               The import-run caught 75% false re-imports on a run where
//               auth was cascading-failing; treating AuthError as "missing"
//               generated 146 unnecessary duplicate-attempt POSTs that all
//               also failed. When we can't verify, assume exists and skip.
async function verifyImport(progress, filename, noteKey, client) {
  if (!isImported(progress, filename, noteKey)) return 'missing';
  const entry = progress.files[filename].imported[noteKey];
  const pageId = entry && entry.onenote_page_id;
  if (!pageId) return 'missing'; // migrated from v1 — no page ID stored, must re-import
  try {
    const token = await client.getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${GRAPH_PAGES_BASE}/${pageId}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (res.ok) return 'exists';
      if (res.status === 404) return 'missing';
      // 401, 403, 429, 5xx — unknown state. Don't re-import.
      return 'unknown';
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Network error, auth error from getToken(), abort timeout — all unknown.
    return 'unknown';
  }
}

module.exports = {
  PROGRESS_FILE,
  PROGRESS_SCHEMA_VERSION,
  loadProgress,
  saveProgress,
  markImported,
  isImported,
  verifyImport,
  // v1.3.0 — chunked-upload resume primitives
  markAttachmentInProgress,
  getActiveUploadSession,
  markAttachmentCompleted,
  inProgressKey,
};
