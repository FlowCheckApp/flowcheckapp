'use strict';

/**
 * syncTransactionPages — walk Plaid's transactionsSync cursor, one page at a
 * time, writing each page BEFORE advancing the cursor.
 *
 * This lives in its own module for one reason: the ordering it enforces is
 * the difference between a slow sync and a silently lossy one, and
 * backend/server.js starts an HTTP listener on require, so nothing inside it
 * can be tested. Here it can.
 *
 * The ordering that must hold, per page:
 *
 *     fetch page → write its rows → advance the cursor
 *
 * The original code did the opposite: it fetched EVERY page into memory,
 * saved the final cursor, and only then wrote the rows. A restart in that
 * window — a Railway deploy, an OOM, a crash — left the cursor pointing past
 * transactions that had never been written. Plaid does not send a delta
 * twice, so those transactions were gone for good, with nothing anywhere to
 * indicate it had happened.
 *
 * Re-running a page is harmless: writes are set/merge keyed on
 * transaction_id. Losing one is not. So when in doubt this errs toward
 * repeating work.
 *
 * @param {object}   o
 * @param {function} o.fetchPage  async (cursor) => { added, modified, removed, next_cursor, has_more }
 * @param {function} o.writePage  async ({ added, modified, removed }) => void
 * @param {function} o.saveCursor async (cursor) => void
 * @param {string=}  o.cursor     where to resume from; undefined = full history
 * @param {number=}  o.maxPages   runaway guard; Plaid has no hard page cap
 * @returns {Promise<{added:number, modified:number, removed:number, pages:number, cursor:string|undefined}>}
 */
async function syncTransactionPages({ fetchPage, writePage, saveCursor, cursor, maxPages = 200 }) {
  let added = 0, modified = 0, removed = 0, pages = 0;
  let hasMore = true;

  while (hasMore) {
    if (++pages > maxPages) {
      // Stop rather than loop forever. The cursor is already saved through the
      // last completed page, so the next sync picks up exactly here.
      throw new Error(`transactionsSync exceeded ${maxPages} pages — refusing to loop`);
    }

    const page = await fetchPage(cursor);
    const pageAdded    = page.added    || [];
    const pageModified = page.modified || [];
    const pageRemoved  = page.removed  || [];

    await writePage({ added: pageAdded, modified: pageModified, removed: pageRemoved });

    /* Only now. Every row this cursor accounts for is committed. */
    cursor = page.next_cursor;
    await saveCursor(cursor);

    added += pageAdded.length;
    modified += pageModified.length;
    removed += pageRemoved.length;
    hasMore = Boolean(page.has_more);
  }

  return { added, modified, removed, pages, cursor };
}

module.exports = { syncTransactionPages };
