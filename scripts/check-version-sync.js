#!/usr/bin/env node
/**
 * check-version-sync.js
 *
 * package.json and fc-config.js must agree on the app version.
 *
 * WHY
 * ---
 * The version is consumed in three places: package.json (tooling), the
 * Settings screen (which reads FC_CONFIG at runtime) and Sentry's release tag
 * (which now also reads FC_CONFIG). If package.json and FC_CONFIG drift, the
 * two disagree about what is installed — and a wrong Sentry release does not
 * fail loudly, it just files every crash under the wrong build, which is worse
 * than no tag when you are trying to tell whether a release fixed something.
 *
 * iOS is deliberately NOT checked: Info.plist uses $(MARKETING_VERSION), so
 * Xcode owns that number and reading it here would compare a literal to a
 * build variable.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

const cfgSrc = fs.readFileSync(path.join(root, 'www/js/fc-config.js'), 'utf8');
const m = cfgSrc.match(/version:\s*'([^']+)'/);
if (!m) {
  console.error("✗ version-sync: could not find `version:` in www/js/fc-config.js");
  process.exit(1);
}
const cfg = m[1];

if (pkg !== cfg) {
  console.error('✗ version mismatch:\n');
  console.error(`    package.json      ${pkg}`);
  console.error(`    fc-config.js      ${cfg}`);
  console.error('\n  The Settings screen and Sentry\'s release tag both read fc-config.js.');
  console.error('  A mismatch means crashes get filed under the wrong build.');
  process.exit(1);
}

/* The Sentry release must be derived, never a literal. */
const html = fs.readFileSync(path.join(root, 'www/index.html'), 'utf8');
if (/release:\s*'flowcheck@[\d.]+'/.test(html)) {
  console.error("✗ Sentry `release` is hardcoded in www/index.html.");
  console.error("  Build it from FC_CONFIG.app.version so it cannot go stale.");
  process.exit(1);
}

console.log(`✓ version sync: package.json and fc-config.js both ${pkg}; Sentry release is derived`);
