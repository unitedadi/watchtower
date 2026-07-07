import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import {
  fetchSparkline,
  fetchSummary,
  windowDays,
  type Range,
  type ReasonRow,
  type SparklinePoint,
  type SummaryResponse,
} from "./api";
import { Chip, Skeleton, Sparkline } from "./ui";

const PROJECT_LABELS: Record<string, string> = {
  "checkout-web": "Checkout",
  "ios-app": "iOS App",
  "ops-portal": "Ops Portal",
  "doctor-dashboard": "Doctor Dashboard",
};

const COMING: Array<{ id: string; label: string }> = [
  { id: "ios-app", label: "iOS App" },
  { id: "ops-portal", label: "Ops Portal" },
];

export function OrgHome({ range, date }: { range: Range; date: string }) {
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [spark, setSpark] = useState<SparklinePoint[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      Promise.all([fetchSummary(range, date), fetchSparkline()])
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
  }, [range, date]);

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
  const live = new Set((summary?.projects ?? []).map((p) => p.project));

  return (
    <>
      {error && (
        <div className="banner">
          <span className="t">API unreachable</span>
          <span className="b mono">{error}</span>
        </div>
      )}

      {summary && range === "all" && windowDays(summary) <= 1 && (
        <div className="banner">
          <span className="t">All time pending</span>
          <span className="b">the deployed backend answers one day at a time — all-time windows arrive with the next backend deploy; showing today.</span>
        </div>
      )}

      {(summary?.missing_journeys ?? 0) > 0 && (
        <div className="banner">
          <span className="t">Capture gap</span>
          <span className="b">
            <span className="mono">{summary!.missing_journeys}</span> checkout intents produced zero
            client events in this window — unopened links are normal in small numbers; a spike means
            tracking itself is broken and silence cannot be trusted.
          </span>
        </div>
      )}

      {attention.length > 0 && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-h">
            Needs attention
            <span className="meta">reds and unknowns, org-wide</span>
          </div>
          {attention.slice(0, 8).map((r) => (
            <div key={r.project + r.reason} className="promise" style={{ padding: "9px 16px" }}>
              <Chip cls="red">{r.n}</Chip>
              <div>
                <span className="mono">{r.reason}</span>{" "}
                <span className="faint small">in {PROJECT_LABELS[r.project] ?? r.project}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="tiles">
        {summary === null && (
          <div className="panel" style={{ padding: 6 }}>
            <Skeleton rows={4} />
          </div>
        )}
        {(summary?.projects ?? []).map((p) => {
          const cleanGreen = p.green - p.friction;
          const total = p.green + p.yellow + p.red;
          const rate = total ? Math.round((cleanGreen / total) * 100) : null;
          const worst = (summary?.reasons ?? []).find((r) => r.project === p.project);
          return (
            <Link key={p.project} to={`/p/${p.project}`} className="tile">
              <div className="name">
                {PROJECT_LABELS[p.project] ?? p.project}
                {rate !== null && <span className="rate">{rate}%</span>}
              </div>
              <div className="chips">
                <Chip cls="green">{cleanGreen} green</Chip>
                {p.friction > 0 && <Chip cls="yellow">{p.friction} friction</Chip>}
                <Chip cls="yellow">{p.yellow} yellow</Chip>
                <Chip cls="red">{p.red} red</Chip>
                {p.active > 0 && <Chip cls="info">{p.active} active</Chip>}
                {p.unclassified > 0 && <Chip cls="red">{p.unclassified} unknown</Chip>}
              </div>
              <Sparkline points={sparkByProject.get(p.project) ?? []} width={340} />
              <div className="faint small mono" style={{ marginTop: 8 }}>
                {total} journeys · worst: {worst ? worst.reason : "—"}
              </div>
            </Link>
          );
        })}
        {summary !== null &&
          COMING.filter((c) => !live.has(c.id)).map((c) => (
            <div key={c.id} className="tile ghost">
              <div>
                {c.label}
                <br />
                <span className="small">capture client not shipped yet</span>
              </div>
            </div>
          ))}
        {summary && summary.projects.length === 0 && (
          <div className="panel empty" style={{ gridColumn: "1 / -1" }}>
            <div className="big">No journeys recorded in this window</div>
            deploy a capture client, or pick another date
          </div>
        )}
      </div>
    </>
  );
}
