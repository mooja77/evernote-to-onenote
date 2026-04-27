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
  if (msg.includes('401') || msg.includes('authentication failed')) {
    return '  → Re-authenticate: evernote-to-onenote --auth';
  }
  if (msg.includes('429') || msg.includes('rate limit')) {
    return '  → Wait a few minutes, then retry with: --resume';
  }
  if (msg.includes('507') || msg.includes('storage full')) {
    return '  → Free up OneDrive storage at onedrive.live.com, then retry with: --resume';
  }
  if (msg.includes('503')) {
    return '  → Microsoft service temporarily unavailable — retry later with: --resume';
  }
  if (err.code === 'ENOENT') {
    return '  → File not found — check the path is correct';
  }
  if (err.code === 'EACCES') {
    return '  → Permission denied — check you have read access to this file';
  }
  if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('network') || msg.includes('fetch failed')) {
    return '  → Network error — check your internet connection and retry with: --resume';
  }
  return null;
}

// Prompts the user interactively for a .enex directory and start confirmation.
// Re-prompts on invalid input (up to MAX_ATTEMPTS) so beginners are not
// dropped out on the first mistake. Returns an array of resolved .enex paths.
async function interactiveSetup({ dryRun = false } = {}) {
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
    console.log('\nEvernote → OneNote Importer (guided mode)');
    console.log('─────────────────────────────────────────────');
    console.log('\nHow to export your notebooks from Evernote:');
    console.log('  1. Open Evernote and click the notebook you want to export.');
    console.log('  2. Go to File → Export Notes...  (or right-click the notebook).');
    console.log('  3. Choose "ENEX format (.enex)" and save to a folder.');
    console.log('  4. Repeat for each notebook, then enter the folder path below.\n');

    let enexFiles = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let dirInput = await ask('Where are your .enex files? (folder path): ');
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
      console.error('Too many failed attempts. Run --help for usage.');
      rl.close();
      process.exit(1);
    }

    console.log(`\nFound ${enexFiles.length} notebook(s):`);
    enexFiles.forEach(f => console.log(`  • ${path.basename(f)}`));

    const action = dryRun ? 'preview' : 'import';
    const confirm = await ask(`\nStart ${action} of ${enexFiles.length} notebook(s)? [Y/n] `);
    rl.close();

    if (confirm.trim().toLowerCase() === 'n') {
      console.log('Cancelled.');
      process.exit(0);
    }

    return enexFiles;
  } catch (err) {
    rl.close();
    throw err;
  }
}

module.exports = { ProgressBar, describeError, interactiveSetup, fmtTime };
