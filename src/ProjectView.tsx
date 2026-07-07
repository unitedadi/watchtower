import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import {
  fetchJourneyEvents,
  fetchJourneys,
  fetchPromises,
  fetchSummary,
  type JourneyEvent,
  type JourneyRow,
  type PromiseVerdictRow,
  type SummaryResponse,
} from "./api";
import { Dot, Pill, timeShort } from "./ui";

const PROMISE_STATUS_CLS: Record<PromiseVerdictRow["status"], string> = {
  held: "green",
  degraded: "yellow",
  broken: "red",
  unverified: "info",
};

const CLS_FILTERS = ["all", "red", "yellow", "green", "active"] as const;

export function ProjectView({ date }: { date: string }) {
  const { project = "" } = useParams();
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [promises, setPromises] = useState<PromiseVerdictRow[] | null>(null);
  const [journeys, setJourneys] = useState<JourneyRow[]>([]);
  const [cls, setCls] = useState<(typeof CLS_FILTERS)[number]>("all");
  const [open, setOpen] = useState<string | null>(null);
  const [events, setEvents] = useState<JourneyEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      Promise.all([
        fetchSummary(date, project),
        fetchJourneys(project, date, cls === "all" ? undefined : cls),
      ])
        .then(([s, j]) => {
          if (!alive) return;
          setSummary(s);
          setJourneys(j.journeys);
          setError(null);
        })
        .catch((err: Error) => alive && setError(err.message));
      // The promise board — absent (older backend) just hides the section.
      fetchPromises(date, project)
        .then((r) => alive && setPromises(r.promises))
        .catch(() => alive && setPromises(null));
    };
    load();
    const timer = window.setInterval(load, 60_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [date, project, cls]);

  useEffect(() => {
    if (!open) return;
    setEvents([]);
    fetchJourneyEvents(open)
      .then((r) => setEvents(r.events))
      .catch(() => setEvents([]));
  }, [open]);

  const totals = summary?.projects.find((p) => p.project === project);
  const reasons = (summary?.reasons ?? []).filter((r) => r.project === project);

  return (
    <>
      {error && <div className="error-banner">Cannot reach the telemetry API: {error}</div>}

      {promises && promises.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3>Promises — green is earned, not assumed</h3>
          {promises.map((p) => (
            <div key={p.promise_id} className="promise-row">
              <Pill cls={PROMISE_STATUS_CLS[p.status]}>{p.status.toUpperCase()}</Pill>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 550 }}>{p.title}</div>
                <div className="muted small">{p.headline}</div>
                {(p.evidence.samples ?? []).length > 0 && (
                  <div className="small" style={{ marginTop: 4 }}>
                    {p.evidence.samples!.slice(0, 5).map((s) => (
                      <button key={s} className="receipt" onClick={() => setOpen(s)}>
                        {s.slice(0, 24)}
                      </button>
                    ))}
                  </div>
                )}
                <details className="meta">
                  <summary className="small muted">evidence</summary>
                  <pre>{JSON.stringify({ statement: p.statement, ...p.evidence }, null, 2)}</pre>
                </details>
              </div>
            </div>
          ))}
        </div>
      )}

      {totals && (
        <div className="counts" style={{ marginBottom: 16 }}>
          <Pill cls="green" big>{totals.green - totals.friction} green</Pill>
          {totals.friction > 0 && <Pill cls="yellow" big>{totals.friction} green-with-friction</Pill>}
          <Pill cls="yellow" big>{totals.yellow} yellow</Pill>
          <Pill cls="red" big>{totals.red} red</Pill>
          {totals.active > 0 && <Pill cls="info" big>{totals.active} active</Pill>}
          {totals.unclassified > 0 && <Pill cls="red" big>{totals.unclassified} UNCLASSIFIED</Pill>}
          {(summary?.missing_journeys ?? 0) > 0 && (
            <Pill cls="red" big>{summary!.missing_journeys} intents unseen</Pill>
          )}
        </div>
      )}

      {reasons.length > 0 && (
        <div className="card section">
          <h3>Walls and failures today</h3>
          <table>
            <tbody>
              {reasons.map((r) => (
                <tr key={r.cls + r.reason}>
                  <td style={{ width: 70 }}><Pill cls={r.cls}>{r.n}</Pill></td>
                  <td className="mono">{r.reason}</td>
                  <td className="muted small" style={{ width: 90 }}>{r.cls}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card section">
        <h3>Journeys</h3>
        <div className="filters">
          {CLS_FILTERS.map((f) => (
            <button key={f} className={cls === f ? "on" : ""} onClick={() => setCls(f)}>
              {f}
            </button>
          ))}
        </div>
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Journey</th>
              <th>Vertical</th>
              <th>Surface</th>
              <th>Reason</th>
              <th>Events</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {journeys.map((j) => (
              <tr key={j.journey_id} className="rowlink" onClick={() => setOpen(j.journey_id)}>
                <td><Dot cls={j.journey_cls} />{j.journey_cls}{j.goal ? " ✓" : ""}</td>
                <td className="mono">{j.journey_id.slice(0, 26)}</td>
                <td>{j.vertical ?? "—"}</td>
                <td className="small">{j.surface ?? "—"}</td>
                <td className="mono small">{j.primary_reason ?? "—"}</td>
                <td>{j.events}</td>
                <td className="small muted">{timeShort(j.last_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {journeys.length === 0 && <div className="empty">No journeys match.</div>}
      </div>

      {open && (
        <div className="drawer" role="dialog" aria-label="Journey timeline">
          <button className="close" onClick={() => setOpen(null)}>×</button>
          <h2 className="mono" style={{ fontSize: 14 }}>{open}</h2>
          <div className="timeline">
            {events.map((e) => (
              <div key={e.id} className="tl-row">
                <div className="tl-time">{timeShort(e.created_at)}</div>
                <div className="tl-body">
                  <div className="tl-name">
                    <Dot cls={e.cls} />
                    {e.name}
                    {e.http_status ? <span className="muted"> · {e.http_status}</span> : null}
                    {e.duration_ms ? <span className="muted"> · {e.duration_ms}ms</span> : null}
                  </div>
                  <div className="tl-meta">
                    {e.event_type}
                    {e.reason && e.reason !== "ok" && e.reason !== e.event_type ? ` · ${e.reason}` : ""}
                    {e.path ? ` · ${e.path}` : ""}
                  </div>
                  {e.meta && Object.keys(e.meta).length > 0 && (
                    <details className="meta">
                      <summary className="small muted">meta</summary>
                      <pre>{JSON.stringify(e.meta, null, 2)}</pre>
                    </details>
                  )}
                </div>
              </div>
            ))}
            {events.length === 0 && <div className="empty">Loading events…</div>}
          </div>
        </div>
      )}
    </>
  );
}
