#!/bin/zsh
set -euo pipefail

ENV_FILE="${WATCHTOWER_REPAIR_ENV_FILE:-/Users/mini/codex-runner/config/watchtower-repair.env}"
ROOT="/Users/mini/codex-runner/watchtower"

if [[ ! -f "${ENV_FILE}" ]]; then
  print -u2 "Missing Watchtower repair environment file: ${ENV_FILE}"
  exit 1
fi

set -a
source "${ENV_FILE}"
set +a

case "${1:-}" in
  worker)
    exec /Users/mini/.local/bin/node "${ROOT}/runner/watchtower-repair-worker.mjs"
    ;;
  poller)
    exec /Users/mini/.local/bin/node "${ROOT}/runner/watchtower-repair-poller.mjs"
    ;;
  *)
    print -u2 "Usage: $0 worker|poller"
    exit 2
    ;;
esac
