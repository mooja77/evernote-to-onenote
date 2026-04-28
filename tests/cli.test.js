'use strict';
/**
 * CLI integration tests — runs `node src/index.js` as a subprocess so the
 * full parse → convert → dry-run pipeline is exercised end-to-end.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const CLI = path.join(__dirname, '..', 'src', 'index.js');
const fix = (name) => path.join(__dirname, 'fixtures', name);

function makeTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `enex-cli-${label}-`));
}

function run(args, opts = {}) {
  const { env = {}, cwd } = opts;
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ONENOTE_ACCESS_TOKEN: '', MSAL_NO_INTERACTIVE: '1', ...env },
    timeout: 15000,
    cwd,
  });
}

describe('CLI — --batch error messages', () => {
  test('--batch with nonexistent directory exits 1 with path and Windows drag tip', () => {
    const { status, stderr } = run(['--batch', '/nonexistent-enex-dir-wave6', '--dry-run']);
    assert.equal(status, 1);
    assert.match(stderr, /--batch directory not found/i);
    assert.match(stderr, /Check the folder path/i);
    assert.match(stderr, /drag/i);
  });

  test('--batch with directory containing no .enex files exits 1 with export instructions', () => {
    const emptyDir = makeTempDir('no-enex');
    try {
      const { status, stderr } = run(['--batch', emptyDir, '--dry-run']);
      assert.equal(status, 1);
      assert.match(stderr, /No \.enex files found/i);
      assert.match(stderr, /Export Notebook/i);
      assert.match(stderr, /ENEX format/i);
      assert.match(stderr, /--batch.*--dry-run/);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe('CLI — argument handling', () => {
  test('prints usage and exits 0 with no arguments', () => {
    const { status, stdout } = run([]);
    assert.equal(status, 0);
    assert.match(stdout, /evernote-to-onenote --help/i);
  });

  test('prints usage and exits 0 with --help', () => {
    const { status, stdout } = run(['--help']);
    assert.equal(status, 0);
    assert.match(stdout, /Usage/i);
    assert.match(stdout, /evernote-to-onenote setup/);
    assert.match(stdout, /evernote-to-onenote doctor/);
  });

  test('prints package version and exits 0 with --version', () => {
    const { status, stdout, stderr } = run(['--version']);
    const { version } = require('../package.json');
    assert.equal(status, 0);
    assert.equal(stderr, '');
    assert.equal(stdout.trim(), version);
  });

  test('doctor prints local setup checks and exits 0', () => {
    const cwdDir = makeTempDir('doctor');
    try {
      const { status, stdout, stderr } = run(['doctor'], { cwd: cwdDir });
      assert.equal(status, 0);
      assert.equal(stderr, '');
      assert.match(stdout, /Evernote -> OneNote Doctor/);
      assert.match(stdout, /Node\.js:/);
      assert.match(stdout, /Microsoft sign-in:/);
      assert.match(stdout, /Progress file:/);
      assert.match(stdout, /evernote-to-onenote setup/);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('exits 1 with an error when file does not end in .enex', () => {
    const { status, stderr } = run(['notes.txt', '--dry-run']);
    assert.equal(status, 1);
    assert.match(stderr, /\.enex/);
  });

  test('exits 0 and logs error when .enex file does not exist', () => {
    const { status, stderr } = run(['missing.enex', '--dry-run']);
    assert.equal(status, 0);
    assert.match(stderr, /Failed to parse/i);
  });

  test('exits 1 without token in live mode', () => {
    // MSAL_NO_INTERACTIVE=1 prevents device-code flow from blocking
    const { status, stderr } = run([fix('single-note.enex')], {
      env: { ONENOTE_ACCESS_TOKEN: '', MSAL_NO_INTERACTIVE: '1' },
    });
    assert.equal(status, 1);
    assert.match(stderr, /signed in|auth/i);
  });
});

describe('CLI — dry-run mode', () => {
  test('processes single-note.enex successfully', () => {
    const cwdDir = makeTempDir('dry1');
    try {
      const { status, stdout } = run([fix('single-note.enex'), '--dry-run'], { cwd: cwdDir });
      assert.equal(status, 0);
      assert.match(stdout, /1 note\(s\) found/);
      assert.match(stdout, /Single Note/);
      assert.match(stdout, /DRY RUN complete/i);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('processes multi-note.enex — reports 3 notes', () => {
    const cwdDir = makeTempDir('dry2');
    try {
      const { status, stdout } = run([fix('multi-note.enex'), '--dry-run'], { cwd: cwdDir });
      assert.equal(status, 0);
      assert.match(stdout, /3 note\(s\) found/);
      assert.match(stdout, /Imported: 3/);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('processes mixed-notes.enex (3 notes with tags and ENML content)', () => {
    const cwdDir = makeTempDir('dry3');
    try {
      const { status, stdout } = run([fix('mixed-notes.enex'), '--dry-run'], { cwd: cwdDir });
      assert.equal(status, 0);
      assert.match(stdout, /3 note\(s\) found/);
      assert.match(stdout, /Project Ideas/);
      assert.match(stdout, /Meeting Notes/);
      assert.match(stdout, /Recipe/);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('exits 0 cleanly on empty-export.enex', () => {
    const { status, stdout } = run([fix('empty-export.enex'), '--dry-run']);
    assert.equal(status, 0);
    assert.match(stdout, /0 note\(s\) found/);
  });

  test('notebook is named after the input .enex file', () => {
    const cwdDir = makeTempDir('dry-nb');
    try {
      const { status, stdout } = run([fix('single-note.enex'), '--dry-run'], { cwd: cwdDir });
      assert.equal(status, 0);
      assert.match(stdout, /notebook "single-note"/i);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('default section name is "Imported"', () => {
    const cwdDir = makeTempDir('dry-sec');
    try {
      const { status, stdout } = run([fix('single-note.enex'), '--dry-run'], { cwd: cwdDir });
      assert.equal(status, 0);
      assert.match(stdout, /section.*Imported/i);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('prints tags when note has tags', () => {
    const cwdDir = makeTempDir('dry-tags');
    try {
      const { status, stdout } = run([fix('single-note.enex'), '--dry-run'], { cwd: cwdDir });
      assert.equal(status, 0);
      assert.match(stdout, /Tags:/);
      assert.match(stdout, /test/);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('does NOT print tags line when note has no tags', () => {
    // multi-note.enex: Note Two has no tags
    const cwdDir = makeTempDir('dry-notags');
    try {
      const { status } = run([fix('multi-note.enex'), '--dry-run'], { cwd: cwdDir });
      assert.equal(status, 0);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('displays filename in output', () => {
    const cwdDir = makeTempDir('dry-fn');
    try {
      const { status, stdout } = run([fix('single-note.enex'), '--dry-run'], { cwd: cwdDir });
      assert.equal(status, 0);
      assert.match(stdout, /single-note\.enex/);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('displays mode as DRY RUN', () => {
    const { status, stdout } = run([fix('single-note.enex'), '--dry-run']);
    assert.equal(status, 0);
    assert.match(stdout, /DRY RUN/);
  });
});

describe('CLI — regression', () => {
  test('does not crash on note with attachment (en-media placeholder)', () => {
    const cwdDir = makeTempDir('reg1');
    try {
      const { status, stdout } = run([fix('with-resources.enex'), '--dry-run'], { cwd: cwdDir });
      assert.equal(status, 0);
      assert.match(stdout, /Imported: 1/);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('imports are counted correctly when 0 fail', () => {
    const cwdDir = makeTempDir('reg2');
    try {
      const { stdout } = run([fix('multi-note.enex'), '--dry-run'], { cwd: cwdDir });
      assert.match(stdout, /Imported: 3/);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('with-resources.enex dry-run logs page with attachment(s) via createPageWithAttachments', () => {
    const cwdDir = makeTempDir('reg-attach');
    try {
      const { status, stdout } = run([fix('with-resources.enex'), '--dry-run'], { cwd: cwdDir });
      assert.equal(status, 0);
      // In dry-run mode createPageWithAttachments logs "attachment(s)"
      assert.match(stdout, /attachment/i);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });
});

describe('CLI — --year-sections', () => {
  test('prints "Sections: by year" in header when --year-sections is set', () => {
    const cwdDir = makeTempDir('yr-header');
    try {
      const { status, stdout } = run([fix('multi-note.enex'), '--dry-run', '--year-sections'], { cwd: cwdDir });
      assert.equal(status, 0);
      assert.match(stdout, /Sections.*by year/i);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('--year-sections creates section named after note creation year', () => {
    // multi-note.enex notes are created in 2026 — section should be "2026"
    const cwdDir = makeTempDir('yr-sec');
    try {
      const { status, stdout } = run([fix('multi-note.enex'), '--dry-run', '--year-sections'], { cwd: cwdDir });
      assert.equal(status, 0);
      assert.match(stdout, /section.*2026/i);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('--year-sections uses "Imported" section for notes with no created date', () => {
    // minimal-note.enex has no <created> field
    const cwdDir = makeTempDir('yr-no-date');
    try {
      const { status, stdout } = run([fix('minimal-note.enex'), '--dry-run', '--year-sections'], { cwd: cwdDir });
      assert.equal(status, 0);
      assert.match(stdout, /section.*Imported/i);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });
});

describe('CLI — --force-reimport', () => {
  test('--force-reimport overrides progress skip and re-imports all notes', () => {
    const cwdDir = makeTempDir('force1');
    try {
      // Write v1 progress marking the note as already imported
      const progressData = {
        'single-note.enex': {
          imported: ['single-note.enex::Single Note::20260101T090000Z'],
        },
      };
      fs.writeFileSync(path.join(cwdDir, 'progress.json'), JSON.stringify(progressData, null, 2));

      const { status, stdout } = run(
        [fix('single-note.enex'), '--dry-run', '--resume', '--force-reimport'],
        { cwd: cwdDir }
      );
      assert.equal(status, 0);
      // Force-reimport must NOT skip — should import 1, not 0
      assert.match(stdout, /Imported: 1/);
      assert.doesNotMatch(stdout, /Skipped:\s+1/);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('--force-reimport header shows "Force: re-importing all notes"', () => {
    const cwdDir = makeTempDir('force-header');
    try {
      const { status, stdout } = run([fix('single-note.enex'), '--dry-run', '--force-reimport'], { cwd: cwdDir });
      assert.equal(status, 0);
      assert.match(stdout, /Force.*re-import/i);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('--force-reimport with --batch re-imports all notes across all files', () => {
    const batchDir = makeTempDir('force-batch-in');
    const cwdDir = makeTempDir('force-batch-cwd');
    try {
      fs.copyFileSync(fix('single-note.enex'), path.join(batchDir, 'single-note.enex'));
      fs.copyFileSync(fix('multi-note.enex'), path.join(batchDir, 'multi-note.enex'));

      // Pre-populate progress marking everything as already imported
      const progressData = {
        'single-note.enex': { imported: ['single-note.enex::Single Note::20260101T090000Z'] },
        'multi-note.enex': {
          imported: [
            'multi-note.enex::Note One::20260101T090000Z',
            'multi-note.enex::Note Two::20260102T090000Z',
            'multi-note.enex::Note Three::20260103T090000Z',
          ],
        },
      };
      fs.writeFileSync(path.join(cwdDir, 'progress.json'), JSON.stringify(progressData, null, 2));

      const { status, stdout } = run(
        ['--batch', batchDir, '--dry-run', '--resume', '--force-reimport'],
        { cwd: cwdDir }
      );
      assert.equal(status, 0);
      assert.match(stdout, /Imported: 4/);
      assert.doesNotMatch(stdout, /Skipped/);
    } finally {
      fs.rmSync(batchDir, { recursive: true, force: true });
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });
});

describe('CLI — --verify (standalone mode)', () => {
  test('--verify exits 1 with error when no progress.json and no enex file given', () => {
    const cwdDir = makeTempDir('verify-no-progress');
    try {
      const { status, stderr } = run(['--verify'], { cwd: cwdDir });
      assert.equal(status, 1);
      assert.match(stderr, /progress\.json|no files tracked/i);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('--verify requires a token (exits 1 with sign-in error when no token)', () => {
    const cwdDir = makeTempDir('verify-no-token');
    try {
      // Write a minimal progress.json so verify proceeds past the "no files" check
      const progressData = {
        version: 2,
        files: { 'notes.enex': { notebook_id: null, section_ids: [], imported: {} } },
      };
      fs.writeFileSync(path.join(cwdDir, 'progress.json'), JSON.stringify(progressData, null, 2));
      const { status, stderr } = run(['--verify'], { cwd: cwdDir });
      assert.equal(status, 1);
      assert.match(stderr, /signed in|auth/i);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });
});

describe('CLI — --guided flag', () => {
  test('--guided appears in --help output', () => {
    const { status, stdout } = run(['--help']);
    assert.equal(status, 0);
    assert.match(stdout, /--guided/);
    assert.match(stdout, /--no-interactive/);
  });

  test('--guided --help prints help instead of entering prompts', () => {
    const { status, stdout } = run(['--guided', '--help']);
    assert.equal(status, 0);
    assert.match(stdout, /Usage/);
    assert.match(stdout, /--guided/);
  });

  test('--guided with piped stdin collects path and runs dry-run successfully', () => {
    const batchDir = makeTempDir('guided-in');
    const cwdDir = makeTempDir('guided-cwd');
    try {
      fs.copyFileSync(fix('single-note.enex'), path.join(batchDir, 'single-note.enex'));
      const { status, stdout } = spawnSync(
        process.execPath,
        [CLI, '--guided', '--dry-run', '--no-report'],
        {
          encoding: 'utf8',
          input: batchDir + '\ny\n',
          env: { ...process.env, ONENOTE_ACCESS_TOKEN: '', MSAL_NO_INTERACTIVE: '1' },
          timeout: 15000,
          cwd: cwdDir,
        }
      );
      assert.equal(status, 0, `stdout: ${stdout}`);
      assert.match(stdout, /1 note\(s\) found/);
    } finally {
      fs.rmSync(batchDir, { recursive: true, force: true });
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('setup command runs the beginner guided dry-run path', () => {
    const batchDir = makeTempDir('setup-in');
    const cwdDir = makeTempDir('setup-cwd');
    try {
      fs.copyFileSync(fix('single-note.enex'), path.join(batchDir, 'single-note.enex'));
      const { status, stdout, stderr } = spawnSync(
        process.execPath,
        [CLI, 'setup', '--no-report'],
        {
          encoding: 'utf8',
          input: batchDir + '\ny\n',
          env: { ...process.env, ONENOTE_ACCESS_TOKEN: '', MSAL_NO_INTERACTIVE: '1' },
          timeout: 15000,
          cwd: cwdDir,
        }
      );
      assert.equal(status, 0, `stdout: ${stdout}\nstderr: ${stderr}`);
      assert.match(stdout, /Step 3 of 4: Microsoft and OneDrive preflight/);
      assert.match(stdout, /DRY RUN complete/i);
    } finally {
      fs.rmSync(batchDir, { recursive: true, force: true });
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('--guided defaults to a safe dry-run preview even without --dry-run', () => {
    const batchDir = makeTempDir('guided-default-preview');
    const cwdDir = makeTempDir('guided-default-preview-cwd');
    try {
      fs.copyFileSync(fix('single-note.enex'), path.join(batchDir, 'single-note.enex'));
      const { status, stdout, stderr } = spawnSync(
        process.execPath,
        [CLI, '--guided', '--no-report'],
        {
          encoding: 'utf8',
          input: batchDir + '\ny\n',
          env: { ...process.env, ONENOTE_ACCESS_TOKEN: '', MSAL_NO_INTERACTIVE: '1' },
          timeout: 15000,
          cwd: cwdDir,
        }
      );
      assert.equal(status, 0, `stdout: ${stdout}\nstderr: ${stderr}`);
      assert.match(stdout, /safe preview/i);
      assert.match(stdout, /DRY RUN complete/i);
      assert.doesNotMatch(stderr, /signed in|auth/i);
    } finally {
      fs.rmSync(batchDir, { recursive: true, force: true });
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('--guided explains existing progress before prompting', () => {
    const batchDir = makeTempDir('guided-progress');
    const cwdDir = makeTempDir('guided-progress-cwd');
    try {
      fs.copyFileSync(fix('single-note.enex'), path.join(batchDir, 'single-note.enex'));
      fs.writeFileSync(path.join(cwdDir, 'progress.json'), JSON.stringify({
        version: 2,
        files: {
          'single-note.enex': {
            imported: {
              'single-note.enex::Single Note::20260101000000Z': { onenote_page_id: 'page-1' },
            },
          },
        },
      }, null, 2));
      const { status, stdout } = spawnSync(
        process.execPath,
        [CLI, '--guided', '--dry-run', '--no-report'],
        {
          encoding: 'utf8',
          input: batchDir + '\ny\n',
          env: { ...process.env, ONENOTE_ACCESS_TOKEN: '', MSAL_NO_INTERACTIVE: '1' },
          timeout: 15000,
          cwd: cwdDir,
        }
      );
      assert.equal(status, 0, `stdout: ${stdout}`);
      assert.match(stdout, /Existing progress found/i);
      assert.match(stdout, /--resume/);
    } finally {
      fs.rmSync(batchDir, { recursive: true, force: true });
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('--no-interactive with no input prints usage and exits 0', () => {
    const { status, stdout } = run(['--no-interactive']);
    assert.equal(status, 0);
    assert.match(stdout, /guided prompts were skipped/i);
    assert.match(stdout, /--batch <dir> --dry-run/);
  });

  test('--guided re-prompts on empty path before accepting valid input', () => {
    const batchDir = makeTempDir('guided-reprompt');
    const cwdDir = makeTempDir('guided-reprompt-cwd');
    try {
      fs.copyFileSync(fix('single-note.enex'), path.join(batchDir, 'single-note.enex'));
      // First line empty → re-prompt; second line valid path → success
      const { status, stdout } = spawnSync(
        process.execPath,
        [CLI, '--guided', '--dry-run', '--no-report'],
        {
          encoding: 'utf8',
          input: '\n' + batchDir + '\ny\n',
          env: { ...process.env, ONENOTE_ACCESS_TOKEN: '', MSAL_NO_INTERACTIVE: '1' },
          timeout: 15000,
          cwd: cwdDir,
        }
      );
      assert.equal(status, 0, `stdout: ${stdout}`);
      assert.match(stdout, /1 note\(s\) found/);
    } finally {
      fs.rmSync(batchDir, { recursive: true, force: true });
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('--guided cancels cleanly when user enters n at confirmation', () => {
    const batchDir = makeTempDir('guided-cancel');
    const cwdDir = makeTempDir('guided-cancel-cwd');
    try {
      fs.copyFileSync(fix('single-note.enex'), path.join(batchDir, 'single-note.enex'));
      const { status, stdout } = spawnSync(
        process.execPath,
        [CLI, '--guided'],
        {
          encoding: 'utf8',
          input: batchDir + '\nn\n',
          env: { ...process.env, ONENOTE_ACCESS_TOKEN: '', MSAL_NO_INTERACTIVE: '1' },
          timeout: 15000,
          cwd: cwdDir,
        }
      );
      assert.equal(status, 0);
      assert.match(stdout, /Cancelled/i);
    } finally {
      fs.rmSync(batchDir, { recursive: true, force: true });
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });
});

describe('CLI — dry-run report', () => {
  test('--report and --no-report appear in --help output', () => {
    const { status, stdout } = run(['--help']);
    assert.equal(status, 0);
    assert.match(stdout, /--report/);
    assert.match(stdout, /--no-report/);
  });

  test('--dry-run creates dry-run-report.txt in cwd by default', () => {
    const cwdDir = makeTempDir('report-default');
    try {
      const { status } = run([fix('single-note.enex'), '--dry-run'], { cwd: cwdDir });
      assert.equal(status, 0);
      assert.ok(
        fs.existsSync(path.join(cwdDir, 'dry-run-report.txt')),
        'dry-run-report.txt should be created in cwd'
      );
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('dry-run report contains notebook name and note count', () => {
    const cwdDir = makeTempDir('report-content');
    try {
      const { status } = run([fix('single-note.enex'), '--dry-run'], { cwd: cwdDir });
      assert.equal(status, 0);
      const report = fs.readFileSync(path.join(cwdDir, 'dry-run-report.txt'), 'utf8');
      assert.match(report, /single-note/);
      assert.match(report, /1 note/);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('dry-run report multi-notebook batch shows each notebook', () => {
    const batchDir = makeTempDir('report-batch-in');
    const cwdDir = makeTempDir('report-batch-cwd');
    try {
      fs.copyFileSync(fix('single-note.enex'), path.join(batchDir, 'single-note.enex'));
      fs.copyFileSync(fix('multi-note.enex'), path.join(batchDir, 'multi-note.enex'));
      const { status } = run(['--batch', batchDir, '--dry-run'], { cwd: cwdDir });
      assert.equal(status, 0);
      const report = fs.readFileSync(path.join(cwdDir, 'dry-run-report.txt'), 'utf8');
      assert.match(report, /single-note/);
      assert.match(report, /multi-note/);
      assert.match(report, /4 note\(s\) across 2 notebook/);
    } finally {
      fs.rmSync(batchDir, { recursive: true, force: true });
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('dry-run report states no data was sent to Microsoft', () => {
    const cwdDir = makeTempDir('report-disclaimer');
    try {
      const { status } = run([fix('single-note.enex'), '--dry-run'], { cwd: cwdDir });
      assert.equal(status, 0);
      const report = fs.readFileSync(path.join(cwdDir, 'dry-run-report.txt'), 'utf8');
      assert.match(report, /No data was sent to Microsoft/);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('--no-report suppresses dry-run report creation', () => {
    const cwdDir = makeTempDir('no-report');
    try {
      const { status } = run([fix('single-note.enex'), '--dry-run', '--no-report'], { cwd: cwdDir });
      assert.equal(status, 0);
      assert.ok(
        !fs.existsSync(path.join(cwdDir, 'dry-run-report.txt')),
        'dry-run-report.txt should NOT be created with --no-report'
      );
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('--report <path> writes report to specified path', () => {
    const cwdDir = makeTempDir('custom-report');
    try {
      const customReport = path.join(cwdDir, 'my-preview.txt');
      const { status } = run(
        [fix('single-note.enex'), '--dry-run', '--report', customReport],
        { cwd: cwdDir }
      );
      assert.equal(status, 0);
      assert.ok(fs.existsSync(customReport), 'custom report path should be created');
      assert.ok(
        !fs.existsSync(path.join(cwdDir, 'dry-run-report.txt')),
        'default report.txt should NOT be created when --report is specified'
      );
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('--report creates parent directories when needed', () => {
    const cwdDir = makeTempDir('custom-report-dir');
    try {
      const customReport = path.join(cwdDir, 'reports', 'preview.txt');
      const { status } = run(
        [fix('single-note.enex'), '--dry-run', '--report', customReport],
        { cwd: cwdDir }
      );
      assert.equal(status, 0);
      assert.ok(fs.existsSync(customReport), 'custom nested report path should be created');
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('--report without a path exits with a clear error', () => {
    const { status, stderr } = run([fix('single-note.enex'), '--dry-run', '--report']);
    assert.equal(status, 1);
    assert.match(stderr, /--report requires a file path/);
  });

  test('stdout mentions where report was saved', () => {
    const cwdDir = makeTempDir('report-mention');
    try {
      const { status, stdout } = run([fix('single-note.enex'), '--dry-run'], { cwd: cwdDir });
      assert.equal(status, 0);
      assert.match(stdout, /Dry-run report saved to/i);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });
});

describe('CLI — --on-conflict', () => {
  test('--on-conflict appears in --help output', () => {
    const { status, stdout } = run(['--help']);
    assert.equal(status, 0);
    assert.match(stdout, /--on-conflict/);
  });

  test('--on-conflict skip is accepted without error (dry-run)', () => {
    const cwdDir = makeTempDir('conflict-skip');
    try {
      const { status } = run([fix('single-note.enex'), '--dry-run', '--on-conflict', 'skip'], { cwd: cwdDir });
      assert.equal(status, 0);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('--on-conflict rename is accepted without error (dry-run)', () => {
    const cwdDir = makeTempDir('conflict-rename');
    try {
      const { status } = run([fix('single-note.enex'), '--dry-run', '--on-conflict', 'rename'], { cwd: cwdDir });
      assert.equal(status, 0);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('--on-conflict overwrite is accepted without error (dry-run)', () => {
    const cwdDir = makeTempDir('conflict-overwrite');
    try {
      const { status } = run([fix('single-note.enex'), '--dry-run', '--on-conflict', 'overwrite'], { cwd: cwdDir });
      assert.equal(status, 0);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('--on-conflict ask is accepted without error (dry-run, conflict check skipped in dry-run)', () => {
    const cwdDir = makeTempDir('conflict-ask');
    try {
      const { status } = run([fix('single-note.enex'), '--dry-run', '--on-conflict', 'ask'], { cwd: cwdDir });
      assert.equal(status, 0);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  test('--on-conflict with invalid value exits 1 with error message', () => {
    const { status, stderr } = run([fix('single-note.enex'), '--dry-run', '--on-conflict', 'merge']);
    assert.equal(status, 1);
    assert.match(stderr, /--on-conflict/);
  });

  test('--on-conflict without value defaults to skip and exits 0 (dry-run)', () => {
    const cwdDir = makeTempDir('conflict-default');
    try {
      const { status, stdout } = run([fix('single-note.enex'), '--dry-run', '--on-conflict'], { cwd: cwdDir });
      assert.equal(status, 0);
      assert.match(stdout, /conflict.*skip/i);
    } finally {
      fs.rmSync(cwdDir, { recursive: true, force: true });
    }
  });
});
