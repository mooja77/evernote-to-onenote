'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { runVerify } = require('../src/index');

function makeClient({ notebooksArr = [], sectionMap = {}, pageMap = {} } = {}) {
  return {
    listNotebooks: async () => notebooksArr,
    listSections: async (nbId) => sectionMap[nbId] || [],
    listPages: async (secId) => pageMap[secId] || [],
  };
}

async function runCapture(asyncFn) {
  const captured = [];
  const origLog = console.log.bind(console);
  const origWrite = process.stdout.write.bind(process.stdout);
  let exitCode = null;

  console.log = (...args) => captured.push(args.join(' '));
  process.stdout.write = (s) => { captured.push(s); return true; };

  try {
    await asyncFn({ _exit: (code) => { exitCode = code; } });
  } finally {
    console.log = origLog;
    process.stdout.write = origWrite;
  }

  return { output: captured.join('\n'), exitCode };
}

// ─── Multi-notebook totals ────────────────────────────────────────────────────

describe('runVerify — multi-notebook totals', () => {
  test('reports correct totals when two notebooks both match', async () => {
    const client = makeClient({
      notebooksArr: [
        { id: 'nb1', displayName: 'Work' },
        { id: 'nb2', displayName: 'Personal' },
      ],
      sectionMap: {
        nb1: [{ id: 's1' }],
        nb2: [{ id: 's2' }],
      },
      pageMap: {
        s1: [{ id: 'p1' }, { id: 'p2' }],
        s2: [{ id: 'p3' }],
      },
    });
    const progress = {
      version: 2,
      files: {
        'Work.enex': { imported: { k1: {}, k2: {} } },
        'Personal.enex': { imported: { k3: {} } },
      },
    };
    const { output, exitCode } = await runCapture(({ _exit }) =>
      runVerify(client, progress, ['/f/Work.enex', '/f/Personal.enex'], { _exit })
    );
    assert.equal(exitCode, null);
    assert.match(output, /Notebooks:\s+2/);
    assert.match(output, /Src notes:\s+3/);
    assert.match(output, /ON pages:\s+3/);
    assert.match(output, /Matches:\s+2/);
    assert.doesNotMatch(output, /Mismatches/);
  });

  test('reports mismatches count when page counts differ across notebooks', async () => {
    const client = makeClient({
      notebooksArr: [
        { id: 'nb1', displayName: 'Work' },
        { id: 'nb2', displayName: 'Personal' },
      ],
      sectionMap: {
        nb1: [{ id: 's1' }],
        nb2: [{ id: 's2' }],
      },
      pageMap: {
        s1: [{ id: 'p1' }],  // 1 page, src=2 → mismatch
        s2: [{ id: 'p2' }],  // 1 page, src=1 → match
      },
    });
    const progress = {
      version: 2,
      files: {
        'Work.enex': { imported: { k1: {}, k2: {} } },
        'Personal.enex': { imported: { k3: {} } },
      },
    };
    const { output, exitCode } = await runCapture(({ _exit }) =>
      runVerify(client, progress, ['/f/Work.enex', '/f/Personal.enex'], { _exit })
    );
    assert.equal(exitCode, 1);
    assert.match(output, /Notebooks:\s+2/);
    assert.match(output, /Matches:\s+1/);
    assert.match(output, /Mismatches:\s+1/);
  });

  test('reports skipped count for notebooks absent from OneNote', async () => {
    const client = makeClient({
      notebooksArr: [{ id: 'nb1', displayName: 'Work' }],
      sectionMap: { nb1: [{ id: 's1' }] },
      pageMap: { s1: [{ id: 'p1' }] },
    });
    const progress = {
      version: 2,
      files: {
        'Work.enex': { imported: { k1: {} } },
        'Archive.enex': { imported: { k2: {}, k3: {} } },
      },
    };
    const { output, exitCode } = await runCapture(({ _exit }) =>
      runVerify(client, progress, ['/f/Work.enex', '/f/Archive.enex'], { _exit })
    );
    // Archive not in OneNote → skip+mismatch
    assert.equal(exitCode, 1);
    assert.match(output, /Skipped:\s+1/);
  });

  test('aggregates pages across multiple sections per notebook', async () => {
    const client = makeClient({
      notebooksArr: [{ id: 'nb1', displayName: 'Notes' }],
      sectionMap: { nb1: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] },
      pageMap: {
        s1: [{ id: 'p1' }, { id: 'p2' }],
        s2: [{ id: 'p3' }],
        s3: [{ id: 'p4' }, { id: 'p5' }],
      },
    });
    const progress = {
      version: 2,
      files: {
        'Notes.enex': { imported: { k1: {}, k2: {}, k3: {}, k4: {}, k5: {} } },
      },
    };
    const { output, exitCode } = await runCapture(({ _exit }) =>
      runVerify(client, progress, ['/f/Notes.enex'], { _exit })
    );
    assert.equal(exitCode, null);
    assert.match(output, /ON pages:\s+5/);
    assert.match(output, /Src notes:\s+5/);
    assert.match(output, /Matches:\s+1/);
  });
});

// ─── Guidance text ────────────────────────────────────────────────────────────

describe('runVerify — guidance text', () => {
  test('suggests --resume when mismatches found', async () => {
    const client = makeClient({
      notebooksArr: [{ id: 'nb1', displayName: 'Notes' }],
      sectionMap: { nb1: [{ id: 's1' }] },
      pageMap: { s1: [] },
    });
    const progress = {
      version: 2,
      files: { 'Notes.enex': { imported: { k1: {} } } },
    };
    const { output } = await runCapture(({ _exit }) =>
      runVerify(client, progress, ['/f/Notes.enex'], { _exit })
    );
    assert.match(output, /--resume/);
  });

  test('prints completion confirmation when all counts match', async () => {
    const client = makeClient({
      notebooksArr: [{ id: 'nb1', displayName: 'Notes' }],
      sectionMap: { nb1: [{ id: 's1' }] },
      pageMap: { s1: [{ id: 'p1' }] },
    });
    const progress = {
      version: 2,
      files: { 'Notes.enex': { imported: { k1: {} } } },
    };
    const { output, exitCode } = await runCapture(({ _exit }) =>
      runVerify(client, progress, ['/f/Notes.enex'], { _exit })
    );
    assert.equal(exitCode, null);
    assert.match(output, /All counts match.*[Cc]omplete/i);
  });

  test('prints mismatch detected message on mismatch', async () => {
    const client = makeClient({
      notebooksArr: [{ id: 'nb1', displayName: 'Notes' }],
      sectionMap: { nb1: [{ id: 's1' }] },
      pageMap: { s1: [] },
    });
    const progress = {
      version: 2,
      files: { 'Notes.enex': { imported: { k1: {}, k2: {} } } },
    };
    const { output, exitCode } = await runCapture(({ _exit }) =>
      runVerify(client, progress, ['/f/Notes.enex'], { _exit })
    );
    assert.equal(exitCode, 1);
    assert.match(output, /Mismatch detected/i);
  });
});

// ─── --quiet JSON output ──────────────────────────────────────────────────────

describe('runVerify — --quiet JSON output', () => {
  test('emits valid JSON to stdout with correct totals for two matching notebooks', async () => {
    const client = makeClient({
      notebooksArr: [
        { id: 'nb1', displayName: 'Work' },
        { id: 'nb2', displayName: 'Personal' },
      ],
      sectionMap: { nb1: [{ id: 's1' }], nb2: [{ id: 's2' }] },
      pageMap: { s1: [{ id: 'p1' }], s2: [{ id: 'p2' }, { id: 'p3' }] },
    });
    const progress = {
      version: 2,
      files: {
        'Work.enex': { imported: { k1: {} } },
        'Personal.enex': { imported: { k2: {}, k3: {} } },
      },
    };
    const { output, exitCode } = await runCapture(({ _exit }) =>
      runVerify(client, progress, ['/f/Work.enex', '/f/Personal.enex'], { quiet: true, _exit })
    );
    assert.equal(exitCode, null);
    const json = JSON.parse(output.trim());
    assert.equal(json.notebooks, 2);
    assert.equal(json.notes, 3);
    assert.equal(json.pages, 3);
    assert.equal(json.matches, 2);
    assert.equal(json.mismatches, 0);
    assert.equal(json.complete, true);
  });

  test('JSON sets complete:false and exits 1 on mismatch', async () => {
    const client = makeClient({
      notebooksArr: [{ id: 'nb1', displayName: 'Work' }],
      sectionMap: { nb1: [{ id: 's1' }] },
      pageMap: { s1: [] },
    });
    const progress = {
      version: 2,
      files: { 'Work.enex': { imported: { k1: {}, k2: {} } } },
    };
    const { output, exitCode } = await runCapture(({ _exit }) =>
      runVerify(client, progress, ['/f/Work.enex'], { quiet: true, _exit })
    );
    assert.equal(exitCode, 1);
    const json = JSON.parse(output.trim());
    assert.equal(json.mismatches, 1);
    assert.equal(json.complete, false);
    assert.equal(json.notes, 2);
    assert.equal(json.pages, 0);
  });

  test('quiet mode suppresses table and human-readable text', async () => {
    const client = makeClient({
      notebooksArr: [{ id: 'nb1', displayName: 'Notes' }],
      sectionMap: { nb1: [{ id: 's1' }] },
      pageMap: { s1: [{ id: 'p1' }] },
    });
    const progress = {
      version: 2,
      files: { 'Notes.enex': { imported: { k1: {} } } },
    };
    const { output } = await runCapture(({ _exit }) =>
      runVerify(client, progress, ['/f/Notes.enex'], { quiet: true, _exit })
    );
    // Only valid JSON — no human-readable labels
    const json = JSON.parse(output.trim());
    assert.ok(typeof json === 'object');
    assert.doesNotMatch(output, /Notebooks:/);
    assert.doesNotMatch(output, /Verifying/);
    assert.doesNotMatch(output, /All counts match/);
  });
});
