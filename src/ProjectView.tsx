import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";

import {
  fetchFindings,
  fetchJourneyEvents,
  fetchJourneys,
  fetchPromises,
  fetchRepairCases,
  fetchSummary,
  windowDays,
  type Finding,
  type Range,
  type JourneyEvent,
  type JourneyRow,
  type PromiseVerdictRow,
  type PromiseReceipt,
  type RepairCase,
  type ReasonRow,
  type ReasonSample,
  type SummaryResponse,
} from "./api";
import { Chip, CopyButton, Dot, Skeleton, offsetLabel, spanLabel, timeShort } from "./ui";

const CLS_FILTERS = ["all", "red", "yellow", "green", "active"] as const;
const EV_FILTERS = ["all", "red", "yellow", "green", "info"] as const;

const PROMISE_STATUS_CLS: Record<PromiseVerdictRow["status"], string> = {
  held: "green",
  degraded: "yellow",
  broken: "red",
  unverified: "gray",
};

// Plain-English names for the machine reasons, so the headline reads like a
// sentence a human wrote, not an error code.
const REASON_LABEL: Record<string, string> = {
  checkout_intent_expired: "opened an expired link",
  checkout_intent_no_longer_valid: "opened a dead/replaced link",
  checkout_intent_superseded: "opened a replaced link",
  slot_unavailable: "no time slot available",
  slot_too_soon: "picked a too-soon slot",
  address_unserviceable: "address not in a served area",
  address_outside_service_zone: "address not in a served area",
  promo_rejected: "promo code rejected",
  third_party_script_error: "hit a marketing-tag error (non-blocking)",
  client_exception: "hit an app error",
  validation_error: "sent a bad request (our bug)",
  network_error: "lost their connection",
  payment_sheet_failed: "payment sheet failed to load",
  payment_stuck: "payment never came back",
  false_green_payment: "shown paid but money not captured",
  // iOS app reasons
  goal_rx_subscription_activated: "Rx subscription activated",
  goal_consultation_booked: "consultation booked",
  registration_completed: "finished signup",
  goal_registration_completed: "finished signup",
  user_cancelled_payment: "closed the payment sheet",
  apple_pay_unavailable: "Apple Pay not available on device",
  payment_result_timeout: "paid but app never saw confirmation",
  rx_activation_pending: "paid, Rx activation still pending",
  rx_checkout_not_complete: "Rx activation still processing",
  auth_token_missing: "asked to sign in mid-action",
  memory_warning: "device ran low on memory",
  app_hang: "app froze",
  app_crash: "app crashed",
  checkout_create_failed: "checkout could not be created",
  checkout_prerequisite_missing: "checkout was missing required state",
  maps_lookup_failed: "address lookup failed",
  capture_queue_overflow: "telemetry queue dropped evidence",
  capture_event_rejected: "backend rejected telemetry evidence",
  voip_registration_failed: "doctor-call notifications could not register",
};

interface Headline {
  total: number;
  completed: number;
  broke: JourneyRow[];
  walls: Array<{ reason: string; label: string; n: number; cls: string }>;
  bounced: number;
}

// Bucket journeys into what a human actually wants: who finished, who broke,
// who hit a nameable wall, who just opened a link and left.
function summarizeJourneys(journeys: JourneyRow[]): Headline {
  const broke = journeys.filter((j) => j.journey_cls === "red");
  const completed = journeys.filter((j) => j.goal).length;
  const wallMap = new Map<string, { n: number; cls: string }>();
  let bounced = 0;
  for (const j of journeys) {
    if (j.journey_cls === "red" || j.goal) continue;
    const r = j.primary_reason;
    if (r) {
      const prev = wallMap.get(r) ?? { n: 0, cls: j.journey_cls };
      wallMap.set(r, { n: prev.n + 1, cls: j.journey_cls });
    } else {
      bounced += 1;
    }
  }
  const walls = Array.from(wallMap.entries())
    .map(([reason, v]) => ({ reason, label: REASON_LABEL[reason] ?? reason.replace(/_/g, " "), n: v.n, cls: v.cls }))
    .sort((a, b) => b.n - a.n);
  return { total: journeys.length, completed, broke, walls, bounced };
}

const SEVERITY_CLS: Record<Finding["severity"], string> = {
  critical: "red",
  high: "red",
  medium: "yellow",
  low: "info",
};

function codexHandoffText(f: Finding): string {
  if (!f.codex_handoff) return "";
  const lines = [
    `Problem: ${f.codex_handoff.problem}`,
    `Expected: ${f.codex_handoff.expected}`,
    "",
    "Observed:",
    ...f.codex_handoff.observed.map((line) => `- ${line}`),
    "",
    "Receipts:",
    ...f.codex_handoff.receipts.map((line) => `- ${line}`),
    "",
    `Autofix ready: ${f.autofix?.ready ? "yes" : "no"}`,
    `Autofix gate: ${f.autofix?.reason ?? "not provided"}`,
  ];
  if (f.autofix?.repo) lines.push(`Repo: ${f.autofix.repo}`);
  if (f.autofix?.files?.length) lines.push(`Files: ${f.autofix.files.join(", ")}`);
  lines.push("", "Prompt:", f.codex_handoff.prompt);
  return lines.join("\n");
}

function emptyJourneysCopy(cls: (typeof CLS_FILTERS)[number], range: Range, date: string): string {
  if (cls !== "all") return "no journeys match this filter";
  if (range === "today") return `no checkout journeys recorded yet today (${date})`;
  if (range === "yesterday") return `no checkout journeys recorded for ${date}`;
  return "no checkout journeys recorded in this window";
}

function FindingRow({ f, onOpen }: { f: Finding; onOpen: (j: string) => void }) {
  const handoff = codexHandoffText(f);
  return (
    <div className="finding">
      <div className="finding-head">
        <span className={`chip ${SEVERITY_CLS[f.severity]}`}>
          <span className="d" />
          {f.severity}
        </span>
        <span className="finding-title">{f.title}</span>
        {f.confidence && <span className="finding-affected mono">{f.confidence} confidence</span>}
        <span className="finding-affected mono">{f.affected} affected</span>
      </div>
      <div className="finding-body">
        <p className="finding-cause">{f.root_cause}</p>
        {f.evidence_summary && f.evidence_summary.length > 0 && (
          <div className="finding-ev">
            <span className="fl">proof</span>
            <span className="mono">{f.evidence_summary.join(" · ")}</span>
          </div>
        )}
        <p className="finding-impact">
          <span className="fl">impact</span> {f.impact}
        </p>
        <p className="finding-fix">
          <span className="fl">fix</span> {f.suggested_fix}
        </p>
        {f.evidence.length > 0 && (
          <div className="finding-ev">
            <span className="fl">evidence</span>
            {f.evidence.map((j) => (
              <button key={j} className="receipt" onClick={() => onOpen(j)}>
                {j.slice(0, 22)}
              </button>
            ))}
          </div>
        )}
        {handoff && (
          <details className="meta">
            <summary>Codex handoff</summary>
            <pre>{handoff}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

function Headline({
  h,
  project,
  promises,
  promiseError,
  onPick,
}: {
  h: Headline;
  project: string;
  promises: PromiseVerdictRow[] | null;
  promiseError: string | null;
  onPick: (c: "all" | "red" | "green") => void;
}) {
  const ops = project === "ops-portal";
  const hasJourneys = h.total > 0;
  const brokenPromises = promises?.filter((promise) => promise.status === "broken").length ?? 0;
  const degradedPromises = promises?.filter((promise) => promise.status === "degraded").length ?? 0;
  const unverifiedPromises = promises?.filter((promise) => promise.status === "unverified").length ?? 0;
  const promiseCatalogMissing = promiseError !== null || (promises !== null && promises.length === 0);
  const verdictCls =
    brokenPromises > 0 || h.broke.length > 0
      ? "red"
      : degradedPromises > 0
        ? "yellow"
        : unverifiedPromises > 0 || promiseCatalogMissing || promises === null
          ? "yellow"
          : "green";
  const verdict = brokenPromises > 0
    ? `${brokenPromises} ${brokenPromises === 1 ? "promise" : "promises"} broken`
    : h.broke.length > 0
      ? `${h.broke.length} ${h.broke.length === 1 ? "journey" : "journeys"} broke`
      : degradedPromises > 0
        ? `${degradedPromises} ${degradedPromises === 1 ? "promise" : "promises"} degraded`
        : unverifiedPromises > 0
          ? "green not yet proven"
          : promiseCatalogMissing
            ? "promise evidence unavailable"
            : promises === null
              ? "checking promises"
              : "all promises held";
  return (
    <div className="headline">
      <div className="headline-top">
        <span className={`hl-verdict ${verdictCls}`}>
          <span className={`dot ${verdictCls}`} />
          {verdict}
        </span>
        {hasJourneys ? (
          <span className="hl-line">
            <b>{h.total}</b> {ops ? "work journeys" : "sessions"} ·{" "}
            <button className="hl-num green" onClick={() => onPick("green")}>
              {h.completed} {ops ? "verified" : "completed"}
            </button>{" "}
            ·{" "}
            <button className="hl-num red" onClick={() => onPick("red")}>
              {h.broke.length} broke
            </button>{" "}
            · <span className="faint">{h.bounced} {ops ? "unresolved" : "opened & left"}</span>
          </span>
        ) : (
          <span className="hl-line">
            <b>0</b> {ops ? "work journeys · no captured CX work" : "sessions · no customer evidence in this selected window"}
          </span>
        )}
      </div>
      {promises && promises.length > 0 && (
        <div className="hl-walls">
          <span className="hl-wall">
            <span className="dot green" />
            <b>{promises.filter((promise) => promise.status === "held").length}</b> held
          </span>
          {degradedPromises > 0 && (
            <span className="hl-wall"><span className="dot yellow" /><b>{degradedPromises}</b> degraded</span>
          )}
          {brokenPromises > 0 && (
            <span className="hl-wall"><span className="dot red" /><b>{brokenPromises}</b> broken</span>
          )}
          {unverifiedPromises > 0 && (
            <span className="hl-wall"><span className="dot gray" /><b>{unverifiedPromises}</b> unverified</span>
          )}
        </div>
      )}
      {hasJourneys && h.walls.length > 0 && (
        <div className="hl-walls">
          {h.walls.map((w) => (
            <span key={w.reason} className="hl-wall">
              <span className={`dot ${w.cls}`} />
              <b>{w.n}</b> {w.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function sampleTitle(sample: ReasonSample): string {
  const bits = [
    `journey ${sample.journey_id}`,
    `event ${sample.event_id}`,
    sample.name,
    sample.http_status ? `status ${sample.http_status}` : null,
    sample.error_code ? `code ${sample.error_code}` : null,
    sample.path,
    timeShort(sample.created_at),
  ].filter(Boolean);
  return bits.join(" · ");
}

function reasonLabel(reason: string): string {
  return REASON_LABEL[reason] ?? reason.replace(/_/g, " ");
}

function projectRepositories(project: string): string[] {
  if (project === "ios-app") {
    return [
      "- iOS app: /Users/aditya/Documents/DarDocAppCodex/DarDoc",
      "- Backend and promise engine: /Users/aditya/Documents/RealBackend-dev-clean",
      "- Watchtower UI: /Users/aditya/Documents/DarDocWatchtower",
    ];
  }
  if (project === "ops-portal") {
    return [
      "- Ops Portal: /Users/aditya/Documents/dardoc-ops-portal",
      "- Backend and promise engine: /Users/aditya/Documents/RealBackend-dev-clean",
      "- Watchtower UI: /Users/aditya/Documents/DarDocWatchtower",
    ];
  }
  return [
    "- Checkout app: /Users/aditya/Documents/checkout-dardoc",
    "- Backend and promise engine: /Users/aditya/Documents/RealBackend-dev-clean",
    "- Watchtower UI: /Users/aditya/Documents/DarDocWatchtower",
  ];
}

function receiptStatusCls(sample: ReasonSample): string {
  if (!sample.http_status) return "";
  return sample.http_status >= 400 ? "st-bad" : "st-ok";
}

function sampleCaseLine(sample: ReasonSample): string {
  const request = sample.path ?? sample.name;
  return [
    `event_id=${sample.event_id}`,
    `journey_id=${sample.journey_id}`,
    `session_id=${sample.session_id}`,
    sample.http_status ? `http_status=${sample.http_status}` : null,
    sample.error_code ? `error_code=${sample.error_code}` : null,
    request ? `request=${request}` : null,
    sample.surface ? `surface=${sample.surface}` : null,
    sample.vertical ? `vertical=${sample.vertical}` : null,
    `created_at=${sample.created_at}`,
  ]
    .filter(Boolean)
    .join(" | ");
}

function buildProblemCasePrompt(params: { project: string; range: Range; date: string; reason: ReasonRow }): string {
  const { project, range, date, reason } = params;
  const samples = reason.samples ?? [];
  const label = reasonLabel(reason.reason);
  const receipts =
    samples.length > 0
      ? samples.map((sample, index) => `${index + 1}. ${sampleCaseLine(sample)}`).join("\n")
      : "No sample receipts were attached by the backend for this reason row.";

  return [
    "You are Codex. Investigate and fix this customer-experience problem.",
    "",
    `Product: ${project}`,
    `Selected window: ${range} (${date}, Asia/Dubai day)`,
    `Problem: ${label}`,
    `Machine reason: ${reason.reason}`,
    `Severity class: ${reason.cls}`,
    `Observed count: ${reason.n} event${reason.n === 1 ? "" : "s"}`,
    `Receipt samples included: ${samples.length}`,
    "",
    "Repositories:",
    ...projectRepositories(project),
    "",
    "What happened:",
    `- Watchtower classified ${reason.n} event${reason.n === 1 ? "" : "s"} as ${reason.cls} for ${reason.reason}.`,
    "- Treat this as not-green until the exact cause is understood and either fixed or deliberately reclassified with evidence.",
    "",
    "Receipts:",
    receipts,
    "",
    "Fix brief:",
    "- Open the listed product, backend, and Watchtower repositories and trace the exact request or event names in the receipts.",
    project === "ops-portal"
      ? "- Reproduce or explain why the CX action failed or why the displayed state disagreed with source truth."
      : "- Reproduce or explain why the customer hit this condition.",
    "- Patch the smallest code path that prevents the broken or misleading experience.",
    "- Add/adjust focused tests or telemetry classification only if that is required to prevent missing this again.",
    "- Verify against the same receipt shape before marking the case done.",
  ].join("\n");
}

function buildPromiseCasePrompt(params: {
  project: string;
  range: Range;
  date: string;
  promise: PromiseVerdictRow;
}): string {
  const { project, range, date, promise } = params;
  const samples = Array.from(new Set(promise.evidence.samples ?? []));
  const notes = promise.evidence.notes ?? [];
  const proofGaps = promise.evidence.proof_gaps ?? [];
  const receipts = promise.evidence.receipts ?? [];
  const sourceReceipts = promise.evidence.source_receipts ?? [];
  const notGreen = promise.status !== "held";
  const checkedAt = promise.checked_at ? `Checked at: ${promise.checked_at}` : null;
  const repositories = projectRepositories(project);

  const receiptTimeline =
    receipts.length > 0
      ? receipts.map((receipt, index) => `${index + 1}. ${promiseReceiptLine(receipt)}`).join("\n")
      : sourceReceipts.length > 0
        ? "No client event timeline applies to this independent source-truth invariant; use the source receipts below."
        : "No receipt timeline was attached. Treat the missing receipts as an evidence-engine defect, not as proof that nothing broke.";

  const sourceReceiptTimeline =
    sourceReceipts.length > 0
      ? sourceReceipts
          .map((receipt, index) =>
            `${index + 1}. source=${receipt.source} | subject=${receipt.subject}` +
            `${receipt.observed_at ? ` | observed_at=${receipt.observed_at}` : ""} | facts=${JSON.stringify(receipt.facts)}`,
          )
          .join("\n")
      : "No independent source-truth receipts attached.";

  return [
    "You are Codex. Investigate and fix this Watchtower promise.",
    "",
    `Product: ${project}`,
    `Selected window: ${range} (${date}, Asia/Dubai day)`,
    `Promise: ${promise.title}`,
    `Promise id: ${promise.promise_id}`,
    `Statement: ${promise.statement}`,
    `Status: ${promise.status}`,
    `Headline: ${promise.headline}`,
    checkedAt,
    "",
    "Repositories:",
    ...repositories,
    "",
    "Why this matters:",
    notGreen
      ? `- Watchtower marked this promise ${promise.status}. Treat the product as not-green until the cause is fixed or deliberately reclassified with stronger evidence.`
      : "- Watchtower marked this promise held. Use this case to verify the evidence is still strong enough to keep it green.",
    "",
    "Evidence facts:",
    JSON.stringify(promise.evidence.facts ?? {}, null, 2),
    "",
    "Evidence notes:",
    notes.length > 0 ? notes.map((note) => `- ${note}`).join("\n") : "No notes attached.",
    "",
    "Missing proof:",
    proofGaps.length > 0 ? proofGaps.map((gap) => `- ${gap}`).join("\n") : "No declared proof gaps.",
    "",
    "Sample journeys:",
    samples.length > 0 ? samples.map((sample, index) => `${index + 1}. ${sample}`).join("\n") : "No sample journeys attached.",
    "",
    `Receipt timeline (${receipts.length} event${receipts.length === 1 ? "" : "s"}):`,
    receiptTimeline,
    "",
    `Source-truth receipts (${sourceReceipts.length}):`,
    sourceReceiptTimeline,
    "",
    "Fix brief:",
    "- Open the listed app, backend, and Watchtower repositories and trace the exact event names, request ids, and paths in the receipts.",
    "- If the customer experience is genuinely broken, patch the smallest product or backend path.",
    "- If the verdict is stale, vague, missing receipts, or has a proof gap, strengthen the evidence engine; never turn it green from absence of errors.",
    "- Verify by rerunning this promise window and confirming the status, headline, and evidence changed as intended.",
  ]
    .filter(Boolean)
    .join("\n");
}

function promiseReceiptLine(receipt: PromiseReceipt): string {
  const requestId = typeof receipt.meta?.request_id === "string" ? receipt.meta.request_id : null;
  return [
    `event_id=${receipt.event_id}`,
    receipt.client_event_id ? `client_event_id=${receipt.client_event_id}` : null,
    requestId ? `request_id=${requestId}` : null,
    `journey_id=${receipt.journey_id}`,
    `source=${receipt.session_id === "backend-observer" || receipt.session_id === "server" ? "backend" : "client"}`,
    `class=${receipt.cls}`,
    `reason=${receipt.reason}`,
    `name=${receipt.name}`,
    receipt.http_status != null ? `http_status=${receipt.http_status}` : null,
    receipt.error_code ? `error_code=${receipt.error_code}` : null,
    receipt.path ? `path=${receipt.path}` : null,
    receipt.surface ? `surface=${receipt.surface}` : null,
    receipt.vertical ? `vertical=${receipt.vertical}` : null,
    `observed_at=${receipt.observed_at}`,
    `ingested_at=${receipt.ingested_at}`,
  ]
    .filter(Boolean)
    .join(" | ");
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy selection path. Some embedded browsers expose
      // navigator.clipboard but reject writes even after a click.
    }
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "true");
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textArea);
  return copied;
}

function CopyCaseButton({ prompt, secondary = false }: { prompt: string; secondary?: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "ready">("idle");
  return (
    <span className="casecopy">
      <button
        className={`casebtn${secondary ? " casebtn-secondary" : ""}`}
        title="Copy this evidence-backed case for Codex"
        onClick={async (e) => {
          e.stopPropagation();
          const copied = await copyTextToClipboard(prompt);
          if (!copied) {
            setState("ready");
            return;
          }
          setState("copied");
          window.setTimeout(() => setState("idle"), 1400);
        }}
      >
        {state === "copied" ? "case copied" : state === "ready" ? "case ready" : secondary ? "copy case" : "fix this case"}
      </button>
      {state === "ready" && (
        <textarea
          className="case-draft"
          readOnly
          aria-label="case prompt"
          value={prompt}
          onClick={(e) => {
            e.stopPropagation();
            e.currentTarget.select();
          }}
          onFocus={(e) => e.currentTarget.select()}
        />
      )}
    </span>
  );
}

const REPAIR_STATE_LABEL: Record<RepairCase["state"], string> = {
  QUEUED: "queued",
  ISSUE_OPEN: "issue open",
  CLAIMED: "in progress",
  INVESTIGATED: "diagnosis only",
  PATCH_READY: "tested patch ready",
  SHIPPED: "fix shipped",
  NEEDS_HUMAN: "blocked — not fixed",
  STOPPED: "stopped",
  RECOVERED: "recovered",
};

type ReportValue = Record<string, unknown>;

function reportObject(value: unknown): ReportValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ReportValue : null;
}

function reportStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function RepairReport({ repairCase }: { repairCase: RepairCase }) {
  const report = reportObject(repairCase.latest_report);
  if (!report && !repairCase.latest_summary) return null;

  const diagnosis = reportObject(report?.diagnosis) ?? report;
  const repair = reportObject(report?.repair);
  const release = reportObject(report?.release);
  const evidence = Array.isArray(diagnosis?.decisive_evidence)
    ? diagnosis.decisive_evidence.map(reportObject).filter((item): item is ReportValue => item !== null)
    : [];
  const tests = Array.isArray(release?.tests)
    ? release.tests.map(reportObject).filter((item): item is ReportValue => item !== null)
    : Array.isArray(repair?.tests_run)
      ? repair.tests_run.map(reportObject).filter((item): item is ReportValue => item !== null)
      : [];
  const blocker = [
    report?.execution_error,
    repair?.blocker,
    diagnosis?.blocker,
    repairCase.state === "NEEDS_HUMAN" ? repairCase.latest_summary : null,
  ].find((value): value is string => typeof value === "string" && value.length > 0);
  const solution = typeof repair?.solution === "string" && repair.solution.length > 0
    ? repair.solution
    : reportStrings(diagnosis?.repair_plan)[0];
  const risks = [...reportStrings(diagnosis?.proof_gaps), ...reportStrings(repair?.remaining_risks)];

  return (
    <details className="repair-report">
      <summary>case history</summary>
      <div className="repair-report-body">
        {repairCase.github_issue_url && (
          <section>
            <div className="repair-report-label">GitHub issue</div>
            <a className="repair-report-link mono" href={repairCase.github_issue_url} target="_blank" rel="noreferrer">
              {repairCase.github_issue_repository}#{repairCase.github_issue_number}
            </a>
          </section>
        )}
        {typeof diagnosis?.customer_impact === "string" && (
          <section>
            <div className="repair-report-label">Customer impact</div>
            <p>{diagnosis.customer_impact}</p>
          </section>
        )}
        {typeof diagnosis?.root_cause === "string" && (
          <section>
            <div className="repair-report-label">Root cause</div>
            <p>{diagnosis.root_cause}</p>
          </section>
        )}
        {evidence.length > 0 && (
          <section>
            <div className="repair-report-label">Decisive evidence</div>
            <ul>
              {evidence.map((item, index) => (
                <li key={`${String(item.receipt ?? "receipt")}-${index}`}>
                  {String(item.fact ?? "Evidence attached")}
                  {item.receipt ? <span className="mono"> {String(item.receipt)}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        )}
        {solution && (
          <section>
            <div className="repair-report-label">Solution</div>
            <p>{solution}</p>
          </section>
        )}
        {blocker && repairCase.state === "NEEDS_HUMAN" && (
          <section className="repair-report-blocker">
            <div className="repair-report-label">Why it stopped</div>
            <p>{blocker}</p>
          </section>
        )}
        {tests.length > 0 && (
          <section>
            <div className="repair-report-label">Tests</div>
            <ul>
              {tests.map((test, index) => (
                <li key={`${String(test.command ?? "test")}-${index}`}>
                  <span className="mono">{String(test.command ?? "validation")}</span>: {String(test.result ?? "recorded")}
                </li>
              ))}
            </ul>
          </section>
        )}
        {release && Boolean(release.commit || release.branch) && (
          <section>
            <div className="repair-report-label">Patch</div>
            {release.commit ? <p className="mono">commit {String(release.commit)}</p> : null}
            {release.branch ? <p className="mono">branch {String(release.branch)}</p> : null}
          </section>
        )}
        {risks.length > 0 && (
          <section>
            <div className="repair-report-label">Still owed</div>
            <ul>{risks.map((risk) => <li key={risk}>{risk}</li>)}</ul>
          </section>
        )}
        {!report && repairCase.latest_summary && <p>{repairCase.latest_summary}</p>}
      </div>
    </details>
  );
}

function RepairActions({ repairCase, prompt }: { repairCase?: RepairCase; prompt: string }) {
  const historical = repairCase && repairCase.state !== "QUEUED" && repairCase.state !== "CLAIMED";
  const issueUrl = repairCase?.github_issue_url;
  return (
    <div className="repair-actions">
      {issueUrl ? (
        <>
          <a
            className="casebtn"
            href={issueUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
          >
            open GitHub issue
          </a>
          <CopyCaseButton prompt={prompt} secondary />
        </>
      ) : (
        <CopyCaseButton prompt={prompt} />
      )}
      {historical && (
        <span
          className={`repair-status repair-${repairCase.state.toLowerCase()}`}
          title={`${repairCase.case_id} · risk ${repairCase.risk_tier}${repairCase.latest_summary ? ` · ${repairCase.latest_summary}` : ""}`}
        >
          {REPAIR_STATE_LABEL[repairCase.state]}
        </span>
      )}
      {historical && <RepairReport repairCase={repairCase} />}
      {historical && <span className="repair-id mono">{repairCase.case_id}</span>}
    </div>
  );
}

function matchingRepairCase(
  cases: RepairCase[],
  sourceKind: RepairCase["source_kind"],
  subjectId: string,
  date: string,
) {
  return cases.find(
    (repairCase) =>
      repairCase.source_kind === sourceKind &&
      repairCase.subject_id === subjectId &&
      repairCase.selected_date === date,
  );
}

function PromiseEvidenceRow({
  promise,
  project,
  range,
  date,
  repairCase,
  onOpen,
}: {
  promise: PromiseVerdictRow;
  project: string;
  range: Range;
  date: string;
  repairCase?: RepairCase;
  onOpen: (journeyId: string) => void;
}) {
  const samples = Array.from(new Set(promise.evidence.samples ?? []));
  const receipts = promise.evidence.receipts ?? [];
  const sourceReceipts = promise.evidence.source_receipts ?? [];
  const casePrompt = buildPromiseCasePrompt({ project, range, date, promise });
  return (
    <div className="promise case-promise">
      <div className="promise-actions">
        {promise.status !== "held" && <RepairActions repairCase={repairCase} prompt={casePrompt} />}
        <Chip cls={PROMISE_STATUS_CLS[promise.status]}>{promise.status}</Chip>
      </div>
      <div className="promise-main">
        <div className="t">{promise.title}</div>
        <div className="hl">{promise.headline}</div>
        {samples.length > 0 && (
          <div>
            {samples.slice(0, 5).map((sample) => (
              <button key={sample} className="receipt" onClick={() => onOpen(sample)}>
                {sample.slice(0, 26)}
              </button>
            ))}
          </div>
        )}
        <div className="meta">
          {receipts.length > 0 || sourceReceipts.length > 0
            ? `${receipts.length} event receipt${receipts.length === 1 ? "" : "s"} · ${sourceReceipts.length} source receipt${sourceReceipts.length === 1 ? "" : "s"}`
            : "no receipt timeline attached"}
        </div>
        <details className="meta">
          <summary>evidence</summary>
          <pre>{JSON.stringify({ statement: promise.statement, ...promise.evidence }, null, 2)}</pre>
        </details>
      </div>
    </div>
  );
}

function ReasonEvidenceRow({
  reason,
  project,
  range,
  date,
  repairCase,
  onOpen,
}: {
  reason: ReasonRow;
  project: string;
  range: Range;
  date: string;
  repairCase?: RepairCase;
  onOpen: (journeyId: string) => void;
}) {
  const samples = reason.samples ?? [];
  const casePrompt = buildProblemCasePrompt({ project, range, date, reason });
  return (
    <div className="reason-row">
      <div className="reason-actionbar">
        <RepairActions
          repairCase={repairCase}
          prompt={casePrompt}
        />
        <span className={`reason-count ${reason.cls}`}>
          {reason.n} {reason.n === 1 ? "event" : "events"}
        </span>
      </div>
      <div className="reason-body">
        <div className="reason-top">
          <span className="reason-label">{reasonLabel(reason.reason)}</span>
          <span className="fact mono reason-code">{reason.reason}</span>
        </div>
        <div className="reason-evidence-line">
          {samples.length > 0
            ? `${samples.length} receipts shown of ${reason.n} ${reason.n === 1 ? "event" : "events"}`
            : "backend counted this, but receipts are not attached yet"}
        </div>
        {samples.length > 0 ? (
          <div className="reason-samples">
            {samples.map((sample) => {
              const primary = sample.error_code ?? reason.reason;
              const request = sample.path ?? sample.name;
              return (
                <button
                  key={`${reason.reason}-${sample.event_id}`}
                  className="receipt reason-receipt"
                  title={sampleTitle(sample)}
                  onClick={() => onOpen(sample.journey_id)}
                >
                  <span className="receipt-top">
                    <span className="receipt-id">#{sample.event_id}</span>
                    {sample.http_status ? (
                      <span className={`receipt-status ${receiptStatusCls(sample)}`}>HTTP {sample.http_status}</span>
                    ) : null}
                  </span>
                  <span className="receipt-main">{primary}</span>
                  {request && request !== primary ? <span className="receipt-request">{request}</span> : null}
                  <span className="receipt-meta">
                    {sample.journey_id.slice(0, 22)} · {timeShort(sample.created_at)}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="reason-empty">backend has the count, but not receipts for this row yet</div>
        )}
      </div>
    </div>
  );
}

export function ProjectView({ range, date }: { range: Range; date: string }) {
  const { project = "" } = useParams();
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [promises, setPromises] = useState<PromiseVerdictRow[] | null>(null);
  const [promiseError, setPromiseError] = useState<string | null>(null);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [repairCases, setRepairCases] = useState<RepairCase[]>([]);
  const [journeys, setJourneys] = useState<JourneyRow[] | null>(null);
  const [cls, setCls] = useState<(typeof CLS_FILTERS)[number]>("all");
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setPromises(null);
    setPromiseError(null);
    const load = () => {
      Promise.all([
        fetchSummary(range, date, project),
        fetchJourneys(project, range, date, cls === "all" ? undefined : cls),
      ])
        .then(([s, j]) => {
          if (!alive) return;
          setSummary(s);
          setJourneys(j.journeys);
          setError(null);
        })
        .catch((err: Error) => alive && setError(err.message));
      if (range === "all") {
        setPromises(null);
        setPromiseError(null);
      } else {
        fetchPromises(date, project)
          .then((r) => {
            if (!alive) return;
            setPromises(r.promises);
            setPromiseError(null);
          })
          .catch((err: Error) => {
            if (!alive) return;
            setPromises([]);
            setPromiseError(err.message);
          });
      }
      fetchFindings(range, date, project)
        .then((r) => alive && setFindings(r.findings))
        .catch(() => alive && setFindings(null));
      fetchRepairCases(project)
        .then((r) => alive && setRepairCases(r.repair_cases))
        .catch(() => alive && setRepairCases([]));
    };
    load();
    const timer = window.setInterval(load, 60_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [range, date, project, cls]);

  const totals = summary?.projects.find((p) => p.project === project);
  const reasons = (summary?.reasons ?? []).filter((r) => r.project === project);
  const cleanGreen = totals ? totals.green - totals.friction : 0;
  const total = totals ? totals.green + totals.yellow + totals.red : 0;
  const headline = journeys ? summarizeJourneys(journeys) : null;

  return (
    <>
      {error && (
        <div className="banner">
          <span className="t">API unreachable</span>
          <span className="b mono">{error}</span>
        </div>
      )}

      {headline && (
        <Headline h={headline} project={project} promises={promises} promiseError={promiseError} onPick={setCls} />
      )}

      {findings && findings.length > 0 && (
        <div className="panel findings" style={{ marginBottom: 16 }}>
          <div className="panel-h">
            Findings
            <span className="meta">actual problems, with the fix — most severe first</span>
          </div>
          {findings.map((f) => (
            <FindingRow key={f.id} f={f} onOpen={setOpen} />
          ))}
        </div>
      )}

      {summary && range === "all" && windowDays(summary) <= 1 && (
        <div className="banner">
          <span className="t">All time pending</span>
          <span className="b">the deployed backend answers one day at a time — all-time windows arrive with the next backend deploy; showing today.</span>
        </div>
      )}

      {totals && (
        <div className="kpis">
          <div className="kpi">
            <div className="l">{project === "ops-portal" ? "Verified" : "Completed"}</div>
            <div className="v green">{headline ? headline.completed : totals.green}</div>
            <div className="s">
              {totals.friction > 0
                ? `${cleanGreen} clean · ${totals.friction} w/ friction`
                : project === "ops-portal" ? "source-backed outcome" : "reached checkout"}
            </div>
          </div>
          <div className="kpi">
            <div className="l">Broke</div>
            <div className="v red">{headline ? headline.broke.length : totals.red}</div>
            <div className="s">hard failures</div>
          </div>
          <div className="kpi">
            <div className="l">Hit a wall</div>
            <div className="v yellow">{headline ? headline.walls.reduce((s, w) => s + w.n, 0) : 0}</div>
            <div className="s">named friction</div>
          </div>
          <div className="kpi">
            <div className="l">{project === "ops-portal" ? "Unresolved" : "Opened & left"}</div>
            <div className="v">{headline ? headline.bounced : 0}</div>
            <div className="s">{project === "ops-portal" ? "no terminal outcome" : "no action taken"}</div>
          </div>
          <div className="kpi">
            <div className="l">Unknown</div>
            <div className="v red">{totals.unclassified}</div>
            <div className="s">must reach zero</div>
          </div>
          <div className="kpi">
            <div className="l">Active</div>
            <div className="v info">{totals.active}</div>
            <div className="s">in flight now</div>
          </div>
          <div className="kpi">
            <div className="l">{project === "ops-portal" ? "Capture gaps" : "Unseen intents"}</div>
            <div className="v">{summary?.missing_journeys ?? 0}</div>
            <div className="s">capture gap</div>
          </div>
        </div>
      )}

      <div className="cols">
        <div className="stack">
          <div className="panel">
            <div className="panel-h">
              Promises
              <span className="meta">green is earned, not assumed</span>
            </div>
            {promises === null && range === "all" && (
              <div className="empty">promises are judged per day — switch to Today or Yesterday</div>
            )}
            {promiseError && range !== "all" && (
              <div className="empty">
                <div className="big">promise catalog unavailable for {project}</div>
                <div className="mono">{promiseError}</div>
              </div>
            )}
            {!promiseError && promises === null && range !== "all" && <Skeleton rows={5} />}
            {promises?.map((p) => (
              <PromiseEvidenceRow
                key={p.promise_id}
                promise={p}
                project={project}
                range={range}
                date={date}
                repairCase={matchingRepairCase(repairCases, "promise", p.promise_id, date)}
                onOpen={setOpen}
              />
            ))}
            {!promiseError && promises !== null && promises.length === 0 && (
              <div className="empty">no promise catalog answered for this backend</div>
            )}
          </div>
        </div>

        <div className="stack">
          <div className="panel">
            <div className="panel-h">
              Walls & failures
              <span className="meta">today, ranked</span>
            </div>
            {summary === null && <Skeleton rows={3} />}
            {reasons.map((r) => (
              <ReasonEvidenceRow
                key={r.cls + r.reason}
                reason={r}
                project={project}
                range={range}
                date={date}
                repairCase={matchingRepairCase(repairCases, "reason", `${r.cls}:${r.reason}`, date)}
                onOpen={setOpen}
              />
            ))}
            {summary !== null && reasons.length === 0 && <div className="empty">nothing hit a wall today</div>}
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-h">
          Journeys
          <div className="filters" style={{ marginLeft: 14 }}>
            {CLS_FILTERS.map((f) => (
              <button key={f} className={cls === f ? "on" : ""} onClick={() => setCls(f)}>
                {f}
              </button>
            ))}
          </div>
          <span className="meta">{journeys?.length ?? "…"} shown · click to inspect</span>
        </div>
        {journeys === null && <Skeleton rows={5} />}
        {journeys !== null && (
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Journey</th>
                <th>Vertical</th>
                <th>Surface</th>
                <th>Primary reason</th>
                <th style={{ textAlign: "right" }}>Events</th>
                <th style={{ textAlign: "right" }}>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {journeys.map((j) => (
                <tr key={j.journey_id} className="rowlink" onClick={() => setOpen(j.journey_id)}>
                  <td>
                    <span className="statuscell">
                      <Dot cls={j.journey_cls} />
                      {j.journey_cls}
                      {j.goal ? <span className="fact st-ok">goal</span> : null}
                    </span>
                  </td>
                  <td className="mono">{j.journey_id.slice(0, 30)}</td>
                  <td className="small">{j.vertical ?? "—"}</td>
                  <td className="small faint">{j.surface ?? "—"}</td>
                  <td className="mono small">{j.primary_reason ?? "—"}</td>
                  <td className="num">{j.events}</td>
                  <td className="num faint">{timeShort(j.last_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {journeys !== null && journeys.length === 0 && <div className="empty">{emptyJourneysCopy(cls, range, date)}</div>}
      </div>

      {open && <Inspector journeyId={open} onClose={() => setOpen(null)} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// The inspector: one journey, every event, every stored field.

function Inspector({ journeyId, onClose }: { journeyId: string; onClose: () => void }) {
  const [events, setEvents] = useState<JourneyEvent[] | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [evCls, setEvCls] = useState<(typeof EV_FILTERS)[number]>("all");

  useEffect(() => {
    setEvents(null);
    setExpanded(null);
    fetchJourneyEvents(journeyId)
      .then((r) => setEvents(r.events))
      .catch(() => setEvents([]));
  }, [journeyId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const first = events?.[0];
  const stats = useMemo(() => {
    if (!events?.length) return null;
    const by = { green: 0, yellow: 0, red: 0, info: 0 };
    for (const e of events) by[e.cls] += 1;
    const steps = events.filter((e) => e.name.startsWith("step:")).map((e) => e.name.slice(5));
    return {
      by,
      steps: Array.from(new Set(steps)),
      span: spanLabel(events[0].created_at, events[events.length - 1].created_at),
      surface: events.find((e) => e.surface)?.surface ?? null,
      vertical: events.find((e) => e.vertical)?.vertical ?? null,
      customer: events.find((e) => e.customer_id)?.customer_id ?? null,
    };
  }, [events]);

  const visible = (events ?? []).filter(
    (e) =>
      (evCls === "all" || e.cls === evCls) &&
      (!q || `${e.name} ${e.reason} ${e.path ?? ""} ${e.error_code ?? ""}`.toLowerCase().includes(q.toLowerCase())),
  );

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="inspector" role="dialog" aria-label="Journey inspector">
        <div className="inspector-h">
          <div className="idrow">
            <span className="jid">{journeyId}</span>
            <CopyButton text={journeyId} />
            <button className="close" onClick={onClose} aria-label="Close">
              ×
            </button>
          </div>
          {stats && (
            <div className="jstats">
              <div className="jstat">
                <div className="l">Events</div>
                <div className="v">
                  {events!.length}
                  <span className="faint">
                    {" "}
                    (<span style={{ color: "var(--green)" }}>{stats.by.green}</span>/
                    <span style={{ color: "var(--amber)" }}>{stats.by.yellow}</span>/
                    <span style={{ color: "var(--red)" }}>{stats.by.red}</span>/{stats.by.info})
                  </span>
                </div>
              </div>
              <div className="jstat">
                <div className="l">Span</div>
                <div className="v">{stats.span}</div>
              </div>
              <div className="jstat">
                <div className="l">Vertical</div>
                <div className="v">{stats.vertical ?? "—"}</div>
              </div>
              <div className="jstat">
                <div className="l">Surface</div>
                <div className="v">{stats.surface ?? "—"}</div>
              </div>
              <div className="jstat">
                <div className="l">Customer</div>
                <div className="v">{stats.customer ? stats.customer.slice(0, 16) + "…" : "—"}</div>
              </div>
              <div className="jstat">
                <div className="l">Funnel</div>
                <div className="v">{stats.steps.length ? stats.steps.join(" → ") : "—"}</div>
              </div>
            </div>
          )}
        </div>

        <div className="inspector-tools">
          <input placeholder="filter events — name, reason, path, code…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="filters">
            {EV_FILTERS.map((f) => (
              <button key={f} className={evCls === f ? "on" : ""} onClick={() => setEvCls(f)}>
                {f}
              </button>
            ))}
          </div>
        </div>

        <div className="inspector-body">
          {events === null && <Skeleton rows={7} />}
          {events !== null && visible.length === 0 && (
            <div className="empty">
              <div className="big">no events match</div>
              adjust the filter above
            </div>
          )}
          {first &&
            visible.map((e) => (
              <EventRow
                key={e.id}
                e={e}
                baseIso={first.created_at}
                expanded={expanded === e.id}
                onToggle={() => setExpanded(expanded === e.id ? null : e.id)}
              />
            ))}
        </div>
      </div>
    </>
  );
}

function EventRow({
  e,
  baseIso,
  expanded,
  onToggle,
}: {
  e: JourneyEvent;
  baseIso: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const server = e.session_id === "server";
  const statusCls = e.http_status ? (e.http_status < 400 ? "st-ok" : "st-bad") : "";
  return (
    <div className="ev">
      <div className="off">{offsetLabel(e.created_at, baseIso)}</div>
      <div className="railcell">
        <div className="rail" />
        <div className={`node dot ${server ? "active" : e.cls}`} />
      </div>
      <div className="body">
        <div className="row1" onClick={onToggle}>
          <span className="n">{e.name}</span>
          {server && <span className="fact" style={{ color: "var(--accent)" }}>server verdict</span>}
          <span className="facts">
            {e.http_status ? <span className={`fact ${statusCls}`}>{e.http_status}</span> : null}
            {e.duration_ms ? <span className="fact">{e.duration_ms}ms</span> : null}
            {e.error_code ? <span className="fact code">{e.error_code}</span> : null}
            <span className="fact">{e.event_type}</span>
          </span>
        </div>
        <div className="sub">
          {e.reason !== "ok" && e.reason !== e.event_type ? `${e.cls}:${e.reason}` : e.cls}
          {e.path ? ` · ${e.path}` : ""}
        </div>
        {expanded && <EventDetail e={e} />}
      </div>
    </div>
  );
}

function EventDetail({ e }: { e: JourneyEvent }) {
  const lag =
    e.client_ts && e.created_at
      ? new Date(e.created_at).getTime() - new Date(e.client_ts).getTime()
      : null;
  const rows: Array<[string, unknown]> = [
    ["event id", e.id],
    ["type", e.event_type],
    ["judgment", `${e.cls} — ${e.reason}`],
    ["http status", e.http_status],
    ["duration", e.duration_ms != null ? `${e.duration_ms} ms` : null],
    ["error code", e.error_code],
    ["our api", e.api === true ? "yes" : e.api === false ? "no (third-party)" : null],
    ["path", e.path],
    ["session", e.session_id],
    ["journey", e.journey_id],
    ["customer", e.customer_id],
    ["seller", e.seller_id],
    ["surface", e.surface],
    ["vertical", e.vertical],
    ["classifier", e.classifier_version != null ? `v${e.classifier_version}` : null],
    ["client time", e.client_ts ? `${timeShort(e.client_ts)} (device clock)` : null],
    ["ingested", `${timeShort(e.created_at)}${lag !== null ? ` · ${lag >= 0 ? "+" : ""}${(lag / 1000).toFixed(1)}s after device` : ""}`],
  ];
  const hasMeta = e.meta && Object.keys(e.meta).length > 0;
  return (
    <div className="detail" onClick={(ev) => ev.stopPropagation()}>
      <div className="dgrid">
        {rows
          .filter(([, v]) => v !== null && v !== undefined && v !== "")
          .flatMap(([k, v]) => [
            <div key={k + "k"} className="dk">
              {k}
            </div>,
            <div key={k + "v"} className="dv">
              {String(v)}
            </div>,
          ])}
      </div>
      {hasMeta && <pre>{JSON.stringify(e.meta, null, 2)}</pre>}
    </div>
  );
}
