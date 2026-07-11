#!/bin/zsh
set -euo pipefail

source /Users/mini/codex-runner/.env
exec /Users/mini/.nvm/versions/node/v24.16.0/bin/node /Users/mini/codex-runner/scripts/watchtower-repair-worker.mjs
