#!/usr/bin/env node
/**
 * check-design-scale.js
 *
 * A design system is only a system if the values are finite. Measured across
 * 606 rendered elements on all five tabs, this app was using 18 distinct font
 * sizes, 13 border radii (including THREE spellings of the same pill —
 * 999px, 99px and 9999px), 7 font weights, and 22 spacing values of which 16
 * were off any scale.
 *
 * That is the mechanism behind the !important debt, not a separate problem
 * from it. With no agreed scale every new screen invents values, those values
 * collide with a neighbour's, and !important is what settles the argument —
 * 728 of them across the stylesheets, against 629 inline styles that outrank
 * all of them anyway.
 *
 * This is a RATCHET, exactly like KNOWN_ORPHANS in check-dom-ids.js: it holds
 * the current counts and fails if they grow. It does not demand the app be
 * refactored to a pure scale today. It demands the drift stop getting worse,
 * and every number below is allowed to go down and never up.
 *
 * Deliberately NOT flagged, because prior audits established them as correct:
 *   · 12.5px segments vs 12px chips — CLAUDE.md calls the 0.5px difference
 *     deliberate, and warns that a sweep mixing them reports a false split.
 *   · 14px card radius on Activity/Settings — fc-premium-screens.css has a
 *     coherent compact-list treatment; design_audit_2026_08_09 flagged this
 *     as a bug, then corrected itself. Do not "fix" it again.
 *
 * Exit 0 = clean or improved. Exit 1 = drift grew.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const SOURCES = [
  'www/css/flowcheck-design-system.css',
  'www/css/fc-screens.css',
  'www/css/fc-premium-screens.css',
  'www/index.html',
];

/* The scale. Anything outside it is drift by definition. */
const SPACING_SCALE = new Set([0, 1, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 56, 64]);
const WEIGHT_SCALE  = new Set([400, 500, 600, 700]);

/* ── Ceilings. Lower these as drift is removed; never raise them. ────────
   Set from the real counts on 2026-08-12, after collapsing 99px -> 999px. */
const CEILING = {
  distinctFontSizes:  40,
  distinctRadii:      21,
  offScaleWeights:     1,   // was 5: 560, 650, 750, 800, 900 — the app's font renders four of them identically
  offScaleSpacing:   469,
  pillSpellings:       0,   // all three spellings gone; --fc-r-pill is the only one
};

const declRe = {
  fontSize:  /font-size:\s*([0-9.]+)px/g,
  radius:    /border-radius:\s*([0-9.]+)(px|%)/g,
  weight:    /font-weight:\s*([0-9]{3})/g,
  spacing:   /(?:padding|margin)(?:-(?:top|bottom|left|right))?:\s*([^;{}"']+)/g,
};

const fontSizes = new Map(), radii = new Map(), weights = new Map(), spacing = new Map();
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

for (const rel of SOURCES) {
  const src = fs.readFileSync(path.join(root, rel), 'utf8');
  let m;
  declRe.fontSize.lastIndex = 0;
  while ((m = declRe.fontSize.exec(src))) bump(fontSizes, parseFloat(m[1]));
  declRe.radius.lastIndex = 0;
  while ((m = declRe.radius.exec(src))) bump(radii, m[1] + m[2]);
  declRe.weight.lastIndex = 0;
  while ((m = declRe.weight.exec(src))) bump(weights, parseInt(m[1], 10));
  declRe.spacing.lastIndex = 0;
  while ((m = declRe.spacing.exec(src))) {
    // Only plain px values — calc()/var()/env() are intentional, not drift.
    if (/calc|var\(|env\(|%/.test(m[1])) continue;
    (m[1].match(/-?[0-9.]+px/g) || []).forEach(tok => bump(spacing, parseFloat(tok)));
  }
}

const offScaleWeights = [...weights.keys()].filter(w => !WEIGHT_SCALE.has(w));
const offScaleSpacing = [...spacing.entries()].filter(([v]) => !SPACING_SCALE.has(Math.abs(v)));
const offScaleSpacingCount = offScaleSpacing.reduce((s, [, n]) => s + n, 0);
const pillSpellings = [...radii.keys()].filter(r => /^9{2,}px$/.test(r));

const actual = {
  distinctFontSizes: fontSizes.size,
  distinctRadii:     radii.size,
  offScaleWeights:   offScaleWeights.length,
  offScaleSpacing:   offScaleSpacingCount,
  pillSpellings:     pillSpellings.length,
};

const failures = [];
for (const [k, ceiling] of Object.entries(CEILING)) {
  if (actual[k] > ceiling) {
    failures.push(`${k}: ${actual[k]} exceeds the ceiling of ${ceiling}`);
  }
}

/* A ratchet that never tightens is a ratchet nobody maintains. */
const improved = Object.entries(CEILING)
  .filter(([k, c]) => actual[k] < c)
  .map(([k, c]) => `${k}: ${actual[k]} (ceiling ${c})`);

if (failures.length) {
  console.error('Design scale check FAILED — drift grew:\n');
  failures.forEach(f => console.error('  ✗ ' + f));
  if (offScaleWeights.length) {
    console.error(`\n  off-scale weights in use: ${offScaleWeights.sort().join(', ')}`);
  }
  const worst = offScaleSpacing.sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (worst.length) {
    console.error(`  most common off-scale spacing: ${worst.map(([v, n]) => v + 'px×' + n).join('  ')}`);
  }
  console.error('\nUse the scale, or lower the ceiling if you removed drift.\n');
  process.exit(1);
}

console.log(`design scale: ${actual.distinctFontSizes} font sizes, ${actual.distinctRadii} radii, `
  + `${actual.offScaleWeights} off-scale weights, ${actual.offScaleSpacing} off-scale spacing decls`);
if (improved.length) {
  console.log('↓ improved since the ceiling was set — lower CEILING in this file:');
  improved.forEach(i => console.log('    ' + i));
}
console.log('✓ design scale drift has not grown.');
