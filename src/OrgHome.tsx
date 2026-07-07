import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import {
  fetchSparkline,
  fetchSummary,
  type ReasonRow,
  type SparklinePoint,
  type SummaryResponse,
} from "./api";
import { Pill, Sparkline } from "./ui";

const PROJECT_LABELS: Record<string, string> = {
  "checkout-web": "Checkout",
  "ios-app": "iOS App",
  "ops-portal": "Ops Portal",
  "doctor-dashboard": "Doctor Dashboard",
};

export function OrgHome({ date }: { date: string }) {
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [spark, setSpark] = useState<SparklinePoint[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      Promise.all([fetchSummary(date), fetchSparkline()])
        .then(([s, sp]) => {
          if (!alive) return;
          setSummary(s);
          setSpark(sp.rows);
          setError(null);
        })
        .catch((err: Error) => alive && setError(err.message));
    };
    load();
    const timer = window.setInterval(load, 60_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [date]);

  const sparkByProject = useMemo(() => {
    const map = new Map<string, SparklinePoint[]>();
    for (const p of spark) {
      const list = map.get(p.project) ?? [];
      list.push(p);
      map.set(p.project, list);
    }
    return map;
  }, [spark]);

  const attention: ReasonRow[] = (summary?.reasons ?? []).filter(
    (r) => r.cls === "red" || r.reason === "UNCLASSIFIED",
  );

  return (
    <>
      {error && <div className="error-banner">Cannot reach the telemetry API: {error}</div>}

      {(summary?.missing_journeys ?? 0) > 0 && (
        <div className="card attention" style={{ marginBottom: 16 }}>
          <h3>Capture gap</h3>
          <div className="small">
            <Pill cls="red">{summary!.missing_journeys}</Pill>{" "}
            checkout intents created today produced <b>zero</b> client events — unopened
            links are normal in small numbers; a spike means tracking itself is broken
            and silence cannot be trusted.
          </div>
        </div>
      )}

      {attention.length > 0 && (
        <div className="card attention" style={{ marginBottom: 16 }}>
          <h3>Needs attention</h3>
          {attention.slice(0, 8).map((r) => (
            <div key={r.project + r.reason} className="small" style={{ padding: "3px 0" }}>
              <Pill cls="red">{r.n}</Pill>{" "}
              <span className="mono">{r.reason}</span>{" "}
              <span className="muted">in {PROJECT_LABELS[r.project] ?? r.project}</span>
            </div>
          ))}
        </div>
      )}

      <div className="grid">
        {(summary?.projects ?? []).map((p) => {
          const cleanGreen = p.green - p.friction;
          const total = p.green + p.yellow + p.red;
          const rate = total ? Math.round((cleanGreen / total) * 100) : null;
          return (
            <Link key={p.project} to={`/p/${p.project}?date=${date}`} className="card tile">
              <div className="name">
                {PROJECT_LABELS[p.project] ?? p.project}
                {rate !== null && (
                  <span className={`muted small`}>{rate}% clean green</span>
                )}
              </div>
              <div className="counts">
                <Pill cls="green">{cleanGreen} green</Pill>
                {p.friction > 0 && <Pill cls="yellow">{p.friction} green w/ friction</Pill>}
                <Pill cls="yellow">{p.yellow} yellow</Pill>
                <Pill cls="red">{p.red} red</Pill>
                {p.active > 0 && <Pill cls="info">{p.active} active</Pill>}
                {p.unclassified > 0 && <Pill cls="red">{p.unclassified} unclassified</Pill>}
              </div>
              <Sparkline points={sparkByProject.get(p.project) ?? []} />
            </Link>
          );
        })}
        {summary && summary.projects.length === 0 && (
          <div className="card">
            <div className="empty">No journeys recorded for {date} yet.</div>
          </div>
        )}
      </div>
    </>
  );
}
