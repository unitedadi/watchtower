import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";

import {
  fetchFindings,
  fetchJourneyEvents,
  fetchJourneys,
  fetchPromises,
  fetchSummary,
  windowDays,
  type Finding,
  type Range,
  type JourneyEvent,
  type JourneyRow,
  type PromiseVerdictRow,
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

function FindingRow({ f, onOpen }: { f: Finding; onOpen: (j: string) => void }) {
  return (
    <div className="finding">
      <div className="finding-head">
        <span className={`chip ${SEVERITY_CLS[f.severity]}`}>
          <span className="d" />
          {f.severity}
        </span>
        <span className="finding-title">{f.title}</span>
        <span className="finding-affected mono">{f.affected} affected</span>
      </div>
      <div className="finding-body">
        <p className="finding-cause">{f.root_cause}</p>
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
      </div>
    </div>
  );
}

function Headline({ h, onPick }: { h: Headline; onPick: (c: "all" | "red" | "green") => void }) {
  const verdictCls = h.broke.length > 0 ? "red" : h.completed > 0 ? "green" : "yellow";
  const verdict =
    h.broke.length > 0
      ? `${h.broke.length} ${h.broke.length === 1 ? "journey" : "journeys"} broke`
      : "nothing broke";
  return (
    <div className="headline">
      <div className="headline-top">
        <span className={`hl-verdict ${verdictCls}`}>
          <span className={`dot ${verdictCls}`} />
          {verdict}
        </span>
        <span className="hl-line">
          <b>{h.total}</b> sessions ·{" "}
          <button className="hl-num green" onClick={() => onPick("green")}>
            {h.completed} completed
          </button>{" "}
          ·{" "}
          <button className="hl-num red" onClick={() => onPick("red")}>
            {h.broke.length} broke
          </button>{" "}
          · <span className="faint">{h.bounced} opened &amp; left</span>
        </span>
      </div>
      {h.walls.length > 0 && (
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

export function ProjectView({ range, date }: { range: Range; date: string }) {
  const { project = "" } = useParams();
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [promises, setPromises] = useState<PromiseVerdictRow[] | null>(null);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [journeys, setJourneys] = useState<JourneyRow[] | null>(null);
  const [cls, setCls] = useState<(typeof CLS_FILTERS)[number]>("all");
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
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
      } else {
        fetchPromises(date, project)
          .then((r) => alive && setPromises(r.promises))
          .catch(() => alive && setPromises(null));
      }
      fetchFindings(range, date, project)
        .then((r) => alive && setFindings(r.findings))
        .catch(() => alive && setFindings(null));
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

      {headline && <Headline h={headline} onPick={setCls} />}

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
            <div className="l">Completed</div>
            <div className="v green">{headline ? headline.completed : totals.green}</div>
            <div className="s">{totals.friction > 0 ? `${cleanGreen} clean · ${totals.friction} w/ friction` : "reached checkout"}</div>
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
            <div className="l">Opened &amp; left</div>
            <div className="v">{headline ? headline.bounced : 0}</div>
            <div className="s">no action taken</div>
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
            <div className="l">Unseen intents</div>
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
            {promises === null && range !== "all" && <Skeleton rows={5} />}
            {promises?.map((p) => (
              <div key={p.promise_id} className="promise">
                <Chip cls={PROMISE_STATUS_CLS[p.status]}>{p.status}</Chip>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="t">{p.title}</div>
                  <div className="hl">{p.headline}</div>
                  {(p.evidence.samples ?? []).length > 0 && (
                    <div>
                      {p.evidence.samples!.slice(0, 5).map((s) => (
                        <button key={s} className="receipt" onClick={() => setOpen(s)}>
                          {s.slice(0, 26)}
                        </button>
                      ))}
                    </div>
                  )}
                  <details className="meta">
                    <summary>evidence</summary>
                    <pre>{JSON.stringify({ statement: p.statement, ...p.evidence }, null, 2)}</pre>
                  </details>
                </div>
              </div>
            ))}
            {promises !== null && promises.length === 0 && (
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
              <div key={r.cls + r.reason} className="promise" style={{ padding: "8px 16px", alignItems: "center" }}>
                <Chip cls={r.cls}>{r.n}</Chip>
                <span className="mono" style={{ fontSize: 12 }}>{r.reason}</span>
              </div>
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
        {journeys !== null && journeys.length === 0 && <div className="empty">no journeys match this filter</div>}
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
