#!/usr/bin/env node
/**
 * check-haptics-gated.js
 *
 * Every haptic must go through FCApp.haptic(), because that is the only place
 * the user's "Haptic feedback" preference is enforced.
 *
 * WHY
 * ---
 * The setting was added by gating FCApp.haptic() — one change silencing all
 * 124 call sites. Except three routes never went through it: fc-auth.js had
 * its own haptic() calling Capacitor directly (nine call sites), and
 * index.html fired Haptics.impact() directly on every onboarding slide change
 * and goal selection.
 *
 * So the toggle flipped, the preference saved, and the phone kept buzzing.
 * A preference that visibly does nothing is worse than no preference: the
 * user concludes the app is broken, and they are right.
 *
 * The single fallback inside fc-auth's own haptic() is allowed — it only runs
 * before fc-app has published FCApp.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

const FILES = ['www/js/fc-app.js', 'www/js/fc-auth.js', 'www/js/fc-data.js',
               'www/js/fc-iap.js', 'www/js/fc-push.js', 'www/index.html'];

/* The two legitimate sinks: fc-app's gated implementation, and fc-auth's
   pre-FCApp fallback. Everything else must delegate. */
/* Each allowed implementation contains TWO sinks — the Capacitor call and a
   navigator.vibrate fallback for the web build — so the ceiling is 2, not 1. */
const ALLOWED = [
  { file: 'www/js/fc-app.js',  max: 2 },   // the gated haptic() itself
  { file: 'www/js/fc-auth.js', max: 2 },   // pre-FCApp fallback only
];

const SINK = /(?:Capacitor\.Plugins\.Haptics|Haptics\(\))\s*\.\s*impact|navigator\.vibrate\s*\(/g;

const problems = [];
for (const rel of FILES) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) continue;
  const src = fs.readFileSync(p, 'utf8');
  const hits = (src.match(SINK) || []).length;
  const allow = (ALLOWED.find(a => a.file === rel) || { max: 0 }).max;
  if (hits > allow) {
    problems.push(`${rel}: ${hits} direct haptic sink(s), only ${allow} allowed`);
  }
}

/* The native lock screen fires its own UIImpactFeedbackGenerator. It is not
   reachable from JS, so it must read the same preference out of
   NSUserDefaults — Capacitor's Preferences plugin writes it under the
   CapacitorStorage prefix. Three calls there ignored the setting, and because
   that screen only appears on resume and Face ID, the buzz came back
   intermittently long after the user had switched haptics off. */
const swift = path.join(root, 'ios/App/App/NativeLockScreenViewController.swift');
if (fs.existsSync(swift)) {
  const src = fs.readFileSync(swift, 'utf8');
  const raw = (src.match(/UIImpactFeedbackGenerator\(style: \.[a-z]+\)\.impactOccurred\(\)/g) || []).length;
  /* The helper itself calls UIImpactFeedbackGenerator(style: style) with a
     VARIABLE, so it does not match this pattern. Any literal style — .light,
     .medium, .heavy — is a call that skipped impact(_:) and therefore the
     preference. Zero is the only acceptable count. */
  if (raw > 0) {
    problems.push(`ios/App/App/NativeLockScreenViewController.swift: ${raw} ungated UIImpactFeedbackGenerator call(s) — route them through impact(_:)`);
  }
  if (!src.includes('CapacitorStorage.fc_haptics_enabled')) {
    problems.push('NativeLockScreenViewController.swift no longer reads the haptics preference');
  }
}

/* The SwiftUI app has the same shape of hole in a different language. There,
   `fcHaptic` is the gate — it wraps `.sensoryFeedback` and returns false from
   the condition closure when `appState.hapticsEnabled` is off. Calling
   `.sensoryFeedback` directly compiles, reads identically in review, and
   ignores the setting entirely.

   One place did: the "Can I afford this?" sheet, the app's signature
   interaction. It also latched — its trigger was `verdict != nil`, true from
   the first answer onward, so only the first purchase you checked ever buzzed.

   The native repository is nested inside this one. When it is absent this
   section is skipped rather than failing on something the developer cannot
   see. */
const nativeRoot = path.join(root, 'FlowCheckSwiftUI/FlowCheckSwiftUI');
const gate = path.join(nativeRoot, 'Core/Design/FlowCheckMotion.swift');
if (fs.existsSync(gate)) {
  const gateSrc = fs.readFileSync(gate, 'utf8');
  if (!/hapticsEnabled/.test(gateSrc)) {
    problems.push('Core/Design/FlowCheckMotion.swift: fcHaptic no longer consults '
      + 'appState.hapticsEnabled — the setting is now decorative app-wide');
  }

  /* Walk every Swift file. The gate itself is the one legitimate caller. */
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.isFile() && e.name.endsWith('.swift') ? [full] : [];
  });

  for (const file of walk(nativeRoot)) {
    if (file === gate) continue;
    const src = fs.readFileSync(file, 'utf8');
    const hits = (src.match(/\.sensoryFeedback\s*\(/g) || []).length;
    if (hits > 0) {
      const rel = path.relative(root, file);
      problems.push(`${rel}: ${hits} direct .sensoryFeedback call(s) — use `
        + `.fcHaptic(_:trigger:), the only place hapticsEnabled is checked`);
    }
  }
}

if (problems.length) {
  console.error('✗ haptics bypass the user preference:\n');
  problems.forEach(p => console.error('  ' + p));
  console.error('\n  Call FCApp.haptic(style) instead. It is the only place the');
  console.error('  "Haptic feedback" setting is enforced — a direct Capacitor call');
  console.error('  keeps buzzing after the user has switched haptics off.');
  console.error('  In the SwiftUI app the equivalent is .fcHaptic(_:trigger:).');
  process.exit(1);
}
console.log('✓ haptics: every trigger — JS, Capacitor native and SwiftUI — honours the preference');
