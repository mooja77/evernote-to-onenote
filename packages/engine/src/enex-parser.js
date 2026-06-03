'use strict';
/**
 * ENEX Parser — reads Evernote export files (.enex) and returns structured note objects
 */
const xml2js = require('xml2js');
const fs = require('fs');

// 500MB cap — raised from 100MB so To Do List.enex (228MB, 862 notes)
// parses. xml2js can handle hundreds of megabytes on modern hardware;
// the original 100MB number was overly cautious.
const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024;

async function parseEnexFile(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_SIZE_BYTES) {
    throw new Error(`ENEX file too large (${(stat.size / 1024 / 1024).toFixed(0)}MB > 500MB limit): ${filePath}`);
  }
  const xml = await fs.promises.readFile(filePath, 'utf8');
  const parser = new xml2js.Parser({ explicitArray: false, explicitCharkey: true });

  const result = await parser.parseStringPromise(xml);
  const enExport = result['en-export'];

  // Handle single note or array of notes
  let notes = enExport.note;
  if (!notes) return [];
  if (!Array.isArray(notes)) notes = [notes];

  const results = [];
  for (const note of notes) {
    try {
      const attrs = note['note-attributes'] || null;
      results.push({
        title: getText(note.title),
        created: getText(note.created) || null,
        updated: getText(note.updated) || null,
        tags: parseTags(note.tag),
        content: getText(note.content),   // ENML string
        resources: parseResources(note.resource),
        author: attrs ? (getText(attrs.author) || null) : null,
        sourceUrl: attrs ? (getText(attrs['source-url']) || null) : null,
      });
    } catch (err) {
      let safeTitle = '<untitled>';
      try { safeTitle = getText(note.title) || '<untitled>'; } catch { /* title itself is corrupt */ }
      console.warn(`[enex-parser] Skipping corrupt note "${safeTitle}": ${err.message}`);
    }
  }
  return results;
}

function getText(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (val._) return val._;
  return '';
}

function parseTags(tag) {
  if (!tag) return [];
  if (Array.isArray(tag)) return tag.map(getText);
  return [getText(tag)];
}

function parseResources(resource) {
  if (!resource) return [];
  if (!Array.isArray(resource)) resource = [resource];
  return resource.map(r => ({
    mime: getText(r.mime),
    fileName: r['resource-attributes'] ? getText(r['resource-attributes'].filename || r['resource-attributes']['file-name']) : '',
    data: getText(r.data),
  }));
}

module.exports = { parseEnexFile };
