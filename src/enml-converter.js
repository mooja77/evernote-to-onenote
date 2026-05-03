'use strict';
/**
 * ENML Converter — converts Evernote Markup Language (ENML) to plain HTML.
 *
 * v1.3.0 hardening additions (additive — pre-1.3.0 inputs that don't trigger
 * the new handlers behave unchanged):
 *   - convertCodeBlocks       — <en-codeblock> → <pre><code class="language-X">
 *   - flattenNestedTables     — tables nested in <td>/<th> flattened to
 *                               pipe-separated text rows (OneNote can't
 *                               render nested tables)
 *   - convertFootnotes        — <sup><a href="#fn-N">N</a></sup> → <sup>[N]</sup>;
 *                               back-links stripped; <section.footnotes> →
 *                               <div.endnotes>
 *   - convertMedia preserves style/width/height (v1.2.4 dropped them)
 *   - <en-crypt> message reworded for actionability
 *   - convertUnknownEnElements — final safety net so any unhandled <en-*>
 *                               element emits a visible [unsupported: en-X]
 *                               marker instead of being silently passed to
 *                               OneNote
 */

function enmlToHtml(enml) {
  if (!enml) return '<p></p>';

  let html = enml;

  html = html.replace(/<\?xml[^>]*\?>/gi, '');
  html = html.replace(/<!DOCTYPE[^>]*>/gi, '');

  html = html.replace(/<en-note[^>]*>/gi, '<div class="note-body">');
  html = html.replace(/<\/en-note>/gi, '</div>');

  // Convert <en-codeblock> BEFORE the en-* fallback strips it.
  html = convertCodeBlocks(html);

  html = html.replace(/<en-todo[^>]*checked="true"[^>]*\/>/gi, '<span>✅ </span>');
  html = html.replace(/<en-todo[^/]*(\/?)>/gi, '<span>☐ </span>');

  html = html.replace(/<en-media[^>]*\/>/gi, '[attachment]');

  // v1.3.0: en-crypt message reworded for actionability.
  html = html.replace(
    /<en-crypt[^>]*>[\s\S]*?<\/en-crypt>/gi,
    '<p>[Encrypted content — decrypt in Evernote before export]</p>',
  );

  html = flattenNestedTables(html);
  html = convertFootnotes(html);
  html = convertUnknownEnElements(html);

  html = html.trim();
  return html || '<p></p>';
}

/**
 * Convert ENML to HTML and resolve <en-media> elements against resource list.
 *
 * v1.3.0 — preserves style/width/height attributes from the original
 * <en-media> so inline positioning survives the conversion.
 */
function enmlToHtmlWithResources(enml, resources = []) {
  if (!enml) return { html: '<p></p>', usedResources: [] };

  const byHash = new Map();
  for (const r of resources) {
    if (r.hash) byHash.set(r.hash.toLowerCase(), r);
  }

  const usedResources = [];
  let partIndex = 0;

  let html = enml;

  html = html.replace(/<\?xml[^>]*\?>/gi, '');
  html = html.replace(/<!DOCTYPE[^>]*>/gi, '');

  html = html.replace(/<en-note[^>]*>/gi, '<div class="note-body">');
  html = html.replace(/<\/en-note>/gi, '</div>');

  html = convertCodeBlocks(html);

  html = html.replace(/<en-todo[^>]*checked="true"[^>]*\/>/gi, '<span>✅ </span>');
  html = html.replace(/<en-todo[^/]*(\/?)>/gi, '<span>☐ </span>');

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

    const positioning = extractPositioningAttrs(attrs);

    if (effectiveMime.startsWith('image/')) {
      return `<img src="name:${partName}"${positioning} />`;
    }

    const filename = escapeHtml(resource.filename || partName);
    return `<object data="name:${partName}" data-attachment="${filename}" type="${escapeHtml(effectiveMime)}"${positioning}></object>`;
  });

  html = html.replace(
    /<en-crypt[^>]*>[\s\S]*?<\/en-crypt>/gi,
    '<p>[Encrypted content — decrypt in Evernote before export]</p>',
  );

  html = flattenNestedTables(html);
  html = convertFootnotes(html);
  html = convertUnknownEnElements(html);

  html = html.trim();
  return { html: html || '<p></p>', usedResources };
}

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

// ─── v1.3.0 hardening helpers ──────────────────────────────────────────────

/**
 * Convert <en-codeblock language="python">...</en-codeblock> to
 * <pre><code class="language-python">...</code></pre>.
 *
 * Both `language=` and `lang=` accepted. Code content preserved verbatim
 * (ENML pre-encodes entities; re-escaping would double-encode).
 */
function convertCodeBlocks(html) {
  return html.replace(
    /<en-codeblock([^>]*)>([\s\S]*?)<\/en-codeblock>/gi,
    (_match, attrs, code) => {
      const lang = extractAttr(attrs, 'language') || extractAttr(attrs, 'lang');
      const classAttr = lang ? ` class="language-${escapeHtmlAttr(lang)}"` : '';
      return `<pre><code${classAttr}>${code}</code></pre>`;
    },
  );
}

/**
 * Flatten tables nested inside <td>/<th> cells into pipe-separated text
 * rows joined by <br/>. OneNote does not support nested tables; v1.2.4
 * left them intact and OneNote rendered them as visually broken.
 */
function flattenNestedTables(html) {
  const MAX_PASSES = 8;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const before = html;
    html = html.replace(
      /<table(?:\s[^>]*)?>(?:(?!<table)[\s\S])*?<\/table>/gi,
      (match, offset, full) => {
        const prefix = full.slice(0, offset);
        return isInsideTableCell(prefix) ? innerTableToText(match) : match;
      },
    );
    if (html === before) break;
  }
  return html;
}

function isInsideTableCell(prefix) {
  const lastOpen = Math.max(prefix.lastIndexOf('<td'), prefix.lastIndexOf('<th'));
  if (lastOpen === -1) return false;
  return !/<\/t[dh]>/i.test(prefix.slice(lastOpen));
}

function innerTableToText(tableHtml) {
  const rows = [];
  const rowRe = /<tr(?:\s[^>]*)?>[\s\S]*?<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(tableHtml)) !== null) {
    const cells = [];
    const cellRe = /<t[dh](?:\s[^>]*)?>[\s\S]*?<\/t[dh]>/gi;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowMatch[0])) !== null) {
      const text = stripTags(cellMatch[0]).trim();
      if (text) cells.push(text);
    }
    if (cells.length > 0) rows.push(cells.join(' | '));
  }
  return rows.join('<br/>');
}

/**
 * Convert footnote-style references to an endnote pattern.
 *
 *  1. Inline refs:   <sup><a href="#fn-N">N</a></sup>  →  <sup>[N]</sup>
 *  2. Back-links:    <a href="#fnref-N">↩</a>          →  (removed)
 *  3. <section class="footnotes">...</section> →
 *     <div class="endnotes"><h4>Notes</h4>...</div>
 *
 * Hash-anchor hrefs are stripped — OneNote pages do not support in-page
 * anchor navigation, so they would silently do nothing.
 */
function convertFootnotes(html) {
  html = html.replace(
    /<sup[^>]*>\s*<a\s[^>]*href=["']#fn[^"']*["'][^>]*>([\s\S]*?)<\/a>\s*<\/sup>/gi,
    (_m, label) => `<sup>[${stripTags(label).trim()}]</sup>`,
  );
  html = html.replace(
    /<a\s[^>]*href=["']#fnref[^"']*["'][^>]*>[\s\S]*?<\/a>/gi,
    '',
  );
  html = html.replace(
    /<section[^>]*class=["'][^"']*footnotes[^"']*["'][^>]*>([\s\S]*?)<\/section>/gi,
    (_m, body) => `<div class="endnotes"><h4>Notes</h4>${body}</div>`,
  );
  return html;
}

/**
 * Replace any remaining <en-*> elements with a visible unsupported marker.
 * Runs AFTER all named conversions so only genuinely unknown elements
 * reach this step. Never silently drops content — the marker is always
 * emitted. Iterative to handle nested unknown elements (innermost first).
 */
function convertUnknownEnElements(html) {
  html = html.replace(/<(en-[a-z][a-z0-9-]*)(?:\s[^>]*)?\s*\/>/gi, '[unsupported: $1]');
  const MAX_PASSES = 5;
  for (let i = 0; i < MAX_PASSES; i++) {
    const before = html;
    html = html.replace(
      /<(en-[a-z][a-z0-9-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi,
      '[unsupported: $1]',
    );
    if (html === before) break;
  }
  return html;
}

function extractAttr(attrStr, name) {
  const re = new RegExp(`\\b${name}=["']([^"']*)["']`, 'i');
  const m = re.exec(attrStr);
  return m ? m[1] : undefined;
}

function escapeHtmlAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function stripTags(html) {
  return String(html).replace(/<[^>]*>/g, '');
}

function extractPositioningAttrs(attrs) {
  const parts = [];
  const style = extractAttr(attrs, 'style');
  const width = extractAttr(attrs, 'width');
  const height = extractAttr(attrs, 'height');
  if (style) parts.push(`style="${escapeHtmlAttr(style)}"`);
  if (width) parts.push(`width="${escapeHtmlAttr(width)}"`);
  if (height) parts.push(`height="${escapeHtmlAttr(height)}"`);
  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}

module.exports = {
  enmlToHtml,
  toOneNoteHtml,
  enmlToHtmlWithResources,
  formatEnexDate,
  // Exposed for testing the v1.3.0 hardening helpers in isolation.
  convertCodeBlocks,
  flattenNestedTables,
  convertFootnotes,
  convertUnknownEnElements,
};
