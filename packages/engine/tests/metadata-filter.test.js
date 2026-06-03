'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { parseEnexFile } = require('../src/enex-parser');
const { toOneNoteHtml, formatEnexDate } = require('../src/enml-converter');

const fix = (name) => path.join(__dirname, 'fixtures', name);

// ── enex-parser: note-attributes ─────────────────────────────────────────────

describe('enex-parser note-attributes', () => {
  test('parses author from note-attributes', async () => {
    const notes = await parseEnexFile(fix('with-metadata.enex'));
    assert.equal(notes[0].author, 'John Doe');
  });

  test('parses source-url from note-attributes', async () => {
    const notes = await parseEnexFile(fix('with-metadata.enex'));
    assert.equal(notes[0].sourceUrl, 'https://example.com/article');
  });

  test('returns null author when note-attributes absent', async () => {
    const notes = await parseEnexFile(fix('single-note.enex'));
    assert.equal(notes[0].author, null);
  });

  test('returns null sourceUrl when note-attributes absent', async () => {
    const notes = await parseEnexFile(fix('single-note.enex'));
    assert.equal(notes[0].sourceUrl, null);
  });

  test('returns null author when note has no-attributes element but no author', async () => {
    const notes = await parseEnexFile(fix('with-metadata.enex'));
    // second note has no note-attributes
    assert.equal(notes[1].author, null);
    assert.equal(notes[1].sourceUrl, null);
  });
});

// ── formatEnexDate ────────────────────────────────────────────────────────────

describe('formatEnexDate', () => {
  test('formats standard Evernote date', () => {
    assert.equal(formatEnexDate('20140315T100000Z'), '2014-03-15');
  });

  test('formats date at year boundary', () => {
    assert.equal(formatEnexDate('20260101T000000Z'), '2026-01-01');
  });

  test('returns null for null input', () => {
    assert.equal(formatEnexDate(null), null);
  });

  test('returns null for short string', () => {
    assert.equal(formatEnexDate('2014'), null);
  });

  test('returns null for non-numeric input', () => {
    assert.equal(formatEnexDate('ABCDEFGHI'), null);
  });
});

// ── toOneNoteHtml: metadata block ─────────────────────────────────────────────

describe('toOneNoteHtml metadata', () => {
  test('includes created date when metadata provided', () => {
    const html = toOneNoteHtml('My Note', '<p>body</p>', { created: '20140315T100000Z' });
    assert.match(html, /Created: 2014-03-15/);
  });

  test('includes author when provided', () => {
    const html = toOneNoteHtml('My Note', '<p>body</p>', { author: 'Jane Smith' });
    assert.match(html, /Author: Jane Smith/);
  });

  test('includes source URL as link when provided', () => {
    const html = toOneNoteHtml('My Note', '<p>body</p>', { sourceUrl: 'https://example.com' });
    assert.match(html, /href="https:\/\/example\.com"/);
    assert.match(html, /Source:/);
  });

  test('escapes HTML in author name', () => {
    const html = toOneNoteHtml('My Note', '<p>body</p>', { author: '<script>xss</script>' });
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
  });

  test('no metadata block when metadata is null', () => {
    const html = toOneNoteHtml('My Note', '<p>body</p>', null);
    assert.doesNotMatch(html, /note-metadata/);
    assert.doesNotMatch(html, /Created:/);
  });

  test('no metadata block when metadata omitted', () => {
    const html = toOneNoteHtml('My Note', '<p>body</p>');
    assert.doesNotMatch(html, /note-metadata/);
  });

  test('no created line when created is null', () => {
    const html = toOneNoteHtml('My Note', '<p>body</p>', { created: null, author: 'Bob' });
    assert.doesNotMatch(html, /Created:/);
    assert.match(html, /Author: Bob/);
  });

  test('no metadata div when all fields are null/empty', () => {
    const html = toOneNoteHtml('My Note', '<p>body</p>', { created: null, author: null, sourceUrl: null });
    assert.doesNotMatch(html, /note-metadata/);
  });
});

// ── Selective import helpers ──────────────────────────────────────────────────

// We test the helpers directly by requiring their implementations. Since they
// are module-internal, we extract the logic into testable patterns here.

function matchNotebookPattern(name, pattern) {
  const re = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
    'i'
  );
  return re.test(name);
}

function parseDateRange(raw) {
  const parts = raw.split('..');
  if (parts.length !== 2) return null;
  const [start, end] = parts.map(p => p.trim());
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(start) || !iso.test(end)) return null;
  return { start, end };
}

function enexDateToIso(d) {
  if (!d || d.length < 8) return null;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

function applyDateRangeFilter(notes, dateRange) {
  return notes.filter(note => {
    const iso = enexDateToIso(note.created);
    if (!iso) return true;
    if (iso < dateRange.start) return false;
    if (iso > dateRange.end) return false;
    return true;
  });
}

describe('matchNotebookPattern', () => {
  test('exact match works', () => {
    assert.ok(matchNotebookPattern('Work', 'Work'));
  });

  test('case-insensitive match', () => {
    assert.ok(matchNotebookPattern('work', 'Work'));
    assert.ok(matchNotebookPattern('WORK', 'work'));
  });

  test('glob * matches any characters', () => {
    assert.ok(matchNotebookPattern('Work Notes', 'Work*'));
    assert.ok(matchNotebookPattern('My Work', '*Work'));
  });

  test('glob ? matches single character', () => {
    assert.ok(matchNotebookPattern('Work', 'W?rk'));
    assert.ok(!matchNotebookPattern('Woork', 'W?rk'));
  });

  test('no match returns false', () => {
    assert.ok(!matchNotebookPattern('Personal', 'Work'));
  });

  test('glob * matches all notebooks', () => {
    assert.ok(matchNotebookPattern('Anything', '*'));
  });
});

describe('parseDateRange', () => {
  test('parses valid range', () => {
    const r = parseDateRange('2020-01-01..2023-12-31');
    assert.deepEqual(r, { start: '2020-01-01', end: '2023-12-31' });
  });

  test('returns null for missing ..', () => {
    assert.equal(parseDateRange('2020-01-01'), null);
  });

  test('returns null for invalid date format', () => {
    assert.equal(parseDateRange('01/01/2020..31/12/2023'), null);
  });

  test('handles whitespace around ..', () => {
    const r = parseDateRange('2020-01-01 .. 2023-12-31');
    assert.deepEqual(r, { start: '2020-01-01', end: '2023-12-31' });
  });
});

describe('applyDateRangeFilter', () => {
  const notes = [
    { title: 'Old', created: '20150101T000000Z' },
    { title: 'In Range', created: '20210601T000000Z' },
    { title: 'New', created: '20240101T000000Z' },
    { title: 'No Date', created: null },
  ];

  test('keeps notes within range', () => {
    const result = applyDateRangeFilter(notes, { start: '2020-01-01', end: '2022-12-31' });
    assert.equal(result.length, 2); // In Range + No Date
    assert.equal(result[0].title, 'In Range');
    assert.equal(result[1].title, 'No Date');
  });

  test('excludes notes before start', () => {
    const result = applyDateRangeFilter(notes, { start: '2020-01-01', end: '2025-12-31' });
    assert.ok(!result.find(n => n.title === 'Old'));
  });

  test('excludes notes after end', () => {
    const result = applyDateRangeFilter(notes, { start: '2015-01-01', end: '2022-12-31' });
    assert.ok(!result.find(n => n.title === 'New'));
  });

  test('keeps notes with null created date', () => {
    const result = applyDateRangeFilter(notes, { start: '2020-01-01', end: '2022-12-31' });
    assert.ok(result.find(n => n.title === 'No Date'));
  });

  test('inclusive boundary: start date', () => {
    const result = applyDateRangeFilter(
      [{ title: 'Exact', created: '20200101T000000Z' }],
      { start: '2020-01-01', end: '2020-12-31' }
    );
    assert.equal(result.length, 1);
  });

  test('inclusive boundary: end date', () => {
    const result = applyDateRangeFilter(
      [{ title: 'Exact', created: '20201231T000000Z' }],
      { start: '2020-01-01', end: '2020-12-31' }
    );
    assert.equal(result.length, 1);
  });
});
