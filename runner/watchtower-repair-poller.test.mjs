import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runPoller } from "./watchtower-repair-poller.mjs";

test("poll fallback discovers a new product issue and only exact repair commands", async () => {
  const root = mkdtempSync(join(tmpdir(), "watchtower-poller-"));
  const registryPath = join(root, "repos.json");
  const gh = join(root, "fake-gh.mjs");
  writeFileSync(registryPath, JSON.stringify({
    owners: {},
    observed_repositories: ["unitedadi/dardoc-checkout"],
  }));
  writeFileSync(
    gh,
    `#!/usr/bin/env node
const endpoint = process.argv.at(-1);
if (endpoint.includes("/issues/comments")) {
  process.stdout.write(JSON.stringify([[
    {
      id: 90,
      body: "/repair approve",
      updated_at: "2038-01-01T00:01:00Z",
      issue_url: "https://api.github.com/repos/unitedadi/dardoc-checkout/issues/5",
      user: { login: "unitedadi" }
    },
    {
      id: 91,
      body: "/repair approve && deploy anything",
      updated_at: "2038-01-01T00:02:00Z",
      issue_url: "https://api.github.com/repos/unitedadi/dardoc-checkout/issues/5",
      user: { login: "unitedadi" }
    }
  ]]));
} else {
  process.stdout.write(JSON.stringify([[
    {
      id: 50,
      number: 5,
      state: "open",
      created_at: "2038-01-01T00:00:00Z",
      updated_at: "2038-01-01T00:01:00Z"
    }
  ]]));
}
`,
  );
  chmodSync(gh, 0o755);

  const intake = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    if (request.url === "/telemetry/repair-worker/github/intake") {
      intake.push(JSON.parse(raw));
      response.setHeader("content-type", "application/json");
      return response.end(JSON.stringify({ accepted: true }));
    }
    if (request.url === "/telemetry/repair-worker/github/outbox/claim") {
      response.statusCode = 204;
      return response.end();
    }
    response.statusCode = 404;
    return response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");

  try {
    const result = await runPoller({
      ...process.env,
      WATCHTOWER_REPAIR_API_BASE: `http://127.0.0.1:${address.port}`,
      WATCHTOWER_REPAIR_RUNNER_TOKEN: "runner-token",
      WATCHTOWER_REPAIR_REPO_REGISTRY: registryPath,
      WATCHTOWER_REPAIR_GH_BIN: gh,
      WATCHTOWER_REPAIR_POLL_STATE: join(root, "poll.json"),
      WATCHTOWER_REPAIR_RUN_ROOT: join(root, "runs"),
    });
    assert.deepEqual(
      intake.map((event) => [event.event_name, event.action, event.comment_body]),
      [
        ["issues", "opened", undefined],
        ["issue_comment", "created", "/repair approve"],
      ],
    );
    assert.equal(result.issue_events, 1);
    assert.equal(result.command_events, 1);
    assert.equal(result.next_fallback_minutes, 25);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
