'use strict';
/**
 * ENML Converter — converts Evernote Markup Language (ENML) to plain HTML
 * ENML is a restricted XHTML variant. We strip the en-note wrapper and
 * remove Evernote-specific tags, producing clean HTML for OneNote.
 */

function enmlToHtml(enml) {
  if (!enml) return '<p></p>';

  let html = enml;

  // Remove XML declaration and DOCTYPE
  html = html.replace(/<\?xml[^>]*\?>/gi, '');
  html = html.replace(/<!DOCTYPE[^>]*>/gi, '');

  // Unwrap <en-note> → <div>
  html = html.replace(/<en-note[^>]*>/gi, '<div class="note-body">');
  html = html.replace(/<\/en-note>/gi, '</div>');

  // Convert <en-todo checked="true"/> → ✅  and <en-todo/> → ☐
  html = html.replace(/<en-todo[^>]*checked="true"[^>]*\/>/gi, '<span>✅ </span>');
  html = html.replace(/<en-todo[^/]*(\/?)>/gi, '<span>☐ </span>');

  // Remove <en-media> (attachments — would need binary upload to OneNote)
  html = html.replace(/<en-media[^>]*\/>/gi, '[attachment]');

  // Remove en-crypt elements
  html = html.replace(/<en-crypt[^>]*>.*?<\/en-crypt>/gis, '[encrypted content]');

  // Trim whitespace
  html = html.trim();

  return html || '<p></p>';
}

/**
 * Convert ENML to HTML and resolve <en-media> elements against resource list.
 *
 * Images become: <img src="name:partN" />
 * Other types become: <object data="name:partN" data-attachment="filename" type="contentType" />
 *
 * @param {string} enml
 * @param {Array<{ hash: string, mime: string, filename: string, data: Buffer }>} resources
 * @returns {{ html: string, usedResources: Array<{ contentType: string, data: Buffer, partName: string }> }}
 */
function enmlToHtmlWithResources(enml, resources = []) {
  if (!enml) return { html: '<p></p>', usedResources: [] };

  // Build a hash → resource lookup
  const byHash = new Map();
  for (const r of resources) {
    if (r.hash) byHash.set(r.hash.toLowerCase(), r);
  }

  const usedResources = [];
  let partIndex = 0;

  let html = enml;

  // Remove XML declaration and DOCTYPE
  html = html.replace(/<\?xml[^>]*\?>/gi, '');
  html = html.replace(/<!DOCTYPE[^>]*>/gi, '');

  // Unwrap <en-note> → <div>
  html = html.replace(/<en-note[^>]*>/gi, '<div class="note-body">');
  html = html.replace(/<\/en-note>/gi, '</div>');

  // Convert <en-todo>
  html = html.replace(/<en-todo[^>]*checked="true"[^>]*\/>/gi, '<span>✅ </span>');
  html = html.replace(/<en-todo[^/]*(\/?)>/gi, '<span>☐ </span>');

  // Replace <en-media> with inline references
  html = html.replace(/<en-media\b([^>]*)\/>/gi, (match, attrs) => {
    const hashMatch = attrs.match(/hash="([a-f0-9]+)"/i);
    const mimeMatch = attrs.match(/type="([^"]+)"/i);
    const hash = hashMatch ? hashMatch[1].toLowerCase() : null;
    const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';

    if (!hash || !byHash.has(hash)) {
      return '[attachment]';
    }

    const resource = byHash.get(hash);
    const partName = `part${++partIndex}`;
    const effectiveMime = resource.mime || mime;

    usedResources.push({
      contentType: effectiveMime,
      data: resource.data,
      partName,
    });

    if (effectiveMime.startsWith('image/')) {
      return `<img src="name:${partName}" />`;
    }

    const filename = escapeHtml(resource.filename || partName);
    return `<object data="name:${partName}" data-attachment="${filename}" type="${escapeHtml(effectiveMime)}"></object>`;
  });

  // Remove en-crypt elements
  html = html.replace(/<en-crypt[^>]*>.*?<\/en-crypt>/gis, '[encrypted content]');

  html = html.trim();

  return { html: html || '<p></p>', usedResources };
}

/**
 * Wrap converted HTML in a OneNote-compatible HTML page structure.
 * @param {string} title
 * @param {string} htmlBody
 * @param {{ created?: string|null, author?: string|null, sourceUrl?: string|null }|null} [metadata]
 */
function toOneNoteHtml(title, htmlBody, metadata = null) {
  let metaBlock = '';
  if (metadata) {
    const lines = [];
    if (metadata.created) {
      const formatted = formatEnexDate(metadata.created);
      if (formatted) lines.push(`<p><em>Created: ${formatted}</em></p>`);
    }
    if (metadata.author) {
      lines.push(`<p><em>Author: ${escapeHtml(metadata.author)}</em></p>`);
    }
    if (metadata.sourceUrl) {
      const escapedUrl = escapeHtml(metadata.sourceUrl);
      lines.push(`<p><em>Source: <a href="${escapedUrl}">${escapedUrl}</a></em></p>`);
    }
    if (lines.length > 0) {
      metaBlock = `<div class="note-metadata">\n  ${lines.join('\n  ')}\n  </div>\n  `;
    }
  }
  return `<!DOCTYPE html>
<html>
<head>
  <title>${escapeHtml(title)}</title>
  <meta charset="utf-8" />
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${metaBlock}${htmlBody}
</body>
</html>`;
}

function formatEnexDate(enexDate) {
  if (!enexDate || enexDate.length < 8) return null;
  const year = enexDate.slice(0, 4);
  const month = enexDate.slice(4, 6);
  const day = enexDate.slice(6, 8);
  if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(month) || !/^\d{2}$/.test(day)) return null;
  return `${year}-${month}-${day}`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { enmlToHtml, toOneNoteHtml, enmlToHtmlWithResources, formatEnexDate };
