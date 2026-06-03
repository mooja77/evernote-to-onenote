'use strict';

// Import orchestration for the desktop app — a slim re-implementation of the
// CLI's importNotes() loop with no terminal I/O. It imports one .enex file
// into one existing OneNote section, sequentially, and emits structured
// progress events. Resumable: notes already in the progress ledger are
// skipped, so re-running after an interruption picks up where it left off.

const path = require('path');
const crypto = require('crypto');

const { parseEnexFile } = require('./lib/enex-parser');
const { enmlToHtml, enmlToHtmlWithResources, toOneNoteHtml } = require('./lib/enml-converter');
const { OneNoteClient } = require('./lib/onenote-client');
const { loadProgress, saveProgress, markImported, isImported } = require('./lib/progress');

// Stable per-note identity for the resume ledger. Scoped by target section
// so that re-importing the same .enex into a DIFFERENT section is not
// mistaken for an already-done note (and silently skipped). Re-importing
// into the SAME section still resolves to the same key — a genuine resume.
function noteKey(sectionId, filename, note) {
  return `${sectionId}::${filename}::${note.title || 'Untitled'}::${note.created || ''}`;
}

// base64 <data> blocks → buffers with an md5 hash (matches the CLI's
// prepareResources; enmlToHtmlWithResources matches them back by hash).
function prepareResources(rawResources) {
  return (rawResources || [])
    .filter((r) => r.data && r.data.trim())
    .map((r) => {
      const buf = Buffer.from(r.data.replace(/\s+/g, ''), 'base64');
      return {
        hash: crypto.createHash('md5').update(buf).digest('hex'),
        mime: r.mime || 'application/octet-stream',
        filename: r.fileName || r.filename || '',
        data: buf,
      };
    });
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
 * @returns {Promise<{total,imported,skipped,failed,cancelled,errors}>}
 */
async function runImport({ enexPath, sectionId, getToken, onProgress, shouldCancel, force = false }) {
  const emit = (e) => {
    if (typeof onProgress === 'function') {
      try { onProgress(e); } catch { /* a listener error must not abort the import */ }
    }
  };
  const cancelled = () => typeof shouldCancel === 'function' && shouldCancel();
  const filename = path.basename(enexPath);

  emit({ phase: 'parsing', file: filename });
  const notes = await parseEnexFile(enexPath);

  const progress = loadProgress();
  const client = new OneNoteClient({ getToken });

  const total = notes.length;
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  const errors = [];

  emit({ phase: 'start', total });

  for (let i = 0; i < notes.length; i++) {
    if (cancelled()) {
      emit({ phase: 'cancelled', current: i, total, imported, skipped, failed });
      return { total, imported, skipped, failed, cancelled: true, errors };
    }

    const note = notes[i];
    const title = note.title || 'Untitled Note';
    const key = noteKey(sectionId, filename, note);
    emit({ phase: 'note', current: i + 1, total, title, status: 'importing' });

    try {
      // Resume: a note already in the ledger is never re-sent to OneNote —
      // unless the user explicitly asked to re-import (force).
      if (!force && isImported(progress, filename, key)) {
        skipped++;
        emit({ phase: 'note', current: i + 1, total, title, status: 'skipped' });
        continue;
      }

      const resources = prepareResources(note.resources);
      let html;
      let usedResources;
      if (resources.length > 0) {
        ({ html, usedResources } = enmlToHtmlWithResources(note.content, resources));
      } else {
        html = enmlToHtml(note.content);
        usedResources = [];
      }

      const meta = { created: note.created, author: note.author, sourceUrl: note.sourceUrl };
      const pageHtml = toOneNoteHtml(title, html, meta);

      const created = usedResources.length > 0
        ? await client.createPageWithAttachments(sectionId, title, pageHtml, usedResources)
        : await client.createPage(sectionId, title, pageHtml);

      // Record in the ledger immediately, so a crash here never re-creates
      // the page on the next run.
      markImported(progress, filename, key, (created && created.id) || null);
      saveProgress(progress);
      imported++;
      emit({ phase: 'note', current: i + 1, total, title, status: 'imported' });
    } catch (err) {
      failed++;
      errors.push({ title, message: err.message });
      emit({ phase: 'note', current: i + 1, total, title, status: 'failed', error: err.message });
    }
  }

  emit({ phase: 'done', total, imported, skipped, failed });
  return { total, imported, skipped, failed, cancelled: false, errors };
}

module.exports = { runImport };
