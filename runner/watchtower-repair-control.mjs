const base = String(process.env.WATCHTOWER_REPAIR_API_BASE || "https://api-prod.dardoc.com").replace(/\/+$/, "");
const [command = "status", caseId] = process.argv.slice(2);

async function read(path) {
  const response = await fetch(`${base}${path}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${body.error || path}`);
  return body;
}

async function mutate(path) {
  const token = String(process.env.WATCHTOWER_REPAIR_RUNNER_TOKEN || "").trim();
  if (!token) throw new Error("WATCHTOWER_REPAIR_RUNNER_TOKEN is required");
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ worker_id: "whatsapp-control" }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${body.error || path}`);
  return body;
}

let result;
if (command === "status" && caseId) {
  result = await read(`/telemetry/repair-cases/${encodeURIComponent(caseId)}`);
} else if (command === "status") {
  result = await read("/telemetry/repair-cases?limit=10");
} else if (command === "stop" && caseId) {
  result = await mutate(`/telemetry/repair-worker/${encodeURIComponent(caseId)}/stop`);
} else if ((command === "retry" || command === "requeue") && caseId) {
  result = await mutate(`/telemetry/repair-worker/${encodeURIComponent(caseId)}/requeue`);
} else {
  throw new Error("usage: watchtower-repair-control.mjs status [case] | stop <case> | retry <case>");
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
