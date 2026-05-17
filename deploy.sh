#!/bin/bash
# FlowCheck — One-command deploy
# Usage: ./deploy.sh "your commit message"

set -e

MSG="${1:-deploy $(date '+%Y-%m-%d %H:%M')}"

echo "🔄 Syncing to iOS..."
cd ~/Desktop/FlowCheck
npx cap sync ios

echo "📦 Pushing monorepo..."
git add -A
git commit -m "$MSG" || echo "Nothing to commit in monorepo"
git push

echo "🚀 Pushing backend to Railway..."
cp ~/Desktop/FlowCheck/backend/server.js ~/Desktop/flowcheck-backend/server.js
cp ~/Desktop/FlowCheck/backend/package.json ~/Desktop/flowcheck-backend/package.json
cp ~/Desktop/FlowCheck/backend/package-lock.json ~/Desktop/flowcheck-backend/package-lock.json
cd ~/Desktop/flowcheck-backend
git add -A
git commit -m "$MSG" || echo "Nothing to commit in backend"
git push

echo "🔥 Deploying Firestore rules..."
cd ~/Desktop/FlowCheck
firebase use flowcheck-46570 --non-interactive
firebase deploy --only firestore:rules

echo "✅ Done! Open Xcode and hit ⌘R to build to device."
open ~/Desktop/FlowCheck/ios/App/App.xcworkspace
