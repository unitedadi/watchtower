export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "method_not_allowed" });
  }

  const backendBase = (process.env.WATCHTOWER_REPAIR_API_BASE || "https://api-prod.dardoc.com").replace(/\/+$/, "");
  const operatorToken = process.env.WATCHTOWER_REPAIR_OPERATOR_TOKEN || "";
  if (!operatorToken) return response.status(503).json({ error: "repair_operator_not_configured" });

  try {
    const upstream = await fetch(`${backendBase}/telemetry/repair-cases`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${operatorToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request.body ?? {}),
    });
    const payload = await upstream.text();
    response.status(upstream.status);
    response.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    return response.send(payload);
  } catch (error) {
    return response.status(502).json({
      error: "repair_backend_unreachable",
      detail: String(error instanceof Error ? error.message : error).slice(0, 160),
    });
  }
}
