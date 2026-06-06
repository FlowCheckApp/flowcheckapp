#!/bin/bash
# FlowCheck — deploy
# Usage:
#   ./deploy.sh                          # deploy with auto timestamp message
#   ./deploy.sh "my commit message"      # deploy with custom message
#   ./deploy.sh --skip-firebase          # skip Firestore rules deploy
#   ./deploy.sh --no-xcode               # skip opening Xcode (backend-only deploy)
#   ./deploy.sh "msg" --skip-firebase --no-xcode

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SKIP_FIREBASE=false
NO_XCODE=false
MSG=""

# Parse args
for arg in "$@"; do
  case "$arg" in
    --skip-firebase) SKIP_FIREBASE=true ;;
    --no-xcode)      NO_XCODE=true ;;
    *)               MSG="$arg" ;;
  esac
done

[[ -z "$MSG" ]] && MSG="deploy $(date '+%Y-%m-%d %H:%M')"

# Colors
GRN='\033[0;32m'; CYN='\033[0;36m'; RED='\033[0;31m'; DIM='\033[2m'; RST='\033[0m'
step() { echo -e "\n${CYN}▶ $1${RST}"; }
ok()   { echo -e "${GRN}  ✓ $1${RST}"; }
warn() { echo -e "${RED}  ✗ $1${RST}"; }

echo -e "\n${CYN}━━━ FlowCheck Deploy ━━━━━━━━━━━━━━━━━━━━━━━━${RST}"
echo -e "${DIM}  $MSG${RST}"

# ── 1. Copy web files into iOS bundle ───────────────────────────
# Direct copy instead of `npx cap sync ios` — faster and avoids SPM
# resolution delays. Copies exactly what the app needs.
step "Copying web files → iOS bundle"
PUBLIC="$ROOT/ios/App/App/public"

cp -r "$ROOT/www/css"        "$PUBLIC/"
cp -r "$ROOT/www/js"         "$PUBLIC/"
cp    "$ROOT/www/index.html" "$PUBLIC/index.html"
# Optional dirs — skip silently if absent
[[ -d "$ROOT/www/legal"  ]] && cp -r "$ROOT/www/legal"  "$PUBLIC/" || true
[[ -d "$ROOT/www/assets" ]] && cp -r "$ROOT/www/assets" "$PUBLIC/" || true
[[ -d "$ROOT/www/fonts"  ]] && cp -r "$ROOT/www/fonts"  "$PUBLIC/" || true

ok "Web files synced"

# ── 2. Git commit + push ─────────────────────────────────────────
step "Git commit & push"
cd "$ROOT"

# Stage specific paths — never use -A (risks committing .env, keys, etc.)
git add \
  www/ \
  backend/ \
  ios/App/App/public/ \
  ios/App/App/AppDelegate.swift \
  ios/App/App.xcodeproj/project.pbxproj \
  ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved \
  ios/App/App/GoogleService-Info.plist \
  capacitor.config.json \
  firestore.rules \
  firestore.indexes.json \
  deploy.sh 2>/dev/null || true

if git diff --cached --quiet; then
  echo -e "${DIM}  (nothing to commit — pushing anyway)${RST}"
else
  git commit -m "$MSG"
  ok "Committed: $MSG"
fi

git push
ok "Pushed — Railway will auto-deploy backend"

# ── 3. Firestore rules ───────────────────────────────────────────
if [[ "$SKIP_FIREBASE" == false ]]; then
  step "Deploying Firestore rules"
  if command -v firebase &>/dev/null; then
    cd "$ROOT"
    firebase use flowcheck-46570 --non-interactive 2>/dev/null || true
    firebase deploy --only firestore:rules
    ok "Firestore rules deployed"
  else
    warn "firebase CLI not found — skipping rules (run: npm install -g firebase-tools)"
  fi
else
  echo -e "${DIM}  (skipping Firestore — --skip-firebase passed)${RST}"
fi

# ── 4. Open Xcode ───────────────────────────────────────────────
if [[ "$NO_XCODE" == false ]]; then
  step "Opening Xcode"
  XCODE_FILE=""
  if [[ -d "$ROOT/ios/App/App.xcworkspace" ]]; then
    XCODE_FILE="$ROOT/ios/App/App.xcworkspace"
  else
    XCODE_FILE="$ROOT/ios/App/App.xcodeproj"
  fi
  open "$XCODE_FILE"
  ok "Opened $(basename "$XCODE_FILE")"
  echo -e "\n${GRN}━━━ Done — hit ⌘R in Xcode to build to device ━━━${RST}\n"
else
  echo -e "\n${GRN}━━━ Done — backend deploying on Railway ━━━${RST}\n"
fi
