'use strict';

const readline = require('readline');
const path = require('path');
const fs = require('fs');

function fmtTime(seconds) {
  const s = Math.round(Math.max(0, seconds));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

class ProgressBar {
  constructor(total, { quiet = false } = {}) {
    this.total = total;
    this.done = 0;
    this.quiet = quiet;
    this.startTime = Date.now();
  }

  tick() {
    this.done++;
    if (this.quiet) return;
    const elapsed = (Date.now() - this.startTime) / 1000;
    const rate = elapsed > 0 ? this.done / elapsed : 0;
    const remaining = rate > 0 && this.done < this.total ? (this.total - this.done) / rate : 0;
    const pct = this.total > 0 ? Math.round((this.done / this.total) * 20) : 0;
    const bar = '█'.repeat(pct) + '░'.repeat(20 - pct);
    const est = rate > 0 && this.done < this.total ? ` | ~${fmtTime(remaining)} remaining` : '';
    process.stdout.write(`  [${bar}] ${this.done}/${this.total} | ${fmtTime(elapsed)} elapsed${est}\n`);
  }
}

// Maps a caught error to an actionable next-step hint, or returns null.
function describeError(err) {
  const msg = (err.message || '').toLowerCase();

  // Auth errors
  if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('authentication failed')) {
    return '  → Your login session expired. Run: evernote-to-onenote --auth\n' +
           '    Note: only personal Microsoft accounts are supported (not work/school).';
  }
  if (msg.includes('consent_required') || msg.includes('interaction_required') || msg.includes('consent required')) {
    return '  → Microsoft requires you to approve access again. Run: evernote-to-onenote --auth';
  }
  if (msg.includes('invalid_grant')) {
    return '  → Your saved login is no longer valid. Run: evernote-to-onenote --auth';
  }

  // Account type mismatch
  if (msg.includes('aadsts') || msg.includes('work or school') || msg.includes('tenant')) {
    return '  → This tool only works with personal Microsoft accounts (Outlook.com / Hotmail / Live).\n' +
           '    Work and school accounts (Microsoft 365 / Entra ID) are not supported.';
  }

  // Rate limiting
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) {
    return '  → Microsoft has temporarily slowed your requests. Wait a few minutes, then:\n' +
           '    evernote-to-onenote --batch <dir> --resume';
  }

  // Storage / section overflow
  if (msg.includes('507') || msg.includes('storage full') || msg.includes('insufficient storage')) {
    return '  → Your OneDrive is full. Free up space at onedrive.live.com, then:\n' +
           '    evernote-to-onenote --batch <dir> --resume';
  }

  // Service errors
  if (msg.includes('503') || msg.includes('service unavailable')) {
    return '  → Microsoft\'s servers are temporarily unavailable. Try again in a few minutes:\n' +
           '    evernote-to-onenote --batch <dir> --resume';
  }
  if (msg.includes('500') || msg.includes('internal server error')) {
    return '  → Microsoft returned a server error. This is usually temporary — retry with:\n' +
           '    evernote-to-onenote --batch <dir> --resume';
  }

  // Client errors
  if (msg.includes('400') || msg.includes('bad request')) {
    return '  → The note could not be accepted by OneNote (possibly invalid content or attachment).\n' +
           '    The importer will continue with other notes. Check the note content in Evernote.';
  }
  if (msg.includes('404') || msg.includes('not found')) {
    return '  → Resource not found in OneNote. This is usually harmless — the importer will continue.';
  }
  if (msg.includes('413') || msg.includes('payload too large') || msg.includes('request entity too large')) {
    return '  → This note is too large to import directly (>25 MB including attachments).\n' +
           '    Try removing large attachments from this note in Evernote before exporting.';
  }
  if (msg.includes('409') || msg.includes('conflict')) {
    return '  → A page with this title already exists in OneNote. Use --on-conflict rename to auto-rename.';
  }

  // File system errors
  if (err.code === 'ENOENT') {
    return '  → File not found — check the path is correct and the file exists.';
  }
  if (err.code === 'EACCES' || err.code === 'EPERM') {
    return '  → Permission denied — check you have read access to this file.';
  }
  if (err.code === 'ENOSPC') {
    return '  → Not enough disk space to save progress. Free up space and retry.';
  }

  // Network errors
  if (msg.includes('econnreset') || msg.includes('econnrefused') || msg.includes('etimedout') ||
      msg.includes('network') || msg.includes('fetch failed') || msg.includes('socket hang up') ||
      msg.includes('dns') || msg.includes('getaddrinfo')) {
    return '  → Network error — check your internet connection, then:\n' +
           '    evernote-to-onenote --batch <dir> --resume';
  }

  return null;
}

// Prompts the user interactively for a .enex directory and start confirmation.
// Re-prompts on invalid input (up to MAX_ATTEMPTS) so beginners are not
// dropped out on the first mistake. Returns an array of resolved .enex paths.
async function interactiveSetup({
  dryRun = false,
  exit = process.exit,
  setupMode = false,
  hasSavedSession = false,
  nodeVersion = process.version,
} = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const MAX_ATTEMPTS = 5;
  let ask;

  if (typeof rl.on === 'function') {
    const queuedLines = [];
    const waiters = [];
    let closed = false;

    rl.on('line', line => {
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else queuedLines.push(line);
    });

    rl.on('close', () => {
      closed = true;
      while (waiters.length > 0) waiters.shift()('');
    });

    ask = prompt => {
      process.stdout.write(prompt);
      if (queuedLines.length > 0) return Promise.resolve(queuedLines.shift());
      if (closed) return Promise.resolve('');
      return new Promise(resolve => waiters.push(resolve));
    };
  } else {
    ask = prompt => new Promise(resolve => rl.question(prompt, resolve));
  }

  try {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║         Evernote → OneNote Importer              ║');
    console.log('╚══════════════════════════════════════════════════╝');
    console.log('');
    console.log('This tool moves your Evernote notes into Microsoft OneNote.');
    console.log('Nothing is deleted from Evernote — it only creates new pages in OneNote.');
    console.log('Progress is saved after every note, so it is safe to resume later.');
    console.log('');
    console.log('What you will need:');
    console.log(`  ✓ Node.js 20 or later (${nodeVersion} detected)`);
    console.log('  • A personal Microsoft account (Outlook.com / Hotmail / Live)');
    console.log('    Work/school accounts (Microsoft 365) are NOT supported.');
    console.log('  • Your Evernote notebooks exported as .enex files (see below)');
    console.log('');

    const progressPath = path.join(process.cwd(), 'progress.json');
    if (fs.existsSync(progressPath)) {
      let importedCount = 0;
      let fileCount = 0;
      try {
        const progress = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
        const files = progress.files || {};
        fileCount = Object.keys(files).length;
        importedCount = Object.values(files).reduce((sum, file) => {
          return sum + Object.keys((file && file.imported) || {}).length;
        }, 0);
      } catch {
        // The importer handles corrupt progress files later; this banner is
        // only a plain-English hint for non-technical users.
      }
      console.log('─────────────────────────────────────────────');
      console.log('Existing progress found');
      console.log('─────────────────────────────────────────────');
      if (fileCount > 0 || importedCount > 0) {
        console.log(`  progress.json tracks ${importedCount} imported note(s) across ${fileCount} file(s).`);
      } else {
        console.log('  progress.json is present in this folder.');
      }
      console.log('  If an import was interrupted, continue later with:');
      console.log('    evernote-to-onenote --batch <folder> --resume');
      console.log('');
    }

    console.log('─────────────────────────────────────────────');
    console.log('Step 1 of 4: Export your notebooks from Evernote');
    console.log('─────────────────────────────────────────────');
    console.log('');
    console.log('  1. Open Evernote on your computer.');
    console.log('  2. Right-click a notebook → "Export Notebook..."');
    console.log('     (or go to File → Export Notes)');
    console.log('  3. Choose "ENEX format (.enex)" and save the file.');
    console.log('  4. Repeat for each notebook you want to import.');
    console.log('  5. Put all the .enex files into one folder.');
    console.log('');

    let enexFiles = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let dirInput = await ask('Step 2 of 4 — Where are your .enex files? (folder path): ');
      dirInput = dirInput.trim();

      if (!dirInput) {
        console.error('  No path entered — please type the folder where your .enex files are saved.');
        console.error('  Example: C:\\Users\\You\\Documents\\Evernote-Export\n');
        continue;
      }

      const dir = path.resolve(dirInput);

      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        console.error(`  Folder not found: ${dir}`);
        console.error('  → Double-check the path and try again.');
        console.error('  → Export from Evernote first: File → Export Notes → ENEX format.\n');
        continue;
      }

      const found = fs.readdirSync(dir)
        .filter(f => f.toLowerCase().endsWith('.enex'))
        .map(f => path.join(dir, f));

      if (found.length === 0) {
        console.error(`  No .enex files found in: ${dir}`);
        console.error('  → Each notebook exports as one .enex file.');
        console.error('  → Export from Evernote: File → Export Notes → ENEX format, save to this folder.\n');
        continue;
      }

      enexFiles = found;
      break;
    }

    if (!enexFiles) {
      console.error('Too many failed attempts.');
      console.error('Run: evernote-to-onenote --help  for usage instructions.');
      rl.close();
      return exit(1);
    }

    console.log('');
    console.log('─────────────────────────────────────────────');
    console.log('Step 3 of 4: Microsoft and OneDrive preflight');
    console.log('─────────────────────────────────────────────');
    console.log('');
    if (hasSavedSession) {
      console.log('  ✓ A saved Microsoft sign-in was found on this machine.');
    } else {
      console.log('  • No saved Microsoft sign-in was found yet.');
      console.log('    Before the real import, run: evernote-to-onenote --auth');
    }
    console.log('  • Use a personal Microsoft account only (Outlook.com / Hotmail / Live).');
    console.log('  • Check OneDrive has enough free space before a large migration.');
    console.log('  • This guided run starts with a dry-run preview, so no sign-in is needed yet.');
    if (setupMode) {
      console.log('  • After this setup preview, you can run the printed import command when ready.');
    }
    console.log('');

    console.log('─────────────────────────────────────────────');
    console.log('Step 4 of 4: Review what will be imported');
    console.log('─────────────────────────────────────────────');
    console.log('');
    console.log(`Found ${enexFiles.length} notebook(s):`);
    enexFiles.forEach(f => console.log(`  • ${path.basename(f, '.enex')}`));
    console.log('');

    if (dryRun) {
      console.log('PREVIEW mode: this run will show what would be imported without changing anything.');
    } else {
      console.log('IMPORT mode: notes will be created in your Microsoft OneNote account.');
      console.log('Progress is saved after every note — if interrupted, run with --resume to continue.');
    }
    console.log('');

    const action = dryRun ? 'preview' : 'import';
    const confirm = await ask(`Start ${action} of ${enexFiles.length} notebook(s)? [Y/n] `);
    rl.close();

    if (confirm.trim().toLowerCase() === 'n') {
      console.log('Cancelled. Your files were not changed.');
      return exit(0);
    }

    return enexFiles;
  } catch (err) {
    rl.close();
    throw err;
  }
}

module.exports = { ProgressBar, describeError, interactiveSetup, fmtTime };
