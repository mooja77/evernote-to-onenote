'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { importNotes } = require('../src/index');

const noBackoff = { wait: async () => {}, active: false, set: () => {} };

function makeProgress() {
  return { version: 2, files: {} };
}

function makeNote(overrides = {}) {
  return {
    title: 'My Note',
    created: '20260101T000000Z',
    updated: null,
    tags: [],
    content: '<en-note><p>body</p></en-note>',
    resources: [],
    author: null,
    sourceUrl: null,
    ...overrides,
  };
}

function makeClient(overrides = {}) {
  const base = {
    createSectionCalls: [],
    createPageCalls: [],
    deletePageCalls: [],
    findPageByTitleResult: null,
    async createSection(notebookId, name) {
      this.createSectionCalls.push({ notebookId, name });
      return { id: `sec-${name}`, displayName: name };
    },
    async findPageByTitle(sectionId, title) {
      return this.findPageByTitleResult;
    },
    async createPage(sectionId, title, html) {
      this.createPageCalls.push({ sectionId, title });
      return { id: `page-${title}` };
    },
    async deletePage(pageId) {
      this.deletePageCalls.push(pageId);
    },
    async createPageWithAttachments(sectionId, title, html, resources) {
      this.createPageCalls.push({ sectionId, title });
      return { id: `page-${title}` };
    },
    async getOrCreateSectionGroup(notebookId, name) {
      return { id: `grp-${name}`, displayName: name };
    },
    async createSectionInGroup(sectionGroupId, name) {
      return { id: `sec-grp-${sectionGroupId}-${name}`, displayName: name };
    },
  };
  // Merge overrides, keeping method override style working
  return Object.assign(Object.create(null), base, overrides);
}

async function runImport(clientOverrides, onConflict, noteOverrides = {}, extra = {}) {
  const client = makeClient(clientOverrides);
  const progress = makeProgress();
  const counts = await importNotes({
    notes: [makeNote(noteOverrides)],
    filename: 'test.enex',
    fileIndex: 1,
    fileCount: 1,
    client,
    notebook: { id: 'nb-1', displayName: 'Test' },
    dryRun: false,
    resume: false,
    forceReimport: false,
    yearSections: false,
    defaultSectionName: 'Imported',
    progress,
    outputHtmlDir: null,
    tagsStrategy: 'page-metadata',
    onConflict,
    concurrency: 1,
    globalBackoff: noBackoff,
    enqueueWrite: () => Promise.resolve(),
    preserveMetadata: false,
    ...extra,
  });
  return { counts, client };
}

// ── skip mode ──────────────────────────────────────────────────────────────────

describe('on-conflict: skip', () => {
  test('skips note when page already exists', async () => {
    const { counts } = await runImport(
      { findPageByTitleResult: { id: 'existing-1', title: 'My Note' } },
      'skip'
    );
    assert.equal(counts.skipped, 1);
    assert.equal(counts.succeeded, 0);
    assert.equal(counts.failed, 0);
  });

  test('does NOT create page when skipping', async () => {
    const { client } = await runImport(
      { findPageByTitleResult: { id: 'existing-1', title: 'My Note' } },
      'skip'
    );
    assert.equal(client.createPageCalls.length, 0);
  });

  test('imports note normally when no conflict', async () => {
    const { counts, client } = await runImport({ findPageByTitleResult: null }, 'skip');
    assert.equal(counts.succeeded, 1);
    assert.equal(counts.skipped, 0);
    assert.equal(client.createPageCalls.length, 1);
    assert.equal(client.createPageCalls[0].title, 'My Note');
  });

  test('handles note with special chars in title without error', async () => {
    const { counts } = await runImport(
      { findPageByTitleResult: { id: 'ex', title: "O'Brien's Note" } },
      'skip',
      { title: "O'Brien's Note" }
    );
    assert.equal(counts.skipped, 1);
  });
});

// ── rename mode ────────────────────────────────────────────────────────────────

describe('on-conflict: rename', () => {
  test('succeeds when conflict detected', async () => {
    const { counts } = await runImport(
      { findPageByTitleResult: { id: 'existing-1', title: 'My Note' } },
      'rename'
    );
    assert.equal(counts.succeeded, 1);
    assert.equal(counts.skipped, 0);
  });

  test('creates page with date-suffixed title on conflict', async () => {
    const { client } = await runImport(
      { findPageByTitleResult: { id: 'existing-1', title: 'My Note' } },
      'rename'
    );
    assert.equal(client.createPageCalls.length, 1);
    const createdTitle = client.createPageCalls[0].title;
    assert.match(createdTitle, /My Note/);
    assert.match(createdTitle, /imported/i);
    // Suffix should include today's date in YYYY-MM-DD format
    assert.match(createdTitle, /\d{4}-\d{2}-\d{2}/);
  });

  test('keeps original title when no conflict', async () => {
    const { client } = await runImport({ findPageByTitleResult: null }, 'rename');
    assert.equal(client.createPageCalls[0].title, 'My Note');
  });

  test('does NOT call deletePage in rename mode', async () => {
    const { client } = await runImport(
      { findPageByTitleResult: { id: 'existing-1', title: 'My Note' } },
      'rename'
    );
    assert.equal(client.deletePageCalls.length, 0);
  });
});

// ── overwrite mode ─────────────────────────────────────────────────────────────

describe('on-conflict: overwrite', () => {
  test('deletes existing page then creates new one', async () => {
    const { counts, client } = await runImport(
      { findPageByTitleResult: { id: 'existing-abc', title: 'My Note' } },
      'overwrite'
    );
    assert.equal(counts.succeeded, 1);
    assert.equal(client.deletePageCalls.length, 1);
    assert.equal(client.deletePageCalls[0], 'existing-abc');
    assert.equal(client.createPageCalls.length, 1);
  });

  test('preserves original title after overwrite', async () => {
    const { client } = await runImport(
      { findPageByTitleResult: { id: 'existing-abc', title: 'My Note' } },
      'overwrite'
    );
    assert.equal(client.createPageCalls[0].title, 'My Note');
  });

  test('still creates page even if deletePage throws (consumer tier 503)', async () => {
    const { counts, client } = await runImport(
      {
        findPageByTitleResult: { id: 'page-1', title: 'My Note' },
        async deletePage(pageId) {
          this.deletePageCalls.push(pageId);
          throw new Error('503 Service Unavailable');
        },
      },
      'overwrite'
    );
    assert.equal(counts.succeeded, 1);
    assert.equal(client.createPageCalls.length, 1);
  });

  test('imports normally when no existing page', async () => {
    const { counts, client } = await runImport({ findPageByTitleResult: null }, 'overwrite');
    assert.equal(counts.succeeded, 1);
    assert.equal(client.deletePageCalls.length, 0);
    assert.equal(client.createPageCalls.length, 1);
  });
});

// ── ask mode ──────────────────────────────────────────────────────────────────

describe('on-conflict: ask (non-TTY defaults to skip)', () => {
  test('skips in non-interactive mode when page exists', async () => {
    // In test runner, process.stdin.isTTY is undefined/false → askConflict returns 'skip'
    const { counts } = await runImport(
      { findPageByTitleResult: { id: 'existing-1', title: 'My Note' } },
      'ask'
    );
    assert.equal(counts.skipped, 1);
    assert.equal(counts.succeeded, 0);
  });

  test('does NOT create page when non-TTY skips', async () => {
    const { client } = await runImport(
      { findPageByTitleResult: { id: 'existing-1', title: 'My Note' } },
      'ask'
    );
    assert.equal(client.createPageCalls.length, 0);
  });

  test('imports normally in non-TTY when no conflict', async () => {
    const { counts } = await runImport({ findPageByTitleResult: null }, 'ask');
    assert.equal(counts.succeeded, 1);
  });
});

// ── conflict detection disabled ────────────────────────────────────────────────

describe('onConflict: null (no conflict detection)', () => {
  test('does not call findPageByTitle when onConflict is null', async () => {
    let findPageCalled = false;
    const { counts } = await runImport(
      {
        findPageByTitleResult: { id: 'existing-1', title: 'My Note' },
        async findPageByTitle(sectionId, title) {
          findPageCalled = true;
          return this.findPageByTitleResult;
        },
      },
      null
    );
    assert.equal(findPageCalled, false);
    assert.equal(counts.succeeded, 1);
  });
});

// ── multiple notes ─────────────────────────────────────────────────────────────

describe('multiple notes with mixed conflict outcomes', () => {
  test('counts skipped and succeeded correctly for mixed batch', async () => {
    const existingTitles = new Set(['Note A']);
    const client = makeClient({
      findPageByTitleResult: null,
      async findPageByTitle(sectionId, title) {
        return existingTitles.has(title) ? { id: `ex-${title}`, title } : null;
      },
    });
    const progress = makeProgress();
    const counts = await importNotes({
      notes: [
        makeNote({ title: 'Note A' }),
        makeNote({ title: 'Note B' }),
        makeNote({ title: 'Note C' }),
      ],
      filename: 'test.enex',
      fileIndex: 1,
      fileCount: 1,
      client,
      notebook: { id: 'nb-1', displayName: 'Test' },
      dryRun: false,
      resume: false,
      forceReimport: false,
      yearSections: false,
      defaultSectionName: 'Imported',
      progress,
      outputHtmlDir: null,
      tagsStrategy: 'page-metadata',
      onConflict: 'skip',
      concurrency: 1,
      globalBackoff: noBackoff,
      enqueueWrite: () => Promise.resolve(),
      preserveMetadata: false,
    });
    assert.equal(counts.skipped, 1);
    assert.equal(counts.succeeded, 2);
    assert.equal(counts.failed, 0);
  });
});

// ── tags strategy interplay ────────────────────────────────────────────────────

describe('section-groups strategy + conflict modes', () => {
  test('section-groups skip: routes to tag section, skips on conflict', async () => {
    const client = makeClient({
      findPageByTitleResult: { id: 'existing-1', title: 'Tagged Note' },
    });
    const progress = makeProgress();
    const counts = await importNotes({
      notes: [makeNote({ title: 'Tagged Note', tags: ['work'] })],
      filename: 'test.enex',
      fileIndex: 1,
      fileCount: 1,
      client,
      notebook: { id: 'nb-1', displayName: 'Test' },
      dryRun: false,
      resume: false,
      forceReimport: false,
      yearSections: false,
      defaultSectionName: 'Imported',
      progress,
      outputHtmlDir: null,
      tagsStrategy: 'section-groups',
      onConflict: 'skip',
      concurrency: 1,
      globalBackoff: noBackoff,
      enqueueWrite: () => Promise.resolve(),
      preserveMetadata: false,
    });
    assert.equal(counts.skipped, 1);
    assert.equal(counts.succeeded, 0);
  });

  test('section-groups rename: creates page in tag section with renamed title', async () => {
    const client = makeClient({
      findPageByTitleResult: { id: 'existing-1', title: 'Tagged Note' },
    });
    const progress = makeProgress();
    const counts = await importNotes({
      notes: [makeNote({ title: 'Tagged Note', tags: ['work'] })],
      filename: 'test.enex',
      fileIndex: 1,
      fileCount: 1,
      client,
      notebook: { id: 'nb-1', displayName: 'Test' },
      dryRun: false,
      resume: false,
      forceReimport: false,
      yearSections: false,
      defaultSectionName: 'Imported',
      progress,
      outputHtmlDir: null,
      tagsStrategy: 'section-groups',
      onConflict: 'rename',
      concurrency: 1,
      globalBackoff: noBackoff,
      enqueueWrite: () => Promise.resolve(),
      preserveMetadata: false,
    });
    assert.equal(counts.succeeded, 1);
    assert.equal(client.createPageCalls.length, 1);
    assert.match(client.createPageCalls[0].title, /imported/i);
  });
});
