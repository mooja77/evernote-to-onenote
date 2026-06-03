'use strict';

// Renderer — the wizard. Talks to the main process only through window.api
// (see preload.js). No Node, no network here.

const $ = (id) => document.getElementById(id);
const STEPS = { 1: 'step-signin', 2: 'step-file', 3: 'step-section', 4: 'step-import', 5: 'step-done' };

const state = { enexPath: null, enexName: null, sectionId: null, total: 0 };
let signedIn = false;

function goStep(n) {
  for (const id of Object.values(STEPS)) $(id).hidden = true;
  $(STEPS[n]).hidden = false;
  document.querySelectorAll('.stepper .step').forEach((el) => {
    const s = Number(el.dataset.step);
    el.classList.toggle('active', s === n);
    el.classList.toggle('done', s < n);
  });
  // Account bar: shown when signed in — but hidden during the import (step 4)
  // so its Sign out button cannot pull the token out from under the run.
  $('account-bar').hidden = !(signedIn && n !== 4);
  // Move focus to the new step's heading — keyboard and screen-reader users
  // otherwise lose their place when the card swaps out under them.
  const h = $(STEPS[n]).querySelector('h2');
  if (h) { h.setAttribute('tabindex', '-1'); h.focus(); }
}

function humanSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return ` (${mb.toFixed(1)} MB)`;
  return ` (${Math.max(1, Math.round(bytes / 1024))} KB)`;
}

function showError(id, message) {
  const el = $(id);
  el.textContent = message;
  el.hidden = !message;
}

// Turn a raw/technical error into something a non-technical user can act on.
function friendlyError(raw, context) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('econn') || s.includes('enotfound') || s.includes('etimedout') ||
      s.includes('network') || s.includes('getaddrinfo') || s.includes('fetch failed') ||
      s.includes('socket') || s.includes('dns')) {
    return 'Could not reach Microsoft. Check your internet connection and try again.';
  }
  if (s.includes('429') || s.includes('rate limit')) {
    return 'Microsoft is busy right now. Wait a minute, then try again.';
  }
  if (s.includes('507') || s.includes('storage')) {
    return 'Your OneDrive storage is full. Free up some space, then try again.';
  }
  if (context === 'note') {
    if (s.includes('413') || s.includes('too large') || s.includes('size')) return 'too large for OneNote';
    return 'could not be imported';
  }
  if (context === 'load') {
    return 'Could not load your OneNote. Check your connection and click Refresh.';
  }
  if (context === 'createsection') {
    return 'Could not create the section. Please try again.';
  }
  if (context === 'import') {
    return 'The import could not finish. Check your connection, then run it again — finished notes are skipped.';
  }
  return 'Sign-in did not complete. Please try again.';
}

// Set the "Signed in as ..." text and the signed-in flag. goStep controls
// whether the bar is actually visible.
function setAccount(account) {
  const who = account && (account.username || account.name);
  signedIn = !!who;
  if (who) $('account-who').textContent = 'Signed in as ' + who;
}

// ── Step 1: sign in ────────────────────────────────────────────────────

// Each sign-in click bumps this. A click's result — or a Cancel — that no
// longer matches the current value is ignored, so an abandoned sign-in can
// never resurface and the UI never looks frozen.
let signInAttempt = 0;

function resetSignInUi() {
  $('btn-signin').disabled = false;
  $('btn-signin').textContent = 'Sign in with Microsoft';
  $('signin-wait').hidden = true;
}

$('btn-signin').addEventListener('click', async () => {
  const attempt = ++signInAttempt;
  showError('signin-error', '');
  $('btn-signin').disabled = true;
  $('btn-signin').textContent = 'Signing in…';
  $('signin-wait').hidden = false;
  try {
    const res = await api.signIn();
    if (attempt !== signInAttempt) return; // cancelled or superseded
    if (res && res.signedIn) {
      setAccount(res.account);
      goStep(2);
    } else {
      showError('signin-error', friendlyError(res && res.error, 'signin'));
    }
  } catch (err) {
    if (attempt !== signInAttempt) return;
    showError('signin-error', friendlyError(err && err.message, 'signin'));
  } finally {
    if (attempt === signInAttempt) resetSignInUi();
  }
});

$('btn-signin-cancel').addEventListener('click', () => {
  signInAttempt++; // invalidate the in-flight attempt
  resetSignInUi();
  showError('signin-error', '');
});

$('btn-signout').addEventListener('click', async () => {
  try { await api.signOut(); } catch { /* ignore */ }
  setAccount(null);
  state.enexPath = null;
  state.enexName = null;
  state.sectionId = null;
  $('file-chosen').hidden = true;
  $('file-name').textContent = '';
  $('btn-file-next').disabled = true;
  goStep(1);
});

// ── Step 2: choose file ────────────────────────────────────────────────

$('btn-pick').addEventListener('click', async () => {
  const file = await api.pickEnex();
  if (!file) return;
  state.enexPath = file.path;
  state.enexName = file.name;
  $('file-name').textContent = file.name + humanSize(file.sizeBytes);
  $('file-chosen').hidden = false;
  $('btn-file-next').disabled = false;
});

$('btn-file-next').addEventListener('click', () => { goStep(3); loadNotebooks(); });

// ── Step 3: pick section ───────────────────────────────────────────────

async function loadNotebooks(selectSectionId) {
  state.sectionId = null;
  $('btn-start').disabled = true;
  $('notebooks').hidden = true;
  $('notebooks').innerHTML = '';
  $('new-section').hidden = true;
  $('new-section-form').hidden = true;
  $('new-section-msg').hidden = true;
  $('notebooks-loading').hidden = false;
  showError('section-error', '');
  try {
    const notebooks = await api.listNotebooks();
    renderNotebooks(notebooks || [], selectSectionId);
  } catch (err) {
    showError('section-error', friendlyError(err && err.message, 'load'));
  } finally {
    $('notebooks-loading').hidden = true;
  }
}

function renderNotebooks(notebooks, selectSectionId) {
  const root = $('notebooks');
  root.innerHTML = '';
  if (!notebooks || notebooks.length === 0) {
    showError('section-error',
      'No OneNote notebooks were found on this account. Create one in OneNote, then click Refresh.');
    return;
  }
  for (const nb of notebooks) {
    const hasSections = nb.sections && nb.sections.length > 0;
    const nbEl = document.createElement('div');
    nbEl.className = 'notebook';

    // The notebook name is a collapsible header — accounts with many
    // notebooks/sections would otherwise be one enormous flat scroll.
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'nb-name';
    if (hasSections) head.setAttribute('aria-expanded', 'false');
    const caret = document.createElement('span');
    caret.className = 'nb-caret';
    caret.textContent = hasSections ? '▸' : '·';
    const label = document.createElement('span');
    label.className = 'nb-label';
    label.textContent = nb.name;
    const count = document.createElement('span');
    count.className = 'nb-count';
    count.textContent = hasSections
      ? nb.sections.length + (nb.sections.length === 1 ? ' section' : ' sections')
      : 'no sections';
    head.append(caret, label, count);
    nbEl.appendChild(head);

    const body = document.createElement('div');
    body.className = 'nb-sections';
    body.hidden = true;

    if (!hasSections) {
      head.disabled = true;
    } else {
      for (const sec of nb.sections) {
        const opt = document.createElement('label');
        opt.className = 'section-opt';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'section';
        radio.value = sec.id;
        radio.addEventListener('change', () => {
          state.sectionId = sec.id;
          document.querySelectorAll('.section-opt').forEach((o) => o.classList.remove('selected'));
          opt.classList.add('selected');
          $('btn-start').disabled = false;
        });
        const text = document.createElement('span');
        text.textContent = sec.name;
        opt.append(radio, text);
        body.appendChild(opt);

        // Auto-select (e.g. a section the user just created).
        if (selectSectionId && sec.id === selectSectionId) {
          body.hidden = false;
          caret.textContent = '▾';
          head.classList.add('expanded');
          head.setAttribute('aria-expanded', 'true');
          radio.checked = true;
          opt.classList.add('selected');
          state.sectionId = sec.id;
          $('btn-start').disabled = false;
        }
      }
      head.addEventListener('click', () => {
        const open = body.hidden;
        body.hidden = !open;
        caret.textContent = open ? '▾' : '▸';
        head.classList.toggle('expanded', open);
        head.setAttribute('aria-expanded', String(open));
      });
    }

    nbEl.appendChild(body);
    root.appendChild(nbEl);
  }
  root.hidden = false;

  // Populate the "create a new section" notebook picker and reveal it.
  const sel = $('new-section-notebook');
  sel.innerHTML = '';
  for (const nb of notebooks) {
    const o = document.createElement('option');
    o.value = nb.id;
    o.textContent = nb.name;
    sel.appendChild(o);
  }
  $('new-section').hidden = false;

  if (selectSectionId) {
    const picked = root.querySelector('.section-opt.selected');
    if (picked) picked.scrollIntoView({ block: 'nearest' });
  }
}

$('btn-new-section-toggle').addEventListener('click', () => {
  const form = $('new-section-form');
  form.hidden = !form.hidden;
  if (!form.hidden) $('new-section-name').focus();
});

$('btn-create-section').addEventListener('click', async () => {
  const notebookId = $('new-section-notebook').value;
  const name = $('new-section-name').value.trim();
  $('new-section-msg').hidden = true;
  if (!name) {
    showError('new-section-msg', 'Type a name for the new section.');
    return;
  }
  if (!notebookId) {
    showError('new-section-msg', 'Choose a notebook for the new section.');
    return;
  }
  if (/[?*\\/:<>|&#%~"]/.test(name)) {
    showError('new-section-msg', 'A section name cannot contain  ?  *  \\  /  :  <  >  |  &  #  %  ~');
    return;
  }
  $('btn-create-section').disabled = true;
  $('btn-create-section').textContent = 'Creating…';
  try {
    const sec = await api.createSection({ notebookId, name });
    $('new-section-name').value = '';
    // Reload so the new section appears in the list, and auto-select it.
    await loadNotebooks(sec && sec.id);
  } catch (err) {
    showError('new-section-msg', friendlyError(err && err.message, 'createsection'));
  } finally {
    $('btn-create-section').disabled = false;
    $('btn-create-section').textContent = 'Create';
  }
});

$('btn-section-back').addEventListener('click', () => goStep(2));
$('btn-section-refresh').addEventListener('click', () => loadNotebooks());
$('btn-start').addEventListener('click', () => { goStep(4); startImport(false); });

// ── Step 4: importing ──────────────────────────────────────────────────

let counts = { imported: 0, skipped: 0, failed: 0 };

api.onImportProgress((evt) => {
  if (evt.phase === 'parsing') {
    $('progress-line').textContent = 'Reading ' + evt.file + '…';
  } else if (evt.phase === 'start') {
    state.total = evt.total;
    counts = { imported: 0, skipped: 0, failed: 0 };
    $('progress-line').textContent = '0 of ' + evt.total + ' notes';
  } else if (evt.phase === 'note') {
    const pct = evt.total ? Math.round((evt.current / evt.total) * 100) : 0;
    $('progress-fill').style.width = pct + '%';
    $('progressbar').setAttribute('aria-valuenow', String(pct));
    $('progress-line').textContent = evt.current + ' of ' + evt.total + ' notes';
    if (evt.status === 'importing') {
      $('progress-note').textContent = '→ ' + evt.title;
    } else if (evt.status === 'imported') {
      counts.imported++;
    } else if (evt.status === 'skipped') {
      counts.skipped++;
    } else if (evt.status === 'failed') {
      counts.failed++;
    }
    // Highlight failures in red while the import runs — a plain-grey count
    // is easy to miss when you are watching a long import.
    const failedPart = counts.failed > 0
      ? '<span class="tally-fail">' + counts.failed + ' failed</span>'
      : counts.failed + ' failed';
    $('progress-counts').innerHTML =
      counts.imported + ' imported · ' + counts.skipped + ' skipped · ' + failedPart;
  }
});

$('btn-cancel').addEventListener('click', async () => {
  $('btn-cancel').disabled = true;
  $('btn-cancel').textContent = 'Stopping…';
  await api.cancelImport();
});

async function startImport(force) {
  $('progress-fill').style.width = '0%';
  $('progressbar').setAttribute('aria-valuenow', '0');
  $('progress-line').textContent = 'Starting…';
  $('progress-note').textContent = '';
  $('progress-counts').textContent = '';
  $('btn-cancel').disabled = false;
  $('btn-cancel').textContent = 'Stop';

  const res = await api.startImport({
    enexPath: state.enexPath,
    sectionId: state.sectionId,
    force: !!force,
  });
  showDone(res);
}

// ── Step 5: done ───────────────────────────────────────────────────────

function showDone(res) {
  goStep(5);
  // Reset the action buttons to the default (successful-import) set.
  $('btn-open-onenote').hidden = false;
  $('btn-retry').hidden = true;
  $('btn-force-reimport').hidden = true;

  if (!res || !res.ok) {
    $('done-title').textContent = 'Import could not finish';
    $('done-big').textContent = '';
    $('done-line').textContent = '';
    showError('done-errors', friendlyError(res && res.error, 'import'));
    // Nothing was imported — offer a retry of the same import, not "Open OneNote".
    $('btn-open-onenote').hidden = true;
    $('btn-retry').hidden = false;
    return;
  }
  const s = res.summary;

  // The .enex had no notes at all — most likely the wrong file.
  if (s.total === 0) {
    $('done-title').textContent = 'Nothing to import';
    $('done-big').textContent = '';
    $('done-line').textContent =
      'That file has no notes in it — check you exported the right .enex file from Evernote.';
    showError('done-errors', '');
    $('btn-open-onenote').hidden = true; // nothing imported — pick another file
    return;
  }

  // Re-running an import that was already done: everything skipped. Say so
  // plainly — a bare "0 imported" reads like a failure — and offer a way to
  // re-import anyway (e.g. if the pages were deleted from OneNote).
  if (!s.cancelled && s.imported === 0 && s.failed === 0 && s.skipped > 0) {
    $('done-title').textContent = 'Already imported';
    $('done-big').innerHTML = '<span class="tally-skip">' + s.skipped + '</span> already in OneNote';
    $('done-line').textContent =
      'These notes were imported on an earlier run, so nothing was duplicated.';
    showError('done-errors', '');
    $('btn-force-reimport').hidden = false;
    return;
  }

  $('done-title').textContent = s.cancelled ? 'Import stopped' : 'Import finished';
  $('done-big').innerHTML = '<span class="tally-ok">' + s.imported + '</span> imported';
  let line = '';
  if (s.skipped) line += '<span class="tally-skip">' + s.skipped + '</span> already done · ';
  if (s.failed) line += '<span class="tally-fail">' + s.failed + '</span> failed · ';
  line += 'out of ' + s.total + ' notes';
  $('done-line').innerHTML = line;

  if (s.failed && s.errors && s.errors.length) {
    const lines = s.errors.slice(0, 5).map((e) => '• ' + e.title + ' — ' + friendlyError(e.message, 'note'));
    if (s.errors.length > 5) lines.push('…and ' + (s.errors.length - 5) + ' more.');
    lines.push('Run the import again to retry failed notes — finished notes are skipped.');
    showError('done-errors', lines.join('\n'));
  } else {
    showError('done-errors', '');
  }
}

$('btn-open-onenote').addEventListener('click', () => { api.openOneNote(); });

$('btn-retry').addEventListener('click', () => { goStep(4); startImport(false); });

$('btn-force-reimport').addEventListener('click', () => { goStep(4); startImport(true); });

$('btn-again').addEventListener('click', () => {
  state.enexPath = null;
  state.enexName = null;
  state.sectionId = null;
  $('file-chosen').hidden = true;
  $('file-name').textContent = '';
  $('btn-file-next').disabled = true;
  goStep(2);
});

// ── Boot ───────────────────────────────────────────────────────────────

(async function boot() {
  // Don't flash the sign-in card on every launch: decide the first step
  // only after the saved-session check has resolved.
  try {
    const st = await api.authStatus();
    if (st && st.signedIn) {
      setAccount(st.account);
      goStep(2);
      return;
    }
  } catch { /* fall through to sign-in */ }
  goStep(1);
})();
