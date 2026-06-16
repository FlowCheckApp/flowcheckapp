#!/usr/bin/env node
// Patches ios/App/App/capacitor.config.json after `npx cap sync` regenerates it.
// `cap sync`'s plugin scanner detects @codetrix-studio/capacitor-google-auth's
// declared native class name ("GoogleAuth") and writes it into the TOP-LEVEL
// packageClassList. But that npm package has no Package.swift, so it's never
// compiled — we ship a hand-written replacement plugin instead
// (CapApp-SPM/Sources/CapApp-SPM/GoogleAuthPlugin.swift, @objc(CapacitorGoogleAuth)).
//
// CapacitorBridge.swift's registerPlugins() decodes ONLY the top-level
// packageClassList key (the nested ios.packageClassList is inert — not part of
// the RegistrationList Codable struct) and calls NSClassFromString(name) for
// each entry. "GoogleAuth" resolves to nil and is silently skipped, so the real
// class "CapacitorGoogleAuth" must be in the TOP-LEVEL list or the plugin never
// registers and Cap().GoogleAuth is undefined in JS.
const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '../ios/App/App/capacitor.config.json');

if (!fs.existsSync(configPath)) {
  console.log('[patch-capacitor-config] capacitor.config.json not found — skipping');
  process.exit(0);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const list = config.packageClassList;

if (!Array.isArray(list)) {
  console.log('[patch-capacitor-config] no top-level packageClassList — skipping');
  process.exit(0);
}

let changed = false;

const wrongIndex = list.indexOf('GoogleAuth');
if (wrongIndex !== -1) {
  list.splice(wrongIndex, 1);
  changed = true;
}

if (!list.includes('CapacitorGoogleAuth')) {
  list.push('CapacitorGoogleAuth');
  changed = true;
}

if (changed) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, '\t') + '\n', 'utf8');
  console.log('[patch-capacitor-config] ✓ Fixed packageClassList: GoogleAuth → CapacitorGoogleAuth');
} else {
  console.log('[patch-capacitor-config] packageClassList already correct — no change needed');
}
