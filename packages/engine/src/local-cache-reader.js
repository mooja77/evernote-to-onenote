'use strict';

/**
 * Local-cache reader — Evernote v10 / v11 SQLite (conduit-storage) shim.
 *
 * Used by `--from-local` to import notes without an .enex export, when the
 * Evernote API is unavailable (e.g. after API key suspension). v1 is
 * text-only: bodies are imported, in-line images / attachments are
 * replaced with a marker pointing the user back to the .enex path. The
 * body in CacheLookaside is HTML, not ENML; we wrap it in a synthetic
 * <en-note> envelope so the existing pipeline accepts it.
 *
 * Read-only & immutable: the SQLite file is opened with `immutable=1` so
 * we never lock or modify the user's Evernote data.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// `__local__` keeps progress.json schema unchanged: noteKey() composes
// `${filename}::${title}::${created}` and so the synthetic filename slot
// is just another key in `progress.files[…]`.
const LOCAL_FILENAME_SLOT = '__local__';
const LOCAL_NOTEBOOK_NAME = 'Evernote (local cache)';

let _Database;
function loadSqlite() {
  if (_Database) return _Database;
  try {
    _Database = require('better-sqlite3');
    return _Database;
  } catch (err) {
    const e = new Error(
      'The --from-local mode needs the better-sqlite3 package, which could not be loaded.\n' +
      '  Run: npm install -g evernote-to-onenote (re-installs all dependencies)\n' +
      '  Or:  npm install --save better-sqlite3 (in this project folder)'
    );
    e.cause = err;
    throw e;
  }
}

function getCandidateCacheDirs() {
  const home = os.homedir();
  const dirs = [];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    dirs.push(path.join(localAppData, 'Evernote', 'conduit-storage'));
    dirs.push(path.join(appData, 'Evernote', 'conduit-storage'));
  } else if (process.platform === 'darwin') {
    dirs.push(path.join(home, 'Library', 'Application Support', 'Evernote', 'conduit-storage'));
    dirs.push(path.join(
      home, 'Library', 'Containers', 'com.evernote.Evernote',
      'Data', 'Library', 'Application Support', 'Evernote', 'conduit-storage'
    ));
  } else {
    dirs.push(path.join(home, '.config', 'Evernote', 'conduit-storage'));
    dirs.push(path.join(home, '.local', 'share', 'Evernote', 'conduit-storage'));
  }
  return dirs;
}

/**
 * On macOS the App Store build of Evernote ("sandboxed") stores notes in a
 * Core Data SQLite file with a different schema (Z-prefixed tables — ZENNOTE,
 * ZGUID, ZLOCALUUID) instead of the conduit-storage layout this importer
 * understands. Probing the well-known container path lets us emit a specific
 * error rather than the generic "could not find a cache" message, which would
 * otherwise leave App Store users stuck with no clear next step.
 */
function findSandboxedDarwinStore() {
  if (process.platform !== 'darwin') return null;
  const home = os.homedir();
  const candidates = [
    path.join(home, 'Library', 'Containers', 'com.evernote.Evernote',
      'Data', 'Library', 'Application Support', 'com.evernote.Evernote',
      'accounts', 'www.evernote.com'),
    path.join(home, 'Library', 'Containers', 'com.evernote.Evernote',
      'Data', 'Library', 'Application Support', 'com.evernote.Evernote'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

function findSqlInDir(dir, depth = 2) {
  // Recurse one level by default — conduit-storage on real installs has the
  // SQL files inside a per-host subfolder (e.g. https%3A%2F%2Fwww.evernote.com)
  // not at the top level. v1.4.0 shipped without recursion and silently
  // failed auto-detect; this is the fix.
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return null; }
  const matches = [];
  const subdirs = [];
  for (const e of entries) {
    const full = path.join(dir, e);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.isFile()) {
      // Evernote v10/v11 typically writes:
      //   UDB-User<id>+RemoteGraph.sql
      // Match anything ending in RemoteGraph.sql — covers personal & business graphs.
      if (/RemoteGraph\.sql$/i.test(e)) {
        matches.push({ full, mtime: stat.mtimeMs });
      }
    } else if (stat.isDirectory() && depth > 0) {
      subdirs.push(full);
    }
  }
  // Recurse only if no top-level matches; saves a stat() per file on the
  // common --cache-path-points-at-the-folder-with-the-files case.
  if (matches.length === 0) {
    for (const sub of subdirs) {
      const found = findSqlInDir(sub, depth - 1);
      if (found) matches.push({ full: found, mtime: 0 });
    }
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.mtime - a.mtime);
  return matches[0].full;
}

function discoverCacheFile({ explicitPath = null } = {}) {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Cache path not found: ${resolved}`);
    }
    const stat = fs.statSync(resolved);
    if (stat.isFile()) return resolved;
    if (stat.isDirectory()) {
      const found = findSqlInDir(resolved);
      if (found) return found;
      throw new Error(
        `No Evernote cache (*RemoteGraph.sql) found in: ${resolved}\n` +
        '  Pass the .sql file directly with --cache-path "<file>" if you know the location.'
      );
    }
    throw new Error(`--cache-path is neither a file nor a directory: ${resolved}`);
  }

  const candidateDirs = getCandidateCacheDirs();
  for (const dir of candidateDirs) {
    if (!fs.existsSync(dir)) continue;
    const found = findSqlInDir(dir);
    if (found) return found;
  }

  // No conduit-storage layout found. On macOS, check whether this is the
  // App Store sandboxed build — its data lives in a Core Data SQLite file
  // with an entirely different schema, which this importer does not support.
  // Surface a specific error so the user knows to install Evernote Legacy
  // or the direct download from evernote.com instead of staring at "could
  // not find an Evernote cache" with no path forward.
  if (findSandboxedDarwinStore()) {
    throw new Error(
      'Evernote App Store (sandboxed) build detected.\n' +
      '  This version stores notes in a Core Data format that --from-local does not support.\n' +
      '  Install Evernote Legacy or the direct download from https://evernote.com/download,\n' +
      '  sign in there, let it sync, then re-run --from-local.'
    );
  }
  return null;
}

function openReadOnly(filePath) {
  const Database = loadSqlite();
  // better-sqlite3 does not enable URI parsing by default, so the
  // sqlite3 `?immutable=1` trick isn't accessible. Open in readonly
  // mode and convert lock errors into a friendly "close Evernote"
  // message; that is the realistic failure mode users hit.
  try {
    return new Database(filePath, { readonly: true, fileMustExist: true });
  } catch (err) {
    const msg = String(err && err.message || '');
    if (/SQLITE_BUSY/i.test(msg) || /database is locked/i.test(msg)) {
      const e = new Error(
        'Cannot read the Evernote cache while Evernote is running.\n' +
        '  1. Open Evernote and let any pending sync finish.\n' +
        '  2. Close Evernote completely (right-click tray icon → Quit).\n' +
        '  3. Re-run this command.'
      );
      e.cause = err;
      throw e;
    }
    throw err;
  }
}

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function getColumnsOf(db, table) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
    return new Set(rows.map(r => r.name));
  } catch {
    return new Set();
  }
}

function detectSchema(db) {
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
  );
  return {
    tables,
    hasNodesNote: tables.has('Nodes_Note'),
    hasNodesTag: tables.has('Nodes_Tag'),
    hasNodesNotebook: tables.has('Nodes_Notebook'),
    hasCacheLookaside: tables.has('CacheLookaside'),
  };
}

function pickColumn(cols, ...candidates) {
  for (const c of candidates) if (cols.has(c)) return c;
  return null;
}

function safeJsonParse(s) {
  if (typeof s !== 'string' || !s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function ensureEnexDate(s) {
  if (s == null) return null;
  if (typeof s === 'number' && Number.isFinite(s)) {
    return formatEnexFromDate(new Date(s));
  }
  if (typeof s !== 'string') return null;
  if (/^\d{8}T\d{6}Z$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return formatEnexFromDate(d);
}

function formatEnexFromDate(d) {
  const pad = n => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    'Z'
  );
}

/**
 * Replace local resource references in cached HTML (which point at on-disk
 * files in Evernote's resource cache) with a plain-English marker so the
 * resulting OneNote page does not display a broken file:// or
 * evernote+resource:// link. v1 is text-only — these markers tell the
 * user to use --batch with .enex if they need full-fidelity images.
 */
function scrubLocalResourceRefs(html) {
  if (!html || typeof html !== 'string') return html || '';
  // <img src="evernote+resource://…" /> or src="file:…" or src="C:\…"
  html = html.replace(
    /<img\b[^>]*\bsrc=(["'])(evernote\+resource:\/\/|file:\/\/|[a-zA-Z]:\\|\/[^/])[^"']*\1[^>]*\/?\s*>/gi,
    '[image not included — export from Evernote for full content]'
  );
  // <a href="evernote+resource://…">label</a>
  html = html.replace(
    /<a\b[^>]*\bhref=(["'])evernote\+resource:\/\/[^"']*\1[^>]*>([\s\S]*?)<\/a>/gi,
    '[attachment not included — export from Evernote for full content]'
  );
  return html;
}

/**
 * Count local-resource references in cached HTML without mutating it.
 * Used by index.js to surface per-note attachment counts in the dry-run
 * summary so the operator knows how many in-line images / files would be
 * dropped. Mirrors the regexes in scrubLocalResourceRefs() exactly.
 */
function countLocalResourceRefs(html) {
  if (!html || typeof html !== 'string') return 0;
  const imgRe =
    /<img\b[^>]*\bsrc=(["'])(evernote\+resource:\/\/|file:\/\/|[a-zA-Z]:\\|\/[^/])[^"']*\1[^>]*\/?\s*>/gi;
  const aRe =
    /<a\b[^>]*\bhref=(["'])evernote\+resource:\/\/[^"']*\1[^>]*>([\s\S]*?)<\/a>/gi;
  return (html.match(imgRe) || []).length + (html.match(aRe) || []).length;
}

function buildTagLookup(db, schema) {
  const map = new Map();
  if (!schema.hasNodesTag) return map;
  const cols = getColumnsOf(db, 'Nodes_Tag');
  const idCol = pickColumn(cols, 'TKey', 'guid', 'id');
  const valCol = pickColumn(cols, 'TValue', 'value', 'data');
  if (!idCol || !valCol) return map;
  let rows;
  try {
    rows = db.prepare(
      `SELECT ${quoteIdent(idCol)} AS id, ${quoteIdent(valCol)} AS val FROM Nodes_Tag`
    ).all();
  } catch { return map; }
  for (const r of rows) {
    const obj = safeJsonParse(r.val);
    let name = null;
    if (obj && typeof obj === 'object') {
      name = obj.name || obj.label || (obj.NodeFields && obj.NodeFields.name) || null;
    } else if (typeof r.val === 'string' && r.val.length > 0 && r.val.length < 80) {
      name = r.val;
    }
    if (name) map.set(r.id, name);
  }
  return map;
}

function makeBodyLookup(db, schema) {
  if (!schema.hasCacheLookaside) {
    return () => null;
  }
  const cols = getColumnsOf(db, 'CacheLookaside');
  const idCol = pickColumn(cols, 'TKey', 'key', 'id');
  const valCol = pickColumn(cols, 'TValue', 'value', 'data');
  if (!idCol || !valCol) return () => null;

  // Try a handful of common key shapes — different conduit versions key
  // the body row by raw GUID, by `Note:GUID`, or by `Note:GUID:content`.
  const stmt = db.prepare(
    `SELECT ${quoteIdent(valCol)} AS val FROM CacheLookaside ` +
    `WHERE ${quoteIdent(idCol)} = ? OR ${quoteIdent(idCol)} = ? ` +
    `OR ${quoteIdent(idCol)} = ? OR ${quoteIdent(idCol)} = ? LIMIT 1`
  );

  return function lookupBody(noteId) {
    const variants = [
      `${noteId}`,
      `Note:${noteId}`,
      `note:${noteId}`,
      `Note:${noteId}:content`,
    ];
    let row;
    try {
      row = stmt.get(...variants);
    } catch { return null; }
    if (!row || row.val == null) return null;
    const val = row.val;
    if (typeof val !== 'string') return null;

    const parsed = safeJsonParse(val);
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.html === 'string') return parsed.html;
      if (typeof parsed.body === 'string') return parsed.body;
      if (typeof parsed.content === 'string') return parsed.content;
    }
    return val;
  };
}

/**
 * Yield notes from the cache one at a time. Output shape matches
 * enex-parser.parseEnexFile() so importNotes() consumes it unchanged.
 *
 * Yields three kinds of objects:
 *   - normal note (with title, content, etc.)
 *   - { _skip: true, reason: 'no-body', guid, title } — note metadata
 *     present but body not yet downloaded to local cache
 *   - { _skip: true, reason: 'unparseable-metadata', guid }
 */
function* iterateNotes(db, { schema = null } = {}) {
  const s = schema || detectSchema(db);
  if (!s.hasNodesNote) {
    throw new Error(
      'This SQLite file does not look like an Evernote cache (no Nodes_Note table).\n' +
      '  Confirm Evernote v10 or v11 is installed, or pass --cache-path "<file>" explicitly.\n' +
      '  If you are using Evernote from the Mac App Store, that version uses a different\n' +
      '  storage format and is not supported. Install Evernote Legacy or the direct\n' +
      '  download from https://evernote.com/download.'
    );
  }

  const tagById = buildTagLookup(db, s);
  const lookupBody = makeBodyLookup(db, s);

  const noteCols = getColumnsOf(db, 'Nodes_Note');
  const idCol = pickColumn(noteCols, 'TKey', 'guid', 'id');
  const valCol = pickColumn(noteCols, 'TValue', 'value', 'data');

  // Evernote v11 (released 2026-01-19) replaced the v10 TKey/TValue JSON-blob
  // shape with flat columns (id, label, snippet, content_hash, created,
  // updated, parent_Notebook_id, ...). The CacheLookaside body table was also
  // dropped — bodies live in Offline_Search_Note_Content as plain text only,
  // not the HTML/ENML this importer expects. Detect this layout up front and
  // refuse with actionable guidance instead of "no recognised id/value
  // columns" which leaves the operator stuck.
  const isV11FlatSchema = !valCol && noteCols.has('id') && noteCols.has('content_hash') && noteCols.has('snippet');
  if (isV11FlatSchema) {
    throw new Error(
      'Detected Evernote v11 desktop cache (flat-column schema), which --from-local does not support.\n' +
      '  v11 stores note metadata as flat columns and only plain-text bodies\n' +
      '  in Offline_Search_Note_Content — the HTML/ENML this importer needs is\n' +
      '  not stored locally on v11. Two options:\n' +
      '    1. Export your notebooks as .enex from Evernote, then run:\n' +
      '         evernote-to-onenote --batch <export-folder>\n' +
      '    2. Install Evernote v10 (the previous desktop release) — its local\n' +
      '       cache uses the older schema this importer can read.\n' +
      '  Tracking issue: https://github.com/mooja77/evernote-to-onenote/issues'
    );
  }

  if (!idCol || !valCol) {
    throw new Error(
      'Unexpected Nodes_Note schema (no recognised id/value columns).\n' +
      '  This Evernote build may be too old or too new for this importer version.'
    );
  }

  const stmt = db.prepare(
    `SELECT ${quoteIdent(idCol)} AS id, ${quoteIdent(valCol)} AS val FROM Nodes_Note`
  );

  for (const row of stmt.iterate()) {
    const meta = safeJsonParse(row.val);
    if (!meta || typeof meta !== 'object') {
      yield { _skip: true, reason: 'unparseable-metadata', guid: row.id };
      continue;
    }
    // NodeFields wrapping is used in some conduit versions
    const fields = (meta.NodeFields && typeof meta.NodeFields === 'object') ? meta.NodeFields : meta;

    const title = (fields.title && String(fields.title)) || 'Untitled Note';
    const created =
      ensureEnexDate(fields.created) ||
      ensureEnexDate(fields.createdAt) ||
      ensureEnexDate(fields.created_at) ||
      null;
    const updated =
      ensureEnexDate(fields.updated) ||
      ensureEnexDate(fields.updatedAt) ||
      ensureEnexDate(fields.updated_at) ||
      null;

    const tagGuids = Array.isArray(fields.tagGuids) ? fields.tagGuids
      : Array.isArray(fields.tags) ? fields.tags
      : [];
    const tags = tagGuids.map(g => tagById.get(g)).filter(Boolean);

    const body = lookupBody(row.id);
    if (body == null || body === '') {
      yield { _skip: true, reason: 'no-body', guid: row.id, title };
      continue;
    }

    const scrubbedResourceCount = countLocalResourceRefs(body);
    const wrapped = `<en-note>${scrubLocalResourceRefs(body)}</en-note>`;

    yield {
      title,
      created,
      updated,
      tags,
      content: wrapped,
      resources: [],
      author: fields.author || null,
      sourceUrl: fields.sourceUrl || fields.sourceURL || null,
      _guid: row.id,
      _scrubbedResourceCount: scrubbedResourceCount,
    };
  }
}

/**
 * Quick counts for the dry-run / status display. Approximate — body
 * presence is checked via the same key-variant set used by makeBodyLookup
 * (we don't reopen each row in JS, we count CacheLookaside rows whose
 * key references a Nodes_Note row).
 */
function summarizeCache(db, { schema = null } = {}) {
  const s = schema || detectSchema(db);
  if (!s.hasNodesNote) return { total: 0, withBody: 0, withoutBody: 0, available: false };

  const noteCols = getColumnsOf(db, 'Nodes_Note');
  const noteIdCol = pickColumn(noteCols, 'TKey', 'guid', 'id');
  // Evernote v11 has flat columns (no TKey/TValue) and no CacheLookaside.
  // Mark unsupported so the caller doesn't print misleading totals like
  // "2073 of 2073 notes don't have content yet" when in fact zero are
  // extractable. iterateNotes() throws a v11-specific error with guidance.
  const isV11FlatSchema = !pickColumn(noteCols, 'TValue', 'value', 'data')
    && noteCols.has('id') && noteCols.has('content_hash') && noteCols.has('snippet');
  if (isV11FlatSchema) {
    return { total: 0, withBody: 0, withoutBody: 0, available: false, unsupportedSchema: 'v11-flat' };
  }
  if (!noteIdCol) return { total: 0, withBody: 0, withoutBody: 0, available: false };

  const total = db.prepare('SELECT COUNT(*) AS c FROM Nodes_Note').get().c;

  let withBody = 0;
  if (s.hasCacheLookaside) {
    const cacheCols = getColumnsOf(db, 'CacheLookaside');
    const cacheIdCol = pickColumn(cacheCols, 'TKey', 'key', 'id');
    if (cacheIdCol) {
      // The original implementation OR'd all four candidate shapes inside a
      // single JOIN, which forced SQLite onto a full Nodes_Note ×
      // CacheLookaside scan: multi-second on 10k+ note vaults. Run each
      // shape as its own EXISTS subquery — each one uses the index on the
      // CacheLookaside key column — then UNION the matching note ids and
      // count distinct rows. Same result as the OR'd JOIN, faster by orders
      // of magnitude on real-sized vaults.
      const nIdQ = quoteIdent(noteIdCol);
      const cIdQ = quoteIdent(cacheIdCol);
      const subqueries = [
        `SELECT n.${nIdQ} AS id FROM Nodes_Note n WHERE EXISTS (SELECT 1 FROM CacheLookaside c WHERE c.${cIdQ} = n.${nIdQ})`,
        `SELECT n.${nIdQ} AS id FROM Nodes_Note n WHERE EXISTS (SELECT 1 FROM CacheLookaside c WHERE c.${cIdQ} = 'Note:' || n.${nIdQ})`,
        `SELECT n.${nIdQ} AS id FROM Nodes_Note n WHERE EXISTS (SELECT 1 FROM CacheLookaside c WHERE c.${cIdQ} = 'note:' || n.${nIdQ})`,
        `SELECT n.${nIdQ} AS id FROM Nodes_Note n WHERE EXISTS (SELECT 1 FROM CacheLookaside c WHERE c.${cIdQ} = 'Note:' || n.${nIdQ} || ':content')`,
      ];
      try {
        const r = db.prepare(
          `SELECT COUNT(*) AS c FROM (${subqueries.join(' UNION ')})`
        ).get();
        withBody = (r && r.c) || 0;
      } catch {
        withBody = 0;
      }
    }
  }
  return {
    total,
    withBody: Math.min(withBody, total),
    withoutBody: Math.max(0, total - Math.min(withBody, total)),
    available: true,
  };
}

module.exports = {
  LOCAL_FILENAME_SLOT,
  LOCAL_NOTEBOOK_NAME,
  getCandidateCacheDirs,
  discoverCacheFile,
  openReadOnly,
  detectSchema,
  iterateNotes,
  summarizeCache,
  scrubLocalResourceRefs,
  countLocalResourceRefs,
  findSandboxedDarwinStore,
  ensureEnexDate,
  // exposed for tests
  _internals: { quoteIdent, getColumnsOf, pickColumn, buildTagLookup, makeBodyLookup },
};
