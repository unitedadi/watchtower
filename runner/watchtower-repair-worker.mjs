import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const DEFAULT_API_BASE = "https://api-prod.dardoc.com";
const DEFAULT_RUN_ROOT = "/Users/mini/codex-runner/runs/watchtower-repair";
const DEFAULT_LOCK_PATH = "/Users/mini/codex-runner/state/watchtower-repair.lock";
const DEFAULT_BACKEND_REPO = "/Users/mini/codex-runner/repos/realbackend";
const DEFAULT_WATCHTOWER_REPO = "/Users/mini/codex-runner/repos/watchtower";
const DEFAULT_GITHUB_ISSUE_REPO = "unitedadi/DarDocCodexControlPlane";
const execFileAsync = promisify(execFile);

const DEFAULT_PRODUCT_REPOS = {
  "checkout-web": "/Users/mini/codex-runner/repos/checkout-dardoc",
  "ios-app": "/Users/mini/codex-runner/repos/dardoc-ios",
  "ops-portal": "/Users/mini/codex-runner/repos/dardoc-ops-portal",
};

function required(env, name) {
  const value = String(env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function repoPaths(env) {
  return {
    backend: env.WATCHTOWER_REPAIR_BACKEND_REPO || DEFAULT_BACKEND_REPO,
    watchtower: env.WATCHTOWER_REPAIR_WATCHTOWER_REPO || DEFAULT_WATCHTOWER_REPO,
    products: {
      ...DEFAULT_PRODUCT_REPOS,
      ...(env.WATCHTOWER_REPAIR_PRODUCT_REPO ? { [env.WATCHTOWER_REPAIR_PRODUCT]: env.WATCHTOWER_REPAIR_PRODUCT_REPO } : {}),
    },
  };
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

async function runCaptured(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      timeout: options.timeout ?? 10 * 60_000,
      maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
      ...options,
    });
    return { code: 0, stdout: result.stdout || "", stderr: result.stderr || "" };
  } catch (error) {
    return {
      code: Number.isInteger(error?.code) ? error.code : 1,
      stdout: String(error?.stdout || ""),
      stderr: String(error?.stderr || error?.message || error),
    };
  }
}

export async function sendWhatsApp(env, message) {
  if (env.WATCHTOWER_REPAIR_WHATSAPP_DISABLED === "true") return;
  const target = required(env, "WATCHTOWER_REPAIR_WHATSAPP_TARGET");
  const binary = env.WATCHTOWER_REPAIR_WACLI_BIN || "/Users/mini/.local/bin/wacli";
  const { stdout } = await execFileAsync(binary, [
    "--lock-wait",
    "15s",
    "--timeout",
    "60s",
    "--json",
    "send",
    "text",
    "--to",
    target,
    "--message",
    message,
    "--post-send-wait",
    "0s",
  ], { env, timeout: 75_000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout || "{}");
  if (result?.success !== true || result?.data?.sent !== true) {
    throw new Error(`WhatsApp send failed: ${result?.error || "message was not sent"}`);
  }
}

function issueLine(issue) {
  return issue?.url ? `Issue: ${issue.url}` : "Issue: not created";
}

function initialIssueBody(repairCase) {
  const evidence = JSON.stringify(repairCase.evidence ?? {}, null, 2).slice(0, 30_000);
  return [
    "# Watchtower: not green",
    "",
    `**Case:** ${repairCase.case_id}`,
    `**Product:** ${repairCase.product}`,
    `**Window:** ${repairCase.selected_date || "not supplied"}`,
    `**Observed status:** ${repairCase.observed_status || "not green"}`,
    `**Risk tier:** ${repairCase.risk_tier || "not supplied"}`,
    "",
    "## Customer-facing promise",
    repairCase.statement || repairCase.title,
    "",
    "## What Watchtower observed",
    repairCase.headline,
    "",
    "## Evidence at detection",
    "```json",
    evidence,
    "```",
    "",
    "## Repair contract",
    "- Prove the exact customer impact and root cause from decisive receipts.",
    "- Make the smallest focused change and run deterministic validation.",
    "- Keep this issue open while a patch is merely prepared or shipped.",
    "- Close only after Watchtower independently observes the promise recover.",
    "",
    "_This issue is maintained automatically by Watchtower._",
  ].join("\n");
}

function diagnosisIssueComment(diagnosis, repairable) {
  const evidence = (diagnosis.decisive_evidence ?? [])
    .map((item) => `- ${compact(item.fact, 1_000)} (${compact(item.receipt, 500)})`)
    .join("\n") || "- No decisive receipt attached.";
  return [
    `## ${repairable ? "Root cause proven" : "Automation blocked"}`,
    "",
    `**Customer impact:** ${diagnosis.customer_impact}`,
    "",
    `**Root cause:** ${diagnosis.root_cause}`,
    "",
    `**Confidence:** ${diagnosis.confidence}`,
    `**Category:** ${diagnosis.category}`,
    `**Repair owner:** ${diagnosis.repair_target}`,
    "",
    "### Decisive evidence",
    evidence,
    "",
    "### Repair plan",
    listLines(diagnosis.repair_plan, 10) || "- No safe repair plan was proven.",
    "",
    "### Verification plan",
    listLines(diagnosis.verification_plan, 10) || "- No verification plan was supplied.",
    diagnosis.proof_gaps?.length ? `\n### Missing proof\n${listLines(diagnosis.proof_gaps, 10)}` : "",
    !repairable ? `\n**Why automation stopped:** ${diagnosis.blocker || "High-confidence autofix gate was not met."}` : "",
  ].filter(Boolean).join("\n");
}

function patchIssueComment(diagnosis, repair, release) {
  return [
    "## Tested patch ready",
    "",
    `**Root cause:** ${diagnosis.root_cause}`,
    "",
    `**Solution:** ${repair.solution}`,
    "",
    `**Changed files:** ${release.changed_files.join(", ")}`,
    "",
    "### Required validation",
    release.tests.map((test) => `- \`${test.command}\`: **${test.result}**`).join("\n"),
    "",
    `**Commit:** \`${release.commit}\``,
    `**Branch:** \`${release.branch}\``,
    "",
    "This issue remains open. A tested patch is not the same as a deployed and independently verified recovery.",
  ].join("\n");
}

async function assertPrivateIssueRepository(env, repository) {
  const gh = env.WATCHTOWER_REPAIR_GH_BIN || "/opt/homebrew/bin/gh";
  const result = await runCaptured(gh, ["repo", "view", repository, "--json", "visibility", "--jq", ".visibility"], { env, timeout: 60_000 });
  if (result.code !== 0) throw new Error(`GitHub issue repository check failed: ${compact(result.stderr || result.stdout)}`);
  if (result.stdout.trim() !== "PRIVATE") throw new Error(`GitHub issue repository must be private: ${repository}`);
}

async function ensureGitHubIssue(env, repairCase, runDir) {
  const repository = repairCase.github_issue_repository || env.WATCHTOWER_REPAIR_GITHUB_REPO || DEFAULT_GITHUB_ISSUE_REPO;
  await assertPrivateIssueRepository(env, repository);
  if (repairCase.github_issue_url && repairCase.github_issue_number) {
    return { repository, number: Number(repairCase.github_issue_number), url: repairCase.github_issue_url };
  }
  const bodyPath = join(runDir, "github-issue.md");
  writeFileSync(bodyPath, initialIssueBody(repairCase));
  const gh = env.WATCHTOWER_REPAIR_GH_BIN || "/opt/homebrew/bin/gh";
  const title = `[Watchtower][${repairCase.case_id}] ${repairCase.product}: ${compact(repairCase.title, 140)}`;
  const result = await runCaptured(gh, ["issue", "create", "--repo", repository, "--title", title, "--body-file", bodyPath], { env, timeout: 60_000 });
  if (result.code !== 0) throw new Error(`GitHub issue creation failed: ${compact(result.stderr || result.stdout)}`);
  const url = result.stdout.trim().split(/\s+/).find((value) => /^https:\/\//.test(value));
  const number = Number(url?.match(/\/issues\/(\d+)(?:$|[/?#])/)?.[1]);
  if (!url || !Number.isInteger(number) || number <= 0) throw new Error("GitHub issue creation did not return an issue URL.");
  return { repository, number, url };
}

async function commentOnGitHubIssue(env, issue, runDir, name, body) {
  const bodyPath = join(runDir, `${name}.md`);
  writeFileSync(bodyPath, body);
  const gh = env.WATCHTOWER_REPAIR_GH_BIN || "/opt/homebrew/bin/gh";
  const result = await runCaptured(gh, ["issue", "comment", String(issue.number), "--repo", issue.repository, "--body-file", bodyPath], { env, timeout: 60_000 });
  if (result.code !== 0) throw new Error(`GitHub issue update failed: ${compact(result.stderr || result.stdout)}`);
}

async function tryCommentOnGitHubIssue(env, issue, runDir, name, body) {
  try {
    await commentOnGitHubIssue(env, issue, runDir, name, body);
    return null;
  } catch (error) {
    return compact(error?.message || error, 1_500);
  }
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

function diagnosisSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "customer_impact",
      "root_cause",
      "decisive_evidence",
      "confidence",
      "category",
      "repair_target",
      "affected_paths",
      "repair_plan",
      "verification_plan",
      "proof_gaps",
      "autofix",
      "blocker",
    ],
    properties: {
      customer_impact: { type: "string" },
      root_cause: { type: "string" },
      decisive_evidence: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["fact", "receipt"],
          properties: { fact: { type: "string" }, receipt: { type: "string" } },
        },
      },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      category: { type: "string", enum: ["product_bug", "backend_bug", "telemetry_gap", "stale_data", "operations", "not_a_bug", "unknown"] },
      repair_target: { type: "string", enum: ["backend", "product", "watchtower", "none"] },
      affected_paths: { type: "array", items: { type: "string" } },
      repair_plan: { type: "array", items: { type: "string" } },
      verification_plan: { type: "array", items: { type: "string" } },
      proof_gaps: { type: "array", items: { type: "string" } },
      autofix: { type: "string", enum: ["ready", "blocked", "not_applicable"] },
      blocker: { type: "string" },
    },
  };
}

function repairSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["status", "solution", "changed_files", "tests_run", "verification_notes", "remaining_risks", "blocker"],
    properties: {
      status: { type: "string", enum: ["fixed", "blocked"] },
      solution: { type: "string" },
      changed_files: { type: "array", items: { type: "string" } },
      tests_run: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["command", "result"],
          properties: { command: { type: "string" }, result: { type: "string", enum: ["passed", "failed"] } },
        },
      },
      verification_notes: { type: "array", items: { type: "string" } },
      remaining_risks: { type: "array", items: { type: "string" } },
      blocker: { type: "string" },
    },
  };
}

function diagnosisPrompt(repairCase, env) {
  const repos = repoPaths(env);
  const productRepo = repos.products[repairCase.product] || "/Users/mini/Documents";
  return [
    "Read /Users/mini/.codex/skills/watchtower-investigate/SKILL.md first and follow it exactly.",
    "This is the evidence pass. Do not edit yet. Your output decides whether a separate repair pass is allowed.",
    "Autofix may be ready only when confidence is high, decisive receipts prove one root cause, proof_gaps is empty, and one repository owns the smallest repair.",
    "A classification or evidence repair is valid only when it preserves the original customer-impacting receipt instead of hiding it.",
    "Set blocker to an exact reason when autofix is not ready; use an empty string only when it is ready.",
    "",
    repairCase.case_prompt,
    "",
    "Repository map:",
    `- Product: ${productRepo}`,
    `- Backend: ${repos.backend}`,
    `- Watchtower: ${repos.watchtower}`,
    "",
    "Return only the JSON object required by the output schema.",
  ].join("\n");
}

function repairPrompt(repairCase, diagnosis) {
  return [
    "Read /Users/mini/.codex/skills/watchtower-repair/SKILL.md first and follow it exactly.",
    "You are in an isolated writable worktree. Implement the smallest repair proven by the diagnosis below.",
    "Add focused regression coverage and run the relevant focused tests. Do not commit, push, deploy, or mutate any database; the worker owns those steps.",
    "Do not broaden scope. If the evidence is insufficient or the proposed path is unsafe, leave the worktree unchanged and return blocked with one exact reason.",
    "",
    `Case: ${repairCase.case_id}`,
    `Product: ${repairCase.product}`,
    `Title: ${repairCase.title}`,
    "",
    "Proven diagnosis:",
    JSON.stringify(diagnosis, null, 2),
    "",
    "Return only the JSON object required by the output schema.",
  ].join("\n");
}

function compact(value, limit = 900) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function listLines(values, limit = 3) {
  return (Array.isArray(values) ? values : []).slice(0, limit).map((value) => `- ${compact(value, 500)}`).join("\n");
}

export function detectedMessage(repairCase, issue) {
  return [
    "WATCHTOWER: NOT GREEN",
    `${repairCase.product} | ${repairCase.title}`,
    `Observed: ${compact(repairCase.headline, 700)}`,
    `Case: ${repairCase.case_id}`,
    issueLine(issue),
    "Status: tracing exact receipts and code path",
  ].join("\n");
}

export function rootCauseMessage(repairCase, diagnosis, issue) {
  const evidence = diagnosis.decisive_evidence?.slice(0, 2).map((item) => `- ${compact(item.fact, 450)} (${compact(item.receipt, 220)})`).join("\n");
  return [
    `WATCHTOWER: ROOT CAUSE PROVEN (${String(diagnosis.confidence).toUpperCase()})`,
    `${repairCase.product} | ${repairCase.title}`,
    `Customer impact: ${compact(diagnosis.customer_impact)}`,
    `Cause: ${compact(diagnosis.root_cause)}`,
    evidence ? `Evidence:\n${evidence}` : "Evidence: no decisive receipt attached",
    `Repair: ${compact(diagnosis.repair_plan?.[0] || diagnosis.blocker || "No repair defined")}`,
    `Case: ${repairCase.case_id}`,
    issueLine(issue),
  ].join("\n");
}

export function blockedMessage(repairCase, diagnosis, blocker, issue) {
  return [
    "WATCHTOWER: BLOCKED - NOT FIXED",
    `${repairCase.product} | ${repairCase.title}`,
    `Customer impact: ${compact(diagnosis?.customer_impact || repairCase.headline)}`,
    `Known cause: ${compact(diagnosis?.root_cause || "Not proven")}`,
    `Blocker: ${compact(blocker || diagnosis?.blocker || "The repair could not be proven safely")}`,
    diagnosis?.proof_gaps?.length ? `Missing proof:\n${listLines(diagnosis.proof_gaps)}` : "Missing proof: none declared",
    `Case: ${repairCase.case_id}`,
    issueLine(issue),
  ].join("\n");
}

export function patchReadyMessage(repairCase, diagnosis, repair, release, issue) {
  const tests = release.tests.map((test) => `- ${test.command}: ${test.result}`).join("\n");
  return [
    "WATCHTOWER: TESTED PATCH READY",
    `${repairCase.product} | ${repairCase.title}`,
    `Customer impact: ${compact(diagnosis.customer_impact)}`,
    `Root cause: ${compact(diagnosis.root_cause)}`,
    `Fix: ${compact(repair.solution)}`,
    `Changed: ${release.changed_files.join(", ")}`,
    `Tests:\n${tests}`,
    `Commit: ${release.commit}`,
    `Branch: ${release.branch}`,
    "Release: not shipped yet; historical red evidence remains intact",
    `Case: ${repairCase.case_id}`,
    issueLine(issue),
  ].join("\n");
}

function fallbackDiagnosis(message) {
  return {
    customer_impact: "The customer-impacting behavior could not be determined safely.",
    root_cause: message,
    decisive_evidence: [],
    confidence: "low",
    category: "unknown",
    repair_target: "none",
    affected_paths: [],
    repair_plan: [],
    verification_plan: [],
    proof_gaps: ["A complete structured diagnosis was not produced."],
    autofix: "blocked",
    blocker: message,
  };
}

function parseReport(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function codexArgs(env, sandbox, schemaPath, reportPath, cwd) {
  const args = [
    "exec",
    "--sandbox",
    sandbox,
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
  if (env.WATCHTOWER_REPAIR_CODEX_REASONING_EFFORT) {
    args.push("-c", `model_reasoning_effort="${env.WATCHTOWER_REPAIR_CODEX_REASONING_EFFORT}"`);
  }
  args.push("-");
  return args;
}

async function runCodex({ env, cwd, sandbox, schemaPath, reportPath, promptPath, onChild }) {
  const codexBin = env.WATCHTOWER_REPAIR_CODEX_BIN || "/Users/mini/.nvm/versions/node/v24.16.0/bin/codex";
  return runCommand(codexBin, codexArgs(env, sandbox, schemaPath, reportPath, cwd), {
    cwd,
    env,
    stdio: ["pipe", "ignore", "ignore"],
    onChild(value) {
      onChild(value);
      value.stdin.on("error", () => undefined);
      value.stdin.end(readFileSync(promptPath, "utf8"));
    },
  });
}

function repairRepository(repairCase, diagnosis, env) {
  const repos = repoPaths(env);
  if (diagnosis.repair_target === "backend") {
    return {
      path: repos.backend,
      baseBranch: env.WATCHTOWER_REPAIR_BACKEND_BASE_BRANCH || "dev",
      validation: [["npm", "run", "build:backend"]],
    };
  }
  if (diagnosis.repair_target === "watchtower") {
    return { path: repos.watchtower, baseBranch: "main", validation: [["npm", "run", "build"]] };
  }
  if (diagnosis.repair_target === "product") {
    const path = repos.products[repairCase.product];
    if (!path) return { blocker: `No repair repository is configured for ${repairCase.product}.` };
    if (repairCase.product === "ios-app") {
      return { blocker: "The iOS build and signing validation adapter is not configured on the repair worker." };
    }
    return { path, baseBranch: "main", validation: [["npm", "run", "build"]] };
  }
  return { blocker: "The diagnosis did not name one repository that owns the repair." };
}

async function prepareWorktree(env, repo, runDir, repairCase) {
  const git = env.WATCHTOWER_REPAIR_GIT_BIN || "/usr/bin/git";
  const workspace = join(runDir, "workspace");
  rmSync(workspace, { recursive: true, force: true });
  await execFileAsync(git, ["-C", repo.path, "worktree", "prune"], { env, timeout: 60_000 });
  await execFileAsync(git, ["-C", repo.path, "fetch", "origin", "--prune", "--quiet"], { env, timeout: 120_000 });
  await execFileAsync(git, ["-C", repo.path, "worktree", "add", "--detach", workspace, `origin/${repo.baseBranch}`], { env, timeout: 120_000 });
  const branch = `watchtower/${repairCase.case_id.toLowerCase()}`;
  await execFileAsync(git, ["-C", workspace, "switch", "-C", branch], { env, timeout: 60_000 });
  return { workspace, branch, git };
}

async function changedFiles(git, workspace, env) {
  const [tracked, untracked] = await Promise.all([
    execFileAsync(git, ["-C", workspace, "diff", "--name-only"], { env }),
    execFileAsync(git, ["-C", workspace, "ls-files", "--others", "--exclude-standard"], { env }),
  ]);
  return [...new Set(`${tracked.stdout}\n${untracked.stdout}`.split("\n").map((item) => item.trim()).filter(Boolean))].sort();
}

async function validateWorkspace(repo, workspace, env) {
  const tests = [];
  for (const [command, ...args] of repo.validation) {
    const label = [command, ...args].join(" ");
    const result = await runCaptured(command, args, { cwd: workspace, env, timeout: 15 * 60_000 });
    tests.push({
      command: label,
      result: result.code === 0 ? "passed" : "failed",
      output: compact(`${result.stdout}\n${result.stderr}`, 2_000),
    });
    if (result.code !== 0) break;
  }
  return tests;
}

async function commitAndPush(env, workspaceState, repairCase) {
  const { git, workspace, branch } = workspaceState;
  const diffCheck = await runCaptured(git, ["-C", workspace, "diff", "--check"], { env });
  if (diffCheck.code !== 0) throw new Error(`diff check failed: ${compact(diffCheck.stderr || diffCheck.stdout)}`);
  await execFileAsync(git, ["-C", workspace, "add", "-A"], { env });
  const staged = await runCaptured(git, ["-C", workspace, "diff", "--cached", "--quiet"], { env });
  if (staged.code === 0) throw new Error("repair produced no code changes");
  if (staged.code !== 1) throw new Error(`could not inspect staged repair: ${compact(staged.stderr)}`);
  await execFileAsync(git, [
    "-C",
    workspace,
    "-c",
    "user.name=DarDoc Watchtower",
    "-c",
    "user.email=watchtower@dardoc.com",
    "commit",
    "-m",
    `Fix ${compact(repairCase.title, 120)}`,
  ], { env, timeout: 120_000 });
  const commit = (await execFileAsync(git, ["-C", workspace, "rev-parse", "HEAD"], { env })).stdout.trim();
  await execFileAsync(git, ["-C", workspace, "push", "--force-with-lease", "origin", `HEAD:refs/heads/${branch}`], { env, timeout: 180_000 });
  return { commit, branch };
}

async function removeWorktree(env, repo, workspaceState) {
  if (!workspaceState?.workspace) return;
  await runCaptured(workspaceState.git, ["-C", repo.path, "worktree", "remove", "--force", workspaceState.workspace], {
    env,
    timeout: 120_000,
  });
}

async function progress(env, repairCase, workerId, leaseToken, phase, summary, data = {}, githubIssue) {
  return apiRequest(env, `/telemetry/repair-worker/${encodeURIComponent(repairCase.case_id)}/progress`, {
    worker_id: workerId,
    lease_token: leaseToken,
    phase,
    summary,
    data,
    ...(githubIssue ? { github_issue: githubIssue } : {}),
  });
}

async function complete(env, repairCase, workerId, leaseToken, outcome, summary, report) {
  return apiRequest(env, `/telemetry/repair-worker/${encodeURIComponent(repairCase.case_id)}/complete`, {
    worker_id: workerId,
    lease_token: leaseToken,
    outcome,
    summary,
    report,
  });
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
    const workerId = env.WATCHTOWER_REPAIR_WORKER_ID || "mac-mini-autofix";
    const claim = await apiRequest(env, "/telemetry/repair-worker/claim", {
      worker_id: workerId,
      lease_seconds: 1800,
    });
    if (!claim) return { status: "idle" };

    const repairCase = claim.repair_case;
    const leaseToken = claim.lease_token;
    let leaseLost = false;
    heartbeat = setInterval(() => {
      apiRequest(env, `/telemetry/repair-worker/${encodeURIComponent(repairCase.case_id)}/heartbeat`, {
        worker_id: workerId,
        lease_token: leaseToken,
        lease_seconds: 1800,
      }).catch(() => {
        leaseLost = true;
        child?.kill("SIGTERM");
      });
    }, 120_000);

    const runRoot = env.WATCHTOWER_REPAIR_RUN_ROOT || DEFAULT_RUN_ROOT;
    const runDir = join(runRoot, repairCase.case_id);
    mkdirSync(runDir, { recursive: true });
    let issue;
    try {
      issue = await ensureGitHubIssue(env, repairCase, runDir);
      await progress(
        env,
        repairCase,
        workerId,
        leaseToken,
        "INVESTIGATING",
        `Private GitHub issue #${issue.number} created; tracing exact receipts and code path.`,
        {},
        issue,
      );
      await sendWhatsApp(env, detectedMessage(repairCase, issue));
    } catch (error) {
      const diagnosis = fallbackDiagnosis(`Private GitHub issue setup failed: ${compact(error?.message || error, 1_000)}`);
      await complete(env, repairCase, workerId, leaseToken, "NEEDS_HUMAN", diagnosis.blocker, diagnosis);
      await sendWhatsApp(env, blockedMessage(repairCase, diagnosis, diagnosis.blocker));
      return { status: "needs_human", case_id: repairCase.case_id };
    }

    try {
      const repos = repoPaths(env);
      const mirrors = new Map([
        [repos.backend, env.WATCHTOWER_REPAIR_BACKEND_BRANCH || "dev"],
        [repos.watchtower, "main"],
        [repos.products[repairCase.product], "main"],
      ]);
      for (const [path, branch] of mirrors) {
        if (path) await syncMirror(path, branch, env);
      }
    } catch (error) {
      const diagnosis = fallbackDiagnosis(`Repository mirror refresh failed: ${compact(error?.message || error, 500)}`);
      const issueUpdateError = await tryCommentOnGitHubIssue(env, issue, runDir, "repository-blocked", diagnosisIssueComment(diagnosis, false));
      const report = { ...diagnosis, github_issue: issue, ...(issueUpdateError ? { issue_update_error: issueUpdateError } : {}) };
      await complete(env, repairCase, workerId, leaseToken, "NEEDS_HUMAN", diagnosis.blocker, report);
      await sendWhatsApp(env, blockedMessage(repairCase, diagnosis, diagnosis.blocker, issue));
      return { status: "needs_human", case_id: repairCase.case_id };
    }

    const diagnosisSchemaPath = join(runDir, "diagnosis.schema.json");
    const diagnosisPath = join(runDir, "diagnosis.json");
    const diagnosisPromptPath = join(runDir, "diagnosis.txt");
    writeFileSync(diagnosisSchemaPath, JSON.stringify(diagnosisSchema(), null, 2));
    writeFileSync(diagnosisPromptPath, diagnosisPrompt(repairCase, env));

    const repos = repoPaths(env);
    const productRepo = repos.products[repairCase.product];
    const diagnosisCwd = productRepo && existsSync(productRepo) ? productRepo : repos.backend;
    const diagnosisResult = await runCodex({
      env,
      cwd: diagnosisCwd,
      sandbox: "read-only",
      schemaPath: diagnosisSchemaPath,
      reportPath: diagnosisPath,
      promptPath: diagnosisPromptPath,
      onChild(value) { child = value; },
    });
    child = null;
    if (leaseLost) return { status: "lease_lost", case_id: repairCase.case_id };

    const diagnosis = parseReport(
      diagnosisPath,
      fallbackDiagnosis(`Codex diagnosis exited ${diagnosisResult.code === 0 ? "without a structured report" : `with code ${diagnosisResult.code}`}.`),
    );
    const repairable = diagnosisResult.code === 0
      && diagnosis.confidence === "high"
      && diagnosis.autofix === "ready"
      && diagnosis.repair_target !== "none"
      && Array.isArray(diagnosis.decisive_evidence)
      && diagnosis.decisive_evidence.length > 0
      && Array.isArray(diagnosis.proof_gaps)
      && diagnosis.proof_gaps.length === 0;

    if (!repairable) {
      const blocker = diagnosis.blocker || "The evidence did not satisfy the high-confidence autofix gate.";
      const issueUpdateError = await tryCommentOnGitHubIssue(env, issue, runDir, "diagnosis-blocked", diagnosisIssueComment(diagnosis, false));
      const report = { ...diagnosis, github_issue: issue, ...(issueUpdateError ? { issue_update_error: issueUpdateError } : {}) };
      await complete(env, repairCase, workerId, leaseToken, "NEEDS_HUMAN", blocker, report);
      await sendWhatsApp(env, blockedMessage(repairCase, diagnosis, blocker, issue));
      return { status: "needs_human", case_id: repairCase.case_id };
    }

    const diagnosisIssueError = await tryCommentOnGitHubIssue(env, issue, runDir, "root-cause", diagnosisIssueComment(diagnosis, true));
    if (diagnosisIssueError) {
      const blocker = `The root cause was proven, but the private GitHub issue could not be updated: ${diagnosisIssueError}`;
      const report = { diagnosis, github_issue: issue, issue_update_error: diagnosisIssueError };
      await complete(env, repairCase, workerId, leaseToken, "NEEDS_HUMAN", blocker, report);
      await sendWhatsApp(env, blockedMessage(repairCase, diagnosis, blocker, issue));
      return { status: "needs_human", case_id: repairCase.case_id };
    }

    await sendWhatsApp(env, rootCauseMessage(repairCase, diagnosis, issue));

    const repo = repairRepository(repairCase, diagnosis, env);
    if (repo.blocker) {
      const issueUpdateError = await tryCommentOnGitHubIssue(env, issue, runDir, "repair-owner-blocked", `## Repair blocked\n\n${repo.blocker}`);
      const report = { diagnosis, github_issue: issue, ...(issueUpdateError ? { issue_update_error: issueUpdateError } : {}) };
      await complete(env, repairCase, workerId, leaseToken, "NEEDS_HUMAN", repo.blocker, report);
      await sendWhatsApp(env, blockedMessage(repairCase, diagnosis, repo.blocker, issue));
      return { status: "needs_human", case_id: repairCase.case_id };
    }

    let workspaceState = null;
    try {
      await progress(env, repairCase, workerId, leaseToken, "REPAIRING", `Root cause proven: ${compact(diagnosis.root_cause, 1_500)}`, {
        repair_target: diagnosis.repair_target,
        affected_paths: diagnosis.affected_paths,
      }, issue);
      workspaceState = await prepareWorktree(env, repo, runDir, repairCase);
      const repairSchemaPath = join(runDir, "repair.schema.json");
      const repairPath = join(runDir, "repair.json");
      const repairPromptPath = join(runDir, "repair.txt");
      writeFileSync(repairSchemaPath, JSON.stringify(repairSchema(), null, 2));
      writeFileSync(repairPromptPath, repairPrompt(repairCase, diagnosis));
      const repairResult = await runCodex({
        env,
        cwd: workspaceState.workspace,
        sandbox: "workspace-write",
        schemaPath: repairSchemaPath,
        reportPath: repairPath,
        promptPath: repairPromptPath,
        onChild(value) { child = value; },
      });
      child = null;
      if (leaseLost) return { status: "lease_lost", case_id: repairCase.case_id };

      const repair = parseReport(repairPath, {
        status: "blocked",
        solution: "",
        changed_files: [],
        tests_run: [],
        verification_notes: [],
        remaining_risks: [],
        blocker: `Codex repair exited ${repairResult.code === 0 ? "without a structured report" : `with code ${repairResult.code}`}.`,
      });
      const files = await changedFiles(workspaceState.git, workspaceState.workspace, env);
      if (repairResult.code !== 0 || repair.status !== "fixed" || files.length === 0) {
        const blocker = repair.blocker || "The repair pass did not produce a concrete code change.";
        const issueUpdateError = await tryCommentOnGitHubIssue(env, issue, runDir, "repair-blocked", `## Repair pass blocked\n\n${blocker}`);
        const report = { diagnosis, repair: { ...repair, changed_files: files }, github_issue: issue, ...(issueUpdateError ? { issue_update_error: issueUpdateError } : {}) };
        await complete(env, repairCase, workerId, leaseToken, "NEEDS_HUMAN", blocker, report);
        await sendWhatsApp(env, blockedMessage(repairCase, diagnosis, blocker, issue));
        return { status: "needs_human", case_id: repairCase.case_id };
      }

      await progress(env, repairCase, workerId, leaseToken, "TESTING", `Validating ${files.length} changed file(s).`, { changed_files: files }, issue);
      const tests = await validateWorkspace(repo, workspaceState.workspace, env);
      const failedTest = tests.find((test) => test.result === "failed");
      if (failedTest) {
        const blocker = `Required validation failed: ${failedTest.command}. ${failedTest.output}`;
        const issueUpdateError = await tryCommentOnGitHubIssue(env, issue, runDir, "validation-blocked", `## Validation failed\n\n${blocker}`);
        const report = { diagnosis, repair: { ...repair, changed_files: files }, release: { tests }, github_issue: issue, ...(issueUpdateError ? { issue_update_error: issueUpdateError } : {}) };
        await complete(env, repairCase, workerId, leaseToken, "NEEDS_HUMAN", blocker, report);
        await sendWhatsApp(env, blockedMessage(repairCase, diagnosis, blocker, issue));
        return { status: "needs_human", case_id: repairCase.case_id };
      }

      const pushed = await commitAndPush(env, workspaceState, repairCase);
      const release = { ...pushed, changed_files: files, tests };
      const issueUpdateError = await tryCommentOnGitHubIssue(env, issue, runDir, "patch-ready", patchIssueComment(diagnosis, repair, release));
      const report = { diagnosis, repair: { ...repair, changed_files: files }, release, github_issue: issue, ...(issueUpdateError ? { issue_update_error: issueUpdateError } : {}) };
      const summary = `${compact(repair.solution, 1_200)} Tested patch ${pushed.commit.slice(0, 12)} on ${pushed.branch}.`;
      await complete(env, repairCase, workerId, leaseToken, "PATCH_READY", summary, report);
      await sendWhatsApp(env, patchReadyMessage(repairCase, diagnosis, repair, release, issue));
      return { status: "patch_ready", case_id: repairCase.case_id, commit: pushed.commit, branch: pushed.branch };
    } catch (error) {
      const blocker = `Repair execution failed: ${compact(error?.message || error, 1_500)}`;
      const issueUpdateError = await tryCommentOnGitHubIssue(env, issue, runDir, "execution-blocked", `## Repair execution failed\n\n${blocker}`);
      const report = { diagnosis, execution_error: blocker, github_issue: issue, ...(issueUpdateError ? { issue_update_error: issueUpdateError } : {}) };
      await complete(env, repairCase, workerId, leaseToken, "NEEDS_HUMAN", blocker, report).catch(() => undefined);
      await sendWhatsApp(env, blockedMessage(repairCase, diagnosis, blocker, issue));
      return { status: "needs_human", case_id: repairCase.case_id };
    } finally {
      await removeWorktree(env, repo, workspaceState);
    }
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
