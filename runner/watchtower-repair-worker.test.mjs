import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

function git(cwd, args) {
  return execFileSync("/usr/bin/git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function registry(path, overrides = {}) {
  return {
    owners: {
      checkout: {
        repository: "unitedadi/dardoc-checkout",
        path,
        base_branch: "main",
        validation: [],
        ship: { kind: "disabled" },
      },
      backend: {
        repository: "ado-dardoc/RealBackend",
        path,
        base_branch: "dev",
        validation: [],
        ship: { kind: "disabled" },
      },
      watchtower: {
        repository: "unitedadi/watchtower",
        path,
        base_branch: "main",
        validation: [],
        ship: { kind: "disabled" },
      },
      ...overrides,
    },
    observed_repositories: ["unitedadi/dardoc-checkout"],
  };
}

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  return { server, base: `http://127.0.0.1:${address.port}` };
}

test("diagnosis is read-only and waits for approval without creating or changing a GitHub issue", async () => {
  const root = mkdtempSync(join(tmpdir(), "watchtower-diagnosis-"));
  const registryPath = join(root, "repos.json");
  const reportLog = join(root, "codex-args.json");
  const fakeCodex = join(root, "fake-codex.mjs");
  writeFileSync(registryPath, JSON.stringify(registry(root)));
  writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(args));
const output = args[args.indexOf("--output-last-message") + 1];
writeFileSync(output, JSON.stringify({
  route: "needs_evidence",
  confidence: "low",
  reason: "The backend receipt is missing.",
  customer_impact: "The customer impact is not yet proven.",
  likely_cause: "Unknown.",
  owners: [],
  evidence_bindings: [],
  repair_plan: [],
  verification_plan: [],
  proof_gaps: ["Attach the backend response receipt."]
}));
`,
  );
  chmodSync(fakeCodex, 0o755);

  let parentClaimed = false;
  let diagnosis = null;
  const { server, base } = await listen(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (request.url === "/telemetry/repair-worker/github/outbox/claim") {
      response.statusCode = 204;
      return response.end();
    }
    if (request.url === "/telemetry/repair-worker/claim" && !parentClaimed) {
      parentClaimed = true;
      response.setHeader("content-type", "application/json");
      return response.end(JSON.stringify({
        lease_token: "l".repeat(64),
        repair_case: {
          case_id: "WT-20380101-DIAGNOSE",
          product: "checkout-web",
          title: "Unknown checkout failure",
          case_prompt: "Trace event 1 across all evidence layers.",
        },
      }));
    }
    if (request.url?.endsWith("/diagnosis")) {
      diagnosis = body;
      response.setHeader("content-type", "application/json");
      return response.end(JSON.stringify({ repair_case: { state: "NEEDS_HUMAN" } }));
    }
    response.statusCode = 204;
    return response.end();
  });

  try {
    const worker = new URL("./watchtower-repair-worker.mjs", import.meta.url).pathname;
    const result = await run(process.execPath, [worker], {
      ...process.env,
      WATCHTOWER_REPAIR_API_BASE: base,
      WATCHTOWER_REPAIR_RUNNER_TOKEN: "runner-token",
      WATCHTOWER_REPAIR_REPO_REGISTRY: registryPath,
      WATCHTOWER_REPAIR_CODEX_BIN: fakeCodex,
      WATCHTOWER_REPAIR_CODEX_MODEL: "gpt-5.5",
      WATCHTOWER_REPAIR_CODEX_REASONING_EFFORT: "xhigh",
      WATCHTOWER_REPAIR_RUN_ROOT: join(root, "runs"),
      WATCHTOWER_REPAIR_LOCK_PATH: join(root, "worker.lock"),
      WATCHTOWER_REPAIR_SKIP_SYNC: "true",
      FAKE_CODEX_LOG: reportLog,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(diagnosis.diagnosis.route, "needs_evidence");
    const args = JSON.parse(readFileSync(reportLog, "utf8"));
    assert.deepEqual(args.slice(0, 4), ["exec", "--sandbox", "read-only", "--ephemeral"]);
    assert.equal(args.includes("gpt-5.5"), true);
    assert.equal(args.includes('model_reasoning_effort="xhigh"'), true);
    assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("approved repair creates a tested local commit and never pushes before ship approval", async () => {
  const root = mkdtempSync(join(tmpdir(), "watchtower-patch-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const mirror = join(root, "mirror");
  const registryPath = join(root, "repos.json");
  const fakeCodex = join(root, "fake-codex.mjs");

  mkdirSync(remote);
  git(root, ["init", "--bare", remote]);
  mkdirSync(seed);
  git(seed, ["init"]);
  git(seed, ["config", "user.name", "Test"]);
  git(seed, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(seed, "bug.js"), "export const fixed = false;\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "seed"]);
  git(seed, ["branch", "-M", "dev"]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-u", "origin", "dev"]);
  git(root, ["clone", "--branch", "dev", remote, mirror]);

  writeFileSync(registryPath, JSON.stringify(registry(mirror, {
    backend: {
      repository: "ado-dardoc/RealBackend",
      path: mirror,
      base_branch: "dev",
      validation: [{
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      }],
      ship: { kind: "disabled" },
    },
  })));
  writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const output = args[args.indexOf("--output-last-message") + 1];
writeFileSync(join(process.cwd(), "bug.js"), "export const fixed = true;\\n");
writeFileSync(output, JSON.stringify({
  status: "fixed",
  solution: "Corrected the proven backend branch.",
  changed_files: ["bug.js"],
  tests_run: [{ command: "focused test", result: "passed" }],
  verification_notes: ["Exact receipt covered."],
  remaining_risks: [],
  blocker: ""
}));
`,
  );
  chmodSync(fakeCodex, 0o755);

  let taskClaimed = false;
  let completion = null;
  const { server, base } = await listen(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (request.url === "/telemetry/repair-worker/github/outbox/claim") {
      response.statusCode = 204;
      return response.end();
    }
    if (request.url === "/telemetry/repair-worker/claim") {
      response.statusCode = 204;
      return response.end();
    }
    if (request.url === "/telemetry/repair-worker/tasks/claim" && !taskClaimed) {
      taskClaimed = true;
      response.setHeader("content-type", "application/json");
      return response.end(JSON.stringify({
        lease_token: "t".repeat(64),
        repair_case: {
          case_id: "WT-20380101-PATCH",
          product: "checkout-web",
          title: "Backend branch failed",
        },
        repair_task: {
          task_id: "WT-20380101-PATCH-1-backend",
          occurrence_no: 1,
          owner: "backend",
          repository: "ado-dardoc/RealBackend",
          state: "CLAIMED",
          evidence_refs: [
            { source: "backend_truth", fact: "Branch failed", receipt: "event=1" },
          ],
          repair_plan: ["Correct the branch."],
          verification_plan: ["Run the focused build."],
        },
      }));
    }
    if (request.url?.endsWith("/complete")) {
      completion = body;
      response.setHeader("content-type", "application/json");
      return response.end(JSON.stringify({ repair_task: { state: body.outcome } }));
    }
    response.statusCode = 204;
    return response.end();
  });

  try {
    const worker = new URL("./watchtower-repair-worker.mjs", import.meta.url).pathname;
    const result = await run(process.execPath, [worker], {
      ...process.env,
      WATCHTOWER_REPAIR_API_BASE: base,
      WATCHTOWER_REPAIR_RUNNER_TOKEN: "runner-token",
      WATCHTOWER_REPAIR_REPO_REGISTRY: registryPath,
      WATCHTOWER_REPAIR_CODEX_BIN: fakeCodex,
      WATCHTOWER_REPAIR_RUN_ROOT: join(root, "runs"),
      WATCHTOWER_REPAIR_LOCK_PATH: join(root, "worker.lock"),
      WATCHTOWER_REPAIR_SKIP_SYNC: "true",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(completion.outcome, "PATCH_READY");
    assert.match(completion.worktree_path, /worktrees\/backend$/);
    assert.match(completion.branch, /^codex\//);
    assert.equal(completion.commit_sha.length, 40);
    assert.equal(readFileSync(join(completion.worktree_path, "bug.js"), "utf8"), "export const fixed = true;\n");
    assert.equal(git(root, ["--git-dir", remote, "branch", "--list", completion.branch]), "");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("ship approval cannot bypass an unconfigured fixed release adapter", async () => {
  const root = mkdtempSync(join(tmpdir(), "watchtower-ship-"));
  const registryPath = join(root, "repos.json");
  writeFileSync(registryPath, JSON.stringify(registry(root)));
  let completion = null;
  const { server, base } = await listen(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (request.url === "/telemetry/repair-worker/github/outbox/claim") {
      response.statusCode = 204;
      return response.end();
    }
    if (request.url === "/telemetry/repair-worker/claim") {
      response.statusCode = 204;
      return response.end();
    }
    if (request.url === "/telemetry/repair-worker/tasks/claim") {
      response.setHeader("content-type", "application/json");
      return response.end(JSON.stringify({
        lease_token: "s".repeat(64),
        repair_case: { case_id: "WT-20380101-SHIP", product: "checkout-web" },
        repair_task: {
          task_id: "WT-20380101-SHIP-1-backend",
          occurrence_no: 1,
          owner: "backend",
          repository: "ado-dardoc/RealBackend",
          state: "SHIPPING",
          commit_sha: "abc123",
        },
      }));
    }
    if (request.url?.endsWith("/complete")) {
      completion = body;
      response.setHeader("content-type", "application/json");
      return response.end(JSON.stringify({ repair_task: { state: body.outcome } }));
    }
    response.statusCode = 204;
    return response.end();
  });

  try {
    const worker = new URL("./watchtower-repair-worker.mjs", import.meta.url).pathname;
    const result = await run(process.execPath, [worker], {
      ...process.env,
      WATCHTOWER_REPAIR_API_BASE: base,
      WATCHTOWER_REPAIR_RUNNER_TOKEN: "runner-token",
      WATCHTOWER_REPAIR_REPO_REGISTRY: registryPath,
      WATCHTOWER_REPAIR_RUN_ROOT: join(root, "runs"),
      WATCHTOWER_REPAIR_LOCK_PATH: join(root, "worker.lock"),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(completion.outcome, "BLOCKED");
    assert.match(completion.summary, /Shipping is not configured/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
