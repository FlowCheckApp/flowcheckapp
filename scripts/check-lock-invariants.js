#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const lock = read('ios/App/App/NativeLockScreenViewController.swift');
const delegate = read('ios/App/App/AppDelegate.swift');
const plugin = read('ios/App/App/BiometricPlugin.swift');
const app = read('www/js/fc-app.js');
const failures = [];

function requireMatch(source, pattern, message) {
  if (!pattern.test(source)) failures.push(message);
}

function forbid(source, pattern, message) {
  if (pattern.test(source)) failures.push(message);
}

const passwordHandler = lock.match(/@objc private func passwordTapped\(\)[\s\S]*?\n    }/)?.[0] || '';
forbid(passwordHandler, /dismiss\s*\(/,
  'Native password fallback must not dismiss the lock before sign-out acknowledgement');
requireMatch(lock, /private var hasAppeared = false/,
  'Native lock must guard against viewDidAppear re-authentication after alerts');
requireMatch(lock, /name: \.fcNativeSignOutResult/,
  'Native lock must wait for the explicit sign-out result notification');
requireMatch(delegate, /requestSignOutFromLock\(\)/,
  'AppDelegate must bridge password fallback through FlowCheck\'s biometric plugin');
forbid(delegate, /Notification\.Name\("FCSignOutRequested"\)/,
  'AppDelegate must not post the unbridged FCSignOutRequested notification');
requireMatch(plugin, /CAPPluginMethod\(name: "completeSignOut"/,
  'Biometric plugin must expose completeSignOut acknowledgement');
requireMatch(plugin, /notifyListeners\("signOutRequested"/,
  'Biometric plugin must explicitly notify its JavaScript listeners');
requireMatch(app, /BiometricAuth\.addListener\('signOutRequested'/,
  'Web layer must listen on the plugin that emits signOutRequested');
requireMatch(app, /BiometricAuth\.completeSignOut\(\{ success \}\)/,
  'Web layer must acknowledge the result before the lock can dismiss');
requireMatch(delegate, /blurView\.alpha\s*=\s*1/,
  'Privacy overlay must be opaque immediately when the app resigns active');

if (failures.length) {
  console.error('Native lock invariant check failed:');
  failures.forEach(failure => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Native lock invariants passed.');
