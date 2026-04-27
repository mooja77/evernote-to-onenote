'use strict';
/**
 * Additional edge-case tests for metadata, filtering helpers, and notebook
 * pattern matching.  The basics are already covered in metadata-filter.test.js;
 * this file targets Unicode, special characters, boundary conditions, and
 * comma-separated notebook patterns.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { toOneNoteHtml, formatEnexDate } = require('../src/enml-converter');
const {
  matchNotebookPattern,
  parseDateRange,
  enexDateToIso,
  applyDateRangeFilter,
  sanitizeName,
} = require('../src/index');

// ── toOneNoteHtml: Unicode and edge cases ─────────────────────────────────────

describe('toOneNoteHtml — Unicode metadata', () => {
  test('handles Unicode author name (Japanese)', () => {
    const html = toOneNoteHtml('Note', '<p>body</p>', { author: '田中 太郎' });
    assert.match(html, /田中 太郎/);
  });

  test('handles Unicode author name (emoji)', () => {
    const html = toOneNoteHtml('Note', '<p>body</p>', { author: 'Jane 🎉' });
    assert.match(html, /Jane/);
  });

  test('handles Unicode note title', () => {
    const html = toOneNoteHtml('メモ: 重要', '<p>body</p>');
    assert.match(html, /メモ: 重要/);
  });

  test('escapes source URL containing HTML-special chars', () => {
    const url = 'https://example.com/search?q=a&b=c&lt=1';
    const html = toOneNoteHtml('Note', '<p>body</p>', { sourceUrl: url });
    // The URL in href must be escaped so & → &amp;
    assert.doesNotMatch(html, /href="[^"]*[^&]&[^a][^m]/);
    assert.match(html, /&amp;/);
  });

  test('very long author name renders without truncation', () => {
    const longAuthor = 'A'.repeat(500);
    const html = toOneNoteHtml('Note', '<p>body</p>', { author: longAuthor });
    assert.match(html, new RegExp('A'.repeat(100)));
  });

  test('all metadata fields present together', () => {
    const html = toOneNoteHtml('Full Note', '<p>body</p>', {
      created: '20230715T120000Z',
      author: 'Alice',
      sourceUrl: 'https://example.com',
    });
    assert.match(html, /2023-07-15/);
    assert.match(html, /Alice/);
    assert.match(html, /example\.com/);
  });
});

// ── formatEnexDate: additional edge cases ─────────────────────────────────────

describe('formatEnexDate — edge cases', () => {
  test('handles leap day', () => {
    assert.equal(formatEnexDate('20240229T000000Z'), '2024-02-29');
  });

  test('handles year 2000', () => {
    assert.equal(formatEnexDate('20000101T000000Z'), '2000-01-01');
  });

  test('handles date without time component (8 chars)', () => {
    assert.equal(formatEnexDate('20231231'), '2023-12-31');
  });

  test('returns null for empty string', () => {
    assert.equal(formatEnexDate(''), null);
  });
});

// ── enexDateToIso: edge cases ──────────────────────────────────────────────────

describe('enexDateToIso', () => {
  test('converts standard ENEX date', () => {
    assert.equal(enexDateToIso('20230601T120000Z'), '2023-06-01');
  });

  test('returns null for null', () => {
    assert.equal(enexDateToIso(null), null);
  });

  test('returns null for string shorter than 8 chars', () => {
    assert.equal(enexDateToIso('2023'), null);
    assert.equal(enexDateToIso(''), null);
  });

  test('only uses first 8 chars (ignores time component)', () => {
    assert.equal(enexDateToIso('20231225T000000Z'), '2023-12-25');
  });
});

// ── parseDateRange: additional edge cases ─────────────────────────────────────

describe('parseDateRange — edge cases', () => {
  test('single-day range (start equals end) is valid', () => {
    const r = parseDateRange('2023-06-15..2023-06-15');
    assert.deepEqual(r, { start: '2023-06-15', end: '2023-06-15' });
  });

  test('returns null for three-part split', () => {
    assert.equal(parseDateRange('2020-01-01..2021-01-01..2022-01-01'), null);
  });

  test('returns null for non-ISO month format', () => {
    assert.equal(parseDateRange('Jan-2020..Dec-2020'), null);
  });

  test('returns null for empty string', () => {
    assert.equal(parseDateRange(''), null);
  });

  test('returns null when year has only 2 digits', () => {
    assert.equal(parseDateRange('20-01-01..23-12-31'), null);
  });

  test('accepts a range spanning many years', () => {
    const r = parseDateRange('2000-01-01..2099-12-31');
    assert.equal(r.start, '2000-01-01');
    assert.equal(r.end, '2099-12-31');
  });
});

// ── applyDateRangeFilter: edge cases ──────────────────────────────────────────

describe('applyDateRangeFilter — edge cases', () => {
  test('returns empty array when input is empty', () => {
    const result = applyDateRangeFilter([], { start: '2020-01-01', end: '2023-12-31' });
    assert.deepEqual(result, []);
  });

  test('keeps all notes when all are in range', () => {
    const notes = [
      { title: 'A', created: '20210101T000000Z' },
      { title: 'B', created: '20220601T000000Z' },
    ];
    const result = applyDateRangeFilter(notes, { start: '2020-01-01', end: '2023-12-31' });
    assert.equal(result.length, 2);
  });

  test('filters all notes when none match range', () => {
    const notes = [
      { title: 'A', created: '20100101T000000Z' },
      { title: 'B', created: '20110101T000000Z' },
    ];
    const result = applyDateRangeFilter(notes, { start: '2020-01-01', end: '2023-12-31' });
    assert.equal(result.length, 0);
  });

  test('note with created on exact start boundary is included', () => {
    const result = applyDateRangeFilter(
      [{ title: 'Start', created: '20200101T000000Z' }],
      { start: '2020-01-01', end: '2020-12-31' }
    );
    assert.equal(result.length, 1);
  });

  test('note with created on exact end boundary is included', () => {
    const result = applyDateRangeFilter(
      [{ title: 'End', created: '20201231T235959Z' }],
      { start: '2020-01-01', end: '2020-12-31' }
    );
    assert.equal(result.length, 1);
  });
});

// ── matchNotebookPattern: comma-separated CLI patterns ────────────────────────

describe('matchNotebookPattern — additional patterns', () => {
  test('Unicode notebook name matches exact pattern', () => {
    assert.ok(matchNotebookPattern('仕事', '仕事'));
  });

  test('pattern with special regex chars is treated literally', () => {
    // Dots in pattern should not act as regex wildcards
    assert.ok(!matchNotebookPattern('WorkXNotes', 'Work.Notes'));
    assert.ok(matchNotebookPattern('Work.Notes', 'Work.Notes'));
  });

  test('* at both ends matches substring', () => {
    assert.ok(matchNotebookPattern('My Work Notes', '*Work*'));
  });

  test('? matches exactly one character', () => {
    assert.ok(matchNotebookPattern('Work', 'W?rk'));
    assert.ok(!matchNotebookPattern('Wrk', 'W?rk'));
    assert.ok(!matchNotebookPattern('Wxxrk', 'W?rk'));
  });

  test('empty pattern does not match non-empty name', () => {
    assert.ok(!matchNotebookPattern('Work', ''));
  });

  test('empty name does not match non-empty pattern', () => {
    assert.ok(!matchNotebookPattern('', 'Work'));
  });

  test('empty name matches empty pattern', () => {
    assert.ok(matchNotebookPattern('', ''));
  });

  test('pattern with + is treated literally (not regex quantifier)', () => {
    assert.ok(matchNotebookPattern('Work+Notes', 'Work+Notes'));
    assert.ok(!matchNotebookPattern('WorkNotes', 'Work+Notes'));
  });
});

// ── sanitizeName: edge cases ──────────────────────────────────────────────────

describe('sanitizeName', () => {
  test('returns "Untitled" for empty string', () => {
    assert.equal(sanitizeName(''), 'Untitled');
  });

  test('returns "Untitled" for whitespace-only string', () => {
    assert.equal(sanitizeName('   '), 'Untitled');
  });

  test('strips null bytes and control characters', () => {
    const result = sanitizeName('Note\x00Name\x1f');
    assert.ok(!result.includes('\x00'));
    assert.ok(!result.includes('\x1f'));
  });

  test('replaces filesystem-unsafe chars with hyphens', () => {
    const result = sanitizeName('Note: Work/Project*Test');
    assert.ok(!result.includes(':'));
    assert.ok(!result.includes('/'));
    assert.ok(!result.includes('*'));
  });

  test('removes single quotes (not replaced with hyphen)', () => {
    const result = sanitizeName("O'Brien's Notes");
    assert.ok(!result.includes("'"));
    assert.match(result, /OBriens/);
  });

  test('preserves Unicode characters', () => {
    const result = sanitizeName('メモ帳');
    assert.equal(result, 'メモ帳');
  });

  test('trims leading and trailing whitespace', () => {
    const result = sanitizeName('  My Notes  ');
    assert.equal(result, 'My Notes');
  });
});
