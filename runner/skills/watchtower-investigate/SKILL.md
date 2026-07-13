---
name: watchtower-investigate
description: Investigate one evidence-backed Watchtower case in strict read-only mode. Used by the leased Mac mini worker to trace receipts through the product, backend, and Watchtower repositories and produce a structured diagnosis.
---

# Watchtower Investigation

Your structured diagnosis will be written to the case's private GitHub issue. Every conclusion must therefore be specific enough for another engineer to reproduce from the attached receipts.

Use the evidence snapshot in the prompt as the source of truth for this case. Do not call the repair-control API; the worker already owns the case and supplied its evidence.

1. Inspect the exact local repositories and paths named in the prompt.
2. Trace receipt event names, routes, promise evaluators, and business rules before drawing a conclusion.
3. Distinguish product bugs, backend bugs, telemetry gaps, stale data, and legitimate operational states.
4. Name the smallest exact repair and the independent evidence needed to verify recovery.
5. Mark autofix ready only when decisive receipts prove one root cause, no proof gaps remain, and one repository owns the repair.

Hard boundaries:

- Read only. Do not edit files or databases.
- Do not commit, push, deploy, create branches, or mark a case recovered.
- Do not use missing evidence as proof of health.
- Never use "likely", "probably", or a generic suggested next step as a high-confidence root cause.
- A telemetry repair must preserve genuine customer harm and improve attribution; it must not hide the receipt.
- Return only the JSON object requested by the worker's output schema.
