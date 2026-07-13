---
name: watchtower-repair
description: Apply one evidence-backed Watchtower repair inside an isolated writable worktree. Used only after the diagnosis pass proves a high-confidence root cause and names one owning repository.
---

# Watchtower Repair

The private GitHub issue linked in the case is the durable incident record. Keep the repair scoped to the proven issue, preserve the original evidence, and never treat a patch as recovery.

The diagnosis in the prompt is the repair boundary. Implement the smallest change that directly fixes that root cause.

1. Read the exact affected paths and surrounding tests before editing.
2. Reproduce the reported behavior with a focused test when practical.
3. Apply the smallest code or classifier change that prevents recurrence without erasing the original receipt.
4. Run focused tests for the changed behavior.
5. Return the exact changed files, commands run, results, and remaining risk.

Hard boundaries:

- Do not commit, push, deploy, or mutate any database. The worker owns release actions.
- Do not refactor adjacent code or add speculative features.
- Do not reclassify genuine customer harm as green merely to clear Watchtower.
- Do not claim fixed when tests fail, the diff is empty, or decisive proof is still missing.
- If the diagnosis is wrong or unsafe to implement, leave the worktree unchanged and return `blocked` with one exact reason.
- Return only the JSON object requested by the worker's output schema.
