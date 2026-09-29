#!/bin/sh
# Copies the built web client (dist/public) into the iOS app as its bundled game.
#
#   npm run build:client && tools/sync-ios-game.sh
#
# Xcode runs this from the AgentEmpire target's "Bundle game" Run Script phase. There it also copies the
# Game folder into the app bundle, so a plain xcodebuild always ships the current dist/public.
# mobile/ios/AgentEmpire/Game is build output and is git-ignored.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC="$ROOT/dist/public"
DEST="$ROOT/mobile/ios/AgentEmpire/Game"

if [ ! -f "$SRC/index.html" ]; then
  echo "error: $SRC/index.html not found. Build the web client first: run 'npm run build:client' in $ROOT, then build the iOS app again." >&2
  exit 1
fi

# The app only loads the game page. The web sign-in, claim and founder-desk pages and the service worker are
# not needed in the bundle (sign-in is native).
mkdir -p "$DEST"
rsync -a --delete \
  --exclude 'sw.js' --exclude 'login.html' --exclude 'claim.html' --exclude 'consultancy.html' --exclude '*.map' --exclude '.*' \
  "$SRC/" "$DEST/"
echo "Synced $(find "$DEST" -type f | wc -l | tr -d ' ') game files into $DEST"

if [ -n "${TARGET_BUILD_DIR:-}" ] && [ -n "${UNLOCALIZED_RESOURCES_FOLDER_PATH:-}" ]; then
  OUT="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/Game"
  mkdir -p "$OUT"
  rsync -a --delete "$DEST/" "$OUT/"
  echo "Bundled game into $OUT"
fi
