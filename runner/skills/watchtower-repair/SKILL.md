---
name: watchtower-repair
description: Check, stop, or retry a Watchtower repair case from WhatsApp. Use for messages such as "Watchtower status", "status WT-...", "stop WT-...", or "retry WT-...".
---

# Watchtower Repair Control

Use the deterministic control script. Do not investigate or edit repositories from this skill.

```bash
source /Users/mini/codex-runner/.env
node /Users/mini/codex-runner/scripts/watchtower-repair-control.mjs status [CASE_ID]
node /Users/mini/codex-runner/scripts/watchtower-repair-control.mjs stop CASE_ID
node /Users/mini/codex-runner/scripts/watchtower-repair-control.mjs retry CASE_ID
```

Reply briefly:

- Status: case id, state, title, risk tier, and latest summary.
- Stop/retry: confirm the resulting state.
- Never include credentials, lease tokens, raw environment values, or long JSON.
- Never claim that a diagnosis was deployed or recovered. This phase is read-only.
