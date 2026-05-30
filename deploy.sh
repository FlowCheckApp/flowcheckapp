#!/bin/bash
# FlowCheck — One-command deploy
# Usage: ./deploy.sh "your commit message"
#
# What this does:
#   1. Copies www/ files into the iOS Xcode project (no hanging cap sync)
#   2. Commits and pushes everything to GitHub (Railway auto-deploys from this)
#   3. Deploys Firestore rules
#   4. Opens Xcode so you can hit ⌘R

set -e

MSG="${1:-deploy $(date '+%Y-%m-%d %H:%M')}"
ROOT=~/Desktop/FlowCheck

echo "📂 Copying web files to iOS project..."
cp -r "$ROOT/www/css"        "$ROOT/ios/App/App/public/"
cp -r "$ROOT/www/js"         "$ROOT/ios/App/App/public/"
cp -r "$ROOT/www/legal"      "$ROOT/ios/App/App/public/" 2>/dev/null || true
cp    "$ROOT/www/index.html" "$ROOT/ios/App/App/public/index.html"
echo "   ✓ Web files copied"

echo "📦 Committing and pushing to GitHub..."
cd "$ROOT"
git add -A
git commit -m "$MSG" || echo "   Nothing to commit"
git push
echo "   ✓ Pushed — Railway will auto-deploy the backend"

echo "🔥 Deploying Firestore rules..."
cd "$ROOT"
firebase use flowcheck-46570 --non-interactive
firebase deploy --only firestore:rules
echo "   ✓ Firestore rules deployed"

echo ""
echo "✅ Done! Opening Xcode — hit ⌘R to build to device."
open "$ROOT/ios/App/App.xcworkspace"
