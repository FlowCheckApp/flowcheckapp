#!/usr/bin/env node
/**
 * check-utc-dates.js
 *
 * FlowCheck stores day keys as 'YYYY-MM-DD' and reads them back with
 * parseDateLocal — i.e. as LOCAL days. Any key produced with
 * `toISOString()` is a UTC day, and the two disagree every evening for
 * every user west of UTC, which is the entire US market.
 *
 * This was not theoretical. Found by audit, all in shipped code:
 *
 *   · The notification feed filtered `due_date < todayStr`. From ~7pm
 *     Central `todayStr` was already TOMORROW, so the reminder for a bill
 *     due that day was dropped as "already passed" — every evening, on the
 *     one day it mattered most.
 *   · Net worth snapshots keyed the evening's reading under tomorrow, so a
 *     single local day got two entries or none, corrupting both the chart
 *     and the "paid down since" span.
 *   · A recurring bill's due_date was WRITTEN in UTC and read local.
 *   · The credit-score month key rolled over a day early at month end.
 *
 * Rule: use FCCore.isoDay(date) for any 'YYYY-MM-DD' or 'YYYY-MM' key.
 * toISOString() is allowed only for a full instant timestamp, where UTC is
 * the correct and intended meaning.
 *
 * Exit 0 = clean. Exit 1 = a UTC day key is back.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = [
  'www/js/fc-app.js', 'www/js/fc-data.js', 'www/js/fc-core.js',
  'www/js/fc-auth.js', 'www/js/fc-vault.js', 'www/js/fc-push.js',
  'backend/public/js/app-web.js',
];

/* A day/month key is toISOString() immediately truncated. A bare
   toISOString() with no slice is a full timestamp and is fine. */
const DAY_KEY = /toISOString\(\)\s*\.\s*(split\(\s*['"]T['"]\s*\)\s*\[\s*0\s*\]|slice\(\s*0\s*,\s*(10|7)\s*\))/;

const failures = [];
let scanned = 0;

for (const rel of FILES) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  fs.readFileSync(abs, 'utf8').split('\n').forEach((line, i) => {
    scanned++;
    if (line.trim().startsWith('*') || line.trim().startsWith('//')) return; // prose
    if (!DAY_KEY.test(line)) return;
    failures.push(`${rel}:${i + 1}\n      ${line.trim().slice(0, 110)}`);
  });
}

if (failures.length) {
  console.error(`UTC date-key check FAILED — ${failures.length} site(s):\n`);
  failures.forEach(f => console.error('  ✗ ' + f));
  console.error('\nUse FCCore.isoDay(d) — it formats the LOCAL day. toISOString()');
  console.error('is only correct for a full instant timestamp.\n');
  process.exit(1);
}

console.log(`UTC date-key check: ${scanned} lines across ${FILES.length} files`);
console.log('✓ every YYYY-MM-DD key is built from the local date.');
