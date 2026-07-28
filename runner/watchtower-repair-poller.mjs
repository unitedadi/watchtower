import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { promisify } from "node:util";

import { flushGitHubOutbox, loadRegistry } from "./watchtower-repair-worker.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_API_BASE = "https://api-prod.dardoc.com";
const DEFAULT_STATE_PATH = "/Users/mini/codex-runner/state/watchtower-github-poll.json";

function required(env, name) {
  const value = String(env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function compact(value, limit = 1_000) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function loadState(path) {
  if (!existsSync(path)) {
    return {
      last_poll_at: new Date(Date.now() - 30 * 60_000).toISOString(),
      issues: {},
    };
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return {
      last_poll_at: String(value.last_poll_at),
      issues: value.issues && typeof value.issues === "object" ? value.issues : {},
    };
  } catch {
    throw new Error(`GitHub poll state is unreadable: ${path}`);
  }
}

function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
}

async function ghJson(env, endpoint) {
  const gh = env.WATCHTOWER_REPAIR_GH_BIN || "/Users/mini/.local/bin/gh";
  const result = await execFileAsync(
    gh,
    ["api", "--paginate", "--slurp", endpoint],
    { env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
  );
  const pages = JSON.parse(result.stdout || "[]");
  return Array.isArray(pages) ? pages.flat() : [];
}

async function intake(env, body, fetchImpl = fetch) {
  const base = String(env.WATCHTOWER_REPAIR_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");
  const response = await fetchImpl(`${base}/telemetry/repair-worker/github/intake`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${required(env, "WATCHTOWER_REPAIR_RUNNER_TOKEN")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${payload.error || "github_intake_failed"}`);
  return payload;
}

function deliveryId(parts) {
  return `poll-${createHash("sha256").update(parts.join("|")).digest("hex")}`;
}

export async function runPoller(env = process.env) {
  const registry = loadRegistry(env);
  const repositories = registry.observed_repositories ?? [];
  const statePath = env.WATCHTOWER_REPAIR_POLL_STATE || DEFAULT_STATE_PATH;
  const state = loadState(statePath);
  const polledAt = new Date().toISOString();
  let issueEvents = 0;
  let commentEvents = 0;

  for (const repository of repositories) {
    const since = encodeURIComponent(state.last_poll_at);
    const issues = await ghJson(
      env,
      `repos/${repository}/issues?state=all&labels=watchtower&since=${since}&per_page=100`,
    );
    for (const issue of issues.filter((value) => !value.pull_request)) {
      const key = `${repository}#${issue.number}`;
      const previous = state.issues[key];
      const newlyCreated = String(issue.created_at ?? "") > state.last_poll_at;
      let action = !previous && issue.state === "open" && newlyCreated
        ? "opened"
        : previous === "closed" && issue.state === "open"
          ? "reopened"
          : null;
      if (!action && !previous && issue.state === "open" && !newlyCreated) {
        const events = await ghJson(
          env,
          `repos/${repository}/issues/${issue.number}/events?per_page=100`,
        );
        const recentlyReopened = events.some((event) =>
          event.event === "reopened" &&
          String(event.created_at ?? "") > state.last_poll_at
        );
        if (recentlyReopened) action = "reopened";
      }
      state.issues[key] = issue.state;
      if (!action) continue;
      await intake(env, {
        delivery_id: deliveryId([repository, String(issue.id), action, String(issue.updated_at)]),
        event_name: "issues",
        action,
        repository,
        issue_number: Number(issue.number),
        issue_state: String(issue.state),
      });
      issueEvents += 1;
    }

    const comments = await ghJson(
      env,
      `repos/${repository}/issues/comments?since=${since}&per_page=100`,
    );
    for (const comment of comments) {
      const body = String(comment.body ?? "").trim();
      if (!/^\/repair\s+(approve|ship|status)$/i.test(body)) continue;
      const issueNumber = Number(String(comment.issue_url ?? "").match(/\/issues\/(\d+)$/)?.[1]);
      if (!Number.isInteger(issueNumber) || issueNumber <= 0) continue;
      await intake(env, {
        delivery_id: deliveryId([repository, String(comment.id), String(comment.updated_at)]),
        event_name: "issue_comment",
        action: "created",
        repository,
        issue_number: issueNumber,
        comment_id: Number(comment.id),
        comment_body: body,
        comment_author: String(comment.user?.login ?? ""),
      });
      commentEvents += 1;
    }
  }

  state.last_poll_at = polledAt;
  saveState(statePath, state);
  const deliveredComments = await flushGitHubOutbox(env);
  return {
    status: "complete",
    repositories: repositories.length,
    issue_events: issueEvents,
    command_events: commentEvents,
    delivered_comments: deliveredComments,
    next_fallback_minutes: 25,
  };
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  runPoller().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`watchtower repair poller failed: ${compact(error?.message || error)}\n`);
    process.exitCode = 1;
  });
}
