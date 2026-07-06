import type { SparklinePoint } from "./api";

export function Pill({ cls, children, big }: { cls: string; children: React.ReactNode; big?: boolean }) {
  return <span className={`pill ${cls}${big ? " big" : ""}`}>{children}</span>;
}

export function Dot({ cls }: { cls: string }) {
  return <span className={`dot ${cls}`} />;
}

// 14-day green-rate sparkline. Height encodes volume, color encodes health.
export function Sparkline({ points }: { points: SparklinePoint[] }) {
  if (!points.length) return <div className="muted small">no history yet</div>;
  const width = 240;
  const height = 36;
  const max = Math.max(...points.map((p) => p.total), 1);
  const bar = width / Math.max(points.length, 14);
  return (
    <svg className="sparkline" width={width} height={height} role="img" aria-label="14 day history">
      {points.map((p, i) => {
        const h = Math.max((p.total / max) * (height - 4), 2);
        const rate = p.total ? p.green / p.total : 0;
        const color = rate >= 0.9 ? "var(--green)" : rate >= 0.6 ? "var(--yellow)" : "var(--red)";
        return (
          <rect
            key={p.day + i}
            x={i * bar + 1}
            y={height - h}
            width={Math.max(bar - 2, 2)}
            height={h}
            rx={1.5}
            fill={color}
          >
            <title>{`${p.day.slice(0, 10)}: ${p.green}/${p.total} green`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

export function timeShort(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Dubai",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
