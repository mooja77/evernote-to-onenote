'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { parseEnexFile } = require('../src/enex-parser');

const fix = (name) => path.join(__dirname, 'fixtures', name);

describe('parseEnexFile', () => {
  // ── Happy path ────────────────────────────────────────────────────────────

  test('parses a single note correctly', async () => {
    const notes = await parseEnexFile(fix('single-note.enex'));
    assert.equal(notes.length, 1);
    const note = notes[0];
    assert.equal(note.title, 'Single Note');
    assert.equal(note.created, '20260101T090000Z');
    assert.equal(note.updated, '20260110T143000Z');
    assert.deepEqual(note.tags, ['test']);
    assert.match(note.content, /Hello, world!/);
  });

  test('parses multiple notes from one export', async () => {
    const notes = await parseEnexFile(fix('multi-note.enex'));
    assert.equal(notes.length, 3);
    assert.equal(notes[0].title, 'Note One');
    assert.equal(notes[1].title, 'Note Two');
    assert.equal(notes[2].title, 'Note Three');
  });

  test('returns multiple tags as an array', async () => {
    const notes = await parseEnexFile(fix('multi-note.enex'));
    assert.deepEqual(notes[0].tags, ['alpha', 'beta']);
  });

  test('returns empty tags array when note has no tags', async () => {
    const notes = await parseEnexFile(fix('multi-note.enex'));
    assert.deepEqual(notes[1].tags, []);
  });

  test('parses mixed-notes fixture (3 notes)', async () => {
    const notes = await parseEnexFile(fix('mixed-notes.enex'));
    assert.equal(notes.length, 3);
    assert.equal(notes[0].title, 'Project Ideas');
    assert.equal(notes[1].title, 'Meeting Notes — 2026-01-15');
    assert.equal(notes[2].title, 'Recipe: Chocolate Cake');
  });

  test('returns content as ENML string', async () => {
    const notes = await parseEnexFile(fix('single-note.enex'));
    assert.match(notes[0].content, /en-note/);
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  test('returns empty array when export has no notes', async () => {
    const notes = await parseEnexFile(fix('empty-export.enex'));
    assert.equal(notes.length, 0);
  });

  test('returns null for missing created/updated fields', async () => {
    const notes = await parseEnexFile(fix('minimal-note.enex'));
    assert.equal(notes.length, 1);
    // created/updated are missing in fixture → should be null or empty
    assert.ok(notes[0].created === null || notes[0].created === '');
    assert.ok(notes[0].updated === null || notes[0].updated === '');
  });

  test('returns empty resources array when note has no attachments', async () => {
    const notes = await parseEnexFile(fix('single-note.enex'));
    assert.deepEqual(notes[0].resources, []);
  });

  test('parses resource mime type and filename', async () => {
    const notes = await parseEnexFile(fix('with-resources.enex'));
    assert.equal(notes[0].resources.length, 1);
    assert.equal(notes[0].resources[0].mime, 'image/png');
    assert.equal(notes[0].resources[0].fileName, 'photo.png');
  });

  test('resource data field is present', async () => {
    const notes = await parseEnexFile(fix('with-resources.enex'));
    assert.ok(notes[0].resources[0].data.length > 0);
  });

  // ── Error cases ───────────────────────────────────────────────────────────

  test('throws on non-existent file', async () => {
    await assert.rejects(
      () => parseEnexFile(fix('does-not-exist.enex')),
      /ENOENT/
    );
  });

  test('throws on invalid XML', async () => {
    const fs = require('fs');
    const os = require('os');
    const tmp = path.join(os.tmpdir(), 'bad.enex');
    fs.writeFileSync(tmp, '<<< not valid xml >>>');
    await assert.rejects(() => parseEnexFile(tmp));
    fs.unlinkSync(tmp);
  });
});
