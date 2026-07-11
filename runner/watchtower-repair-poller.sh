#!/bin/zsh
set -euo pipefail

set -a
source /Users/mini/codex-runner/.env
set +a
exec /Users/mini/.nvm/versions/node/v24.16.0/bin/node /Users/mini/codex-runner/scripts/watchtower-repair-worker.mjs
