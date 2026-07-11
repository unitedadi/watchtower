import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const DEFAULT_API_BASE = "https://api-prod.dardoc.com";
const DEFAULT_RUN_ROOT = "/Users/mini/codex-runner/runs/watchtower-repair";
const DEFAULT_LOCK_PATH = "/Users/mini/codex-runner/state/watchtower-repair.lock";
const BACKEND_REPO = "/Users/mini/codex-runner/repos/realbackend";
const WATCHTOWER_REPO = "/Users/mini/codex-runner/repos/watchtower";
const execFileAsync = promisify(execFile);

const PRODUCT_REPOS = {
  "checkout-web": "/Users/mini/codex-runner/repos/checkout-dardoc",
  "ios-app": "/Users/mini/codex-runner/repos/dardoc-ios",
  "ops-portal": "/Users/mini/codex-runner/repos/dardoc-ops-portal",
};

function required(env, name) {
  const value = String(env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function acquireLock(path) {
  mkdirSync(join(path, ".."), { recursive: true });
  try {
    return openSync(path, "wx", 0o600);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    if (Number.isInteger(pid)) {
      try {
        process.kill(pid, 0);
        return null;
      } catch {
        // The recorded process is gone, so this lock can be reclaimed now.
      }
    } else if (Date.now() - statSync(path).mtimeMs < 2 * 60 * 60 * 1000) {
      return null;
    }
    rmSync(path, { force: true });
    return openSync(path, "wx", 0o600);
  }
}

async function apiRequest(env, path, body, fetchImpl = fetch) {
  const base = String(env.WATCHTOWER_REPAIR_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");
  const response = await fetchImpl(`${base}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${required(env, "WATCHTOWER_REPAIR_RUNNER_TOKEN")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${payload.error || path}`);
  return payload;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", ...options });
    child.once("error", () => resolve({ code: 1, child }));
    child.once("exit", (code) => resolve({ code: code ?? 1, child }));
    if (options.onChild) options.onChild(child);
  });
}

async function sendWhatsApp(env, message) {
  const target = String(env.WATCHTOWER_REPAIR_WHATSAPP_TARGET || "").trim();
  if (!target) return;
  const binary = env.WATCHTOWER_REPAIR_OPENCLAW_BIN || "/opt/homebrew/bin/openclaw";
  await runCommand(binary, [
    "message",
    "send",
    "--channel",
    "whatsapp",
    "--account",
    "default",
    "--target",
    target,
    "--message",
    message,
  ], { env });
}

async function syncMirror(path, branch, env) {
  if (env.WATCHTOWER_REPAIR_SKIP_SYNC === "true") return;
  if (!existsSync(join(path, ".git"))) throw new Error(`repair mirror missing: ${path}`);
  const git = env.WATCHTOWER_REPAIR_GIT_BIN || "/usr/bin/git";
  const options = { env, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 };
  const status = await execFileAsync(git, ["-C", path, "status", "--porcelain"], options);
  if (status.stdout.trim()) throw new Error(`repair mirror is dirty: ${path}`);
  await execFileAsync(git, ["-C", path, "fetch", "origin", "--prune", "--quiet"], options);
  await execFileAsync(git, ["-C", path, "switch", branch, "--quiet"], options);
  await execFileAsync(git, ["-C", path, "merge", "--ff-only", `origin/${branch}`, "--quiet"], options);
}

function reportSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["diagnosis", "confidence", "category", "affected_paths", "suggested_next_step", "proof_gaps", "requires_human"],
    properties: {
      diagnosis: { type: "string" },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      category: { type: "string", enum: ["product_bug", "backend_bug", "telemetry_gap", "stale_data", "operations", "unknown"] },
      affected_paths: { type: "array", items: { type: "string" } },
      suggested_next_step: { type: "string" },
      proof_gaps: { type: "array", items: { type: "string" } },
      requires_human: {
        type: "boolean",
        description: "True only when the investigation itself cannot reach a useful diagnosis, not merely because a later repair needs approval.",
      },
    },
  };
}

function codexPrompt(repairCase) {
  const productRepo = PRODUCT_REPOS[repairCase.product] || "/Users/mini/Documents";
  return [
    "Read /Users/mini/.codex/skills/watchtower-investigate/SKILL.md first and follow it exactly.",
    "",
    repairCase.case_prompt,
    "",
    "Repository map:",
    `- Product: ${productRepo}`,
    `- Backend: ${BACKEND_REPO}`,
    `- Watchtower: ${WATCHTOWER_REPO}`,
    "",
    "Return only the JSON object required by the output schema.",
  ].join("\n");
}

function conciseDiagnosis(report) {
  const diagnosis = String(report?.diagnosis || "Investigation did not produce a diagnosis.").replace(/\s+/g, " ").trim();
  return diagnosis.slice(0, 900);
}

export async function runWorker(env = process.env) {
  const lockPath = env.WATCHTOWER_REPAIR_LOCK_PATH || DEFAULT_LOCK_PATH;
  const lock = acquireLock(lockPath);
  if (lock === null) return { status: "already_running" };
  closeSync(lock);
  writeFileSync(lockPath, `${process.pid}\n`, { mode: 0o600 });

  let child = null;
  let heartbeat = null;
  try {
    const workerId = env.WATCHTOWER_REPAIR_WORKER_ID || "mac-mini-readonly";
    const claim = await apiRequest(env, "/telemetry/repair-worker/claim", {
      worker_id: workerId,
      lease_seconds: 600,
    });
    if (!claim) return { status: "idle" };

    const repairCase = claim.repair_case;
    const leaseToken = claim.lease_token;
    try {
      const mirrors = new Map([
        [BACKEND_REPO, env.WATCHTOWER_REPAIR_BACKEND_BRANCH || "dev"],
        [WATCHTOWER_REPO, "main"],
        [PRODUCT_REPOS[repairCase.product], "main"],
      ]);
      for (const [path, branch] of mirrors) {
        if (path) await syncMirror(path, branch, env);
      }
    } catch (error) {
      const summary = `Repository mirror refresh failed: ${String(error?.message || error).slice(0, 500)}`;
      const report = {
        diagnosis: summary,
        confidence: "high",
        category: "operations",
        affected_paths: [],
        suggested_next_step: "Restore a clean, reachable repair mirror and retry this case.",
        proof_gaps: ["Current source could not be verified before investigation."],
        requires_human: true,
      };
      await apiRequest(env, `/telemetry/repair-worker/${encodeURIComponent(repairCase.case_id)}/complete`, {
        worker_id: workerId,
        lease_token: leaseToken,
        outcome: "NEEDS_HUMAN",
        summary,
        report,
      });
      await sendWhatsApp(env, `Watchtower ${repairCase.case_id}: needs review. ${summary.slice(0, 260)}`);
      return { status: "needs_human", case_id: repairCase.case_id };
    }
    const runRoot = env.WATCHTOWER_REPAIR_RUN_ROOT || DEFAULT_RUN_ROOT;
    const runDir = join(runRoot, repairCase.case_id);
    mkdirSync(runDir, { recursive: true });
    const schemaPath = join(runDir, "report.schema.json");
    const reportPath = join(runDir, "report.json");
    const promptPath = join(runDir, "case.txt");
    writeFileSync(schemaPath, JSON.stringify(reportSchema(), null, 2));
    writeFileSync(promptPath, codexPrompt(repairCase));

    await sendWhatsApp(env, `Watchtower ${repairCase.case_id}: investigating ${repairCase.title}. Read-only, no deploy.`);

    let leaseLost = false;
    heartbeat = setInterval(() => {
      apiRequest(env, `/telemetry/repair-worker/${encodeURIComponent(repairCase.case_id)}/heartbeat`, {
        worker_id: workerId,
        lease_token: leaseToken,
        lease_seconds: 600,
      }).catch(() => {
        leaseLost = true;
        child?.kill("SIGTERM");
      });
    }, 120_000);

    const productRepo = PRODUCT_REPOS[repairCase.product];
    const fallbackRepo = env.WATCHTOWER_REPAIR_WORKSPACE_ROOT || BACKEND_REPO;
    const cwd = productRepo && existsSync(productRepo)
      ? productRepo
      : existsSync(fallbackRepo) ? fallbackRepo : process.cwd();
    const codexBin = env.WATCHTOWER_REPAIR_CODEX_BIN || "/Users/mini/.nvm/versions/node/v24.16.0/bin/codex";
    const args = [
      "exec",
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--color",
      "never",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      reportPath,
      "-C",
      cwd,
    ];
    if (env.WATCHTOWER_REPAIR_CODEX_MODEL) args.push("--model", env.WATCHTOWER_REPAIR_CODEX_MODEL);
    args.push("-");

    const result = await runCommand(codexBin, args, {
      cwd,
      env,
      input: readFileSync(promptPath, "utf8"),
      stdio: ["pipe", "ignore", "ignore"],
      onChild(value) {
        child = value;
        value.stdin.on("error", () => undefined);
        value.stdin.end(readFileSync(promptPath, "utf8"));
      },
    });
    child = null;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    if (leaseLost) return { status: "lease_lost", case_id: repairCase.case_id };

    let report;
    try {
      report = JSON.parse(readFileSync(reportPath, "utf8"));
    } catch {
      report = {
        diagnosis: `Codex exited ${result.code === 0 ? "without a structured report" : `with code ${result.code}`}.`,
        confidence: "low",
        category: "unknown",
        affected_paths: [],
        suggested_next_step: "Review the worker run and retry the case.",
        proof_gaps: ["structured diagnosis missing"],
        requires_human: true,
      };
    }
    const outcome = result.code === 0 && !report.requires_human ? "INVESTIGATED" : "NEEDS_HUMAN";
    const summary = conciseDiagnosis(report);
    await apiRequest(env, `/telemetry/repair-worker/${encodeURIComponent(repairCase.case_id)}/complete`, {
      worker_id: workerId,
      lease_token: leaseToken,
      outcome,
      summary,
      report,
    });
    await sendWhatsApp(
      env,
      `Watchtower ${repairCase.case_id}: ${outcome === "INVESTIGATED" ? "diagnosis ready" : "needs review"}. ${summary.slice(0, 260)}`,
    );
    return { status: outcome.toLowerCase(), case_id: repairCase.case_id };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    child?.kill("SIGTERM");
    rmSync(lockPath, { force: true });
  }
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  runWorker().catch((error) => {
    process.stderr.write(`watchtower repair worker failed: ${String(error?.message || error)}\n`);
    process.exitCode = 1;
  });
}
