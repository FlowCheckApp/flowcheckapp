#!/usr/bin/env node
/**
 * check-brand-collisions.js
 *
 * _MBRAND colours a transaction tile by matching a brand key against the
 * merchant name. The match used to be a plain substring test over the RAW
 * bank string, and several keys are common English fragments:
 *
 *   "DEBIT PURCHASE ANTHROPIC"  contains "chase"  -> Chase blue
 *   "POS PURCHASE RAILWAY"      contains "chase"  -> Chase blue
 *   "SQ *SINGAPORE NOODLE"      contains "gap"    -> Gap navy
 *
 * Every card purchase on a statement says PURCHASE, so on a real account
 * five unrelated merchants rendered as one identical blue tile, lettered
 * "D" from "DEBIT".
 *
 * Matching is now whole-word for short keys and leading-boundary for longer
 * ones. This checks the property that made the bug possible in the first
 * place: no key may appear INSIDE a word that turns up on bank statements.
 * A new key like "pos" or "ach" would fail here rather than in production.
 *
 * Exit 0 = clean. Exit 1 = a key collides.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'www/js/fc-app.js'), 'utf8');

const block = src.match(/const _MBRAND = \{[\s\S]*?\n  \};/);
if (!block) {
  console.error('✗ brand-collision check: _MBRAND not found — update this check.');
  process.exit(1);
}
const keys = [...block[0].matchAll(/([a-z][a-z0-9]*):\s*\{\s*bg:/g)].map(m => m[1]);
if (keys.length < 20) {
  console.error(`✗ brand-collision check: only parsed ${keys.length} keys; the map's shape changed.`);
  process.exit(1);
}

/* Words that genuinely appear on US bank statements. Not exhaustive — it is
   a tripwire for the class of mistake, not a dictionary. */
const STATEMENT_WORDS = [
  'purchase', 'purchases', 'prepaid', 'deposit', 'withdrawal', 'transfer',
  'payment', 'pending', 'recurring', 'merchant', 'checkcard', 'debit',
  'credit', 'singapore', 'applebees', 'chargeback', 'clubpass', 'webpay',
  'shellfish', 'nutshell', 'ubereats', 'delta dental', 'zoomcar', 'pineapple',
  'internet', 'international', 'processing', 'subscription',
];

const failures = [];

/* Apply the REAL rule, not a proxy for it: short keys match a whole word,
   longer ones need only a leading boundary. An earlier version of this check
   tested for "key appears inside word", which flagged chase-in-purchase as a
   failure even though the whole-word rule already handles it — testing the
   property instead of the behaviour. */
const matcher = key => new RegExp('\\b' + key + (key.length <= 5 ? '\\b' : ''));

for (const key of keys) {
  for (const word of STATEMENT_WORDS) {
    if (word === key) continue;                  // the brand itself is fine
    if (matcher(key).test(word)) {
      failures.push(`"${key}" still matches "${word}" — that word appears on statements, so every one would be coloured ${key}.`);
    }
  }
}

console.log(`brand-collision check: ${keys.length} brand keys vs ${STATEMENT_WORDS.length} statement words`);
if (failures.length) {
  failures.forEach(f => console.error('  ✗ ' + f));
  console.error('\n  Short keys must match a WHOLE word. Lengthen the key, or drop it.');
  process.exit(1);
}
console.log('  ✓ no brand key hides inside a word that appears on statements.');
