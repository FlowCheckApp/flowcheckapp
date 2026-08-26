#!/usr/bin/env node
/**
 * check-native-legal.js — the native app must LINK the documents, not name them.
 *
 * The SwiftUI app shipped "By continuing you agree to our Terms and Privacy
 * Policy" as plain text. Nothing to tap, on the consent footer and on the
 * paywall. An agreement nobody can open is not an agreement, and App Review
 * requires a working Terms of Use and Privacy Policy link on any screen that
 * sells a subscription — 3.1.2 is one of the more reliably enforced rules.
 *
 * It is an easy regression to reintroduce, because plain text and a link look
 * identical in a diff unless you are looking for the brackets.
 *
 * This asserts three things:
 *   1. FCLegal still declares both URLs.
 *   2. Each URL resolves to a page this backend actually serves. `/terms` maps
 *      onto backend/public/terms.html through express.static's
 *      `extensions: ['html']`, so the file has to exist or the link 404s.
 *   3. The consent string still carries markdown links, so nobody flattens it
 *      back to prose.
 *
 * The native repository is nested inside this one. When it is absent — a
 * web-only checkout — this passes rather than failing on something the
 * developer cannot see.
 *
 * Exit 0 = the documents are reachable. Exit 1 = they are named but not linked.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const componentsRel = 'FlowCheckSwiftUI/FlowCheckSwiftUI/Core/Components/FlowCheckComponents.swift';
const componentsPath = path.join(root, componentsRel);

if (!fs.existsSync(componentsPath)) {
  console.log('native legal: native app not present in this checkout — skipped');
  process.exit(0);
}

const src = fs.readFileSync(componentsPath, 'utf8');
const failures = [];

/** The URL assigned to `FCLegal.<name>URL`. */
function declaredURL(name) {
  const match = new RegExp(`static let ${name}URL\\s*=\\s*"([^"]+)"`).exec(src);
  return match ? match[1] : null;
}

const documents = [
  ['terms', 'Terms of Service'],
  ['privacy', 'Privacy Policy'],
];

for (const [key, label] of documents) {
  const url = declaredURL(key);
  if (!url) {
    failures.push(`${componentsRel} — FCLegal.${key}URL is gone. The ${label} `
      + `link is what App Review checks on the paywall.`);
    continue;
  }

  // The path the backend would have to serve for this link to resolve.
  let pathname;
  try {
    pathname = new URL(url).pathname.replace(/^\/+/, '');
  } catch (_) {
    failures.push(`${componentsRel} — FCLegal.${key}URL is not a valid URL: ${url}`);
    continue;
  }

  const candidates = [
    `backend/public/${pathname}`,
    `backend/public/${pathname}.html`,
  ];
  if (!candidates.some(rel => fs.existsSync(path.join(root, rel)))) {
    failures.push(`${url} has nowhere to land — none of ${candidates.join(' or ')} `
      + `exists, so the ${label} link would 404 from inside the app.`);
  }
}

/* The consent line must still be markdown. Plain prose and a linked sentence
   are indistinguishable in a diff, which is exactly how this regressed. */
const consent = /static let consent\s*=\s*"([^"]+)"/.exec(src);
if (!consent) {
  failures.push(`${componentsRel} — FCLegal.consent is gone.`);
} else {
  const links = (consent[1].match(/\]\(/g) || []).length;
  if (links < 2) {
    failures.push(`${componentsRel} — FCLegal.consent has ${links} markdown link(s), `
      + `expected 2. It reads as an agreement but offers nothing to open, which `
      + `is the state this check exists to prevent.`);
  }
}

if (failures.length) {
  console.error('Native legal check FAILED:\n');
  failures.forEach(f => console.error('  ✗ ' + f));
  console.error(`\n${failures.length} problem(s).\n`);
  process.exit(1);
}

console.log('native legal: Terms and Privacy Policy are linked and both resolve');
console.log('✓ the documents can be opened from inside the app.');
