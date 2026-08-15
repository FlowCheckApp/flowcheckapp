#!/usr/bin/env node
/**
 * check-sub-screens.js
 *
 * Every _openSubScreen('x') must have a matching <div id="view-x"> to open.
 *
 * WHY THIS EXISTS
 * ---------------
 * The duplicate Bills and Debt screens were deleted in a dead-code pass. The
 * markup went; two routes into it did not. _openSubScreen('bills') survived on
 * Plan > Bills — on the "Manage →" button and on every bill row — pointing at
 * a #view-bills that no longer existed.
 *
 * It was invisible for three compounding reasons:
 *
 *   1. _openSubScreen fired haptic('light') BEFORE looking the element up,
 *      then `if (!el) return`. The button buzzed under your thumb and did
 *      nothing else, which reads as a working control on a slow screen rather
 *      than a broken one.
 *   2. check-dom-ids.js only sees STATIC getElementById('literal') calls. This
 *      id is assembled at runtime — 'view-' + screenId — so the id it actually
 *      wants never appears in the source as a string.
 *   3. check-handlers.js confirmed FCApp._openSubScreen resolves to a real
 *      function. It does. The function is fine; the argument is not.
 *
 * So three separate checks all passed while a user tapped a dead button. This
 * one pairs the call-site literal with the markup and closes that gap.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const JS   = path.join(root, 'www/js/fc-app.js');
const HTML = path.join(root, 'www/index.html');

const js   = fs.readFileSync(JS, 'utf8');
const html = fs.readFileSync(HTML, 'utf8');

/* Call sites. Matches both plain source — _openSubScreen('goals') — and the
   escaped form that appears inside onclick="" attributes built by string
   concatenation: FCApp._openSubScreen(\'goals\'). */
const CALL = /_openSubScreen\(\s*\\?['"]([a-z_-]+)\\?['"]\s*\)/g;

/* Comments must be stripped before scanning. This codebase explains itself at
   length in prose, and several of those notes name the very dead routes they
   are describing — including the one in _openSubScreen recording why #view-bills
   went away. Matching those reports a defect that is only a sentence about a
   defect. Block comments are blanked line-for-line so reported line numbers
   still point at the right place. */
function stripComments(src) {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
  return noBlocks
    .split('\n')
    // Only a // that starts a line or follows whitespace — never the one in
    // an https:// URL, which is preceded by a colon.
    .map(line => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

const calls = new Map();            // screenId -> [line numbers]
stripComments(js).split('\n').forEach((line, i) => {
  let m;
  CALL.lastIndex = 0;
  while ((m = CALL.exec(line))) {
    if (!calls.has(m[1])) calls.set(m[1], []);
    calls.get(m[1]).push(i + 1);
  }
});

/* Targets that exist in the markup. */
const views = new Set();
const VIEW = /id=["']view-([a-z_-]+)["']/g;
let v;
while ((v = VIEW.exec(html))) views.add(v[1]);

const dead = [...calls.entries()].filter(([id]) => !views.has(id));

if (dead.length) {
  console.error(`\n✗ ${dead.length} sub-screen route(s) point at a view that does not exist:\n`);
  for (const [id, lines] of dead) {
    console.error(`  _openSubScreen('${id}') → #view-${id} is missing`);
    console.error(`    fc-app.js:${lines.join(', fc-app.js:')}`);
  }
  console.error('\nEither restore the screen, or route the call somewhere real.');
  console.error('Screens folded into a tab are reached with switchTab(...) plus');
  console.error('their segment switcher — e.g. bills:');
  console.error("  switchTab('activity'); switchActivitySegment('bills')\n");
  process.exit(1);
}

console.log(`sub-screen check: ${calls.size} distinct route(s), ${views.size} view(s) defined`);
console.log('✓ every _openSubScreen target resolves to a real view.');
