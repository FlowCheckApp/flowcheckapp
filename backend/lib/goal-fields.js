'use strict';
/**
 * goal-fields.js — what a client may say about a savings goal.
 *
 * The counterpart to bill-schedule's normalizeBill, and it exists for the same
 * reason: the Firestore rules for `goals` use `hasOnly()`, which on an update
 * tests the WHOLE resulting document. A field written here that is not in that
 * allowlist does not get ignored — it makes every later write from any client
 * fail, silently, which is exactly what `autopay` did to bills.
 *
 * Dates are `YYYY-MM-DD` strings handled without ever constructing a local
 * Date, so a target date cannot slip a day. See `scripts/check-utc-dates.js`.
 */

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isRealDay(iso) {
  const match = ISO_DAY.exec(String(iso || ''));
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/** Round to cents without letting float error creep into a balance. */
function money(value) {
  return Math.round(Number(value) * 100) / 100;
}

/**
 * Validate and normalise a goal.
 *
 * Returns `{ fields }` or `{ error }`. With `partial`, only the keys present in
 * `input` come back, so this serves create and update both.
 */
function normalizeGoal(input, { partial = false } = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const fields = {};

  if (source.name !== undefined || !partial) {
    const name = String(source.name == null ? '' : source.name).trim();
    if (!name) return { error: 'A goal needs a name.' };
    if (name.length > 60) return { error: 'That name is too long (60 characters max).' };
    fields.name = name;
  }

  if (source.target !== undefined || !partial) {
    const target = Number(source.target);
    if (!Number.isFinite(target) || target <= 0) {
      return { error: 'Set a target greater than zero.' };
    }
    if (target > 100_000_000) return { error: 'That target is too large.' };
    fields.target = money(target);
  }

  if (source.current !== undefined || !partial) {
    const current = Number(source.current);
    if (!Number.isFinite(current) || current < 0) {
      /* Zero is a perfectly good starting point; negative is not. A goal with
         a negative balance would render a progress bar running backwards. */
      return { error: 'Saved so far cannot be negative.' };
    }
    if (current > 100_000_000) return { error: 'That amount is too large.' };
    fields.current = money(current);
  }

  /* Optional, and explicitly clearable. `null` is how a client says "no
     deadline" — distinct from omitting the key, which means "leave it alone". */
  if (source.target_date !== undefined || !partial) {
    const raw = source.target_date;
    if (raw === null || raw === '') {
      fields.target_date = null;
    } else {
      const date = String(raw).trim();
      if (!isRealDay(date)) return { error: 'Enter a target date as YYYY-MM-DD.' };
      fields.target_date = date;
    }
  }

  if (partial && Object.keys(fields).length === 0) {
    return { error: 'Nothing to update.' };
  }

  return { fields };
}

/**
 * A contribution toward a goal.
 *
 * Kept apart from `normalizeGoal` because it is an increment, not a value: two
 * contributions made from two devices should add up, and a client that sends
 * the new total instead would silently overwrite one of them.
 */
function normalizeContribution(input) {
  const amount = Number((input && input.amount) ?? NaN);
  if (!Number.isFinite(amount) || amount === 0) {
    return { error: 'Enter an amount to add.' };
  }
  if (Math.abs(amount) > 100_000_000) return { error: 'That amount is too large.' };
  // Negative is allowed on purpose: taking money back out of a goal is a
  // thing people do, and refusing it would leave them stuck.
  return { amount: money(amount) };
}

module.exports = { normalizeGoal, normalizeContribution, isRealDay };
