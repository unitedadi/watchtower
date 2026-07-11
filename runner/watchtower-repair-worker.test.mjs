import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function run(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", (code) => resolve({ code, stderr }));
  });
}

test("worker claims exactly one case and submits a read-only structured diagnosis", async () => {
  const root = mkdtempSync(join(tmpdir(), "watchtower-repair-"));
  const codexLog = join(root, "codex-args.json");
  const whatsappLog = join(root, "whatsapp.log");
  const fakeCodex = join(root, "fake-codex.mjs");
  const fakeOpenclaw = join(root, "fake-openclaw.mjs");
  writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(args));
const output = args[args.indexOf("--output-last-message") + 1];
writeFileSync(output, JSON.stringify({ diagnosis: "The classifier lacks a receipt for this failure.", confidence: "high", category: "telemetry_gap", affected_paths: ["src/services/telemetryClassifier.ts"], suggested_next_step: "Add the named rule and receipt test.", proof_gaps: [], requires_human: false }));
`,
  );
  writeFileSync(
    fakeOpenclaw,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.FAKE_WHATSAPP_LOG, process.argv.slice(2).join(" ") + "\\n");
`,
  );
  chmodSync(fakeCodex, 0o755);
  chmodSync(fakeOpenclaw, 0o755);

  let claimed = false;
  let completion = null;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/telemetry/repair-worker/claim" && !claimed) {
      claimed = true;
      return response.end(JSON.stringify({
        lease_token: "lease-token-for-test-000000000000000000000000000000000000000000000000",
        repair_case: {
          case_id: "WT-20370412-TESTCASE",
          product: "unknown-test-product",
          title: "Synthetic failure",
          case_prompt: "Inspect the synthetic receipt. Do not edit anything.",
        },
      }));
    }
    if (request.url?.endsWith("/complete")) {
      completion = body;
      return response.end(JSON.stringify({ repair_case: { state: body.outcome } }));
    }
    response.statusCode = 204;
    return response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");

  try {
    const worker = new URL("./watchtower-repair-worker.mjs", import.meta.url).pathname;
    const result = await run(process.execPath, [worker], {
      ...process.env,
      WATCHTOWER_REPAIR_API_BASE: `http://127.0.0.1:${address.port}`,
      WATCHTOWER_REPAIR_RUNNER_TOKEN: "runner-test-token",
      WATCHTOWER_REPAIR_WHATSAPP_TARGET: "+971500000000",
      WATCHTOWER_REPAIR_CODEX_BIN: fakeCodex,
      WATCHTOWER_REPAIR_CODEX_MODEL: "gpt-5.5",
      WATCHTOWER_REPAIR_CODEX_REASONING_EFFORT: "xhigh",
      WATCHTOWER_REPAIR_OPENCLAW_BIN: fakeOpenclaw,
      WATCHTOWER_REPAIR_RUN_ROOT: join(root, "runs"),
      WATCHTOWER_REPAIR_LOCK_PATH: join(root, "state", "worker.lock"),
      WATCHTOWER_REPAIR_WORKSPACE_ROOT: root,
      WATCHTOWER_REPAIR_SKIP_SYNC: "true",
      FAKE_CODEX_LOG: codexLog,
      FAKE_WHATSAPP_LOG: whatsappLog,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(completion.outcome, "INVESTIGATED");
    assert.equal(completion.report.confidence, "high");
    assert.match(completion.summary, /classifier lacks a receipt/);

    const codexArgs = JSON.parse(readFileSync(codexLog, "utf8"));
    assert.deepEqual(codexArgs.slice(0, 4), ["exec", "--sandbox", "read-only", "--ephemeral"]);
    assert.equal(codexArgs.includes("--dangerously-bypass-approvals-and-sandbox"), false);
    assert.equal(codexArgs.includes("gpt-5.5"), true);
    assert.equal(codexArgs.includes('model_reasoning_effort="xhigh"'), true);
    const whatsapp = readFileSync(whatsappLog, "utf8");
    assert.match(whatsapp, /investigating Synthetic failure/);
    assert.match(whatsapp, /diagnosis ready/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
