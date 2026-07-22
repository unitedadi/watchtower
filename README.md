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

Watchtower is the repair inbox. Open a non-green promise or failure, inspect
its receipts, then use **fix this case** to copy the complete evidence packet
into Codex. The dashboard keeps any previous repair report as history.

There is no WhatsApp notifier or always-on repair worker. A problem is not
treated as handled until someone opens it in Watchtower and verifies the fix.

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
