#!/usr/bin/env node
/**
 * check-screen-routes.js
 *
 * Every setScreen('x') must have a matching <section class="fc-screen"
 * data-screen="x"> in index.html.
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * A back button was added to the register screen pointing at
 * setScreen('welcome'). The welcome screen is named 'hero'. Nothing threw:
 * _doSetScreen played the outgoing screen's exit animation, cleaned it up,
 * set body[data-screen="welcome"], found no incoming section to show, and
 * left the user on a blank dark screen with no error and no way back.
 *
 * A typo'd screen name is invisible to node --check, invisible to the DOM-id
 * check (it is a data attribute, not an id), and invisible in review — 'welcome'
 * reads as obviously correct. It only shows up on a device, as a blank app.
 *
 * _doSetScreen now refuses an unknown name at runtime. This catches it at
 * commit time instead, which is where a dead route belongs.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

const html = fs.readFileSync(path.join(root, 'www/index.html'), 'utf8');

const exists = new Set(
  [...html.matchAll(/<section[^>]*class="[^"]*fc-screen[^"]*"[^>]*data-screen="([a-z-]+)"/g)]
    .map(m => m[1])
);
if (!exists.size) {
  console.error('✗ check-screen-routes: found no screen sections at all — the matcher is broken, not the app.');
  process.exit(1);
}

const files = ['www/index.html', 'www/js/fc-app.js', 'www/js/fc-auth.js'];
const bad = [];

for (const rel of files) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) continue;
  const src = fs.readFileSync(full, 'utf8');
  src.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/setScreen\(\s*'([a-z-]+)'\s*\)/g)) {
      if (!exists.has(m[1])) bad.push({ rel, line: i + 1, name: m[1], text: line.trim().slice(0, 90) });
    }
  });
}

if (bad.length) {
  console.error('✗ setScreen() routes to screens that do not exist:\n');
  for (const b of bad) {
    console.error(`  ${b.rel}:${b.line}  setScreen('${b.name}')`);
    console.error(`    ${b.text}`);
  }
  console.error(`\n  Screens that DO exist: ${[...exists].sort().join(', ')}`);
  console.error('\n  A route to a missing screen blanks the app: the old screen exits,');
  console.error('  nothing takes its place, and there is no error and no way back.');
  process.exit(1);
}

console.log(`✓ screen routes: all setScreen() targets exist (${exists.size} screens)`);
