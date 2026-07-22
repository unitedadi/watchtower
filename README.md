# DarDoc Watchtower

The org-wide health dashboard over client telemetry. Every fetch, click, and
business outcome from DarDoc's apps is judged green / yellow / red by the
backend classifier; Watchtower is the view for reviewing it — per project and
for the organization.

- **Org home (`/`)** — one tile per project: today's journey counts, green
  rate, 14-day sparkline, plus an attention strip of reds and UNCLASSIFIED
  events across all projects.
- **Project view (`/p/checkout-web`)** — scoreboard, "walls and failures
  today" ranked by count, the journey table (filter by status), and a
  click-through timeline drawer showing every event in a journey.

## Fixing a problem

Watchtower is the evidence source. Every distinct non-green promise or hard
failure is linked to one durable issue in the private GitHub repository that
owns the customer surface. Repeated observations update that issue instead of
creating duplicates. Use **open GitHub issue** to investigate and fix it;
**copy case** remains available as a fallback.

There is no WhatsApp notifier or always-on repair worker. A merge or deploy
does not close the issue. Watchtower closes it only after independent clean
evidence satisfies the recovery contract.

## Running

```
npm install
npm run dev        # http://localhost:5173
npm run build      # static build in dist/
```

The API base defaults to `https://api-prod.dardoc.com` and can be changed in
the header field (persisted in localStorage) — point it at
`http://localhost:3002` to review a local backend.

## Where the data comes from

- Capture: `src/lib/telemetry.ts` in each app (checkout-web first) reports
  facts to `POST /telemetry/events`.
- Judgment: `src/services/telemetryClassifier.ts` in RealBackend — the single
  place business rules live. Anything unjudged lands as red `UNCLASSIFIED`
  and must be emptied nightly: fix the problem or add a rule.
- Journeys: one checkout intent = one journey; red if anything broke, green
  only if it reached a goal (order created / payment confirmed).
