'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..', '..');

test('desktop exposes no more than five beginner steps and searchable help', () => {
  const html = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/index.html'), 'utf8');
  assert.strictEqual((html.match(/class="step" data-step=/g) || []).length, 5);
  assert.match(html, /id="help-search"/);
  assert.match(html, /CLI fast path/);
  assert.match(html, /Get safe example/);
});

test('safe example and matching caption track are present', () => {
  const example = fs.readFileSync(path.join(ROOT, 'examples/safe-example.enex'), 'utf8');
  const captions = fs.readFileSync(path.join(ROOT, 'docs/assets/evernote-onenote-walkthrough.vtt'), 'utf8');
  assert.match(example, /synthetic example data/i);
  assert.match(captions, /^WEBVTT/);
});

test('destination is spelled out (account, file, notebook, section) before Start import', () => {
  const html = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/app.js'), 'utf8');
  assert.match(html, /id="dest-summary"/);
  assert.match(js, /function updateDestination\(/);
  assert.match(js, /state\.sectionLabel/);
  assert.match(js, /'dest-summary'/);
});
