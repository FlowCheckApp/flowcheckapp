#!/usr/bin/env node
/**
 * check-contrast-tokens.js
 *
 * RUN THIS BEFORE SHIPPING ANY CSS CHANGE.
 *
 * A measured sweep of every screen found 55 WCAG-AA contrast failures that no
 * existing check caught, because none of them were syntax errors — they were
 * colours that simply were not dark enough. Two families, both invisible to
 * code review:
 *
 *   1. HARDCODED LIGHT-MODE COLOURS. rgba(7,20,38,0.44) at 2.92:1,
 *      rgba(13,27,46,0.42) at 2.61:1, #147CFF at 3.92:1 — all written before
 *      the accessibility pass darkened the tokens, and all left behind when
 *      it did. CLAUDE.md already says "always use vars, never hardcode
 *      colors"; this turns that from advice into a build failure.
 *
 *   2. ENUMERATED ALPHA MAPS. The onboarding screen mapped inline white text
 *      to dark equivalents by listing specific alpha values. Two values were
 *      never added to the list, so the "Powered by Plaid" trust strip
 *      rendered white-on-white in light mode — invisible, on the screen that
 *      asks for someone's bank login. The catch-all rule that replaced it is
 *      the thing this check protects.
 *
 * This is a STATIC check: it cannot compute rendered contrast, which depends
 * on the composited background. It enforces the two structural rules that
 * made the failures possible in the first place. Rendered contrast is
 * verified in the browser against the real composited backgrounds.
 *
 * Exit 0 = clean. Exit 1 = a known-bad pattern is back.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const CSS_FILES = [
  'www/css/flowcheck-design-system.css',
  'www/css/fc-screens.css',
  'www/css/fc-premium-screens.css',
];

const failures = [];

/* ── Rule 1: colours measured below AA must not come back ────────────
   Each of these was measured in the browser against the surface it is
   actually painted on. They are banned as TEXT colours specifically —
   the same values are fine as fills, borders and shadows. */
const BANNED_TEXT = [
  { re: /color:\s*rgba\(7,\s*20,\s*38,\s*0\.4[04]\)/gi,   was: '2.60–2.92:1', use: '--fc-text-muted / --fc-text-faint' },
  { re: /color:\s*rgba\(13,\s*27,\s*46,\s*0\.4[258]\)/gi, was: '2.61–3.11:1', use: '--fc-text-faint' },
  { re: /color:\s*#147CFF/gi,                             was: '3.92:1',      use: '--fc-accent' },
  // Negative lookbehind on "-" so border-color / background-color are left
  // alone: the amber FILL is correct, it is amber TEXT that is unreadable.
  { re: /(?:^|[^-a-zA-Z])color:\s*var\(--fc-warning\)/gi, was: '2.15:1',      use: '--fc-warning-text' },
];

for (const file of CSS_FILES) {
  const src = read(file);
  src.split('\n').forEach((line, i) => {
    if (/^\s*\/\*/.test(line)) return;              // skip comment lines
    for (const b of BANNED_TEXT) {
      b.re.lastIndex = 0;
      if (b.re.test(line)) {
        failures.push(`${file}:${i + 1} text colour measured at ${b.was}, under WCAG AA 4.5 — use ${b.use}`);
      }
    }
  });
}

/* fc-app.js and index.html carry inline styles too. */
for (const file of ['www/js/fc-app.js', 'www/index.html']) {
  const src = read(file);
  src.split('\n').forEach((line, i) => {
    if (/(?:^|[^-a-zA-Z])color:\s*var\(--fc-warning\)(?!-)/.test(line)) {
      failures.push(`${file}:${i + 1} --fc-warning is 2.15:1 on white — text must use --fc-warning-text`);
    }
  });
}

/* ── Rule 2: the onboarding catch-all must exist ─────────────────────
   Without it, any inline white in the onboarding markup whose alpha is
   not separately enumerated falls through and renders white-on-white in
   light mode. That is exactly how the Plaid strip disappeared. */
const ds = read('www/css/flowcheck-design-system.css');
const CATCH_ALL = /\.fc-ob-screen\s*\[style\*="color:rgba\(255,255,255"\]/;
if (!CATCH_ALL.test(ds)) {
  failures.push(
    'www/css/flowcheck-design-system.css: the .fc-ob-screen inline-white CATCH-ALL rule is gone.\n' +
    '    Without it, onboarding text falls back to white-on-white in light mode for any\n' +
    '    alpha not separately listed. Do not replace it with an enumeration of alphas —\n' +
    '    that is the bug it exists to prevent.');
}

/* Icons in onboarding draw with a hardcoded white stroke; the rule that
   retints them is equally load-bearing and equally easy to delete. */
if (!/\.fc-ob-screen\s+svg\[stroke\^="rgba\(255,255,255"\]/.test(ds)) {
  failures.push(
    'www/css/flowcheck-design-system.css: the .fc-ob-screen svg[stroke^="rgba(255,255,255"] rule is gone.\n' +
    '    Onboarding padlock/trust icons will render white-on-white in light mode.');
}

if (failures.length) {
  console.error('\n✗ contrast-token check failed:\n');
  failures.forEach(f => console.error('  ' + f));
  console.error('\nThese are colours that were measured below WCAG AA in a real browser.');
  console.error('Use the theme-aware tokens — they are AA in both light and dark.\n');
  process.exit(1);
}

console.log(`contrast-token check: ${CSS_FILES.length} stylesheets + 2 inline-style sources`);
console.log('✓ no known-bad text colours, and the onboarding catch-alls are intact.');
