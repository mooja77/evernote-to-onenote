'use strict';

const VALID_STRATEGIES = ['page-metadata', 'section-groups'];

/**
 * Prepend a tags line to an HTML body fragment.
 * Used by the 'page-metadata' strategy.
 *
 * @param {string} html - HTML body content (not a full page)
 * @param {string[]} tags
 * @returns {string}
 */
function applyTagsToHtml(html, tags) {
  if (!tags || tags.length === 0) return html;
  const escaped = tags.map(t => escapeHtml(String(t))).join(', ');
  const tagLine = `<p><strong>Tags:</strong> ${escaped}</p>`;
  return tagLine + '\n' + html;
}

/**
 * Resolve the OneNote section for a note under the 'section-groups' strategy.
 * Creates a section group per top-level (first) tag and a "Notes" section inside it.
 * Falls back to null when the note has no tags (caller should use default section).
 *
 * @param {string[]} tags
 * @param {string} notebookId
 * @param {object} client - OneNoteClient instance
 * @param {Map} sectionGroupCache - shared cache keyed by tag name
 * @returns {Promise<object|null>} section object, or null if no tags
 */
async function resolveSectionForTags(tags, notebookId, client, sectionGroupCache) {
  const primaryTag = tags && tags.length > 0 ? tags[0] : null;
  if (!primaryTag) return null;

  if (!sectionGroupCache.has(primaryTag)) {
    const group = await client.getOrCreateSectionGroup(notebookId, primaryTag);
    const section = await client.createSectionInGroup(group.id, 'Notes');
    sectionGroupCache.set(primaryTag, { group, section });
  }
  return sectionGroupCache.get(primaryTag).section;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = { applyTagsToHtml, resolveSectionForTags, VALID_STRATEGIES };
