// Thin client for the backend telemetry read APIs. The API base is
// configurable at runtime (header settings) so the same build can point at
// prod, dev, or a local backend.

const DEFAULT_API_BASE = "https://api-prod.dardoc.com";

// The API base is deliberately not in the UI anymore — override with
// ?api=http://localhost:3002 once; it persists in localStorage.
try {
  const override = new URLSearchParams(window.location.search).get("api");
  if (override) localStorage.setItem("watchtower_api", override.replace(/\/+$/, ""));
} catch {
  // non-browser context
}

export type Range = "today" | "yesterday" | "all";

function windowParams(range: Range, date: string): Record<string, string> {
  return range === "all" ? { range: "all" } : { date };
}

export function apiBase(): string {
  try {
    return localStorage.getItem("watchtower_api")?.replace(/\/+$/, "") || DEFAULT_API_BASE;
  } catch {
    return DEFAULT_API_BASE;
  }
}

export function setApiBase(base: string): void {
  localStorage.setItem("watchtower_api", base.trim().replace(/\/+$/, ""));
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error) detail = ` ${body.error}`;
    } catch {
      // Keep the status/path error when the response is not JSON.
    }
    throw new Error(`${res.status}${detail} ${path}`);
  }
  return (await res.json()) as T;
}

export interface ProjectSummary {
  project: string;
  green: number;
  yellow: number;
  red: number;
  active: number;
  friction: number;
  unclassified: number;
}

export interface ReasonRow {
  project: string;
  cls: "yellow" | "red";
  reason: string;
  n: number;
  samples?: ReasonSample[];
}

export interface ReasonSample {
  event_id: number;
  journey_id: string;
  session_id: string;
  name: string;
  created_at: string;
  path: string | null;
  http_status: number | null;
  error_code: string | null;
  surface: string | null;
  vertical: string | null;
}

export interface SummaryResponse {
  from: string;
  to: string;
  projects: ProjectSummary[];
  reasons: ReasonRow[];
  missing_journeys?: number;
}

export interface SparklinePoint {
  project: string;
  day: string;
  green: number;
  total: number;
}

export interface JourneyRow {
  journey_id: string;
  journey_cls: "green" | "yellow" | "red" | "active";
  has_unclassified: boolean;
  goal: boolean;
  events: number;
  surface: string | null;
  vertical: string | null;
  customer_id: string | null;
  first_at: string;
  last_at: string;
  primary_reason: string | null;
}

export interface JourneyEvent {
  id: number;
  project?: string;
  session_id?: string;
  journey_id?: string;
  event_type: string;
  name: string;
  cls: "green" | "yellow" | "red" | "info";
  reason: string;
  http_status: number | null;
  duration_ms: number | null;
  path: string | null;
  error_code?: string | null;
  api?: boolean | null;
  customer_id?: string | null;
  seller_id?: string | null;
  classifier_version?: number;
  meta: Record<string, unknown>;
  surface: string | null;
  vertical: string | null;
  client_ts?: string | null;
  created_at: string;
}

export function fetchSummary(range: Range, date: string, project?: string): Promise<SummaryResponse> {
  const q = new URLSearchParams(windowParams(range, date));
  if (project) q.set("project", project);
  return get(`/telemetry/summary?${q}`);
}

export function fetchSparkline(project?: string): Promise<{ rows: SparklinePoint[] }> {
  const q = new URLSearchParams({ days: "14" });
  if (project) q.set("project", project);
  return get(`/telemetry/sparkline?${q}`);
}

export function fetchJourneys(
  project: string,
  range: Range,
  date: string,
  cls?: string,
): Promise<{ journeys: JourneyRow[] }> {
  const q = new URLSearchParams({ project, limit: "200", ...windowParams(range, date) });
  if (cls) q.set("cls", cls);
  return get(`/telemetry/journeys?${q}`);
}

export function fetchJourneyEvents(journeyId: string): Promise<{ events: JourneyEvent[] }> {
  return get(`/telemetry/journeys/${encodeURIComponent(journeyId)}/events`);
}

export interface PromiseVerdictRow {
  promise_id: string;
  title: string;
  statement: string;
  status: "held" | "degraded" | "broken" | "unverified";
  headline: string;
  evidence: {
    facts: Record<string, unknown>;
    samples?: string[];
    notes?: string[];
    proof_gaps?: string[];
    receipts?: PromiseReceipt[];
    source_receipts?: PromiseSourceReceipt[];
  };
  checked_at?: string;
}

export interface PromiseSourceReceipt {
  source: string;
  subject: string;
  observed_at?: string | null;
  facts: Record<string, unknown>;
}

export interface PromiseReceipt {
  event_id: string;
  client_event_id?: string | null;
  journey_id: string;
  session_id: string;
  name: string;
  cls: string;
  reason: string;
  event_type: string;
  observed_at: string;
  ingested_at: string;
  http_status?: number | null;
  error_code?: string | null;
  path?: string | null;
  surface?: string | null;
  vertical?: string | null;
  meta?: Record<string, unknown>;
}

export function fetchPromises(date: string, product = "checkout-web"): Promise<{ promises: PromiseVerdictRow[] }> {
  const q = new URLSearchParams({ date, product });
  return get(`/telemetry/promises?${q}`);
}

export interface Finding {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  confidence?: "high" | "medium" | "low";
  title: string;
  root_cause: string;
  impact: string;
  suggested_fix: string;
  affected: number;
  evidence: string[];
  evidence_summary?: string[];
  codex_handoff?: {
    problem: string;
    observed: string[];
    expected: string;
    receipts: string[];
    prompt: string;
  };
  autofix?: {
    ready: boolean;
    reason: string;
    repo?: string;
    files?: string[];
  };
}

export function fetchFindings(range: Range, date: string, product = "checkout-web"): Promise<{ findings: Finding[] }> {
  const q = new URLSearchParams({ product, ...windowParams(range, date) });
  return get(`/telemetry/findings?${q}`);
}

export type RepairCaseState =
  | "QUEUED"
  | "CLAIMED"
  | "INVESTIGATED"
  | "PATCH_READY"
  | "SHIPPED"
  | "NEEDS_HUMAN"
  | "STOPPED"
  | "RECOVERED";

export interface RepairCase {
  case_id: string;
  source_kind: "promise" | "reason";
  product: string;
  subject_id: string;
  selected_date: string;
  title: string;
  observed_status: string;
  headline: string;
  risk_tier: "A" | "B" | "C";
  state: RepairCaseState;
  phase: "QUEUED" | "INVESTIGATING" | "REPAIRING" | "TESTING" | "PATCH_READY" | "DEPLOYING" | "VERIFYING" | "DONE" | "BLOCKED";
  latest_summary: string | null;
  latest_report: Record<string, unknown> | null;
  github_issue_url: string | null;
  github_issue_repository: string | null;
  github_issue_number: number | null;
  updated_at: string;
}

export function fetchRepairCase(caseId: string): Promise<{ repair_case: RepairCase }> {
  return get(`/telemetry/repair-cases/${encodeURIComponent(caseId)}`);
}

export function fetchRepairCases(product: string): Promise<{ repair_cases: RepairCase[] }> {
  const query = new URLSearchParams({ product, limit: "200" });
  return get(`/telemetry/repair-cases?${query}`);
}

export function todayDubai(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date());
}

export function yesterdayDubai(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(
    new Date(Date.now() - 24 * 60 * 60 * 1000),
  );
}

// Days covered by a summary window — used to detect a backend that doesn't
// understand range=all yet (it answers with a single day).
export function windowDays(res: { from: string; to: string }): number {
  return (new Date(res.to).getTime() - new Date(res.from).getTime()) / 86_400_000;
}
