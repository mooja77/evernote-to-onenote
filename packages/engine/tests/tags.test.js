'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { applyTagsToHtml, resolveSectionForTags, VALID_STRATEGIES } = require('../src/tags');

describe('VALID_STRATEGIES', () => {
  test('includes page-metadata and section-groups', () => {
    assert.ok(VALID_STRATEGIES.includes('page-metadata'));
    assert.ok(VALID_STRATEGIES.includes('section-groups'));
  });
});

describe('applyTagsToHtml', () => {
  test('prepends tags line before existing HTML', () => {
    const html = '<p>Hello world</p>';
    const result = applyTagsToHtml(html, ['work', 'project']);
    assert.match(result, /<p><strong>Tags:<\/strong> work, project<\/p>/);
    assert.match(result, /<p>Hello world<\/p>/);
    assert.ok(result.indexOf('<p><strong>Tags:') < result.indexOf('<p>Hello world'));
  });

  test('returns original html when tags array is empty', () => {
    const html = '<p>No tags</p>';
    assert.equal(applyTagsToHtml(html, []), html);
  });

  test('returns original html when tags is null', () => {
    const html = '<p>No tags</p>';
    assert.equal(applyTagsToHtml(html, null), html);
  });

  test('handles a single tag', () => {
    const result = applyTagsToHtml('<p>body</p>', ['solo']);
    assert.match(result, /<p><strong>Tags:<\/strong> solo<\/p>/);
  });

  test('escapes HTML special characters in tag names', () => {
    const result = applyTagsToHtml('<p>body</p>', ['<script>', 'a&b', '"quoted"']);
    assert.doesNotMatch(result, /<script>/);
    assert.match(result, /&lt;script&gt;/);
    assert.match(result, /a&amp;b/);
  });

  test('handles many tags joined with comma-space', () => {
    const tags = ['alpha', 'beta', 'gamma', 'delta'];
    const result = applyTagsToHtml('<p>x</p>', tags);
    assert.match(result, /alpha, beta, gamma, delta/);
  });

  test('handles Unicode tag names (Japanese, accented)', () => {
    const result = applyTagsToHtml('<p>body</p>', ['仕事', 'café', 'naïve']);
    assert.match(result, /仕事/);
    assert.match(result, /café/);
    assert.match(result, /naïve/);
  });

  test('handles tag name with only whitespace — included as-is', () => {
    const result = applyTagsToHtml('<p>body</p>', ['  ']);
    assert.match(result, /<strong>Tags:<\/strong>/);
  });

  test('numeric tag names render correctly', () => {
    const result = applyTagsToHtml('<p>body</p>', ['2024', '42']);
    assert.match(result, /2024, 42/);
  });

  test('returns tag line + newline + original html (exact structure)', () => {
    const result = applyTagsToHtml('<p>body</p>', ['x']);
    assert.equal(result, '<p><strong>Tags:</strong> x</p>\n<p>body</p>');
  });
});

describe('resolveSectionForTags', () => {
  function makeClient(sections = []) {
    return {
      getOrCreateSectionGroupCalls: [],
      createSectionInGroupCalls: [],
      async getOrCreateSectionGroup(notebookId, name) {
        this.getOrCreateSectionGroupCalls.push({ notebookId, name });
        return { id: `group-${name}`, displayName: name };
      },
      async createSectionInGroup(sectionGroupId, name) {
        this.createSectionInGroupCalls.push({ sectionGroupId, name });
        return { id: `section-${sectionGroupId}-${name}`, displayName: name };
      },
    };
  }

  test('returns null when tags is empty', async () => {
    const client = makeClient();
    const result = await resolveSectionForTags([], 'nb1', client, new Map());
    assert.equal(result, null);
  });

  test('returns null when tags is null', async () => {
    const client = makeClient();
    const result = await resolveSectionForTags(null, 'nb1', client, new Map());
    assert.equal(result, null);
  });

  test('creates section group and section for primary tag', async () => {
    const client = makeClient();
    const cache = new Map();
    const section = await resolveSectionForTags(['work', 'project'], 'nb1', client, cache);
    assert.ok(section);
    assert.equal(client.getOrCreateSectionGroupCalls.length, 1);
    assert.equal(client.getOrCreateSectionGroupCalls[0].name, 'work');
    assert.equal(client.createSectionInGroupCalls[0].sectionGroupId, 'group-work');
    assert.equal(client.createSectionInGroupCalls[0].name, 'Notes');
  });

  test('caches section group — only one API call per unique tag', async () => {
    const client = makeClient();
    const cache = new Map();
    await resolveSectionForTags(['work'], 'nb1', client, cache);
    await resolveSectionForTags(['work'], 'nb1', client, cache);
    assert.equal(client.getOrCreateSectionGroupCalls.length, 1);
    assert.equal(client.createSectionInGroupCalls.length, 1);
  });

  test('different tags produce different section groups', async () => {
    const client = makeClient();
    const cache = new Map();
    const s1 = await resolveSectionForTags(['alpha'], 'nb1', client, cache);
    const s2 = await resolveSectionForTags(['beta'], 'nb1', client, cache);
    assert.notEqual(s1.id, s2.id);
    assert.equal(client.getOrCreateSectionGroupCalls.length, 2);
  });

  test('returns the section (not the group)', async () => {
    const client = makeClient();
    const section = await resolveSectionForTags(['mytag'], 'nb1', client, new Map());
    assert.ok(section.id.startsWith('section-'));
  });
});
