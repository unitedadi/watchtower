import { useEffect, useRef, useState } from "react";
import lottie from "lottie-web/build/player/lottie_light";

import eyesAnimation from "./assets/eyes.json";
import type { SparklinePoint } from "./api";

// The Watchtower mark: a pair of eyes that blink and glance around.
// The composition is a 2000x2000 canvas with large empty margins, so after
// load the svg viewBox is cropped to the rendered bounding box.
export function EyesMark({ height = 26 }: { height?: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const anim = lottie.loadAnimation({
      container: el,
      renderer: "svg",
      loop: true,
      autoplay: true,
      animationData: eyesAnimation as unknown as object,
    });
    const crop = () => {
      const svg = el.querySelector("svg");
      if (!svg) return;
      try {
        const b = (svg as unknown as SVGGraphicsElement).getBBox();
        const pad = b.height * 0.08;
        svg.setAttribute("viewBox", `${b.x - pad} ${b.y - pad} ${b.width + pad * 2} ${b.height + pad * 2}`);
        svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      } catch {
        // getBBox can throw pre-layout; the uncropped mark still renders
      }
    };
    anim.addEventListener("DOMLoaded", crop);
    return () => anim.destroy();
  }, []);
  return <div ref={ref} style={{ height, width: height * 1.9, display: "block" }} aria-hidden="true" />;
}

export function Chip({ cls, children }: { cls: string; children: React.ReactNode }) {
  return (
    <span className={`chip ${cls}`}>
      <span className="d" />
      {children}
    </span>
  );
}

export function Dot({ cls }: { cls: string }) {
  return <span className={`dot ${cls}`} />;
}

export function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="copybtn"
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(text);
        setDone(true);
        window.setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? "copied" : "copy"}
    </button>
  );
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skel" style={{ width: `${88 - i * 9}%` }} />
      ))}
    </div>
  );
}

const SPARK_COLORS = { good: "#4cc38a", mid: "#e3a94f", bad: "#e56a61" };

// 14-day history: bar height = volume, color = green rate.
export function Sparkline({ points, width = 280, height = 42 }: { points: SparklinePoint[]; width?: number; height?: number }) {
  if (!points.length) return <div className="faint small mono">no history yet</div>;
  const max = Math.max(...points.map((p) => p.total), 1);
  const bar = width / Math.max(points.length, 14);
  return (
    <svg className="sparkline" width={width} height={height} role="img" aria-label="14 day history">
      {points.map((p, i) => {
        const h = Math.max((p.total / max) * (height - 6), 2.5);
        const rate = p.total ? p.green / p.total : 0;
        const color = rate >= 0.9 ? SPARK_COLORS.good : rate >= 0.6 ? SPARK_COLORS.mid : SPARK_COLORS.bad;
        return (
          <rect key={p.day + i} x={i * bar + 1.5} y={height - h} width={Math.max(bar - 3, 2.5)} height={h} rx={1.5} fill={color} opacity={0.9}>
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

export function offsetLabel(iso: string, baseIso: string): string {
  try {
    const ms = new Date(iso).getTime() - new Date(baseIso).getTime();
    if (ms < 1000) return "+0s";
    if (ms < 60_000) return `+${(ms / 1000).toFixed(1)}s`;
    if (ms < 3_600_000) {
      const m = Math.floor(ms / 60_000);
      const s = Math.round((ms % 60_000) / 1000);
      return `+${m}m${s.toString().padStart(2, "0")}`;
    }
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return `+${h}h${m.toString().padStart(2, "0")}`;
  } catch {
    return "";
  }
}

export function spanLabel(fromIso: string, toIso: string): string {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  if (ms < 1000) return "<1s";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}
