#!/bin/sh
# Builds and runs the iOS app's policy checks on the Mac (HostPolicy, GameSchemeHandler path resolution, MIME types,
# and the native bridge protocol: request parsing, key allowlist, value validation, reply/config script encoding),
# plus in-app updates: release URLs, versions, zip-slip, the bundle state machine with its 20 s rollback.
# Twice: as a Release build (no DEBUG: trusts only the owner's release key) and as a Debug build (-D DEBUG: also trusts
# the public development key, REL-07).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
SOURCES="$HERE/../AgentEmpire/HostPolicy.swift $HERE/../AgentEmpire/GameSchemeHandler.swift $HERE/../AgentEmpire/BridgeProtocol.swift $HERE/../AgentEmpire/UpdatePolicy.swift $HERE/../AgentEmpire/GameUpdater.swift $HERE/main.swift"
echo "== Release configuration (no DEBUG)"
# shellcheck disable=SC2086
xcrun swiftc -o "$OUT/checks-release" $SOURCES
"$OUT/checks-release"
echo "== Debug configuration (-D DEBUG)"
# shellcheck disable=SC2086
xcrun swiftc -D DEBUG -o "$OUT/checks-debug" $SOURCES
"$OUT/checks-debug"
