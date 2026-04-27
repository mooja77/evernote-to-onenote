'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { enmlToHtml, toOneNoteHtml, enmlToHtmlWithResources } = require('../src/enml-converter');

describe('enmlToHtml', () => {
  // ── Happy path ────────────────────────────────────────────────────────────

  test('unwraps en-note into a div.note-body', () => {
    const enml = '<en-note><p>Hello</p></en-note>';
    const html = enmlToHtml(enml);
    assert.match(html, /<div class="note-body">/);
    assert.match(html, /<\/div>/);
    assert.doesNotMatch(html, /<en-note/);
  });

  test('strips XML declaration', () => {
    const enml = '<?xml version="1.0" encoding="UTF-8"?><en-note><p>Hi</p></en-note>';
    const html = enmlToHtml(enml);
    assert.doesNotMatch(html, /<\?xml/);
  });

  test('strips DOCTYPE declaration', () => {
    const enml = '<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note><p>Hi</p></en-note>';
    const html = enmlToHtml(enml);
    assert.doesNotMatch(html, /<!DOCTYPE/);
  });

  test('converts unchecked en-todo to ☐ span', () => {
    const enml = '<en-note><en-todo/>Task</en-note>';
    const html = enmlToHtml(enml);
    assert.match(html, /☐/);
    assert.doesNotMatch(html, /<en-todo/);
  });

  test('converts checked en-todo to ✅ span', () => {
    const enml = '<en-note><en-todo checked="true"/>Done</en-note>';
    const html = enmlToHtml(enml);
    assert.match(html, /✅/);
    assert.doesNotMatch(html, /<en-todo/);
  });

  test('replaces en-media with [attachment] placeholder', () => {
    const enml = '<en-note><en-media type="image/png" hash="abc123"/></en-note>';
    const html = enmlToHtml(enml);
    assert.match(html, /\[attachment\]/);
    assert.doesNotMatch(html, /<en-media/);
  });

  test('replaces en-crypt with [encrypted content] placeholder', () => {
    const enml = '<en-note><en-crypt cipher="RC2">ENCRYPTEDDATA</en-crypt></en-note>';
    const html = enmlToHtml(enml);
    assert.match(html, /\[encrypted content\]/);
    assert.doesNotMatch(html, /<en-crypt/);
  });

  test('preserves standard HTML tags (p, ul, li, h2, b, i)', () => {
    const enml = '<en-note><h2>Title</h2><p>Text <b>bold</b> and <i>italic</i></p><ul><li>item</li></ul></en-note>';
    const html = enmlToHtml(enml);
    assert.match(html, /<h2>/);
    assert.match(html, /<b>/);
    assert.match(html, /<i>/);
    assert.match(html, /<ul>/);
    assert.match(html, /<li>/);
  });

  test('preserves anchor tags', () => {
    const enml = '<en-note><a href="https://example.com">link</a></en-note>';
    const html = enmlToHtml(enml);
    assert.match(html, /<a /);
    assert.match(html, /example\.com/);
  });

  // ── Edge / boundary cases ─────────────────────────────────────────────────

  test('returns <p></p> for null input', () => {
    assert.equal(enmlToHtml(null), '<p></p>');
  });

  test('returns <p></p> for empty string input', () => {
    assert.equal(enmlToHtml(''), '<p></p>');
  });

  test('returns <p></p> for whitespace-only input', () => {
    assert.equal(enmlToHtml('   '), '<p></p>');
  });

  test('handles en-note with attributes', () => {
    const enml = '<en-note style="font-size:14px"><p>styled</p></en-note>';
    const html = enmlToHtml(enml);
    assert.match(html, /<div class="note-body">/);
    assert.doesNotMatch(html, /<en-note/);
  });

  test('handles multiple todos in one note', () => {
    const enml = '<en-note><en-todo/>A<en-todo checked="true"/>B<en-todo/>C</en-note>';
    const html = enmlToHtml(enml);
    const unchecked = (html.match(/☐/g) || []).length;
    const checked = (html.match(/✅/g) || []).length;
    assert.equal(unchecked, 2);
    assert.equal(checked, 1);
  });

  test('handles multiple en-media tags', () => {
    const enml = '<en-note><en-media type="image/png" hash="a"/><en-media type="application/pdf" hash="b"/></en-note>';
    const html = enmlToHtml(enml);
    const placeholders = (html.match(/\[attachment\]/g) || []).length;
    assert.equal(placeholders, 2);
  });

  test('full ENML from test fixture converts without errors', () => {
    const enml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">
<en-note>
  <p>Here are some project ideas for Q1:</p>
  <ul>
    <li><en-todo/>Launch the new dashboard</li>
    <li><en-todo checked="true"/>Research competitor pricing</li>
  </ul>
</en-note>`;
    const html = enmlToHtml(enml);
    assert.match(html, /project ideas/);
    assert.match(html, /☐/);
    assert.match(html, /✅/);
  });
});

describe('toOneNoteHtml', () => {
  test('produces valid HTML structure', () => {
    const html = toOneNoteHtml('My Note', '<p>body</p>');
    assert.match(html, /<!DOCTYPE html>/);
    assert.match(html, /<html>/);
    assert.match(html, /<\/html>/);
    assert.match(html, /<head>/);
    assert.match(html, /<body>/);
  });

  test('includes the title in <title> and <h1>', () => {
    const html = toOneNoteHtml('Test Title', '<p>content</p>');
    assert.match(html, /<title>Test Title<\/title>/);
    assert.match(html, /<h1>Test Title<\/h1>/);
  });

  test('includes the body HTML', () => {
    const html = toOneNoteHtml('Note', '<p>Hello world</p>');
    assert.match(html, /<p>Hello world<\/p>/);
  });

  test('escapes HTML special chars in title', () => {
    const html = toOneNoteHtml('<script>alert("xss")</script>', '<p>safe</p>');
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&quot;/);
  });

  test('sets charset meta tag', () => {
    const html = toOneNoteHtml('T', '<p>x</p>');
    assert.match(html, /charset="utf-8"/i);
  });

  test('handles empty title gracefully', () => {
    const html = toOneNoteHtml('', '<p>content</p>');
    assert.match(html, /<title><\/title>/);
    assert.match(html, /<h1><\/h1>/);
  });

  test('handles empty body gracefully', () => {
    const html = toOneNoteHtml('Title', '');
    assert.match(html, /Title/);
  });

  // ── Regression: special chars ─────────────────────────────────────────────

  test('escapes ampersand in title', () => {
    const html = toOneNoteHtml('Cats & Dogs', '<p>pets</p>');
    assert.match(html, /Cats &amp; Dogs/);
  });

  test('escapes angle brackets in title', () => {
    const html = toOneNoteHtml('A > B < C', '<p>math</p>');
    assert.match(html, /A &gt; B &lt; C/);
  });
});

describe('enmlToHtmlWithResources', () => {
  function makeImageResource(hash = 'aabbcc', data = Buffer.from('fake-png')) {
    return { hash, mime: 'image/png', filename: 'photo.png', data };
  }
  function makePdfResource(hash = 'ddeeff', data = Buffer.from('fake-pdf')) {
    return { hash, mime: 'application/pdf', filename: 'doc.pdf', data };
  }

  // ── Happy path ────────────────────────────────────────────────────────────

  test('image resource produces <img src="name:part1" />', () => {
    const enml = '<en-note><en-media type="image/png" hash="aabbcc"/></en-note>';
    const { html, usedResources } = enmlToHtmlWithResources(enml, [makeImageResource('aabbcc')]);
    assert.match(html, /<img src="name:part1" \/>/);
    assert.equal(usedResources.length, 1);
    assert.equal(usedResources[0].partName, 'part1');
    assert.equal(usedResources[0].contentType, 'image/png');
  });

  test('non-image resource produces <object> element', () => {
    const enml = '<en-note><en-media type="application/pdf" hash="ddeeff"/></en-note>';
    const { html, usedResources } = enmlToHtmlWithResources(enml, [makePdfResource('ddeeff')]);
    assert.match(html, /<object data="name:part1"/);
    assert.match(html, /data-attachment="doc\.pdf"/);
    assert.match(html, /type="application\/pdf"/);
    assert.equal(usedResources.length, 1);
  });

  test('missing resource hash falls back to [attachment]', () => {
    const enml = '<en-note><en-media type="image/png" hash="unknown-hash"/></en-note>';
    const { html, usedResources } = enmlToHtmlWithResources(enml, [makeImageResource('aabbcc')]);
    assert.match(html, /\[attachment\]/);
    assert.equal(usedResources.length, 0);
  });

  test('missing hash attribute on en-media falls back to [attachment]', () => {
    const enml = '<en-note><en-media type="image/png"/></en-note>';
    const { html, usedResources } = enmlToHtmlWithResources(enml, [makeImageResource('aabbcc')]);
    assert.match(html, /\[attachment\]/);
    assert.equal(usedResources.length, 0);
  });

  test('mixed resources: image gets <img>, pdf gets <object>', () => {
    const enml = [
      '<en-note>',
      '<en-media type="image/png" hash="aabbcc"/>',
      '<en-media type="application/pdf" hash="ddeeff"/>',
      '</en-note>',
    ].join('');
    const { html, usedResources } = enmlToHtmlWithResources(enml, [
      makeImageResource('aabbcc'),
      makePdfResource('ddeeff'),
    ]);
    assert.match(html, /<img src="name:part1" \/>/);
    assert.match(html, /<object data="name:part2"/);
    assert.equal(usedResources.length, 2);
    assert.equal(usedResources[0].partName, 'part1');
    assert.equal(usedResources[1].partName, 'part2');
  });

  test('empty resources list produces [attachment] for each en-media', () => {
    const enml = '<en-note><en-media type="image/png" hash="abc"/></en-note>';
    const { html, usedResources } = enmlToHtmlWithResources(enml, []);
    assert.match(html, /\[attachment\]/);
    assert.equal(usedResources.length, 0);
  });

  test('hash matching is case-insensitive', () => {
    const enml = '<en-note><en-media type="image/png" hash="AABBCC"/></en-note>';
    const { html } = enmlToHtmlWithResources(enml, [makeImageResource('aabbcc')]);
    assert.match(html, /<img src="name:part1" \/>/);
  });

  test('returns { html, usedResources } shape', () => {
    const { html, usedResources } = enmlToHtmlWithResources(null);
    assert.equal(html, '<p></p>');
    assert.deepEqual(usedResources, []);
  });

  test('partN counter increments per matched resource', () => {
    const enml = [
      '<en-note>',
      '<en-media type="image/jpeg" hash="aa0001"/>',
      '<en-media type="image/gif" hash="bb0002"/>',
      '<en-media type="image/png" hash="cc0003"/>',
      '</en-note>',
    ].join('');
    const resources = [
      { hash: 'aa0001', mime: 'image/jpeg', filename: 'a.jpg', data: Buffer.from('a') },
      { hash: 'bb0002', mime: 'image/gif', filename: 'b.gif', data: Buffer.from('b') },
      { hash: 'cc0003', mime: 'image/png', filename: 'c.png', data: Buffer.from('c') },
    ];
    const { usedResources } = enmlToHtmlWithResources(enml, resources);
    assert.equal(usedResources[0].partName, 'part1');
    assert.equal(usedResources[1].partName, 'part2');
    assert.equal(usedResources[2].partName, 'part3');
  });

  test('en-crypt is still replaced in resource mode', () => {
    const enml = '<en-note><en-crypt>ENCDATA</en-crypt></en-note>';
    const { html } = enmlToHtmlWithResources(enml, []);
    assert.match(html, /\[encrypted content\]/);
    assert.doesNotMatch(html, /<en-crypt/);
  });

  test('object filename is HTML-escaped', () => {
    const r = { hash: 'aabb11', mime: 'application/pdf', filename: '<evil>"name"</evil>', data: Buffer.from('x') };
    const enml = '<en-note><en-media type="application/pdf" hash="aabb11"/></en-note>';
    const { html } = enmlToHtmlWithResources(enml, [r]);
    assert.doesNotMatch(html, /<evil>/);
    assert.match(html, /&lt;evil&gt;/);
  });

  test('usedResources contains correct Buffer data', () => {
    const imgBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header
    const r = { hash: 'cafebabe', mime: 'image/png', filename: 'img.png', data: imgBuf };
    const enml = '<en-note><en-media type="image/png" hash="cafebabe"/></en-note>';
    const { usedResources } = enmlToHtmlWithResources(enml, [r]);
    assert.equal(usedResources[0].data, imgBuf);
  });
});
