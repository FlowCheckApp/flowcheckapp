#!/usr/bin/env node
/**
 * check-live-updates.js
 *
 * Every Firestore listener must repaint through _scheduleTabRender(), which
 * routes to whichever tab is actually on screen.
 *
 * The bug this exists to prevent:
 *
 *   The scheduler used to be `_scheduleHomeRender` and opened with
 *   `if (state.tab !== 'home') return;`. So an update arriving while the user
 *   sat on any other tab was dropped. Listeners compensated one tab at a time:
 *
 *     _scheduleHomeRender();
 *     if (state.tab === 'activity') _renderActivity();
 *     if (state.tab === 'insights') _renderInsights();
 *
 *   …and the tabs nobody remembered to add simply never live-updated. Money
 *   was one of them. Connect a bank and the accounts land in Firestore within
 *   seconds, but Debt, Savings and Net Worth stayed frozen until you switched
 *   tabs and came back. That was reported as "it takes forever for the debts
 *   and savings to push over" — the data had arrived; the screen was never
 *   told. Goals, Plan and Coach had the same hole.
 *
 * Two rules, both cheap to satisfy:
 *
 *   1. Every listenTo* callback must call _scheduleTabRender() somewhere.
 *   2. No listener body may contain a `state.tab === '…'` render ladder —
 *      that is the pattern that rots. Adding a tab to _activeTabRenderer()
 *      fixes every listener at once; adding an `if` fixes exactly one.
 *
 * Exit 0 = clean. Exit 1 = a listener can go stale.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'www/js/fc-app.js'), 'utf8');
const lineOf = idx => SRC.slice(0, idx).split('\n').length;

/* Listeners that legitimately paint nothing on screen — they update a badge,
   a cached array or a notification schedule. Each one is listed by name so
   adding a new silent listener is a deliberate act, not an omission. */
const NO_RENDER_OK = new Set([
  'listenToUser',          // repaints settings + greeting directly
  'listenToNotifications', // updates the bell badge only
  'listenToCreditHistory', // cached for whichever screen reads it next
]);

/** Extract each `FCData.listenToX(… => { body })` call with a balanced body. */
function listenerBodies(src) {
  const out = [];
  const re = /FCData\.(listenTo\w+)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    // Walk from the opening paren to its match, tracking strings and depth.
    let i = re.lastIndex - 1, depth = 0, q = null;
    for (; i < src.length; i++) {
      const c = src[i];
      if (q) {
        if (c === '\\') { i++; continue; }
        if (c === q) q = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { q = c; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (!depth) break; }
    }
    out.push({ name: m[1], line: lineOf(m.index), body: src.slice(re.lastIndex, i) });
  }
  return out;
}

const failures = [];
const listeners = listenerBodies(SRC);

if (listeners.length < 8) {
  failures.push(`only ${listeners.length} listeners parsed — the matcher is broken, `
    + `not the code. Fix this script before trusting a pass.`);
}

for (const l of listeners) {
  const schedules = /_scheduleTabRender\s*\(/.test(l.body);

  if (!schedules && !NO_RENDER_OK.has(l.name)) {
    failures.push(`www/js/fc-app.js:${l.line} ${l.name} never calls _scheduleTabRender() — `
      + `whatever it updates will not appear until the user switches tabs. If it `
      + `genuinely paints nothing, add it to NO_RENDER_OK with a reason.`);
  }

  const ladder = [...l.body.matchAll(/state\.tab\s*===\s*['"](\w+)['"]\s*\)\s*_render/g)];
  for (const hit of ladder) {
    failures.push(`www/js/fc-app.js:${l.line} ${l.name} hand-rolls a repaint for the `
      + `'${hit[1]}' tab. That is the pattern that left Money frozen: it fixes one `
      + `tab and silently omits the rest. Add the tab to _activeTabRenderer() instead.`);
  }
}

/* The dispatcher itself must still know about every nav tab. `more` is the one
   deliberate omission — it hosts sub-screens drawn on top of it. */
const dispatch = (SRC.match(/function _activeTabRenderer\(\)[\s\S]*?\n  \}/) || [''])[0];
if (!dispatch) {
  failures.push('_activeTabRenderer() is gone — the listeners have nowhere to route.');
} else {
  const navTabs = (SRC.match(/_NAV_TABS = new Set\(\[([^\]]*)\]/) || [, ''])[1]
    .split(',').map(t => t.trim().replace(/['"]/g, '')).filter(Boolean);
  for (const tab of navTabs) {
    if (tab === 'more') continue;
    if (!new RegExp(`case\\s*['"]${tab}['"]`).test(dispatch)) {
      failures.push(`_activeTabRenderer() has no case for the '${tab}' tab, so it will `
        + `never live-update while the user is sitting on it.`);
    }
  }
}

if (failures.length) {
  console.error('Live-update check FAILED:\n');
  failures.forEach(f => console.error('  ✗ ' + f));
  console.error(`\n${failures.length} problem(s).\n`);
  process.exit(1);
}

console.log(`live-update check: ${listeners.length} Firestore listeners, `
  + `all routed through one tab-aware scheduler`);
console.log('✓ no tab can silently stop live-updating.');
