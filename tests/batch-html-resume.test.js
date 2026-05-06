'use strict';
/**
 * Tests for batch mode, --output-html, and --resume / progress tracking.
 *
 * All CLI tests run `node src/index.js` as a subprocess so the
 * full parse → convert → dry-run pipeline is exercised end-to-end.
 * Temp directories are created per test (or describe block) and cleaned up
 * in after() hooks to ensure isolation.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CLI = path.join(__dirname, '..', 'src', 'index.js');
const fix = (name) => path.join(__dirname, 'fixtures', name);

function run(args, opts = {}) {
  const { env = {}, cwd } = opts;
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ONENOTE_ACCESS_TOKEN: '', MSAL_NO_INTERACTIVE: '1', ...env },
    timeout: 15000,
    cwd,
  });
}

function makeTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `enex-${label}-`));
}

/** Recursively collect all .html files under dir */
function findHtmlFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findHtmlFiles(full));
    } else if (entry.name.endsWith('.html')) {
      results.push(full);
    }
  }
  return results;
}

// ── Batch mode ───────────────────────────────────────────────────────────────

describe('CLI — batch mode', () => {
  let batchDir;

  before(() => {
    batchDir = makeTempDir('batch');
    fs.copyFileSync(fix('single-note.enex'), path.join(batchDir, 'single-note.enex'));
    fs.copyFileSync(fix('multi-note.enex'), path.join(batchDir, 'multi-note.enex'));
  });

  after(() => {
    fs.rmSync(batchDir, { recursive: true, force: true });
  });

  test('processes all .enex files in a directory', () => {
    const cwdDir = makeTempDir('batch-base');
    try {
      const { status, stdout } = run(['--batch', batchDir, '--dry-run'], { cwd: cwdDir });
      assert.equal(status, 0);
      assert.match(stdout, /Files:\s+2/);
      assert.match(stdout, /single-note\.enex/);
      assert.match(stdout, /multi-note\.enex/);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('reports total note count across all files', () => {
    // single-note.enex: 1 note, multi-note.enex: 3 notes → Imported: 4
    const cwdDir = makeTempDir('batch-count');
    try {
      const { status, stdout } = run(['--batch', batchDir, '--dry-run'], { cwd: cwdDir });
      assert.equal(status, 0);
      assert.match(stdout, /Imported: 4/);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('prints per-file progress label (Importing file N/M)', () => {
    const cwdDir = makeTempDir('batch-label');
    try {
      const { status, stdout } = run(['--batch', batchDir, '--dry-run'], { cwd: cwdDir });
      assert.equal(status, 0);
      assert.match(stdout, /Importing file \d+\/\d+:/);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('reports note count per individual file', () => {
    const cwdDir = makeTempDir('batch-per-file');
    try {
      const { status, stdout } = run(['--batch', batchDir, '--dry-run'], { cwd: cwdDir });
      assert.equal(status, 0);
      assert.match(stdout, /1 note\(s\) found/);
      assert.match(stdout, /3 note\(s\) found/);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('does not require ONENOTE_ACCESS_TOKEN in --dry-run mode', () => {
    const cwdDir = makeTempDir('batch-notoken');
    try {
      const { status } = run(['--batch', batchDir, '--dry-run'], { cwd: cwdDir });
      assert.equal(status, 0);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('exits 1 when --batch directory does not exist', () => {
    const { status, stderr } = run(['--batch', '/nonexistent-enex-batch-dir-xyz', '--dry-run']);
    assert.equal(status, 1);
    assert.match(stderr, /not found|Error/i);
  });

  test('exits 1 when --batch directory contains no .enex files', () => {
    const emptyDir = makeTempDir('empty');
    try {
      const { status, stderr } = run(['--batch', emptyDir, '--dry-run']);
      assert.equal(status, 1);
      assert.match(stderr, /No \.enex files found/i);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  test('ignores non-.enex files in the batch directory', () => {
    const mixedDir = makeTempDir('mixed');
    const cwdDir = makeTempDir('batch-mixed-cwd');
    try {
      fs.copyFileSync(fix('single-note.enex'), path.join(mixedDir, 'notes.enex'));
      fs.writeFileSync(path.join(mixedDir, 'readme.txt'), 'ignore me');
      fs.writeFileSync(path.join(mixedDir, 'notes.json'), '{}');
      const { status, stdout } = run(['--batch', mixedDir, '--dry-run'], { cwd: cwdDir });
      assert.equal(status, 0);
      // Only the .enex file should be imported (1 note)
      assert.match(stdout, /Files:\s+1/);
    } finally {
      fs.rmSync(mixedDir, { recursive: true, force: true });
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('batch mode creates per-file notebooks named after each .enex file', () => {
    const cwdDir = makeTempDir('batch-notebooks');
    try {
      const { status, stdout } = run(['--batch', batchDir, '--dry-run'], { cwd: cwdDir });
      assert.equal(status, 0);
      assert.match(stdout, /notebook "multi-note"/i);
      assert.match(stdout, /notebook "single-note"/i);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });
});

// ── HTML output ──────────────────────────────────────────────────────────────

describe('CLI — --output-html mode', () => {
  test('creates one HTML file for a single-note export', () => {
    const outDir = makeTempDir('html1');
    try {
      const { status } = run([fix('single-note.enex'), '--output-html', outDir]);
      assert.equal(status, 0);
      const files = findHtmlFiles(outDir);
      assert.equal(files.length, 1);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('creates one HTML file per note for a multi-note export', () => {
    const outDir = makeTempDir('html-multi');
    try {
      const { status } = run([fix('multi-note.enex'), '--output-html', outDir]);
      assert.equal(status, 0);
      const files = findHtmlFiles(outDir);
      assert.equal(files.length, 3);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('HTML file contains the note title', () => {
    const outDir = makeTempDir('html-title');
    try {
      run([fix('single-note.enex'), '--output-html', outDir]);
      const files = findHtmlFiles(outDir);
      assert.ok(files.length > 0, 'expected at least one HTML file');
      const content = fs.readFileSync(files[0], 'utf8');
      assert.match(content, /Single Note/);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('HTML file contains the note body text', () => {
    const outDir = makeTempDir('html-body');
    try {
      run([fix('single-note.enex'), '--output-html', outDir]);
      const files = findHtmlFiles(outDir);
      assert.ok(files.length > 0, 'expected at least one HTML file');
      const content = fs.readFileSync(files[0], 'utf8');
      assert.match(content, /Hello, world!/);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('creates the output directory when it does not exist', () => {
    const outDir = path.join(os.tmpdir(), `enex-newdir-${Date.now()}`);
    try {
      assert.ok(!fs.existsSync(outDir), 'precondition: dir should not exist');
      const { status } = run([fix('single-note.enex'), '--output-html', outDir]);
      assert.equal(status, 0);
      assert.ok(fs.existsSync(outDir));
    } finally {
      if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('does not require ONENOTE_ACCESS_TOKEN', () => {
    const outDir = makeTempDir('html-notoken');
    try {
      const { status, stderr } = run([fix('single-note.enex'), '--output-html', outDir]);
      assert.equal(status, 0);
      assert.doesNotMatch(stderr, /ONENOTE_ACCESS_TOKEN/);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('stdout reports "Saved:" path for each note', () => {
    const outDir = makeTempDir('html-saved');
    try {
      const { status, stdout } = run([fix('single-note.enex'), '--output-html', outDir]);
      assert.equal(status, 0);
      assert.match(stdout, /Saved:/);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('mode line shows HTML output destination', () => {
    const outDir = makeTempDir('html-mode');
    try {
      const { status, stdout } = run([fix('single-note.enex'), '--output-html', outDir]);
      assert.equal(status, 0);
      assert.match(stdout, /HTML output/i);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('output filenames contain no path-unsafe characters', () => {
    const outDir = makeTempDir('html-safe');
    try {
      run([fix('multi-note.enex'), '--output-html', outDir]);
      const files = findHtmlFiles(outDir);
      for (const f of files) {
        assert.doesNotMatch(path.basename(f), /[/\\?%*:|"<>]/);
      }
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('--output-html combined with --batch exports all notes', () => {
    const batchDir = makeTempDir('html-batch-in');
    const outDir = makeTempDir('html-batch-out');
    try {
      fs.copyFileSync(fix('single-note.enex'), path.join(batchDir, 'a.enex'));
      fs.copyFileSync(fix('minimal-note.enex'), path.join(batchDir, 'b.enex'));
      const { status } = run(['--batch', batchDir, '--output-html', outDir]);
      assert.equal(status, 0);
      // a.enex has 1 note, b.enex has 1 note → 2 HTML files
      const files = findHtmlFiles(outDir);
      assert.equal(files.length, 2);
    } finally {
      fs.rmSync(batchDir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('note count in summary matches actual HTML files created', () => {
    const outDir = makeTempDir('html-count');
    try {
      const { stdout } = run([fix('multi-note.enex'), '--output-html', outDir]);
      const files = findHtmlFiles(outDir);
      assert.equal(files.length, 3);
      assert.match(stdout, /Imported: 3/);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  // v1.4.2 regression — `--output-html` must resolve `name:partN` multipart-form
  // refs to relative file paths and write each resource to a sibling assets
  // folder. v1.4.0/1.4.1 emitted the OneNote-API multipart placeholders into
  // static HTML, leaving images broken in any browser/note app. Real test
  // against `tests/fixtures/with-resources.enex` (one note, one inline image).
  test('writes resources to <name>.assets/ and rewrites src/data refs', () => {
    const outDir = makeTempDir('html-resources');
    try {
      const { status } = run([fix('with-resources.enex'), '--output-html', outDir]);
      assert.equal(status, 0);
      const files = findHtmlFiles(outDir);
      assert.ok(files.length > 0, 'expected at least one HTML file');
      const content = fs.readFileSync(files[0], 'utf8');
      // No leftover multipart-form refs.
      assert.doesNotMatch(content, /\bsrc=["']name:/);
      assert.doesNotMatch(content, /\bdata=["']name:/);
      // Should reference an .assets/<part>.<ext> file via relative path.
      assert.match(content, /\.assets\/part\d+\.[a-z0-9]+/i);
      // The .assets folder must exist alongside the HTML file with a real file.
      const noteDir = path.dirname(files[0]);
      const assetsDirs = fs.readdirSync(noteDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name.endsWith('.assets'))
        .map(d => path.join(noteDir, d.name));
      assert.ok(assetsDirs.length > 0, 'expected at least one .assets folder');
      const assetFiles = fs.readdirSync(assetsDirs[0]);
      assert.ok(assetFiles.length > 0, 'expected at least one resource file in .assets');
      // The asset file should have a real extension (not .bin) for known mime types.
      assert.match(assetFiles[0], /^part\d+\.[a-z0-9]+$/i);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});

// ── Resume / progress tracking ───────────────────────────────────────────────

describe('CLI — --resume and progress tracking', () => {
  test('--resume without existing progress.json imports all notes (no crash)', () => {
    const cwdDir = makeTempDir('resume-fresh');
    try {
      const { status, stdout } = run([fix('single-note.enex'), '--dry-run', '--resume'], { cwd: cwdDir });
      assert.equal(status, 0);
      assert.match(stdout, /Imported: 1/);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('header shows "Resume: enabled" when --resume flag is set', () => {
    const cwdDir = makeTempDir('resume-header');
    try {
      const { status, stdout } = run([fix('single-note.enex'), '--dry-run', '--resume'], { cwd: cwdDir });
      assert.equal(status, 0);
      assert.match(stdout, /Resume.*on/i);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('creates progress.json after a successful import', () => {
    const cwdDir = makeTempDir('resume-creates');
    try {
      run([fix('single-note.enex'), '--dry-run'], { cwd: cwdDir });
      const progressPath = path.join(cwdDir, 'progress.json');
      assert.ok(fs.existsSync(progressPath), 'progress.json should exist');
      const data = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
      assert.equal(data.version, 2, 'should be v2 schema');
      const fileData = data.files['single-note.enex'];
      assert.ok(fileData, 'entry for file should exist');
      assert.equal(Object.keys(fileData.imported).length, 1);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('progress.json key format is "filename::title::created"', () => {
    const cwdDir = makeTempDir('resume-key');
    try {
      run([fix('single-note.enex'), '--dry-run'], { cwd: cwdDir });
      const data = JSON.parse(fs.readFileSync(path.join(cwdDir, 'progress.json'), 'utf8'));
      const importedKeys = Object.keys(data.files['single-note.enex'].imported);
      assert.equal(importedKeys.length, 1);
      // key: "single-note.enex::Single Note::20260101T090000Z"
      assert.match(importedKeys[0], /^single-note\.enex::Single Note::/);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('--resume skips a note already listed in progress.json', () => {
    const cwdDir = makeTempDir('resume-skip');
    try {
      // Write v1-format progress (will be migrated to v2 on load)
      const progressData = {
        'single-note.enex': {
          imported: ['single-note.enex::Single Note::20260101T090000Z'],
        },
      };
      fs.writeFileSync(path.join(cwdDir, 'progress.json'), JSON.stringify(progressData, null, 2));

      const { status, stdout } = run(
        [fix('single-note.enex'), '--dry-run', '--resume'],
        { cwd: cwdDir }
      );
      assert.equal(status, 0);
      assert.match(stdout, /skipped/i);
      assert.match(stdout, /Skipped:\s+1/i);
      assert.match(stdout, /Imported: 0/);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('--resume imports new notes but skips already-imported ones', () => {
    const cwdDir = makeTempDir('resume-partial');
    try {
      // Mark "Note One" as already imported; "Note Two" and "Note Three" are new
      const progressData = {
        'multi-note.enex': {
          imported: ['multi-note.enex::Note One::20260101T090000Z'],
        },
      };
      fs.writeFileSync(path.join(cwdDir, 'progress.json'), JSON.stringify(progressData, null, 2));

      const { status, stdout } = run(
        [fix('multi-note.enex'), '--dry-run', '--resume'],
        { cwd: cwdDir }
      );
      assert.equal(status, 0);
      assert.match(stdout, /Imported: 2/);
      assert.match(stdout, /Skipped:\s+1/i);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('without --resume, progress.json is ignored and all notes are re-imported', () => {
    const cwdDir = makeTempDir('resume-no-flag');
    try {
      const progressData = {
        'single-note.enex': {
          imported: ['single-note.enex::Single Note::20260101T090000Z'],
        },
      };
      fs.writeFileSync(path.join(cwdDir, 'progress.json'), JSON.stringify(progressData, null, 2));

      const { status, stdout } = run(
        [fix('single-note.enex'), '--dry-run'],
        { cwd: cwdDir }
      );
      assert.equal(status, 0);
      assert.match(stdout, /Imported: 1/);
      assert.doesNotMatch(stdout, /Skipped:/);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('--resume with corrupted progress.json falls back gracefully (treats as empty)', () => {
    const cwdDir = makeTempDir('resume-corrupt');
    try {
      fs.writeFileSync(path.join(cwdDir, 'progress.json'), '{not valid json!!!', 'utf8');
      const { status, stdout } = run(
        [fix('single-note.enex'), '--dry-run', '--resume'],
        { cwd: cwdDir }
      );
      // Should not crash; should import as if no prior progress
      assert.equal(status, 0);
      assert.match(stdout, /Imported: 1/);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('progress.json accumulates entries across multiple runs when --resume is used', () => {
    // Without --resume, each run starts with empty progress (overwrites progress.json).
    // With --resume, each run loads existing progress first, so entries accumulate.
    const cwdDir = makeTempDir('resume-accum');
    try {
      // First run: import single-note.enex (creates progress.json)
      run([fix('single-note.enex'), '--dry-run'], { cwd: cwdDir });
      // Second run: import multi-note.enex WITH --resume so existing entries are preserved
      run([fix('multi-note.enex'), '--dry-run', '--resume'], { cwd: cwdDir });

      const data = JSON.parse(fs.readFileSync(path.join(cwdDir, 'progress.json'), 'utf8'));
      assert.ok(data.files['single-note.enex'], 'single-note.enex entry should exist');
      assert.ok(data.files['multi-note.enex'], 'multi-note.enex entry should exist');
      assert.equal(Object.keys(data.files['multi-note.enex'].imported).length, 3);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('--resume with a note missing created date still tracks it', () => {
    // minimal-note.enex has no <created> field → key ends with "::"
    const cwdDir = makeTempDir('resume-minimal');
    try {
      run([fix('minimal-note.enex'), '--dry-run'], { cwd: cwdDir });
      const data = JSON.parse(fs.readFileSync(path.join(cwdDir, 'progress.json'), 'utf8'));
      const importedKeys = Object.keys(data.files['minimal-note.enex'].imported);
      assert.equal(importedKeys.length, 1);
      // created is null → key ends with ::
      assert.match(importedKeys[0], /^minimal-note\.enex::Minimal::/);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('progress v1 → v2 migration: migrated entries are correctly skipped on --resume', () => {
    const cwdDir = makeTempDir('v1-migrate');
    try {
      // Write a real v1 progress fixture for multi-note.enex
      const v1Progress = {
        'multi-note.enex': {
          imported: [
            'multi-note.enex::Note One::20260101T090000Z',
            'multi-note.enex::Note Two::20260102T090000Z',
          ],
        },
      };
      fs.writeFileSync(path.join(cwdDir, 'progress.json'), JSON.stringify(v1Progress, null, 2));

      const { status, stdout } = run(
        [fix('multi-note.enex'), '--dry-run', '--resume'],
        { cwd: cwdDir }
      );
      assert.equal(status, 0);
      // Note One + Note Two were in v1 progress → skipped; Note Three is new → imported
      assert.match(stdout, /Imported: 1/);
      assert.match(stdout, /Skipped:\s+2/i);

      // Verify that the loaded progress.json is now v2
      const data = JSON.parse(fs.readFileSync(path.join(cwdDir, 'progress.json'), 'utf8'));
      assert.equal(data.version, 2);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });
});
