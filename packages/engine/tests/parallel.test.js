'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Semaphore, createGlobalBackoff, createWriteQueue, runParallel } = require('../src/parallel');

// ── Semaphore ─────────────────────────────────────────────────────────────────

describe('Semaphore', () => {
  test('allows up to limit tasks to run concurrently', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let maxActive = 0;

    const tasks = Array.from({ length: 5 }, (_, i) =>
      (async () => {
        await sem.acquire();
        active++;
        if (active > maxActive) maxActive = active;
        await new Promise(r => setTimeout(r, 10));
        active--;
        sem.release();
      })()
    );

    await Promise.all(tasks);
    assert.equal(maxActive, 2, 'no more than 2 tasks should run simultaneously');
  });

  test('release unblocks the next queued task', async () => {
    const sem = new Semaphore(1);
    const order = [];

    await sem.acquire();
    const waiter = sem.acquire().then(() => { order.push('second'); sem.release(); });
    order.push('first');
    sem.release();
    await waiter;

    assert.deepEqual(order, ['first', 'second']);
  });

  test('single-slot semaphore serialises all tasks', async () => {
    const sem = new Semaphore(1);
    let concurrent = 0;
    let overlapDetected = false;

    await Promise.all(
      Array.from({ length: 4 }, async () => {
        await sem.acquire();
        concurrent++;
        if (concurrent > 1) overlapDetected = true;
        await new Promise(r => setTimeout(r, 5));
        concurrent--;
        sem.release();
      })
    );

    assert.equal(overlapDetected, false, 'tasks must not overlap with concurrency 1');
  });
});

// ── GlobalBackoff ─────────────────────────────────────────────────────────────

describe('createGlobalBackoff', () => {
  test('wait() resolves immediately when no backoff is set', async () => {
    const backoff = createGlobalBackoff();
    const start = Date.now();
    await backoff.wait();
    assert.ok(Date.now() - start < 20, 'wait should resolve immediately');
  });

  test('set() causes wait() to pause for the given duration', async () => {
    const backoff = createGlobalBackoff();
    backoff.set(50);
    const start = Date.now();
    await backoff.wait();
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 40, `wait should pause at least 40ms, got ${elapsed}ms`);
  });

  test('active reflects whether backoff is in effect', async () => {
    const backoff = createGlobalBackoff();
    assert.equal(backoff.active, false);
    backoff.set(200);
    assert.equal(backoff.active, true);
    await backoff.wait();
    assert.equal(backoff.active, false);
  });

  test('set() extends backoff if new duration is longer', () => {
    const backoff = createGlobalBackoff();
    backoff.set(500);
    backoff.set(100); // shorter — should not shorten the existing pause
    assert.equal(backoff.active, true);
  });
});

// ── WriteQueue ────────────────────────────────────────────────────────────────

describe('createWriteQueue', () => {
  test('runs enqueued functions in order', async () => {
    const enqueue = createWriteQueue();
    const order = [];

    await Promise.all([
      enqueue(() => new Promise(r => setTimeout(() => { order.push(1); r(); }, 30))),
      enqueue(() => new Promise(r => setTimeout(() => { order.push(2); r(); }, 10))),
      enqueue(() => { order.push(3); }),
    ]);

    assert.deepEqual(order, [1, 2, 3], 'writes must execute in enqueue order');
  });

  test('error in one write does not break subsequent writes', async () => {
    const enqueue = createWriteQueue();
    const results = [];

    enqueue(() => { throw new Error('write error'); });
    await enqueue(() => { results.push('after error'); });

    assert.deepEqual(results, ['after error']);
  });
});

// ── runParallel ───────────────────────────────────────────────────────────────

describe('runParallel', () => {
  const noBackoff = { wait: async () => {}, active: false, set: () => {} };

  test('processes all items and returns results in input order', async () => {
    const results = await runParallel([10, 20, 30], 3, noBackoff, async (n) => n * 2);
    assert.deepEqual(results, [20, 40, 60]);
  });

  test('respects concurrency limit', async () => {
    let active = 0;
    let maxActive = 0;

    await runParallel(
      Array.from({ length: 6 }, (_, i) => i),
      2,
      noBackoff,
      async () => {
        active++;
        if (active > maxActive) maxActive = active;
        await new Promise(r => setTimeout(r, 10));
        active--;
      }
    );

    assert.equal(maxActive, 2, 'max concurrency must not exceed 2');
  });

  test('waits for globalBackoff before starting each task', async () => {
    const backoff = createGlobalBackoff();
    backoff.set(40);
    const timestamps = [];

    await runParallel([0], 1, backoff, async () => {
      timestamps.push(Date.now());
    });

    // The task started after the backoff expired
    assert.equal(timestamps.length, 1);
    assert.equal(backoff.active, false);
  });

  test('rejects if any task throws (callers must handle errors internally)', async () => {
    // In real usage (importNotes), each task wraps its body in try/catch and
    // never throws, so runParallel never sees a rejection. This test verifies
    // that an unhandled throw propagates correctly (fail-fast via Promise.all).
    await assert.rejects(
      () => runParallel([1, 2, 3], 2, noBackoff, async (n) => {
        if (n === 2) throw new Error('task 2 failed');
        return n;
      }),
      /task 2 failed/,
    );
  });

  test('concurrency > item count: all items still run', async () => {
    const results = await runParallel([1, 2], 10, noBackoff, async (n) => n * 3);
    assert.deepEqual(results, [3, 6]);
  });

  test('single item runs exactly once', async () => {
    let callCount = 0;
    await runParallel(['only'], 5, noBackoff, async () => { callCount++; });
    assert.equal(callCount, 1);
  });

  test('empty items array returns empty results', async () => {
    const results = await runParallel([], 3, noBackoff, async () => 'unreachable');
    assert.deepEqual(results, []);
  });

  test('429 backoff set by one task propagates to subsequent tasks', async () => {
    // Task 0 runs first (concurrency=1), sets a 60ms backoff.
    // Tasks 1+ must wait for backoff before starting.
    const backoff = createGlobalBackoff();
    const startTimes = [];

    await runParallel([0, 1, 2], 1, backoff, async (n) => {
      startTimes.push({ n, t: Date.now() });
      if (n === 0) backoff.set(60); // simulate 429 in first task
    });

    // Task 1 must start at least 50ms after task 0 started
    const gap = startTimes[1].t - startTimes[0].t;
    assert.ok(gap >= 50, `task 1 should have waited for backoff, gap was ${gap}ms`);
  });
});
