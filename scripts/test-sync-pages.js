#!/usr/bin/env node
/**
 * test-sync-pages.js
 *
 * The first tests the backend has. They cover one function, because that
 * function is where a bug loses a user's transactions permanently rather
 * than merely showing the wrong number.
 *
 * The bug being locked out: /plaid/sync used to save the final cursor and
 * THEN write the rows. Plaid never re-sends a delta, so a crash between the
 * two lost those transactions forever, silently. Every test here is about
 * the ordering that prevents it.
 */
'use strict';

const { syncTransactionPages } = require('../backend/lib/sync-pages');

let passed = 0, failed = 0;
const fails = [];
function t(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => { passed++; })
    .catch(e => { failed++; fails.push({ name, msg: e.message }); });
  return t;
}
const eq = (a, b, why) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${why || 'expected'} ${B}, got ${A}`);
};

/** A fake Plaid that hands back pages in order and records the cursors asked for. */
function fakePlaid(pages) {
  const asked = [];
  return {
    asked,
    fetchPage: async (cursor) => {
      asked.push(cursor);
      const p = pages.shift();
      if (!p) throw new Error('fetchPage called more times than there are pages');
      return p;
    },
  };
}

const page = (n, next, more) => ({
  added: Array.from({ length: n }, (_, i) => ({ transaction_id: `${next}-${i}` })),
  modified: [], removed: [], next_cursor: next, has_more: more,
});

/* ── The ordering invariant ──────────────────────────────────────── */

t('writes every page before advancing past it', async () => {
  const log = [];
  const p = fakePlaid([page(2, 'c1', true), page(1, 'c2', false)]);
  await syncTransactionPages({
    fetchPage: p.fetchPage,
    writePage: async ({ added }) => { log.push(`write:${added.length}`); },
    saveCursor: async (c) => { log.push(`cursor:${c}`); },
  });
  eq(log, ['write:2', 'cursor:c1', 'write:1', 'cursor:c2'],
     'the write for a page must precede the cursor that covers it —');
});

t('a crash mid-sync leaves the cursor behind the data, never ahead', async () => {
  /* The whole point. Page 1 is written and acknowledged; page 2 dies during
     its write. The saved cursor must still be c1, so the next sync re-fetches
     page 2 rather than skipping it. */
  let saved;
  const p = fakePlaid([page(2, 'c1', true), page(9, 'c2', true)]);
  let calls = 0;
  await syncTransactionPages({
    fetchPage: p.fetchPage,
    writePage: async () => { if (++calls === 2) throw new Error('firestore died'); },
    saveCursor: async (c) => { saved = c; },
  }).then(() => { throw new Error('should have propagated the write failure'); },
          err => { if (!/firestore died/.test(err.message)) throw err; });
  eq(saved, 'c1', 'cursor after a failed second page should still be');
});

t('resumes from the cursor it was given', async () => {
  const p = fakePlaid([page(1, 'c9', false)]);
  await syncTransactionPages({
    fetchPage: p.fetchPage, writePage: async () => {}, saveCursor: async () => {},
    cursor: 'c8',
  });
  eq(p.asked, ['c8'], 'first fetch should resume from');
});

t('a first sync starts with no cursor, not an empty string', async () => {
  const p = fakePlaid([page(1, 'c1', false)]);
  await syncTransactionPages({ fetchPage: p.fetchPage, writePage: async () => {}, saveCursor: async () => {} });
  eq(p.asked, [undefined], 'first fetch cursor should be');
});

/* ── Counting and paging ─────────────────────────────────────────── */

t('totals every page, not just the last', async () => {
  const r = await syncTransactionPages({
    fetchPage: fakePlaid([page(3, 'c1', true), page(4, 'c2', true), page(2, 'c3', false)]).fetchPage,
    writePage: async () => {}, saveCursor: async () => {},
  });
  eq({ added: r.added, pages: r.pages, cursor: r.cursor }, { added: 9, pages: 3, cursor: 'c3' });
});

t('counts modified and removed separately from added', async () => {
  const r = await syncTransactionPages({
    fetchPage: async () => ({
      added: [{ transaction_id: 'a' }],
      modified: [{ transaction_id: 'b' }, { transaction_id: 'c' }],
      removed: [{ transaction_id: 'd' }],
      next_cursor: 'c1', has_more: false,
    }),
    writePage: async () => {}, saveCursor: async () => {},
  });
  eq({ added: r.added, modified: r.modified, removed: r.removed }, { added: 1, modified: 2, removed: 1 });
});

t('a page with missing arrays is empty, not a crash', async () => {
  const r = await syncTransactionPages({
    fetchPage: async () => ({ next_cursor: 'c1', has_more: false }),
    writePage: async () => {}, saveCursor: async () => {},
  });
  eq({ added: r.added, modified: r.modified, removed: r.removed }, { added: 0, modified: 0, removed: 0 });
});

t('refuses to loop forever when has_more never goes false', async () => {
  let saves = 0;
  await syncTransactionPages({
    fetchPage: async () => ({ added: [], modified: [], removed: [], next_cursor: 'c', has_more: true }),
    writePage: async () => {}, saveCursor: async () => { saves++; },
    maxPages: 5,
  }).then(() => { throw new Error('should have thrown'); },
          err => { if (!/exceeded 5 pages/.test(err.message)) throw err; });
  eq(saves, 5, 'work completed before the guard fired should still be saved —');
});

/* ── Report ──────────────────────────────────────────────────────── */
setTimeout(() => {
  console.log(`sync-pages: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.error('');
    fails.forEach(f => console.error(`  ✗ ${f.name}\n      ${f.msg}`));
    console.error('');
    process.exit(1);
  }
  console.log('✓ the cursor can never move past unwritten transactions.');
}, 50);
