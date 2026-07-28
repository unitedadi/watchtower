import { execFile, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_API_BASE = "https://api-prod.dardoc.com";
const DEFAULT_RUN_ROOT = "/Users/mini/codex-runner/runs/watchtower-repair";
const DEFAULT_LOCK_PATH = "/Users/mini/codex-runner/state/watchtower-repair.lock";
const DEFAULT_REGISTRY_PATH = join(HERE, "repos.example.json");

function compact(value, limit = 1_000) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function required(env, name) {
  const value = String(env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function acquireLock(path) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    const handle = openSync(path, "wx", 0o600);
    closeSync(handle);
    writeFileSync(path, `${process.pid}\n`, { mode: 0o600 });
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    if (Number.isInteger(pid)) {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        // The recorded process is gone.
      }
    } else if (Date.now() - statSync(path).mtimeMs < 2 * 60 * 60 * 1_000) {
      return false;
    }
    rmSync(path, { force: true });
    return acquireLock(path);
  }
}

export function loadRegistry(env = process.env) {
  const path = env.WATCHTOWER_REPAIR_REPO_REGISTRY || DEFAULT_REGISTRY_PATH;
  const registry = JSON.parse(readFileSync(path, "utf8"));
  if (!registry?.owners || typeof registry.owners !== "object") {
    throw new Error("Repair repo registry must contain an owners object.");
  }
  return registry;
}

async function apiRequest(env, path, body, fetchImpl = fetch) {
  const base = String(env.WATCHTOWER_REPAIR_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");
  const response = await fetchImpl(`${base}${path}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${required(env, "WATCHTOWER_REPAIR_RUNNER_TOKEN")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${payload.error || path}`);
  return payload;
}

async function apiGet(env, path, fetchImpl = fetch) {
  const base = String(env.WATCHTOWER_REPAIR_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");
  const response = await fetchImpl(`${base}${path}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${payload.error || path}`);
  return payload;
}

async function withHeartbeat({ env, path, body, leaseSeconds }, operation) {
  let child = null;
  let leaseError = null;
  let heartbeatRunning = false;
  const guard = {
    onChild(value) { child = value; },
    clearChild() { child = null; },
    assert() {
      if (leaseError) throw leaseError;
    },
  };
  const heartbeat = setInterval(async () => {
    if (heartbeatRunning || leaseError) return;
    heartbeatRunning = true;
    try {
      await apiRequest(env, path, { ...body, lease_seconds: leaseSeconds });
    } catch (error) {
      leaseError = new Error(`Repair lease lost: ${compact(error?.message || error)}`);
      child?.kill("SIGTERM");
    } finally {
      heartbeatRunning = false;
    }
  }, 120_000);
  heartbeat.unref();
  try {
    const result = await operation(guard);
    guard.assert();
    return result;
  } finally {
    clearInterval(heartbeat);
    child?.kill("SIGTERM");
  }
}

async function runCaptured(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      timeout: options.timeout ?? 15 * 60_000,
      maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
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

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    child.once("error", (error) => resolve({ code: 1, error, child }));
    child.once("exit", (code) => resolve({ code: code ?? 1, child }));
    options.onChild?.(child);
  });
}

function diagnosisSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "route",
      "confidence",
      "reason",
      "customer_impact",
      "likely_cause",
      "owners",
      "evidence_bindings",
      "repair_plan",
      "verification_plan",
      "proof_gaps",
    ],
    properties: {
      route: {
        type: "string",
        enum: ["watchtower", "backend", "checkout", "multi_repo", "needs_evidence"],
      },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      reason: { type: "string" },
      customer_impact: { type: "string" },
      likely_cause: { type: "string" },
      owners: {
        type: "array",
        uniqueItems: true,
        items: { type: "string", enum: ["watchtower", "backend", "checkout"] },
      },
      evidence_bindings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["source", "fact", "receipt", "repository", "path"],
          properties: {
            source: {
              type: "string",
              enum: ["emitter", "backend_truth", "watchtower_reasoning", "journey"],
            },
            fact: { type: "string" },
            receipt: { type: "string" },
            repository: { type: "string" },
            path: { type: "string" },
          },
        },
      },
      repair_plan: { type: "array", items: { type: "string" } },
      verification_plan: { type: "array", items: { type: "string" } },
      proof_gaps: { type: "array", items: { type: "string" } },
    },
  };
}

function repairSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "status",
      "solution",
      "changed_files",
      "tests_run",
      "verification_notes",
      "remaining_risks",
      "blocker",
    ],
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
          properties: {
            command: { type: "string" },
            result: { type: "string", enum: ["passed", "failed"] },
          },
        },
      },
      verification_notes: { type: "array", items: { type: "string" } },
      remaining_risks: { type: "array", items: { type: "string" } },
      blocker: { type: "string" },
    },
  };
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
  const binary = env.WATCHTOWER_REPAIR_CODEX_BIN || "/Users/mini/.local/bin/codex";
  return runCommand(binary, codexArgs(env, sandbox, schemaPath, reportPath, cwd), {
    cwd,
    env,
    stdio: ["pipe", "ignore", "ignore"],
    onChild(child) {
      onChild?.(child);
      child.stdin.on("error", () => undefined);
      child.stdin.end(readFileSync(promptPath, "utf8"));
    },
  });
}

function parseReport(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function diagnosisFallback(message) {
  return {
    route: "needs_evidence",
    confidence: "low",
    reason: message,
    customer_impact: "The customer impact could not be proven safely.",
    likely_cause: "Unknown until the missing evidence is attached.",
    owners: [],
    evidence_bindings: [],
    repair_plan: [],
    verification_plan: [],
    proof_gaps: [message],
  };
}

function repoSummary(registry) {
  return Object.entries(registry.owners)
    .map(([owner, repo]) => `- ${owner}: ${repo.path} (base ${repo.base_branch})`)
    .join("\n");
}

function diagnosisPrompt(repairCase, registry, evidenceBundlePath, evidenceBundle) {
  return [
    `Read ${join(HERE, "skills/watchtower-investigate/SKILL.md")} first and follow it exactly.`,
    "This pass is read-only. Do not edit, commit, push, deploy, or mutate data.",
    "Trace four evidence layers whenever available: customer emitter, full journey, backend/provider truth, and Watchtower rule reasoning.",
    "Never assign causal ownership from the repository where the GitHub issue happens to live.",
    "A route other than needs_evidence requires high confidence, no proof gaps, at least two decisive evidence bindings from different source kinds, and an executable fresh-telemetry verification plan.",
    "Use multi_repo when more than one repository owes code or regression work.",
    "A Watchtower false positive must route to watchtower and name the regression receipt that prevents the same inference.",
    "",
    repairCase.case_prompt,
    "",
    `Collected evidence bundle: ${evidenceBundlePath}`,
    JSON.stringify(evidenceBundle, null, 2).slice(0, 120_000),
    "",
    "Repository registry:",
    repoSummary(registry),
    "",
    "Return only the JSON object required by the output schema.",
  ].join("\n");
}

function collectJourneyIds(value, key = "", result = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectJourneyIds(item, key, result);
    return result;
  }
  if (value && typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) {
      collectJourneyIds(childValue, childKey, result);
    }
    return result;
  }
  if (/^(journey_id|session_id)$/i.test(key)) {
    const id = String(value ?? "").trim();
    if (id) result.add(id);
  }
  return result;
}

async function collectEvidenceBundle(repairCase, env) {
  const journeyIds = Array.from(collectJourneyIds(repairCase.evidence ?? {})).slice(0, 10);
  const journeyTimelines = [];
  for (const journeyId of journeyIds) {
    try {
      const response = await apiGet(
        env,
        `/telemetry/journeys/${encodeURIComponent(journeyId)}/events`,
      );
      journeyTimelines.push({ journey_id: journeyId, events: response.events ?? [] });
    } catch (error) {
      journeyTimelines.push({
        journey_id: journeyId,
        evidence_gap: compact(error?.message || error, 800),
      });
    }
  }
  return {
    collected_at: new Date().toISOString(),
    detection: repairCase.evidence ?? {},
    independent_verification_contract: repairCase.verification ?? {},
    journey_timelines: journeyTimelines,
  };
}

function repairPrompt(repairCase, task) {
  return [
    `Read ${join(HERE, "skills/watchtower-repair/SKILL.md")} first and follow it exactly.`,
    "You are in one isolated writable worktree, after explicit /repair approve.",
    "Implement only this repository's part of the evidence-backed repair.",
    "Run focused tests. Do not commit, push, open a pull request, deploy, or mutate data; the worker owns the local commit and the separate shipping gate.",
    "If the evidence is insufficient, leave the worktree unchanged and return blocked with one exact reason.",
    "",
    `Case: ${repairCase.case_id}`,
    `Product: ${repairCase.product}`,
    `Promise/problem: ${repairCase.title}`,
    `Task owner: ${task.owner}`,
    `Repository: ${task.repository}`,
    "",
    "Evidence references:",
    JSON.stringify(task.evidence_refs, null, 2),
    "",
    "Scoped repair plan:",
    JSON.stringify(task.repair_plan, null, 2),
    "",
    "Required verification:",
    JSON.stringify(task.verification_plan, null, 2),
    "",
    "Return only the JSON object required by the output schema.",
  ].join("\n");
}

function syncMirror(repo, env) {
  if (env.WATCHTOWER_REPAIR_SKIP_SYNC === "true") return Promise.resolve();
  const git = env.WATCHTOWER_REPAIR_GIT_BIN || "/usr/bin/git";
  if (!existsSync(join(repo.path, ".git"))) throw new Error(`Repair mirror is missing: ${repo.path}`);
  return runCaptured(git, ["-C", repo.path, "fetch", "origin", "--prune", "--quiet"], {
    env,
    timeout: 180_000,
  }).then((result) => {
    if (result.code !== 0) throw new Error(`Mirror refresh failed: ${compact(result.stderr)}`);
  });
}

async function prepareWorktree(repairCase, task, repo, runDir, env) {
  const git = env.WATCHTOWER_REPAIR_GIT_BIN || "/usr/bin/git";
  const workspace = join(runDir, "worktrees", task.owner);
  const branch = `codex/${task.task_id.toLowerCase().replace(/[^a-z0-9._/-]+/g, "-")}`;
  mkdirSync(dirname(workspace), { recursive: true });
  await syncMirror(repo, env);
  await runCaptured(git, ["-C", repo.path, "worktree", "prune"], { env, timeout: 60_000 });
  if (existsSync(workspace)) {
    const existingBranch = await runCaptured(git, ["-C", workspace, "branch", "--show-current"], { env });
    if (existingBranch.code === 0 && existingBranch.stdout.trim() === branch) {
      return { git, workspace, branch };
    }
    throw new Error(`Worktree path already exists with a different branch: ${workspace}`);
  }
  const added = await runCaptured(
    git,
    ["-C", repo.path, "worktree", "add", "-b", branch, workspace, `origin/${repo.base_branch}`],
    { env, timeout: 180_000 },
  );
  if (added.code !== 0) throw new Error(`Worktree creation failed: ${compact(added.stderr || added.stdout)}`);
  return { git, workspace, branch };
}

async function changedFiles(workspaceState, env) {
  const tracked = await runCaptured(
    workspaceState.git,
    ["-C", workspaceState.workspace, "diff", "--name-only"],
    { env },
  );
  const untracked = await runCaptured(
    workspaceState.git,
    ["-C", workspaceState.workspace, "ls-files", "--others", "--exclude-standard"],
    { env },
  );
  return [...new Set(`${tracked.stdout}\n${untracked.stdout}`.split("\n").map((value) => value.trim()).filter(Boolean))].sort();
}

async function validateWorkspace(repo, workspace, env) {
  const tests = [];
  for (const item of repo.validation ?? []) {
    const command = String(item.command);
    const args = Array.isArray(item.args) ? item.args.map(String) : [];
    const result = await runCaptured(command, args, {
      cwd: workspace,
      env,
      timeout: Number(item.timeout_ms ?? 15 * 60_000),
    });
    tests.push({
      command: [command, ...args].join(" "),
      result: result.code === 0 ? "passed" : "failed",
      output: compact(`${result.stdout}\n${result.stderr}`, 2_000),
    });
    if (result.code !== 0) break;
  }
  return tests;
}

async function commitLocal(repairCase, workspaceState, env) {
  const { git, workspace } = workspaceState;
  const check = await runCaptured(git, ["-C", workspace, "diff", "--check"], { env });
  if (check.code !== 0) throw new Error(`Diff check failed: ${compact(check.stderr || check.stdout)}`);
  await execFileAsync(git, ["-C", workspace, "add", "-A"], { env });
  const staged = await runCaptured(git, ["-C", workspace, "diff", "--cached", "--quiet"], { env });
  if (staged.code === 0) throw new Error("Repair produced no code changes.");
  if (staged.code !== 1) throw new Error(`Could not inspect staged repair: ${compact(staged.stderr)}`);
  await execFileAsync(
    git,
    [
      "-C",
      workspace,
      "-c",
      "user.name=DarDoc Watchtower",
      "-c",
      "user.email=watchtower@dardoc.com",
      "commit",
      "-m",
      `Fix ${compact(repairCase.title, 120)}`,
    ],
    { env, timeout: 120_000 },
  );
  return (await execFileAsync(git, ["-C", workspace, "rev-parse", "HEAD"], { env })).stdout.trim();
}

async function completeTask(env, task, workerId, leaseToken, body) {
  return apiRequest(
    env,
    `/telemetry/repair-worker/tasks/${encodeURIComponent(task.task_id)}/complete`,
    { worker_id: workerId, lease_token: leaseToken, ...body },
  );
}

async function runDiagnosis(env, claim, registry, runDir, workerId, leaseGuard) {
  const repairCase = claim.repair_case;
  const schemaPath = join(runDir, "diagnosis.schema.json");
  const reportPath = join(runDir, "diagnosis.json");
  const promptPath = join(runDir, "diagnosis.txt");
  const evidenceBundlePath = join(runDir, "evidence-bundle.json");
  const evidenceBundle = await collectEvidenceBundle(repairCase, env);
  writeFileSync(schemaPath, JSON.stringify(diagnosisSchema(), null, 2));
  writeFileSync(evidenceBundlePath, JSON.stringify(evidenceBundle, null, 2));
  writeFileSync(
    promptPath,
    diagnosisPrompt(repairCase, registry, evidenceBundlePath, evidenceBundle),
  );
  for (const repo of Object.values(registry.owners)) await syncMirror(repo, env);
  const cwd = registry.owners.checkout?.path || registry.owners.backend?.path || registry.owners.watchtower?.path;
  if (!cwd) throw new Error("No diagnosis repository is configured.");
  let child = null;
  const result = await runCodex({
    env,
    cwd,
    sandbox: "read-only",
    schemaPath,
    reportPath,
    promptPath,
    onChild(value) {
      child = value;
      leaseGuard.onChild(value);
    },
  });
  child = null;
  leaseGuard.clearChild();
  const diagnosis = parseReport(
    reportPath,
    diagnosisFallback(`Codex diagnosis exited ${result.code === 0 ? "without a structured report" : `with code ${result.code}`}.`),
  );
  leaseGuard.assert();
  const diagnosisPath = `/telemetry/repair-worker/${encodeURIComponent(repairCase.case_id)}/diagnosis`;
  try {
    await apiRequest(env, diagnosisPath, {
      worker_id: workerId,
      lease_token: claim.lease_token,
      diagnosis,
    });
  } catch (error) {
    const blocked = diagnosisFallback(
      `The proposed route was not anchored to accepted case evidence: ${compact(error?.message || error, 700)}`,
    );
    leaseGuard.assert();
    await apiRequest(env, diagnosisPath, {
      worker_id: workerId,
      lease_token: claim.lease_token,
      diagnosis: blocked,
    });
    return {
      status: "needs_evidence",
      case_id: repairCase.case_id,
      route: "needs_evidence",
    };
  }
  return {
    status: diagnosis.route === "needs_evidence" ? "needs_evidence" : "awaiting_approval",
    case_id: repairCase.case_id,
    route: diagnosis.route,
  };
}

async function runRepairTask(env, claim, registry, runDir, workerId, leaseGuard) {
  const task = claim.repair_task;
  const repairCase = claim.repair_case;
  const repo = registry.owners[task.owner];
  if (!repo || repo.repository !== task.repository) {
    leaseGuard.assert();
    await completeTask(env, task, workerId, claim.lease_token, {
      outcome: "BLOCKED",
      summary: `No matching local repository registry entry exists for ${task.owner} (${task.repository}).`,
    });
    return { status: "blocked", task_id: task.task_id };
  }

  let workspaceState = null;
  try {
    workspaceState = await prepareWorktree(repairCase, task, repo, runDir, env);
    const schemaPath = join(runDir, `${task.owner}.repair.schema.json`);
    const reportPath = join(runDir, `${task.owner}.repair.json`);
    const promptPath = join(runDir, `${task.owner}.repair.txt`);
    writeFileSync(schemaPath, JSON.stringify(repairSchema(), null, 2));
    writeFileSync(promptPath, repairPrompt(repairCase, task));
    const result = await runCodex({
      env,
      cwd: workspaceState.workspace,
      sandbox: "workspace-write",
      schemaPath,
      reportPath,
      promptPath,
      onChild(value) { leaseGuard.onChild(value); },
    });
    leaseGuard.clearChild();
    const repair = parseReport(reportPath, {
      status: "blocked",
      solution: "",
      changed_files: [],
      tests_run: [],
      verification_notes: [],
      remaining_risks: [],
      blocker: `Codex repair exited ${result.code === 0 ? "without a structured report" : `with code ${result.code}`}.`,
    });
    const files = await changedFiles(workspaceState, env);
    if (result.code !== 0 || repair.status !== "fixed" || files.length === 0) {
      const blocker = repair.blocker || "The repair pass did not produce a focused code change.";
      leaseGuard.assert();
      await completeTask(env, task, workerId, claim.lease_token, {
        outcome: "BLOCKED",
        summary: blocker,
        report: { repair, changed_files: files },
        worktree_path: workspaceState.workspace,
        branch: workspaceState.branch,
      });
      return { status: "blocked", task_id: task.task_id };
    }
    const tests = await validateWorkspace(repo, workspaceState.workspace, env);
    const failed = tests.find((test) => test.result === "failed");
    if (failed) {
      const blocker = `Required validation failed: ${failed.command}. ${failed.output}`;
      leaseGuard.assert();
      await completeTask(env, task, workerId, claim.lease_token, {
        outcome: "BLOCKED",
        summary: blocker,
        report: { repair, changed_files: files, tests },
        worktree_path: workspaceState.workspace,
        branch: workspaceState.branch,
      });
      return { status: "blocked", task_id: task.task_id };
    }
    const commit = await commitLocal(repairCase, workspaceState, env);
    leaseGuard.assert();
    await completeTask(env, task, workerId, claim.lease_token, {
      outcome: "PATCH_READY",
      summary: `${compact(repair.solution, 1_500)} Local commit ${commit.slice(0, 12)} is tested and waiting for /repair ship.`,
      report: { repair: { ...repair, changed_files: files }, tests },
      worktree_path: workspaceState.workspace,
      branch: workspaceState.branch,
      commit_sha: commit,
    });
    return {
      status: "patch_ready",
      task_id: task.task_id,
      worktree: workspaceState.workspace,
      commit,
    };
  } catch (error) {
    const blocker = `Repair execution failed: ${compact(error?.message || error, 1_500)}`;
    await completeTask(env, task, workerId, claim.lease_token, {
      outcome: "BLOCKED",
      summary: blocker,
      ...(workspaceState ? {
        worktree_path: workspaceState.workspace,
        branch: workspaceState.branch,
      } : {}),
    }).catch(() => undefined);
    return { status: "blocked", task_id: task.task_id, blocker };
  }
}

async function runShipCommand(command, env, cwd) {
  if (!command?.path || !String(command.path).startsWith("/")) {
    throw new Error("Shipping command must be an absolute, locally configured path.");
  }
  const result = await runCaptured(command.path, (command.args ?? []).map(String), {
    cwd,
    env,
    timeout: Number(command.timeout_ms ?? 30 * 60_000),
  });
  if (result.code !== 0) {
    throw new Error(`Shipping command failed: ${compact(result.stderr || result.stdout, 2_000)}`);
  }
  return compact(result.stdout, 2_000);
}

async function runShipTask(env, claim, registry, workerId, leaseGuard) {
  const task = claim.repair_task;
  const repo = registry.owners[task.owner];
  if (!repo || repo.repository !== task.repository) {
    throw new Error(`No matching ship registry entry exists for ${task.owner}.`);
  }
  const ship = repo.ship ?? { kind: "disabled" };
  if (ship.kind === "disabled") {
    leaseGuard.assert();
    await completeTask(env, task, workerId, claim.lease_token, {
      outcome: "BLOCKED",
      summary: `Shipping is not configured for ${task.owner}. Configure a fixed local adapter before approving /repair ship.`,
    });
    return { status: "blocked", task_id: task.task_id };
  }
  try {
    const outputs = [];
    if (ship.kind === "command") {
      outputs.push(await runShipCommand(ship.command, env, task.worktree_path || repo.path));
    } else if (ship.kind === "realbackend_verified_promotion") {
      outputs.push(await runShipCommand(ship.ship_dev, env, task.worktree_path || repo.path));
      outputs.push(await runShipCommand(ship.verify_dev, env, task.worktree_path || repo.path));
      outputs.push(await runShipCommand(ship.promote_production, env, task.worktree_path || repo.path));
    } else {
      throw new Error(`Unknown fixed shipping adapter: ${ship.kind}`);
    }
    const deploymentRef = outputs.filter(Boolean).join(" | ") || `${task.owner}:${task.commit_sha || task.branch}`;
    leaseGuard.assert();
    await completeTask(env, task, workerId, claim.lease_token, {
      outcome: "SHIPPED",
      summary: `${task.owner} release adapter completed. Fresh Watchtower verification is now required.`,
      report: { adapter: ship.kind, outputs },
      deployment_ref: deploymentRef,
    });
    return { status: "shipped", task_id: task.task_id, deployment_ref: deploymentRef };
  } catch (error) {
    const blocker = `Shipping failed: ${compact(error?.message || error, 1_500)}`;
    await completeTask(env, task, workerId, claim.lease_token, {
      outcome: "BLOCKED",
      summary: blocker,
    }).catch(() => undefined);
    return { status: "blocked", task_id: task.task_id, blocker };
  }
}

export async function flushGitHubOutbox(env = process.env, limit = 20) {
  const workerId = env.WATCHTOWER_REPAIR_WORKER_ID || "mac-mini-repair";
  const gh = env.WATCHTOWER_REPAIR_GH_BIN || "/Users/mini/.local/bin/gh";
  let delivered = 0;
  for (let index = 0; index < limit; index += 1) {
    const claim = await apiRequest(env, "/telemetry/repair-worker/github/outbox/claim", {
      worker_id: workerId,
      lease_seconds: 300,
    });
    if (!claim) break;
    const message = claim.message;
    const runRoot = env.WATCHTOWER_REPAIR_RUN_ROOT || DEFAULT_RUN_ROOT;
    const bodyPath = join(runRoot, "outbox", `${message.id}.md`);
    mkdirSync(dirname(bodyPath), { recursive: true });
    writeFileSync(bodyPath, message.body);
    const labelArgs = [
      "issue",
      "edit",
      String(message.issue_number),
      "--repo",
      message.repository,
      ...(message.add_labels?.length ? ["--add-label", message.add_labels.join(",")] : []),
      ...(message.remove_labels?.length ? ["--remove-label", message.remove_labels.join(",")] : []),
    ];
    const labelsUpdated = message.add_labels?.length || message.remove_labels?.length
      ? await runCaptured(gh, labelArgs, { env, timeout: 60_000 })
      : { code: 0, stdout: "", stderr: "" };
    const posted = labelsUpdated.code === 0
      ? await runCaptured(
      gh,
      ["issue", "comment", String(message.issue_number), "--repo", message.repository, "--body-file", bodyPath],
      { env, timeout: 60_000 },
      )
      : labelsUpdated;
    await apiRequest(
      env,
      `/telemetry/repair-worker/github/outbox/${encodeURIComponent(message.id)}/complete`,
      {
        worker_id: workerId,
        lease_token: claim.lease_token,
        delivered: posted.code === 0,
        ...(posted.code === 0 ? {} : { error: compact(posted.stderr || posted.stdout, 2_000) }),
      },
    );
    if (posted.code !== 0) break;
    delivered += 1;
  }
  return delivered;
}

export async function runWorker(env = process.env) {
  const lockPath = env.WATCHTOWER_REPAIR_LOCK_PATH || DEFAULT_LOCK_PATH;
  if (!acquireLock(lockPath)) return { status: "already_running" };
  try {
    const registry = loadRegistry(env);
    const workerId = env.WATCHTOWER_REPAIR_WORKER_ID || "mac-mini-repair";
    await flushGitHubOutbox(env);

    const parentClaim = await apiRequest(env, "/telemetry/repair-worker/claim", {
      worker_id: workerId,
      lease_seconds: 1800,
      ...(env.WATCHTOWER_REPAIR_CASE_ID
        ? { case_id: env.WATCHTOWER_REPAIR_CASE_ID }
        : {}),
    });
    if (parentClaim) {
      const runDir = join(env.WATCHTOWER_REPAIR_RUN_ROOT || DEFAULT_RUN_ROOT, parentClaim.repair_case.case_id);
      mkdirSync(runDir, { recursive: true });
      const result = await withHeartbeat({
        env,
        path: `/telemetry/repair-worker/${encodeURIComponent(parentClaim.repair_case.case_id)}/heartbeat`,
        body: {
          worker_id: workerId,
          lease_token: parentClaim.lease_token,
        },
        leaseSeconds: 1800,
      }, (leaseGuard) => runDiagnosis(env, parentClaim, registry, runDir, workerId, leaseGuard));
      await flushGitHubOutbox(env);
      return result;
    }

    const taskClaim = await apiRequest(env, "/telemetry/repair-worker/tasks/claim", {
      worker_id: workerId,
      lease_seconds: 3600,
      ...(env.WATCHTOWER_REPAIR_TASK_ID
        ? { task_id: env.WATCHTOWER_REPAIR_TASK_ID }
        : {}),
    });
    if (!taskClaim) {
      await flushGitHubOutbox(env);
      return { status: "idle" };
    }
    const runDir = join(
      env.WATCHTOWER_REPAIR_RUN_ROOT || DEFAULT_RUN_ROOT,
      taskClaim.repair_case.case_id,
      `occurrence-${taskClaim.repair_task.occurrence_no}`,
    );
    mkdirSync(runDir, { recursive: true });
    const result = await withHeartbeat({
      env,
      path: `/telemetry/repair-worker/tasks/${encodeURIComponent(taskClaim.repair_task.task_id)}/heartbeat`,
      body: {
        worker_id: workerId,
        lease_token: taskClaim.lease_token,
      },
      leaseSeconds: 3600,
    }, (leaseGuard) => taskClaim.repair_task.state === "SHIPPING"
      ? runShipTask(env, taskClaim, registry, workerId, leaseGuard)
      : runRepairTask(env, taskClaim, registry, runDir, workerId, leaseGuard));
    await flushGitHubOutbox(env);
    return result;
  } finally {
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
