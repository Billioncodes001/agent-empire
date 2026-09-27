#!/bin/sh
set -eu
if [ -n "${AGENT_OFFICE_PASSWORD_FILE:-}" ]; then
  AGENT_OFFICE_PASSWORD=$(cat "$AGENT_OFFICE_PASSWORD_FILE")
  export AGENT_OFFICE_PASSWORD
fi
if [ -z "${AGENT_OFFICE_PASSWORD:-}" ]; then
  echo 'Set AGENT_OFFICE_PASSWORD or AGENT_OFFICE_PASSWORD_FILE before starting the host.' >&2
  exit 1
fi
if ! git -C /workspace rev-parse --git-dir >/dev/null 2>&1; then
  echo 'Mount a writable project Git repository at /workspace (owned by UID 1000).' >&2
  exit 1
fi
exec node /app/bin/agent-office.js /workspace "$@"
