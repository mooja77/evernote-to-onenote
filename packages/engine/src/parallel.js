'use strict';

/**
 * Concurrency primitives for parallel note imports.
 *
 * - Semaphore: limits the number of concurrent import slots.
 * - GlobalBackoff: when any request receives a 429, all pending tasks
 *   wait for the Retry-After duration before proceeding.
 * - WriteQueue: serialises progress.json writes so saves never interleave.
 * - runParallel: runs an array of async tasks with Semaphore + GlobalBackoff.
 */

class Semaphore {
  constructor(limit) {
    this._limit = limit;
    this._active = 0;
    this._queue = [];
  }

  acquire() {
    return new Promise(resolve => {
      if (this._active < this._limit) {
        this._active++;
        resolve();
      } else {
        this._queue.push(resolve);
      }
    });
  }

  release() {
    this._active--;
    if (this._queue.length > 0) {
      this._active++;
      this._queue.shift()();
    }
  }
}

/**
 * Global pause applied across all concurrent tasks when a 429 is received.
 * Call set(durationMs) from wherever the 429 is detected, then await wait()
 * before starting (or retrying) any task.
 */
function createGlobalBackoff() {
  let pauseUntil = 0;
  return {
    set(durationMs) {
      const target = Date.now() + durationMs;
      if (target > pauseUntil) pauseUntil = target;
    },
    async wait() {
      const remaining = pauseUntil - Date.now();
      if (remaining > 0) {
        await new Promise(r => setTimeout(r, remaining));
      }
    },
    get active() {
      return Date.now() < pauseUntil;
    },
  };
}

/**
 * Serialises async writes: each enqueued function runs only after the
 * previous one has settled. Errors in one write do not block subsequent writes.
 */
function createWriteQueue() {
  let tail = Promise.resolve();
  return function enqueue(fn) {
    const next = tail.then(() => fn());
    tail = next.catch(() => {});
    return next;
  };
}

/**
 * Runs taskFn(item, index) for every item, with at most `concurrency`
 * running at the same time. Checks globalBackoff before each slot is taken
 * and again inside the slot (in case backoff was set while waiting).
 *
 * @param {Array}    items
 * @param {number}   concurrency  max concurrent tasks
 * @param {object}   globalBackoff  { set, wait, active } from createGlobalBackoff()
 * @param {Function} taskFn       async (item, index) => result
 * @returns {Promise<Array>}      results in input order (rejected tasks carry Error objects)
 */
async function runParallel(items, concurrency, globalBackoff, taskFn) {
  const sem = new Semaphore(concurrency);
  return Promise.all(
    items.map(async (item, index) => {
      // Wait for any active global backoff before joining the queue
      await globalBackoff.wait();
      await sem.acquire();
      try {
        // Check again — backoff may have been set while we were queued
        await globalBackoff.wait();
        return await taskFn(item, index);
      } finally {
        sem.release();
      }
    }),
  );
}

module.exports = { Semaphore, createGlobalBackoff, createWriteQueue, runParallel };
