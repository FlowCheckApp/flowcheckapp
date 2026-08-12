#!/usr/bin/env node
/**
 * check-paywall-gate.js
 *
 * FlowCheck is subscription-only. The client gate is `_mayEnterApp()`, and
 * CLAUDE.md is explicit about why it lives in `setScreen` rather than at each
 * caller:
 *
 *   "That check lives in setScreen on purpose — there are a dozen
 *    setScreen('app') call sites and gating them individually is how a hole
 *    gets left."
 *
 * The guard exists. Nothing tested that it still stands, and it is exactly the
 * kind of thing a refactor removes without noticing: the app keeps working for
 * everyone who is paying, and the hole is invisible until someone finds it.
 *
 * This is a STRUCTURAL check, not a behavioural one. It proves there is no
 * ungated route onto the app screen. It does NOT prove `_mayEnterApp()` decides
 * correctly — driving that needs a hook that mutates auth state at runtime, and
 * shipping one of those in a finance app is a worse idea than the coverage is
 * worth. The real enforcement is `requireEntitlement` in backend/server.js;
 * this guards the client's half.
 *
 * Exit 0 = clean. Exit 1 = something can reach the app ungated.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const rel = 'www/js/fc-app.js';
const src = fs.readFileSync(path.join(root, rel), 'utf8');

const failures = [];
const lineOf = idx => src.slice(0, idx).split('\n').length;

/** Extent of a `function <name>(` body, by brace matching. */
function functionBody(name) {
  const start = src.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (start === -1) return null;
  const open = src.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { start, open, end: i, text: src.slice(open, i + 1) };
    }
  }
  return null;
}

const setScreen   = functionBody('setScreen');
const doSetScreen = functionBody('_doSetScreen');

if (!setScreen) {
  failures.push(`${rel} — setScreen() not found. The paywall gate lives in it.`);
} else {
  /* 1. The gate must still be inside setScreen. */
  if (!/_mayEnterApp\s*\(/.test(setScreen.text)) {
    failures.push(`${rel}:${lineOf(setScreen.start)} setScreen() no longer calls `
      + `_mayEnterApp(). Every route onto the app screen is now ungated.`);
  }

  /* 2. Demo mode must be the ONLY exemption, and must be part of the same
        condition — a separate early return above the gate would skip it. */
  const gateLine = (setScreen.text.match(/[^\n]*_mayEnterApp\s*\([^\n]*/) || [''])[0];
  if (!/_isDemoMode/.test(gateLine)) {
    failures.push(`${rel} the _mayEnterApp() check no longer carries the `
      + `_isDemoMode exemption on the same condition. Demo mode is exempt on `
      + `purpose (App Review evaluates the app through it); any OTHER exemption `
      + `is a hole.`);
  }

  /* 3. The gate must route to the paywall, not merely return. */
  if (!/_doSetScreen\(\s*['"]paywall['"]\s*\)/.test(setScreen.text)) {
    failures.push(`${rel} setScreen()'s gate no longer routes to the paywall.`);
  }
}

/* 4. Nothing may reach _doSetScreen except setScreen itself. It is the
      unguarded primitive — a single call from anywhere else is a bypass,
      and is precisely the "hole" CLAUDE.md warns about. */
if (doSetScreen && setScreen) {
  const re = /_doSetScreen\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const i = m.index;
    const insideSetScreen = i > setScreen.open && i < setScreen.end;
    const isDefinition = i >= doSetScreen.start && i <= doSetScreen.open;
    if (insideSetScreen || isDefinition) continue;
    failures.push(`${rel}:${lineOf(i)} calls _doSetScreen() from outside `
      + `setScreen(), bypassing the paywall gate. Call setScreen() instead.`);
  }
}

/* 5. _doSetScreen must not be exported — that would hand the bypass to
      anything with a reference to FCApp, including the console. */
if (/^\s*_doSetScreen\s*,/m.test(src)) {
  failures.push(`${rel} exports _doSetScreen. That is the ungated primitive; `
    + `exporting it makes the gate optional from outside the module.`);
}

if (failures.length) {
  console.error('Paywall gate check FAILED:\n');
  failures.forEach(f => console.error('  ✗ ' + f));
  console.error(`\n${failures.length} problem(s).\n`);
  process.exit(1);
}

const appRoutes = (src.match(/setScreen\(\s*['"]app['"]\s*\)/g) || []).length;
console.log(`paywall gate: ${appRoutes} setScreen('app') call site(s), all funnelled `
  + `through one _mayEnterApp() check`);
console.log('✓ no ungated route onto the app screen.');
