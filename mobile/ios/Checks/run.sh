#!/bin/sh
# Builds and runs the iOS app's policy checks on the Mac (HostPolicy, GameSchemeHandler path resolution, MIME types,
# and the native bridge protocol: request parsing, key allowlist, value validation, reply/config script encoding),
# plus in-app updates: release URLs, versions, zip-slip, the bundle state machine with its 20 s rollback.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
xcrun swiftc -o "$OUT/checks" "$HERE/../AgentEmpire/HostPolicy.swift" "$HERE/../AgentEmpire/GameSchemeHandler.swift" "$HERE/../AgentEmpire/BridgeProtocol.swift" \
  "$HERE/../AgentEmpire/UpdatePolicy.swift" "$HERE/../AgentEmpire/GameUpdater.swift" "$HERE/main.swift"
"$OUT/checks"
