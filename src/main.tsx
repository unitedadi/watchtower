import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Route, Routes, useLocation, useParams } from "react-router-dom";

import { todayDubai, yesterdayDubai, type Range } from "./api";
import { EyesMark } from "./ui";
import { OrgHome } from "./OrgHome";
import { ProjectView } from "./ProjectView";
import "./styles.css";

const RANGES: Array<[Range, string]> = [
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["all", "All time"],
];

function Topbar({ range, onRange }: { range: Range; onRange: (r: Range) => void }) {
  const location = useLocation();
  const { project } = useParams();
  const onProjectPage = location.pathname.startsWith("/p/");
  return (
    <div className="topbar">
      <Link to="/" className="wordmark">
        <EyesMark />
        WATCHTOWER
      </Link>
      {onProjectPage && project && (
        <span className="crumb">
          / <b>{project}</b>
        </span>
      )}
      <span className="spacer" />
      <div className="filters">
        {RANGES.map(([r, label]) => (
          <button key={r} className={range === r ? "on" : ""} onClick={() => onRange(r)}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function App() {
  const [range, setRange] = useState<Range>("today");
  const date = range === "yesterday" ? yesterdayDubai() : todayDubai();
  return (
    <div className="shell">
      <Routes>
        <Route path="/*" element={<Topbar range={range} onRange={setRange} />} />
      </Routes>
      <Routes>
        <Route path="/" element={<OrgHome range={range} date={date} />} />
        <Route path="/p/:project" element={<ProjectView range={range} date={date} />} />
      </Routes>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
