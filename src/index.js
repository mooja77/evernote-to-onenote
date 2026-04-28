#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const readline = require('readline');
const { parseEnexFile } = require('./enex-parser');
const { enmlToHtml, enmlToHtmlWithResources, toOneNoteHtml } = require('./enml-converter');
const { OneNoteClient } = require('./onenote-client');
const { getAuthenticatedToken, runAuthFlow, getTokenFromFile } = require('./auth');
const { loadProgress, saveProgress, markImported, isImported, verifyImport } = require('./progress');
const { applyTagsToHtml, resolveSectionForTags, VALID_STRATEGIES } = require('./tags');
const { createGlobalBackoff, createWriteQueue, runParallel } = require('./parallel');
const { ProgressBar, describeError, interactiveSetup } = require('./ui');
const { version } = require('../package.json');

const FLAGS_WITH_VALUES = ['--batch', '--output-html', '--tags-strategy', '--on-conflict', '--concurrency', '--notebooks', '--date-range', '--report'];
const MAX_CONCURRENCY = 10;

const VALID_CONFLICT_MODES = ['skip', 'rename', 'overwrite', 'ask'];

function checkNodeVersion({ exit = process.exit, stdout = console.log, stderr = console.error } = {}) {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 18) {
    stderr(`Error: Node.js 20 or later is required. You are running ${process.version}.`);
    stderr('');
    stderr('Download the LTS version from: https://nodejs.org');
    stderr('Then re-run: evernote-to-onenote');
    exit(1);
    return false;
  }
  if (major < 20) {
    stdout(`Warning: Node.js ${major} detected. This tool requires Node.js 20 or later.`);
    stdout('Upgrade at: https://nodejs.org');
    stdout('');
  }
  return true;
}

function hasSavedMicrosoftSession() {
  return Boolean(
    process.env.ONENOTE_ACCESS_TOKEN ||
    fs.existsSync(path.resolve(__dirname, '..', '.access-token')) ||
    fs.existsSync(path.resolve(__dirname, '..', 'msal-cache.json'))
  );
}

function getProgressSummary(progressPath = path.join(process.cwd(), 'progress.json')) {
  if (!fs.existsSync(progressPath)) {
    return { exists: false, readable: false, fileCount: 0, importedCount: 0, path: progressPath };
  }

  try {
    const progress = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
    const files = progress.files || {};
    const importedCount = Object.values(files).reduce((sum, file) => {
      return sum + Object.keys((file && file.imported) || {}).length;
    }, 0);
    return {
      exists: true,
      readable: true,
      fileCount: Object.keys(files).length,
      importedCount,
      path: progressPath,
    };
  } catch {
    return { exists: true, readable: false, fileCount: 0, importedCount: 0, path: progressPath };
  }
}

function printDoctor({
  stdout = console.log,
  nodeVersion = process.version,
  hasSession = hasSavedMicrosoftSession(),
  progress = getProgressSummary(),
  cwd = process.cwd(),
} = {}) {
  stdout('Evernote -> OneNote Doctor');
  stdout('');
  stdout(`Node.js: ${nodeVersion}`);
  stdout(hasSession
    ? 'Microsoft sign-in: saved session found'
    : 'Microsoft sign-in: not found yet');
  stdout(`Current folder: ${cwd}`);
  if (!progress.exists) {
    stdout('Progress file: none in the current folder');
  } else if (!progress.readable) {
    stdout('Progress file: found, but it could not be read');
  } else {
    stdout(`Progress file: ${progress.importedCount} imported note(s) across ${progress.fileCount} file(s)`);
  }
  stdout('');
  stdout('Safe next steps:');
  if (!hasSession) {
    stdout('  1. Sign in once: evernote-to-onenote --auth');
  }
  stdout('  2. Preview first: evernote-to-onenote setup');
  stdout('  3. Import only after checking the dry-run report.');
}

function sanitizeName(name) {
  return name
    .replace(/[\x00-\x1f]/g, '')    // strip null bytes and control chars (invalid in filenames)
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/'/g, '')
    .trim() || 'Untitled';
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
}

function noteKey(filename, note) {
  return `${filename}::${note.title || 'Untitled'}::${note.created || ''}`;
}

function yearFromCreated(created) {
  if (!created || created.length < 4) return null;
  const y = created.slice(0, 4);
  return /^\d{4}$/.test(y) ? y : null;
}

function matchNotebookPattern(name, pattern) {
  // Glob-style matching (supports * and ?) against notebook name (case-insensitive)
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
  // Validate ISO date format YYYY-MM-DD
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(start) || !iso.test(end)) return null;
  return { start, end };
}

function enexDateToIso(enexDate) {
  if (!enexDate || enexDate.length < 8) return null;
  return `${enexDate.slice(0, 4)}-${enexDate.slice(4, 6)}-${enexDate.slice(6, 8)}`;
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

function prepareResources(rawResources) {
  return rawResources
    .filter(r => r.data && r.data.trim())
    .map(r => {
      const buf = Buffer.from(r.data.replace(/\s+/g, ''), 'base64');
      const hash = crypto.createHash('md5').update(buf).digest('hex');
      return {
        hash,
        mime: r.mime || 'application/octet-stream',
        filename: r.fileName || r.filename || '',
        data: buf,
      };
    });
}

async function askConflict(title) {
  if (!process.stdin.isTTY) {
    console.warn(`    ⚠ Non-interactive mode — skipping conflict for "${title}"`);
    return 'skip';
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`    Conflict: "${title}" already exists. [s]kip / [r]ename / [o]verwrite? `, answer => {
      rl.close();
      const a = (answer || '').trim().toLowerCase();
      if (a === 'r' || a === 'rename') resolve('rename');
      else if (a === 'o' || a === 'overwrite') resolve('overwrite');
      else resolve('skip');
    });
  });
}

async function importNotes({
  notes, filename, fileIndex, fileCount,
  client, notebook, dryRun, resume, forceReimport, yearSections,
  defaultSectionName, progress, outputHtmlDir, tagsStrategy, onConflict,
  concurrency = 1, globalBackoff, enqueueWrite, preserveMetadata = true,
  quiet = false, bar = null,
}) {
  const counts = { succeeded: 0, failed: 0, skipped: 0 };
  const doSave = enqueueWrite
    ? () => enqueueWrite(() => saveProgress(progress))
    : () => saveProgress(progress);

  // sectionName → { section, baseName, overflowCount }
  const sectionCache = new Map();
  // sectionName → Promise — deduplicates concurrent createSection calls for the same name
  const sectionCreating = new Map();
  // tag name → { group, section } — used only by 'section-groups' strategy
  const sectionGroupCache = new Map();

  async function getSection(sectionName) {
    if (sectionCache.has(sectionName)) return sectionCache.get(sectionName);
    if (!sectionCreating.has(sectionName)) {
      const p = client.createSection(notebook.id, sectionName).then(section => {
        const entry = { section, baseName: sectionName, overflowCount: 0 };
        sectionCache.set(sectionName, entry);
        return entry;
      });
      sectionCreating.set(sectionName, p);
    }
    return sectionCreating.get(sectionName);
  }

  // 'ask' mode is stdin-driven and cannot run in parallel
  const effectiveConcurrency = onConflict === 'ask' ? 1 : concurrency;
  const backoff = globalBackoff || { wait: async () => {}, active: false, set: () => {} };

  await runParallel(notes, effectiveConcurrency, backoff, async (note, i) => {
    const title = note.title || 'Untitled Note';
    const key = noteKey(filename, note);
    const label = `[file ${fileIndex}/${fileCount}: ${filename}] [note ${i + 1}/${notes.length}]`;

    try {
      if (resume && !forceReimport && isImported(progress, filename, key)) {
        if (dryRun) {
          if (!quiet) process.stdout.write(`  ↷ ${label} "${title}" (skipped)\n`);
          counts.skipped++;
          return;
        }
        const state = await verifyImport(progress, filename, key, client);
        if (state === 'exists') {
          if (!quiet) process.stdout.write(`  ↷ ${label} "${title}" (skipped — verified)\n`);
          counts.skipped++;
          return;
        }
        if (state === 'unknown') {
          // Auth/network/5xx — we don't actually know if the page is gone.
          // Prior behaviour treated this as "missing" and triple-posted
          // through a cascading auth failure. Skip, let the next pass try.
          if (!quiet) process.stdout.write(`  ? ${label} "${title}" (verify inconclusive — skipping, try again later)\n`);
          counts.skipped++;
          return;
        }
        // state === 'missing' — confirmed 404, safe to re-import.
        process.stdout.write(`  ⚠ ${label} "${title}" (page missing in OneNote — re-importing)\n`);
      }

      if (!quiet) process.stdout.write(`  → ${label} "${title}"\n`);

      const resources = prepareResources(note.resources || []);
      let html, usedResources;
      if (resources.length > 0) {
        ({ html, usedResources } = enmlToHtmlWithResources(note.content, resources));
      } else {
        html = enmlToHtml(note.content);
        usedResources = [];
      }

      // Apply tags to HTML body (page-metadata strategy)
      if (tagsStrategy === 'page-metadata' && note.tags && note.tags.length > 0) {
        html = applyTagsToHtml(html, note.tags);
      }

      if (outputHtmlDir) {
        const notebookDir = path.join(outputHtmlDir, sanitizeName(filename.replace(/\.enex$/i, '')));
        if (!fs.existsSync(notebookDir)) fs.mkdirSync(notebookDir, { recursive: true });
        let safeName = sanitizeName(title);
        let outFile = path.join(notebookDir, `${safeName}.html`);
        let counter = 1;
        while (fs.existsSync(outFile)) {
          outFile = path.join(notebookDir, `${safeName} (${counter++}).html`);
        }
        const meta = preserveMetadata ? { created: note.created, author: note.author, sourceUrl: note.sourceUrl } : null;
        fs.writeFileSync(outFile, toOneNoteHtml(title, html, meta), 'utf8');
        if (!quiet) console.log(`    ✓ Saved: ${outFile}`);
        markImported(progress, filename, key, null);
        doSave();
        counts.succeeded++;
        return;
      }

      // Resolve section: 'section-groups' routes by primary tag; default uses year/notebook name.
      let sectionRef;
      if (tagsStrategy === 'section-groups' && note.tags && note.tags.length > 0) {
        const tagSection = await resolveSectionForTags(note.tags, notebook.id, client, sectionGroupCache);
        if (tagSection) {
          sectionRef = { section: tagSection, baseName: note.tags[0], overflowCount: 0 };
        }
      }

      if (!sectionRef) {
        // Default section = the .enex filename (e.g. "AppSoftware"). With
        // --year-sections, split further by created-year within that
        // section. Fallback to "Imported" for hyper-unusual cases where
        // defaultSectionName isn't set (standalone single-file runs).
        const base = defaultSectionName || 'Imported';
        const sectionName = yearSections
          ? `${base} ${yearFromCreated(note.created) || ''}`.trim()
          : base;
        sectionRef = await getSection(sectionName);
      }

      // Conflict detection: check if a page with the same title already exists
      let effectiveTitle = title;
      if (!dryRun && onConflict) {
        const existing = await client.findPageByTitle(sectionRef.section.id, title);
        if (existing) {
          if (onConflict === 'skip') {
            if (!quiet) process.stdout.write(`  ⊝ ${label} "${title}" (conflict — page already exists, skipping)\n`);
            counts.skipped++;
            return;
          } else if (onConflict === 'rename') {
            const dateSuffix = new Date().toISOString().slice(0, 10);
            effectiveTitle = `${title} (imported ${dateSuffix})`;
            if (!quiet) process.stdout.write(`  ↷ ${label} "${title}" → renamed to "${effectiveTitle}"\n`);
          } else if (onConflict === 'overwrite') {
            console.warn(`    ⚠ Overwriting existing page (consumer tier may 503 on delete)`);
            try {
              await client.deletePage(existing.id);
            } catch (deleteErr) {
              console.warn(`    ⚠ Delete failed (${deleteErr.message}) — creating duplicate instead`);
            }
          } else if (onConflict === 'ask') {
            const choice = await askConflict(title);
            if (choice === 'skip') {
              if (!quiet) process.stdout.write(`  ⊝ ${label} "${title}" (conflict — skipped by user)\n`);
              counts.skipped++;
              return;
            } else if (choice === 'rename') {
              const dateSuffix = new Date().toISOString().slice(0, 10);
              effectiveTitle = `${title} (imported ${dateSuffix})`;
            } else if (choice === 'overwrite') {
              console.warn(`    ⚠ Overwriting existing page (consumer tier may 503 on delete)`);
              try {
                await client.deletePage(existing.id);
              } catch (deleteErr) {
                console.warn(`    ⚠ Delete failed (${deleteErr.message}) — creating duplicate instead`);
              }
            }
          }
        }
      }

      const meta = preserveMetadata ? { created: note.created, author: note.author, sourceUrl: note.sourceUrl } : null;
      const page = toOneNoteHtml(effectiveTitle, html, meta);

      let pageId;
      try {
        const created = usedResources.length > 0
          ? await client.createPageWithAttachments(sectionRef.section.id, effectiveTitle, page, usedResources)
          : await client.createPage(sectionRef.section.id, effectiveTitle, page);
        pageId = created && created.id;
      } catch (apiErr) {
        if (apiErr.message.includes('30102') || apiErr.message.includes('507')) {
          sectionRef.overflowCount++;
          const newName = `${sectionRef.baseName} (${sectionRef.overflowCount})`;
          console.log(`    ⚠ Section full — creating "${newName}"`);
          const newSection = await client.createSection(notebook.id, newName);
          sectionRef.section = newSection;
          const created = usedResources.length > 0
            ? await client.createPageWithAttachments(sectionRef.section.id, effectiveTitle, page, usedResources)
            : await client.createPage(sectionRef.section.id, effectiveTitle, page);
          pageId = created && created.id;
        } else {
          throw apiErr;
        }
      }

      if (!dryRun && !quiet) console.log(`    ✓ Imported`);
      if (!quiet && note.tags && note.tags.length > 0) {
        const tagLabel = tagsStrategy === 'section-groups' ? `Tags (section-groups): ` : `Tags: `;
        console.log(`    ${tagLabel}${note.tags.join(', ')}`);
      }

      markImported(progress, filename, key, pageId || null);
      doSave();
      counts.succeeded++;
    } catch (err) {
      const hint = describeError(err);
      console.error(`    ✗ Failed: ${err.message}`);
      if (hint) console.error(hint);
      counts.failed++;
    } finally {
      bar?.tick();
    }
  });

  return { succeeded: counts.succeeded, failed: counts.failed, skipped: counts.skipped };
}

async function runVerify(client, progress, enexFiles, { quiet = false, _exit = process.exit } = {}) {
  if (!quiet) console.log('\nVerifying imported notes against OneNote...\n');
  const notebooks = await client.listNotebooks();
  const nbMap = new Map(notebooks.map(n => [n.displayName, n]));

  let totalSourceNotes = 0;
  let totalOneNotePages = 0;
  let totalMatches = 0;
  let totalMismatches = 0;
  let totalSkipped = 0;

  for (const filePath of enexFiles) {
    const filename = path.basename(filePath);
    const nbName = sanitizeName(filename.replace(/\.enex$/i, ''));
    const fileProgress = progress.files && progress.files[filename];
    const sourceCount = fileProgress ? Object.keys(fileProgress.imported || {}).length : 0;

    const nb = nbMap.get(nbName);
    let oneNotePages = 0;

    if (!nb) {
      totalSkipped++;
    } else {
      const sections = await client.listSections(nb.id);
      for (const sec of sections) {
        const pages = await client.listPages(sec.id);
        oneNotePages += pages.length;
      }
    }

    totalSourceNotes += sourceCount;
    totalOneNotePages += oneNotePages;

    const match = sourceCount === oneNotePages;
    if (match) {
      totalMatches++;
    } else {
      totalMismatches++;
    }

    if (!quiet) {
      const rowStatus = match ? '✓' : '✗';
      console.log(`  ${rowStatus} ${filename.padEnd(40)} src:${String(sourceCount).padStart(4)}  onenote:${String(oneNotePages).padStart(4)}`);
    }
  }

  const complete = totalMismatches === 0;

  if (quiet) {
    process.stdout.write(JSON.stringify({
      notebooks: enexFiles.length,
      notes: totalSourceNotes,
      pages: totalOneNotePages,
      matches: totalMatches,
      mismatches: totalMismatches,
      complete,
    }) + '\n');
    if (!complete) _exit(1);
    return;
  }

  console.log('');
  console.log(`  Notebooks:  ${enexFiles.length}`);
  console.log(`  Src notes:  ${totalSourceNotes}`);
  console.log(`  ON pages:   ${totalOneNotePages}`);
  console.log(`  Matches:    ${totalMatches}`);
  if (totalMismatches > 0) console.log(`  Mismatches: ${totalMismatches}`);
  if (totalSkipped > 0) console.log(`  Skipped:    ${totalSkipped} (not found in OneNote)`);

  if (totalMismatches > 0) {
    console.log('\nMismatch detected.');
    console.log('Some notes may not have been imported. To retry:');
    console.log('  evernote-to-onenote --batch <dir> --resume');
    _exit(1);
    return;
  }

  console.log('\nAll counts match. Import is complete.');
}

async function main() {
  if (!checkNodeVersion()) return;

  let args = process.argv.slice(2);
  const setupRequested = args[0] === 'setup';
  if (setupRequested) {
    args = ['--guided', ...args.slice(1)];
  }

  if (args.includes('--auth')) {
    await runAuthFlow();
    console.log('\n─────────────────────────────────────────────');
    console.log('Sign-in complete.');
    console.log('');
    console.log('Next step — preview your notes before importing:');
    console.log('  evernote-to-onenote --batch <folder-with-enex-files> --dry-run');
    console.log('');
    console.log('Replace <folder-with-enex-files> with the path to the folder');
    console.log('containing your exported .enex files.');
    process.exit(0);
  }

  if (args.includes('--version')) {
    console.log(version);
    process.exit(0);
  }

  if (args[0] === 'doctor' || args.includes('--doctor')) {
    printDoctor();
    process.exit(0);
  }

  if (args.includes('--help')) {
    console.log([
      'Evernote → OneNote Importer',
      '',
      'Moves your Evernote notebooks (.enex files) into Microsoft OneNote.',
      'Nothing is deleted from Evernote. Progress is saved after every note.',
      '',
      'Requirements:',
      '  • Node.js 20 or later',
      '  • A personal Microsoft account (Outlook.com / Hotmail / Live)',
      '    ⚠  Work/school accounts (Microsoft 365 / Entra ID) are NOT supported.',
      '  • Evernote notebooks exported as .enex files',
      '    (Evernote → right-click notebook → Export Notebook → ENEX format)',
      '',
      'First-time setup (3 steps):',
      '  Not technical? Use the setup helper:',
      '    evernote-to-onenote setup',
      '',
      '  Step 1 — Sign in to Microsoft:',
      '    evernote-to-onenote --auth',
      '  Step 2 — Preview what will be imported (nothing is written to OneNote):',
      '    evernote-to-onenote --batch ./Evernote-Export --dry-run',
      '  Step 3 — Run the import:',
      '    evernote-to-onenote --batch ./Evernote-Export',
      '',
      'Optional step — verify the import completed:',
      '    evernote-to-onenote --verify',
      '',
      'Not technical? Run with no arguments for a step-by-step guided experience:',
      '    evernote-to-onenote',
      '',
      'Usage:',
      '  evernote-to-onenote --auth                     Sign in to Microsoft (once)',
      '  evernote-to-onenote --batch <dir> --dry-run    Preview (no data sent to OneNote)',
      '  evernote-to-onenote --batch <dir>              Run the import',
      '  evernote-to-onenote --verify                   Check import completed correctly',
      '  evernote-to-onenote doctor                     Check local setup and next steps',
      '  evernote-to-onenote                            Guided step-by-step mode',
      '  evernote-to-onenote setup                      Beginner setup helper',
      '',
      'All options:',
      '  --guided               Step-by-step prompts; starts with a safe preview',
      '  --no-interactive       Never open prompts; print next-step usage instead',
      '  --auth                 Sign in to Microsoft and save your session, then exit',
      '  --batch <dir>          Import all .enex files in a folder',
      '  --dry-run              Preview what would be imported — nothing is written to OneNote',
      '  --report <path>        Save the dry-run summary to a file (default: ./dry-run-report.txt)',
      '  --no-report            Skip writing the dry-run report file',
      '  --resume               Skip notes already imported (checks OneNote to confirm)',
      '  --force-reimport       Re-import all notes even if already in progress.json',
      '  --verify               Compare progress.json against live OneNote page counts',
      '  --doctor               Check local setup and next steps, then exit',
      '  --year-sections        Organise notes by year (sections: 2018, 2019, …)',
      '  --output-html <dir>    Save notes as HTML files locally (no Microsoft account needed)',
      '  --tags-strategy <s>    Tags as: page-metadata (default, #hashtag footer) or section-groups',
      '  --on-conflict <mode>   If a page title already exists: skip (default), rename, overwrite, ask',
      '  --concurrency <N>      Number of notes to import at once (default: 3, max: 10)',
      '  --notebooks <pattern>  Only import notebooks matching a pattern: --notebooks "Work-*,Personal"',
      '  --date-range <range>   Only import notes in a date range: --date-range 2020-01-01..2023-12-31',
      '  --no-preserve-metadata Omit creation date, author, source URL from page headers',
      '  --quiet                Suppress per-note output (for scripts/CI)',
      '  --version              Print version and exit',
      '  --help                 Show this help',
      '',
      'Windows help:',
      '  https://github.com/mooja77/evernote-to-onenote/blob/master/docs/WINDOWS-TROUBLESHOOTING.md',
    ].join('\n'));
    process.exit(0);
  }

  const quiet = args.includes('--quiet');
  let dryRun = args.includes('--dry-run');
  let resume = args.includes('--resume');
  const forceReimport = args.includes('--force-reimport');
  const yearSections = args.includes('--year-sections');
  const verify = args.includes('--verify');
  const noInteractive = args.includes('--no-interactive');
  const guidedRequested = args.includes('--guided');

  // Guided mode: --guided flag OR no args on a TTY -> interactive prompts.
  let interactiveFiles = null;
  if (!noInteractive && ((args.length === 0 && process.stdin.isTTY) || guidedRequested)) {
    if (!dryRun) {
      dryRun = true;
      console.log('Guided mode starts with a safe preview. Nothing will be written to OneNote.');
      console.log('After checking the report, run the printed import command when you are ready.');
    }
    interactiveFiles = await interactiveSetup({
      dryRun,
      setupMode: setupRequested,
      hasSavedSession: hasSavedMicrosoftSession(),
      nodeVersion: process.version,
    });
  } else if (args.length === 0 || (noInteractive && args.length === 1)) {
    console.log('Evernote → OneNote Importer');
    console.log('');
    console.log('First-time? Start here:');
    console.log('  evernote-to-onenote setup                         Beginner setup helper');
    console.log('  evernote-to-onenote --auth                          Sign in to Microsoft');
    console.log('  evernote-to-onenote --batch <dir> --dry-run         Preview (no changes)');
    console.log('  evernote-to-onenote --batch <dir>                   Run the import');
    console.log('');
    if (noInteractive) {
      console.log('--no-interactive was set, so guided prompts were skipped.');
      console.log('');
    }
    console.log('Run evernote-to-onenote --help for all options and requirements.');
    process.exit(0);
  }

  const batchDir = argValue(args, '--batch');
  const outputHtmlDir = argValue(args, '--output-html');
  const tagsStrategyRaw = argValue(args, '--tags-strategy') || 'page-metadata';
  if (!VALID_STRATEGIES.includes(tagsStrategyRaw)) {
    console.error(`Error: --tags-strategy must be one of: ${VALID_STRATEGIES.join(', ')}`);
    process.exit(1);
  }
  const tagsStrategy = tagsStrategyRaw;

  const onConflict = args.includes('--on-conflict')
    ? (argValue(args, '--on-conflict') || 'skip')
    : null;
  if (onConflict !== null && !VALID_CONFLICT_MODES.includes(onConflict)) {
    console.error(`Error: --on-conflict must be one of: ${VALID_CONFLICT_MODES.join(', ')}`);
    process.exit(1);
  }

  const concurrencyRaw = parseInt(argValue(args, '--concurrency') || '3', 10);
  if (isNaN(concurrencyRaw) || concurrencyRaw < 1) {
    console.error('Error: --concurrency must be a positive integer');
    process.exit(1);
  }
  const concurrency = Math.min(concurrencyRaw, MAX_CONCURRENCY);

  const preserveMetadata = !args.includes('--no-preserve-metadata');
  const notebooksPattern = argValue(args, '--notebooks');
  const dateRangeRaw = argValue(args, '--date-range');
  const noReport = args.includes('--no-report');
  const reportPathArg = argValue(args, '--report');
  if (args.includes('--report') && !reportPathArg) {
    console.error('Error: --report requires a file path');
    process.exit(1);
  }
  const reportPath = reportPathArg
    ? path.resolve(reportPathArg)
    : path.join(process.cwd(), 'dry-run-report.txt');
  let dateRange = null;
  if (dateRangeRaw) {
    dateRange = parseDateRange(dateRangeRaw);
    if (!dateRange) {
      console.error('Error: --date-range must be in format YYYY-MM-DD..YYYY-MM-DD');
      process.exit(1);
    }
  }

  // Collect .enex files
  let enexFiles = [];
  if (interactiveFiles) {
    enexFiles = interactiveFiles;
  } else if (batchDir) {
    const resolvedDir = path.resolve(batchDir);
    if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
      console.error(`Error: --batch directory not found: ${resolvedDir}`);
      console.error('');
      console.error('Check the folder path and try again.');
      console.error('Tip: On Windows, drag the folder into this terminal window to paste its path.');
      process.exit(1);
    }
    enexFiles = fs.readdirSync(resolvedDir)
      .filter(f => f.toLowerCase().endsWith('.enex'))
      .map(f => path.join(resolvedDir, f));
    if (notebooksPattern) {
      const patterns = notebooksPattern.split(',').map(p => p.trim()).filter(Boolean);
      enexFiles = enexFiles.filter(f => {
        const name = path.basename(f, '.enex');
        return patterns.some(p => matchNotebookPattern(name, p));
      });
    }
    if (enexFiles.length === 0) {
      console.error(`No .enex files found in: ${resolvedDir}`);
      console.error('');
      console.error('Your Evernote export files should end in .enex');
      console.error('To export from Evernote:');
      console.error('  1. Open Evernote on your computer');
      console.error('  2. Right-click a notebook → Export Notebook');
      console.error('  3. Choose ENEX format (not HTML or PDF)');
      console.error('  4. Save the .enex file(s) into a folder');
      console.error('  5. Re-run: evernote-to-onenote --batch <that folder> --dry-run');
      process.exit(1);
    }
  } else {
    const enexArg = args.find((a, i) => {
      if (a.startsWith('--')) return false;
      const prev = args[i - 1];
      if (prev && FLAGS_WITH_VALUES.includes(prev)) return false;
      return true;
    });
    if (enexArg) {
      if (!enexArg.toLowerCase().endsWith('.enex')) {
        console.error('Error: Input file must be a .enex file');
        process.exit(1);
      }
      enexFiles = [path.resolve(enexArg)];
    }
  }

  const progress = loadProgress();

  // Standalone --verify: use all files tracked in progress.json
  if (verify && enexFiles.length === 0) {
    if (!progress.files || Object.keys(progress.files).length === 0) {
      console.error('Error: no files tracked in progress.json. Run an import first or specify a file.');
      process.exit(1);
    }
    // Synthesise file list from progress (filenames only, paths won't resolve for API — that's ok)
    enexFiles = Object.keys(progress.files).map(f => path.resolve(f));
  }

  if (!verify && enexFiles.length === 0) {
    console.error('Error: provide a .enex file or use --batch <directory>');
    process.exit(1);
  }

  // Token acquisition: legacy env/file → MSAL silent → error if neither available
  const needsApi = !dryRun && !outputHtmlDir;
  let getToken;
  if (needsApi || verify) {
    const legacyToken = getTokenFromFile();
    if (legacyToken) {
      getToken = () => Promise.resolve(legacyToken);
    } else {
      // Require prior --auth run or MSAL cache; don't block on device-code mid-import
      const msalCachePath = path.resolve(__dirname, '..', 'msal-cache.json');
      const hasCacheFile = fs.existsSync(msalCachePath);
      if (!hasCacheFile && (process.env.MSAL_NO_INTERACTIVE === '1' || !process.stdout.isTTY)) {
        console.error('Error: You are not signed in to Microsoft.');
        console.error('  Run this first: evernote-to-onenote --auth');
        console.error('');
        console.error('  Note: only personal Microsoft accounts are supported');
        console.error('  (Outlook.com / Hotmail / Live). Work/school accounts are not supported.');
        process.exit(1);
      }
      getToken = () => getAuthenticatedToken();
      // Pre-acquire to surface auth errors before processing starts
      try {
        await getToken();
      } catch (err) {
        const hint = describeError(err);
        console.error(`Error: Sign-in failed — ${err.message}`);
        if (hint) {
          console.error(hint);
        } else {
          console.error('  Run: evernote-to-onenote --auth to sign in again');
        }
        process.exit(1);
      }
    }
  }

  // Set up output-html dir
  if (outputHtmlDir) {
    const resolvedOut = path.resolve(outputHtmlDir);
    if (!fs.existsSync(resolvedOut)) fs.mkdirSync(resolvedOut, { recursive: true });
  }

  const globalBackoff = createGlobalBackoff();
  const enqueueWrite = createWriteQueue();

  const mode = outputHtmlDir
    ? `HTML output → ${path.resolve(outputHtmlDir)}`
    : dryRun ? 'DRY RUN (no API calls)' : 'LIVE IMPORT';

  console.log(`\nEvernote → OneNote Importer`);
  if (dryRun) {
    console.log('');
    console.log('  ╔══════════════════════════════════════════════╗');
    console.log('  ║  DRY RUN — nothing will be written to OneNote  ║');
    console.log('  ╚══════════════════════════════════════════════╝');
    console.log('  This is a safe preview. No Microsoft API calls will be made.');
    console.log('  Remove --dry-run when you are ready to import for real.');
  }
  console.log('');
  console.log(`  Files:    ${enexFiles.length} notebook(s)`);
  console.log(`  Mode:     ${mode}`);
  if (!dryRun && !outputHtmlDir) console.log(`  Workers:  ${concurrency} note(s) in parallel`);
  if (yearSections) console.log(`  Sections: organised by year`);
  console.log(`  Tags:     ${tagsStrategy}`);
  if (onConflict) console.log(`  On conflict: ${onConflict}`);
  if (resume) console.log(`  Resume:   on (will skip notes already verified in OneNote)`);
  if (forceReimport) console.log(`  Force:    on (will re-import all notes regardless of progress.json)`);
  if (!preserveMetadata) console.log(`  Metadata: off (creation date, author, source URL will not be saved)`);
  if (notebooksPattern) console.log(`  Filter:   notebooks matching "${notebooksPattern}"`);
  if (dateRange) console.log(`  Date range: ${dateRange.start} → ${dateRange.end}`);
  console.log('');

  let totalSucceeded = 0, totalFailed = 0, totalSkipped = 0;
  const notebookSummaries = [];

  // --verify is read-only — skip the import loop entirely. Previously the
  // loop ran then verify ran, causing duplicate imports of every note.
  // Observed against fixtures: 7 notes turned into 14 OneNote pages.
  //
  // Structure (revised 2026-04-20 after confirming API notebooks DO
  // surface as separate top-level OneNote notebooks — they live at
  // OneDrive/Documents/<name> and have proper webUrl/clientUrl,
  // they just don't appear in OneDrive's "Recent" filter until
  // opened. Previous consolidation into a single "Evernote Import"
  // notebook was based on a misdiagnosis.
  //
  // Mapping: 1 Evernote notebook (.enex file) → 1 top-level OneNote
  // notebook. Inside each: one default section "Imported" with the
  // notes as pages. The user's OneNote root will have 31-32 notebooks,
  // one per .enex, mirroring Evernote's notebook list exactly.
  if (!verify) for (let fi = 0; fi < enexFiles.length; fi++) {
    const filePath = enexFiles[fi];
    const filename = path.basename(filePath);
    const notebookName = sanitizeName(filename.replace(/\.enex$/i, ''));

    console.log(`\nImporting file ${fi + 1}/${enexFiles.length}: ${filename} → notebook "${notebookName}"`);

    let notes;
    try {
      notes = await parseEnexFile(filePath);
    } catch (err) {
      const hint = describeError(err);
      console.error(`  Failed to parse: ${err.message}`);
      if (hint) console.error(hint);
      else console.error('  → Check the file is a valid .enex export from Evernote');
      totalFailed++;
      continue;
    }

    if (dateRange) {
      const before = notes.length;
      notes = applyDateRangeFilter(notes, dateRange);
      const filtered = before - notes.length;
      if (filtered > 0) console.log(`  ${filtered} note(s) filtered by --date-range`);
    }

    if (dryRun) notebookSummaries.push({ name: notebookName, count: notes.length });
    console.log(`  ${notes.length} note(s) found`);
    if (notes.length === 0) continue;

    const bar = new ProgressBar(notes.length, { quiet });

    // Per-file notebook creation. Output-html mode stays offline (no
    // API calls at all); live mode creates one OneNote notebook per
    // .enex file.
    let client = null, notebook = null;
    if (!outputHtmlDir) {
      client = new OneNoteClient({ getToken, dryRun, globalBackoff });
      notebook = await client.createNotebook(notebookName);
    }

    const { succeeded, failed, skipped } = await importNotes({
      notes,
      filename,
      fileIndex: fi + 1,
      fileCount: enexFiles.length,
      client,
      notebook,
      dryRun,
      resume,
      forceReimport,
      yearSections,
      progress,
      outputHtmlDir: outputHtmlDir ? path.resolve(outputHtmlDir) : null,
      tagsStrategy,
      onConflict,
      concurrency,
      globalBackoff,
      enqueueWrite,
      preserveMetadata,
      quiet,
      bar,
    });

    totalSucceeded += succeeded;
    totalFailed += failed;
    totalSkipped += skipped;
  }

  console.log(`\n─────────────────────────────────────────────`);
  if (dryRun) {
    const totalNotesDryRun = notebookSummaries.reduce((s, n) => s + n.count, 0);
    console.log('DRY RUN complete — nothing was written to OneNote.');
    console.log('');
    console.log('What would be imported:');
    notebookSummaries.forEach(n => {
      console.log(`  • ${n.name.padEnd(38)} ${n.count} note(s)`);
    });
    console.log('');
    console.log(`  Total: ${totalNotesDryRun} note(s) across ${notebookSummaries.length} notebook(s)`);
    console.log('');
    console.log(`  Imported: ${totalSucceeded}`);
    if (totalSkipped > 0) console.log(`  Skipped:  ${totalSkipped}`);
    if (totalFailed > 0) console.log(`  Failed:   ${totalFailed}`);
    console.log('');
    console.log('When you are ready to import for real, remove --dry-run:');
    console.log('  evernote-to-onenote --batch <dir>');
  } else {
    console.log('Done.');
    console.log(`  Imported: ${totalSucceeded}`);
    if (totalSkipped > 0) console.log(`  Skipped:  ${totalSkipped}`);
    if (totalFailed > 0) {
      console.log(`  Failed:   ${totalFailed}`);
      console.log('');
      console.log('Some notes failed. To retry failed notes, run:');
      console.log('  evernote-to-onenote --batch <dir> --resume');
    }
    if (totalFailed === 0 && totalSucceeded > 0) {
      console.log('');
      console.log('All done! Your notes are in OneNote.');
      console.log('Run --verify to confirm everything arrived:');
      console.log('  evernote-to-onenote --verify');
    }
  }

  if (dryRun && !noReport) {
    const totalNotes = notebookSummaries.reduce((s, n) => s + n.count, 0);
    const lines = [
      'Evernote → OneNote — Dry-Run Report',
      `Generated: ${new Date().toISOString()}`,
      '',
      'IMPORTANT: This is a preview only. No data was sent to Microsoft.',
      '',
      `Notebooks that would be imported (${notebookSummaries.length}):`,
      ...notebookSummaries.map(n => `  ${n.name.padEnd(40)} ${n.count} note(s)`),
      '',
      `Total: ${totalNotes} note(s) across ${notebookSummaries.length} notebook(s)`,
      '',
      'To run the actual import, remove --dry-run:',
      '  evernote-to-onenote --batch <dir>',
    ];
    try {
      const reportDir = path.dirname(reportPath);
      if (reportDir) fs.mkdirSync(reportDir, { recursive: true });
      fs.writeFileSync(reportPath, lines.join('\n') + '\n', 'utf8');
      console.log('');
      console.log(`Dry-run report saved to: ${reportPath}`);
    } catch (reportErr) {
      console.warn(`Warning: could not write dry-run report: ${reportErr.message}`);
    }
  }

  if (verify) {
    const verifyClient = new OneNoteClient({ getToken, dryRun: false });
    await runVerify(verifyClient, progress, enexFiles, { quiet });
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Unexpected error:', err.message);
    process.exit(1);
  });
}

module.exports = {
  importNotes,
  runVerify,
  checkNodeVersion,
  hasSavedMicrosoftSession,
  getProgressSummary,
  printDoctor,
  matchNotebookPattern,
  parseDateRange,
  enexDateToIso,
  applyDateRangeFilter,
  sanitizeName,
  yearFromCreated,
  noteKey,
  VALID_CONFLICT_MODES,
};
