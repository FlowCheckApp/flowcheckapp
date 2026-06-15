#!/usr/bin/env node
// Patches CapApp-SPM/Package.swift after `npx cap sync ios` regenerates it.
// @codetrix-studio/capacitor-google-auth (Plugin.swift) imports GoogleSignIn but
// has no SPM Package.swift, so Capacitor doesn't add it automatically.
// This script is called by the postinstall hook in package.json.
const fs = require('fs');
const path = require('path');

const pkgSwift = path.join(__dirname, '../ios/App/CapApp-SPM/Package.swift');

if (!fs.existsSync(pkgSwift)) {
  console.log('[patch-package-swift] Package.swift not found — skipping');
  process.exit(0);
}

let content = fs.readFileSync(pkgSwift, 'utf8');

if (content.includes('GoogleSignIn-iOS')) {
  console.log('[patch-package-swift] GoogleSignIn-iOS already present — no change needed');
  process.exit(0);
}

// Insert the package dependency
const depAnchor = '.package(name: "CapacitorSecureStoragePlugin"';
const depPatch  = `.package(name: "CapacitorSecureStoragePlugin"`;
if (!content.includes(depAnchor)) {
  console.error('[patch-package-swift] Could not find anchor — Package.swift format changed');
  process.exit(1);
}

content = content.replace(
  /\.package\(name: "CapacitorSecureStoragePlugin",[^)]+\)\s*\n(\s*\])/,
  (match, closing) => match.replace(
    /(\s*\])/,
    `,\n        // GoogleSignIn-iOS required by @codetrix-studio/capacitor-google-auth\n        .package(url: "https://github.com/google/GoogleSignIn-iOS.git", exact: "7.1.0")\n    ]`
  )
);

// Insert the target product dependency
content = content.replace(
  /\.product\(name: "CapacitorSecureStoragePlugin", package: "CapacitorSecureStoragePlugin"\)\s*\n(\s*\])/,
  (match, closing) => match.replace(
    /(\s*\])/,
    `,\n                .product(name: "GoogleSignIn", package: "GoogleSignIn-iOS")\n            ]`
  )
);

fs.writeFileSync(pkgSwift, content, 'utf8');
console.log('[patch-package-swift] ✓ Added GoogleSignIn-iOS to CapApp-SPM/Package.swift');
