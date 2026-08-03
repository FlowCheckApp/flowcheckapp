#!/usr/bin/env node
/**
 * check-core-parity.js
 *
 * fc-core.js is the single implementation of FlowCheck's money math. The
 * phone loads www/js/fc-core.js; the web app at /app loads the copy in
 * backend/public/js/fc-core.js. If those two files ever differ, the website
 * and the phone can show a different "safe to spend" for the same account —
 * which is the one failure this product cannot have.
 *
 * Also asserts fc-app.js still DELEGATES rather than carrying its own copy.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const A = path.join(ROOT, 'www/js/fc-core.js');
const B = path.join(ROOT, 'backend/public/js/fc-core.js');

const problems = [];

if (!fs.existsSync(B)) {
  problems.push('backend/public/js/fc-core.js is missing — the web app has no money math.');
} else {
  const ha = crypto.createHash('sha256').update(fs.readFileSync(A)).digest('hex');
  const hb = crypto.createHash('sha256').update(fs.readFileSync(B)).digest('hex');
  if (ha !== hb) {
    problems.push(
      'www/js/fc-core.js and backend/public/js/fc-core.js have DIVERGED.\n' +
      '    app : ' + ha.slice(0, 16) + '\n' +
      '    web : ' + hb.slice(0, 16) + '\n' +
      '    Fix: cp www/js/fc-core.js backend/public/js/fc-core.js');
  }
}

const app = fs.readFileSync(path.join(ROOT, 'www/js/fc-app.js'), 'utf8');
if (!/FCCore\.buildRunwaySeries\(/.test(app) || !/FCCore\.buildSafeSpendProjection\(/.test(app)) {
  problems.push('fc-app.js no longer delegates to FCCore — it has grown its own copy of the math again.');
}

if (problems.length) {
  console.error('\n✗ core parity broken:\n');
  problems.forEach(p => console.error('  ' + p));
  console.error('');
  process.exit(1);
}
console.log('✓ fc-core.js identical across app + web, and fc-app.js delegates to it.');
