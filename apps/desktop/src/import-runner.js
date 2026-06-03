'use strict';

// Import orchestration for the desktop app. Delegates per-note import work to
// the engine's import-core while preserving the exact public contract that
// main.js and the renderer expect: the same onProgress event shapes, the same
// return value shape, and section-scoped resume keys.

const path = require('path');
const {
  parseEnexFile,
  importNotes,
  loadProgress,
  saveProgress,
  isImported,
  markImported,
  verifyImport,
  OneNoteClient,
} = require('evernote-onenote-engine');

// Stable per-note identity for the resume ledger. Scoped by target section
// so that re-importing the same .enex into a DIFFERENT section is not
// mistaken for an already-done note (and silently skipped). Re-importing
// into the SAME section still resolves to the same key — a genuine resume.
function desktopNoteKey(sectionId) {
  return (filename, note) => `${sectionId}::${filename}::${note.title || 'Untitled'}::${note.created || ''}`;
}

/**
 * Import one .enex file into one existing OneNote section.
 *
 * @param {object}   opts
 * @param {string}   opts.enexPath      absolute path to the .enex file
 * @param {string}   opts.sectionId     target OneNote section id
 * @param {Function} opts.getToken      async (forceRefresh?) => bearer token
 * @param {Function} [opts.onProgress]  receives structured progress events
 * @param {Function} [opts.shouldCancel] () => boolean, checked between notes
 * @param {boolean}  [opts.force]       re-import notes even if the resume
 *                                      ledger already lists them as done
 * @param {object}   [opts.client]      optional pre-built OneNoteClient (for tests)
 * @returns {Promise<{total,imported,skipped,failed,cancelled,errors}>}
 */
async function runImport({ enexPath, sectionId, getToken, onProgress, shouldCancel, force = false, client = null }) {
  const emit = (e) => {
    if (typeof onProgress === 'function') {
      try { onProgress(e); } catch { /* a listener error must not abort the import */ }
    }
  };
  const filename = path.basename(enexPath);

  emit({ phase: 'parsing', file: filename });
  const notes = await parseEnexFile(enexPath);
  const total = notes.length;
  const progress = loadProgress();
  const oneNote = client || new OneNoteClient({ getToken });

  emit({ phase: 'start', total });

  const errors = [];

  const counts = await importNotes({
    notes,
    filename,
    client: oneNote,
    notebook: { id: null },
    targetSection: { id: sectionId },
    progress,
    noteKeyFn: desktopNoteKey(sectionId),
    resume: !force,
    forceReimport: force,
    concurrency: 1,
    shouldCancel: typeof shouldCancel === 'function' ? shouldCancel : () => false,
    isImported,
    verifyImport,
    markImported,
    saveProgress: () => saveProgress(progress),
    onEvent: (e) => {
      const current = (e.index != null ? e.index : 0) + 1;
      if (e.type === 'noteStart') {
        emit({ phase: 'note', current, total, title: e.title, status: 'importing' });
      } else if (e.type === 'noteImported') {
        emit({ phase: 'note', current, total, title: e.title, status: 'imported' });
      } else if (e.type === 'noteSkipped') {
        emit({ phase: 'note', current, total, title: e.title, status: 'skipped' });
      } else if (e.type === 'error') {
        errors.push({ title: e.title, message: e.message });
        emit({ phase: 'note', current, total, title: e.title, status: 'failed', error: e.message });
      }
      // noteRetry / conflict / sectionOverflow / warning: not part of the
      // desktop fixed-section flow; ignore silently.
    },
  });

  const result = {
    total,
    imported: counts.succeeded,
    skipped: counts.skipped,
    failed: counts.failed,
    cancelled: !!counts.cancelled,
    errors,
  };

  if (counts.cancelled) {
    emit({ phase: 'cancelled', current: total, total, imported: result.imported, skipped: result.skipped, failed: result.failed });
  } else {
    emit({ phase: 'done', total, imported: result.imported, skipped: result.skipped, failed: result.failed });
  }

  return result;
}

module.exports = { runImport };
