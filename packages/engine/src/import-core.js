'use strict';

const crypto = require('node:crypto');
const { enmlToHtml, enmlToHtmlWithResources, toOneNoteHtml } = require('./enml-converter');
const { applyTagsToHtml, resolveSectionForTags } = require('./tags');
const { runParallel } = require('./parallel');
const progressLib = require('./progress');

function prepareResources(rawResources) {
  return (rawResources || [])
    .filter((r) => r.data && (Buffer.isBuffer(r.data) ? r.data.length : r.data.trim()))
    .map((r) => {
      const buf = Buffer.isBuffer(r.data) ? r.data : Buffer.from(String(r.data).replace(/\s+/g, ''), 'base64');
      return { hash: crypto.createHash('md5').update(buf).digest('hex'), mime: r.mime || 'application/octet-stream', filename: r.fileName || r.filename || '', data: buf };
    });
}

function yearFromCreated(created) {
  if (!created || created.length < 4) return null;
  return created.slice(0, 4);
}

/**
 * Import notes from one .enex into OneNote. Emits events; no terminal/GUI I/O.
 *
 * @param {object}   o
 * @param {Array}    o.notes
 * @param {string}   o.filename
 * @param {object}   o.client                OneNoteClient
 * @param {object}   o.notebook              { id }
 * @param {object}   o.progress
 * @param {Function} o.noteKeyFn             (filename, note) => string
 * @param {object}   [o.targetSection]       pre-chosen { id } — when set, every note goes here and no section is created (desktop fixed-section import)
 * @param {string}   [o.defaultSectionName]
 * @param {boolean}  [o.dryRun]
 * @param {boolean}  [o.resume]
 * @param {boolean}  [o.forceReimport]
 * @param {boolean}  [o.yearSections]
 * @param {string}   [o.tagsStrategy]        'page-metadata' | 'section-groups'
 * @param {string}   [o.onConflict]          'skip' | 'rename' | 'overwrite' | 'ask'
 * @param {Function} [o.askConflict]         async (title) => 'skip'|'rename'|'overwrite' (required if onConflict==='ask')
 * @param {number}   [o.concurrency]
 * @param {object}   [o.globalBackoff]
 * @param {boolean}  [o.preserveMetadata]
 * @param {Function} [o.onEvent]             (event) => void
 * @param {Function} [o.isImported]          defaults to progress.isImported
 * @param {Function} [o.verifyImport]        defaults to progress.verifyImport
 * @param {Function} [o.markImported]        defaults to progress.markImported
 * @param {Function} [o.saveProgress]        defaults to progress.saveProgress
 */
async function importNotes(o) {
  const {
    notes, filename, client, notebook, progress, noteKeyFn, targetSection = null,
    defaultSectionName, dryRun = false, resume = false, forceReimport = false,
    yearSections = false, tagsStrategy = 'page-metadata', onConflict = null,
    askConflict = null, concurrency = 1, globalBackoff = null, preserveMetadata = true,
    onEvent = () => {},
    isImported = progressLib.isImported,
    verifyImport = progressLib.verifyImport,
    markImported = progressLib.markImported,
    saveProgress = () => progressLib.saveProgress(progress),
  } = o;

  const counts = { succeeded: 0, failed: 0, skipped: 0 };
  const sectionCache = new Map();
  const sectionCreating = new Map();
  const sectionGroupCache = new Map();

  async function getSection(sectionName) {
    if (sectionCache.has(sectionName)) return sectionCache.get(sectionName);
    if (!sectionCreating.has(sectionName)) {
      const p = client.createSection(notebook.id, sectionName).then((section) => {
        const entry = { section, baseName: sectionName, overflowCount: 0 };
        sectionCache.set(sectionName, entry);
        return entry;
      });
      sectionCreating.set(sectionName, p);
    }
    return sectionCreating.get(sectionName);
  }

  const effectiveConcurrency = onConflict === 'ask' ? 1 : concurrency;
  const backoff = globalBackoff || { wait: async () => {}, active: false, set: () => {} };

  await runParallel(notes, effectiveConcurrency, backoff, async (note, i) => {
    const title = note.title || 'Untitled Note';
    const key = noteKeyFn(filename, note);
    const ctx = { filename, index: i, total: notes.length, title };
    try {
      if (resume && !forceReimport && isImported(progress, filename, key)) {
        if (dryRun) { onEvent({ type: 'noteSkipped', reason: 'dry-run', ...ctx }); counts.skipped++; return; }
        const state = await verifyImport(progress, filename, key, client);
        if (state === 'exists') { onEvent({ type: 'noteSkipped', reason: 'verified', ...ctx }); counts.skipped++; return; }
        if (state === 'unknown') { onEvent({ type: 'noteSkipped', reason: 'verify-inconclusive', ...ctx }); counts.skipped++; return; }
        onEvent({ type: 'noteRetry', reason: 'page-missing', ...ctx });
      }

      onEvent({ type: 'noteStart', ...ctx });

      const resources = prepareResources(note.resources || []);
      let html, usedResources;
      if (resources.length > 0) ({ html, usedResources } = enmlToHtmlWithResources(note.content, resources));
      else { html = enmlToHtml(note.content); usedResources = []; }

      if (tagsStrategy === 'page-metadata' && note.tags && note.tags.length > 0) html = applyTagsToHtml(html, note.tags);

      let sectionRef;
      if (targetSection) {
        sectionRef = { section: targetSection, baseName: '', overflowCount: 0 };
      }
      if (!sectionRef && tagsStrategy === 'section-groups' && note.tags && note.tags.length > 0) {
        const tagSection = await resolveSectionForTags(note.tags, notebook.id, client, sectionGroupCache);
        if (tagSection) sectionRef = { section: tagSection, baseName: note.tags[0], overflowCount: 0 };
      }
      if (!sectionRef) {
        const base = defaultSectionName || 'Imported';
        const sectionName = yearSections ? `${base} ${yearFromCreated(note.created) || ''}`.trim() : base;
        sectionRef = await getSection(sectionName);
      }

      let effectiveTitle = title;
      if (!dryRun && onConflict) {
        const existing = await client.findPageByTitle(sectionRef.section.id, title);
        if (existing) {
          let action = onConflict;
          if (onConflict === 'ask') action = await askConflict(title);
          if (action === 'skip') { onEvent({ type: 'noteSkipped', reason: 'conflict', ...ctx }); counts.skipped++; return; }
          if (action === 'rename') { effectiveTitle = `${title} (imported ${new Date().toISOString().slice(0, 10)})`; onEvent({ type: 'conflict', action: 'rename', from: title, to: effectiveTitle, ...ctx }); }
          if (action === 'overwrite') { onEvent({ type: 'conflict', action: 'overwrite', ...ctx }); try { await client.deletePage(existing.id); } catch (e) { onEvent({ type: 'warning', message: `delete failed: ${e.message}`, ...ctx }); } }
        }
      }

      const meta = preserveMetadata ? { created: note.created, author: note.author, sourceUrl: note.sourceUrl } : null;
      const page = toOneNoteHtml(effectiveTitle, html, meta);

      let pageId;
      try {
        const created = usedResources.length > 0
          ? await client.createPageWithAttachments(sectionRef.section.id, effectiveTitle, page, usedResources)
          : await client.createPage(sectionRef.section.id, effectiveTitle, page);
        pageId = created && created.id;
      } catch (apiErr) {
        if (apiErr.message.includes('30102') || apiErr.message.includes('507')) {
          sectionRef.overflowCount++;
          const newName = `${sectionRef.baseName} (${sectionRef.overflowCount})`;
          onEvent({ type: 'sectionOverflow', newName, ...ctx });
          sectionRef.section = await client.createSection(notebook.id, newName);
          const created = usedResources.length > 0
            ? await client.createPageWithAttachments(sectionRef.section.id, effectiveTitle, page, usedResources)
            : await client.createPage(sectionRef.section.id, effectiveTitle, page);
          pageId = created && created.id;
        } else throw apiErr;
      }

      markImported(progress, filename, key, pageId || null);
      saveProgress(progress);
      onEvent({ type: 'noteImported', pageId: pageId || null, tags: note.tags || [], dryRun, ...ctx });
      counts.succeeded++;
    } catch (err) {
      onEvent({ type: 'error', message: err.message, error: err, ...ctx });
      counts.failed++;
    }
  });

  return counts;
}

module.exports = { importNotes, prepareResources, yearFromCreated };
