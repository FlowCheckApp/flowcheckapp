'use strict';
/**
 * bill-schedule.js — when a recurring bill is next due, and what a bill may say.
 *
 * A bill in this app was a one-shot. `markBillPaid` set `status: 'paid'` and
 * stopped there; nothing ever advanced `due_date`. The add-bill form collected
 * a frequency, stored it, and printed it on the row — "Rent · monthly" — and
 * that word had no behaviour behind it at all. Pay the rent once and it was
 * gone until you typed it again next month.
 *
 * Everything here works on `YYYY-MM-DD` strings in UTC and never constructs a
 * local Date from one. `new Date('2026-08-01')` is midnight UTC, which is the
 * previous day in every American timezone, and a bill that silently moves a day
 * earlier each time it is paid is worse than one that does not move at all.
 * `scripts/check-utc-dates.js` enforces this across the codebase.
 */

/** The cadences a bill may repeat on. `one-time` is a bill that does not. */
const FREQUENCIES = ['one-time', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];

/** Whole months to advance, for the cadences measured in months. */
const MONTH_STEPS = { monthly: 1, quarterly: 3, yearly: 12 };

/** Days to advance, for the cadences measured in days. */
const DAY_STEPS = { weekly: 7, biweekly: 14 };

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days in a given month. `month` is 1-12. */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * The next occurrence of a recurring bill, as `YYYY-MM-DD`.
 *
 * Returns null for `one-time`, for an unknown cadence, and for a date that is
 * not an ISO day — the caller then leaves the bill where it is rather than
 * moving it somewhere invented.
 *
 * Month arithmetic clamps: a bill due on the 31st advances to the 30th of a
 * 30-day month, and to the 28th of a February. It then STAYS on that day —
 * this function only knows the date it is given, so it cannot restore the 31st
 * afterwards. Fixing that properly needs the series' original day stored
 * alongside it, and the Firestore rules for `bills` use `hasOnly()`, so adding
 * a field here would reject every write the web app makes until those rules are
 * deployed. Days 1-28, which is almost every bill, never drift.
 */
function nextDueDate(isoDate, frequency) {
  const match = ISO_DAY.exec(String(isoDate || ''));
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;

  const dayStep = DAY_STEPS[frequency];
  if (dayStep) {
    const moved = new Date(Date.UTC(year, month - 1, day + dayStep));
    return `${moved.getUTCFullYear()}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}`;
  }

  const monthStep = MONTH_STEPS[frequency];
  if (!monthStep) return null;

  const targetIndex = (month - 1) + monthStep;
  const targetYear = year + Math.floor(targetIndex / 12);
  const targetMonth = (targetIndex % 12) + 1;
  return `${targetYear}-${pad(targetMonth)}-${pad(Math.min(day, daysInMonth(targetYear, targetMonth)))}`;
}

/**
 * The occurrence before this one, as `YYYY-MM-DD`. The mirror of
 * `nextDueDate`, and the reason undo works: marking a recurring bill paid
 * moves it forward, so undoing that has to move it back or the bill sits a
 * period in the future with nothing to show for it.
 *
 * Clamps the same way, and is not guaranteed to round-trip through a month
 * end — forward from the 31st then back lands on the 30th. Documented rather
 * than hidden: the alternative is storing the series' original day, which the
 * `hasOnly()` rules on `bills` do not currently permit.
 */
function previousDueDate(isoDate, frequency) {
  const match = ISO_DAY.exec(String(isoDate || ''));
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;

  const dayStep = DAY_STEPS[frequency];
  if (dayStep) {
    const moved = new Date(Date.UTC(year, month - 1, day - dayStep));
    return `${moved.getUTCFullYear()}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}`;
  }

  const monthStep = MONTH_STEPS[frequency];
  if (!monthStep) return null;

  const targetIndex = (month - 1) - monthStep;
  const targetYear = year + Math.floor(targetIndex / 12);
  const targetMonth = ((targetIndex % 12) + 12) % 12 + 1;
  return `${targetYear}-${pad(targetMonth)}-${pad(Math.min(day, daysInMonth(targetYear, targetMonth)))}`;
}

/** Whether a cadence brings the bill back. */
function isRecurring(frequency) {
  return Boolean(DAY_STEPS[frequency] || MONTH_STEPS[frequency]);
}

/**
 * Validate and normalise what a client may set on a bill.
 *
 * Returns `{ fields }` or `{ error }`. Only the fields present in `input` are
 * returned, so this serves both create and a partial update.
 *
 * The field set is deliberately the one the Firestore rules allow. Those rules
 * use `hasOnly()`, which on an update tests the WHOLE resulting document — so a
 * field written here that is not in that allowlist does not merely get ignored,
 * it makes every later client write fail. The web app is currently doing that
 * with `autopay`, which is why editing a bill there silently does nothing.
 */
function normalizeBill(input, { partial = false } = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const fields = {};

  if (source.name !== undefined || !partial) {
    const name = String(source.name == null ? '' : source.name).trim();
    if (!name) return { error: 'A bill needs a name.' };
    if (name.length > 80) return { error: 'That name is too long (80 characters max).' };
    fields.name = name;
  }

  if (source.amount !== undefined || !partial) {
    const amount = Number(source.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { error: 'Enter an amount greater than zero.' };
    }
    // Guards against a fat-fingered figure becoming a runway that reads as a
    // catastrophe, and against Number precision loss further up.
    if (amount > 1_000_000) return { error: 'That amount is too large.' };
    fields.amount = Math.round(amount * 100) / 100;
  }

  if (source.due_date !== undefined || !partial) {
    const due = String(source.due_date == null ? '' : source.due_date).trim();
    const match = ISO_DAY.exec(due);
    if (!match) return { error: 'Enter a due date as YYYY-MM-DD.' };
    const [, y, m, d] = match.map(Number);
    if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) {
      return { error: 'That due date is not a real day.' };
    }
    fields.due_date = due;
  }

  if (source.category !== undefined || !partial) {
    const category = String(source.category == null ? '' : source.category).trim();
    fields.category = category.slice(0, 40) || 'Other';
  }

  if (source.frequency !== undefined || !partial) {
    const frequency = String(source.frequency == null ? '' : source.frequency).trim();
    if (!FREQUENCIES.includes(frequency)) {
      return { error: `Frequency must be one of: ${FREQUENCIES.join(', ')}.` };
    }
    fields.frequency = frequency;
  }

  if (partial && Object.keys(fields).length === 0) {
    return { error: 'Nothing to update.' };
  }

  return { fields };
}

module.exports = {
  FREQUENCIES,
  nextDueDate,
  previousDueDate,
  isRecurring,
  normalizeBill,
  daysInMonth,
};
