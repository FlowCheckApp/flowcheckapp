'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const files = [
  'www/index.html',
  'www/js/fc-app.js',
  'www/js/fc-auth.js',
  'www/js/fc-data.js',
  'www/js/fc-iap.js',
  'www/css/flowcheck-design-system.css',
];

const checks = [
  {
    label: 'Financial data must not be written to browser storage',
    pattern: /localStorage\.setItem\([^\n]*(?:net.?worth|nw_history|debt|balance|transaction|income|spend|milestone_prev)/i,
  },
  {
    label: 'Session storage is prohibited for app state',
    pattern: /sessionStorage\s*\./,
  },
  {
    label: 'Secure values must not fall back to Preferences/localStorage',
    pattern: /else\s+(?:await\s+)?prefSet\s*\(/,
  },
  {
    label: 'Deprecated purple wealth tokens must not return',
    pattern: /(?:--wv-purple|#7c3aed|rgba\(124\s*,\s*58\s*,\s*237)/i,
  },
];

const failures = [];

for (const relative of files) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  const lines = source.split('\n');

  for (const check of checks) {
    lines.forEach((line, index) => {
      if (check.pattern.test(line)) {
        failures.push(`${relative}:${index + 1} ${check.label}`);
      }
      check.pattern.lastIndex = 0;
    });
  }
}

if (failures.length) {
  console.error('FlowCheck invariant check failed:');
  failures.forEach(failure => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('FlowCheck privacy and brand invariants passed.');
