import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { sendWhatsApp } from "./watchtower-repair-worker.mjs";

function run(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", (code) => resolve({ code, stderr }));
  });
}

function git(cwd, args) {
  return execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function installFakeGh(root) {
  const binary = join(root, "fake-gh.mjs");
  const log = join(root, "github.log");
  writeFileSync(
    binary,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_GITHUB_LOG, args.join(" ") + "\\n");
if (args[0] === "repo" && args[1] === "view") process.stdout.write("PRIVATE\\n");
else if (args[0] === "issue" && args[1] === "create") process.stdout.write("https://github.com/unitedadi/DarDocCodexControlPlane/issues/77\\n");
else if (args[0] === "issue" && args[1] === "comment") process.stdout.write("https://github.com/unitedadi/DarDocCodexControlPlane/issues/77#issuecomment-1\\n");
else process.exitCode = 1;
`,
  );
  chmodSync(binary, 0o755);
  return { binary, log };
}

test("worker blocks instead of presenting an incomplete diagnosis as a fix", async () => {
  const root = mkdtempSync(join(tmpdir(), "watchtower-repair-"));
  const codexLog = join(root, "codex-args.json");
  const whatsappLog = join(root, "whatsapp.log");
  const fakeCodex = join(root, "fake-codex.mjs");
  const fakeWacli = join(root, "fake-wacli.mjs");
  const fakeGh = installFakeGh(root);
  writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(args));
const output = args[args.indexOf("--output-last-message") + 1];
writeFileSync(output, JSON.stringify({ customer_impact: "The exact customer impact is not present in the receipt.", root_cause: "The classifier lacks the original error metadata.", decisive_evidence: [], confidence: "medium", category: "telemetry_gap", repair_target: "backend", affected_paths: ["src/services/telemetryClassifier.ts"], repair_plan: ["Attach the missing error metadata."], verification_plan: ["Replay the receipt."], proof_gaps: ["Original error metadata is missing."], autofix: "blocked", blocker: "The worker cannot prove which classifier rule is correct." }));
`,
  );
  writeFileSync(
    fakeWacli,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.FAKE_WHATSAPP_LOG, process.argv.slice(2).join(" ") + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { sent: true } }));
`,
  );
  chmodSync(fakeCodex, 0o755);
  chmodSync(fakeWacli, 0o755);

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
          headline: "1 red event requires an exact diagnosis",
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
      WATCHTOWER_REPAIR_WACLI_BIN: fakeWacli,
      WATCHTOWER_REPAIR_GH_BIN: fakeGh.binary,
      WATCHTOWER_REPAIR_RUN_ROOT: join(root, "runs"),
      WATCHTOWER_REPAIR_LOCK_PATH: join(root, "state", "worker.lock"),
      WATCHTOWER_REPAIR_BACKEND_REPO: root,
      WATCHTOWER_REPAIR_WATCHTOWER_REPO: root,
      WATCHTOWER_REPAIR_SKIP_SYNC: "true",
      FAKE_CODEX_LOG: codexLog,
      FAKE_WHATSAPP_LOG: whatsappLog,
      FAKE_GITHUB_LOG: fakeGh.log,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(completion.outcome, "NEEDS_HUMAN");
    assert.equal(completion.report.confidence, "medium");
    assert.match(completion.summary, /cannot prove which classifier rule/);

    const codexArgs = JSON.parse(readFileSync(codexLog, "utf8"));
    assert.deepEqual(codexArgs.slice(0, 4), ["exec", "--sandbox", "read-only", "--ephemeral"]);
    assert.equal(codexArgs.includes("--dangerously-bypass-approvals-and-sandbox"), false);
    assert.equal(codexArgs.includes("gpt-5.5"), true);
    assert.equal(codexArgs.includes('model_reasoning_effort="xhigh"'), true);
    const whatsapp = readFileSync(whatsappLog, "utf8");
    assert.match(whatsapp, /send text --to \+971500000000/);
    assert.match(whatsapp, /WATCHTOWER: NOT GREEN/);
    assert.match(whatsapp, /WATCHTOWER: BLOCKED - NOT FIXED/);
    assert.match(whatsapp, /DarDocCodexControlPlane\/issues\/77/);
    assert.doesNotMatch(whatsapp, /ROOT CAUSE PROVEN/);
    assert.doesNotMatch(whatsapp, /diagnosis ready/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("WhatsApp delivery failure is surfaced", async () => {
  const root = mkdtempSync(join(tmpdir(), "watchtower-whatsapp-failure-"));
  const fakeWacli = join(root, "fake-wacli.mjs");
  writeFileSync(
    fakeWacli,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ success: false, error: "not_connected" }));
`,
  );
  chmodSync(fakeWacli, 0o755);

  await assert.rejects(
    sendWhatsApp({
      ...process.env,
      WATCHTOWER_REPAIR_WHATSAPP_TARGET: "+971500000000",
      WATCHTOWER_REPAIR_WACLI_BIN: fakeWacli,
    }, "Watchtower test"),
    /WhatsApp send failed: not_connected/,
  );
});

test("high-confidence evidence produces a tested patch branch", async () => {
  const root = mkdtempSync(join(tmpdir(), "watchtower-autofix-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const mirror = join(root, "mirror");
  const fakeCodex = join(root, "fake-codex.mjs");
  const fakeWacli = join(root, "fake-wacli.mjs");
  const codexCount = join(root, "codex-count.txt");
  const whatsappLog = join(root, "whatsapp.log");
  const fakeGh = installFakeGh(root);

  mkdirSync(remote);
  git(root, ["init", "--bare", remote]);
  mkdirSync(seed);
  git(seed, ["init"]);
  git(seed, ["config", "user.name", "Test"]);
  git(seed, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(seed, "package.json"), JSON.stringify({ scripts: { "build:backend": "node -e \"process.exit(0)\"" } }));
  writeFileSync(join(seed, "bug.js"), "export const fixed = false;\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "seed"]);
  git(seed, ["branch", "-M", "dev"]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-u", "origin", "dev"]);
  git(root, ["clone", "--branch", "dev", remote, mirror]);

  writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const output = args[args.indexOf("--output-last-message") + 1];
const count = existsSync(process.env.FAKE_CODEX_COUNT) ? Number(readFileSync(process.env.FAKE_CODEX_COUNT, "utf8")) + 1 : 1;
writeFileSync(process.env.FAKE_CODEX_COUNT, String(count));
if (count === 1) {
  writeFileSync(output, JSON.stringify({ customer_impact: "Customers receive HTTP 500.", root_cause: "The exact branch returns 500 for the sampled receipt.", decisive_evidence: [{ fact: "Request returned 500", receipt: "event_id=1" }], confidence: "high", category: "backend_bug", repair_target: "backend", affected_paths: ["bug.js"], repair_plan: ["Correct the failing branch."], verification_plan: ["Run the backend build."], proof_gaps: [], autofix: "ready", blocker: "" }));
} else {
  writeFileSync(join(process.cwd(), "bug.js"), "export const fixed = true;\\n");
  writeFileSync(output, JSON.stringify({ status: "fixed", solution: "Corrected the failing branch.", changed_files: ["bug.js"], tests_run: [{ command: "focused test", result: "passed" }], verification_notes: ["Receipt shape covered."], remaining_risks: [], blocker: "" }));
}
`,
  );
  writeFileSync(
    fakeWacli,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.FAKE_WHATSAPP_LOG, process.argv.slice(2).join(" ") + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { sent: true } }));
`,
  );
  chmodSync(fakeCodex, 0o755);
  chmodSync(fakeWacli, 0o755);

  let claimed = false;
  let completion = null;
  const progressEvents = [];
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
          case_id: "WT-20370412-PATCHME",
          product: "unknown-test-product",
          title: "Synthetic backend failure",
          headline: "1 customer hit HTTP 500",
          case_prompt: "Resolve the synthetic backend receipt.",
        },
      }));
    }
    if (request.url?.endsWith("/progress")) {
      progressEvents.push(body.phase);
      return response.end(JSON.stringify({ repair_case: { state: "CLAIMED", phase: body.phase } }));
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
      WATCHTOWER_REPAIR_WACLI_BIN: fakeWacli,
      WATCHTOWER_REPAIR_GH_BIN: fakeGh.binary,
      WATCHTOWER_REPAIR_BACKEND_REPO: mirror,
      WATCHTOWER_REPAIR_WATCHTOWER_REPO: mirror,
      WATCHTOWER_REPAIR_RUN_ROOT: join(root, "runs"),
      WATCHTOWER_REPAIR_LOCK_PATH: join(root, "state", "worker.lock"),
      WATCHTOWER_REPAIR_SKIP_SYNC: "true",
      FAKE_CODEX_COUNT: codexCount,
      FAKE_WHATSAPP_LOG: whatsappLog,
      FAKE_GITHUB_LOG: fakeGh.log,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(completion.outcome, "PATCH_READY");
    assert.equal(completion.report.diagnosis.confidence, "high");
    assert.deepEqual(completion.report.release.changed_files, ["bug.js"]);
    assert.equal(completion.report.release.tests[0].result, "passed");
    assert.deepEqual(progressEvents, ["INVESTIGATING", "REPAIRING", "TESTING"]);
    assert.match(git(root, ["--git-dir", remote, "branch", "--list", "watchtower/wt-20370412-patchme"]), /watchtower\/wt-20370412-patchme/);

    const whatsapp = readFileSync(whatsappLog, "utf8");
    assert.match(whatsapp, /WATCHTOWER: ROOT CAUSE PROVEN \(HIGH\)/);
    assert.match(whatsapp, /WATCHTOWER: TESTED PATCH READY/);
    assert.match(whatsapp, /Changed: bug.js/);
    assert.match(whatsapp, /npm run build:backend: passed/);
    assert.match(whatsapp, /DarDocCodexControlPlane\/issues\/77/);
    assert.doesNotMatch(whatsapp, /suggested next step/i);
    const github = readFileSync(fakeGh.log, "utf8");
    assert.match(github, /issue create --repo unitedadi\/DarDocCodexControlPlane/);
    assert.match(github, /issue comment 77 .*root-cause\.md/);
    assert.match(github, /issue comment 77 .*patch-ready\.md/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
