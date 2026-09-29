#!/bin/sh
# Builds and runs the iOS app's policy checks on the Mac (HostPolicy, GameSchemeHandler path resolution, MIME types).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
xcrun swiftc -o "$OUT/checks" "$HERE/../AgentEmpire/HostPolicy.swift" "$HERE/../AgentEmpire/GameSchemeHandler.swift" "$HERE/main.swift"
"$OUT/checks"
