'use strict';

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const PROGRESS_FILE = path.resolve('progress.json');
const GRAPH_PAGES_BASE = 'https://graph.microsoft.com/v1.0/me/onenote/pages';

function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) return { version: 2, files: {} };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  } catch {
    console.warn('  ⚠ progress.json could not be read (corrupt or truncated). Starting fresh.');
    console.warn('    If you had a partial import, run --verify after the next import to reconcile.');
    return { version: 2, files: {} };
  }

  // Schema sanity checks — guard against partially-written or hand-edited files.
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    console.warn('  ⚠ progress.json has unexpected structure. Starting fresh.');
    return { version: 2, files: {} };
  }

  if (!raw.version || raw.version < 2) {
    return _migrateV1(raw);
  }

  // Ensure files map is present and is an object.
  if (!raw.files || typeof raw.files !== 'object' || Array.isArray(raw.files)) {
    console.warn('  ⚠ progress.json is missing the files map. Starting fresh.');
    return { version: 2, files: {} };
  }

  return raw;
}

// v1: { [filename]: { imported: [key, key, ...] } }
// v2: { version: 2, files: { [filename]: { notebook_id, section_ids, imported: { [key]: { onenote_page_id, timestamp } } } } }
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
  return { version: 2, files };
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

module.exports = { PROGRESS_FILE, loadProgress, saveProgress, markImported, isImported, verifyImport };
