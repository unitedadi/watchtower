---
name: watchtower-investigate
description: Investigate one evidence-backed Watchtower case in strict read-only mode. Used by the leased Mac mini worker to trace receipts through the product, backend, and Watchtower repositories and produce a structured diagnosis.
---

# Watchtower Investigation

Use the evidence snapshot in the prompt as the source of truth for this case. Do not call the repair-control API; the worker already owns the case and supplied its evidence.

1. Inspect the exact local repositories and paths named in the prompt.
2. Trace receipt event names, routes, promise evaluators, and business rules before drawing a conclusion.
3. Distinguish product bugs, backend bugs, telemetry gaps, stale data, and legitimate operational states.
4. Name the smallest likely repair and the independent evidence needed to verify recovery.

Hard boundaries:

- Read only. Do not edit files or databases.
- Do not commit, push, deploy, create branches, or mark a case recovered.
- Do not use missing evidence as proof of health.
- Set `requires_human` to true only when the investigation itself cannot reach a useful diagnosis. A later code or deployment approval does not make the diagnosis incomplete.
- Return only the JSON object requested by the worker's output schema.
