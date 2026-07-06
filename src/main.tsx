import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Route, Routes, useLocation, useParams } from "react-router-dom";

import { apiBase, setApiBase, todayDubai } from "./api";
import { OrgHome } from "./OrgHome";
import { ProjectView } from "./ProjectView";
import "./styles.css";

function Topbar({ date, onDate }: { date: string; onDate: (d: string) => void }) {
  const location = useLocation();
  const { project } = useParams();
  const [api, setApi] = useState(apiBase());
  const onProjectPage = location.pathname.startsWith("/p/");
  return (
    <div className="topbar">
      <h1>
        <Link to={`/?date=${date}`}>Watchtower</Link>
      </h1>
      {onProjectPage && project && <span className="crumb">/ {project}</span>}
      <span className="spacer" />
      <input type="date" value={date} max={todayDubai()} onChange={(e) => onDate(e.target.value)} />
      <input
        type="text"
        value={api}
        title="Telemetry API base"
        onChange={(e) => setApi(e.target.value)}
        onBlur={() => {
          setApiBase(api);
          window.location.reload();
        }}
      />
    </div>
  );
}

function App() {
  const params = new URLSearchParams(window.location.search);
  const [date, setDate] = useState(params.get("date") || todayDubai());
  return (
    <div className="shell">
      <Routes>
        <Route path="/*" element={<Topbar date={date} onDate={setDate} />} />
      </Routes>
      <Routes>
        <Route path="/" element={<OrgHome date={date} />} />
        <Route path="/p/:project" element={<ProjectView date={date} />} />
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
