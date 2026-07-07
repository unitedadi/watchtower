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
  if (!res.ok) throw new Error(`${res.status} ${path}`);
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
  evidence: { facts: Record<string, unknown>; samples?: string[]; notes?: string[] };
  checked_at?: string;
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
