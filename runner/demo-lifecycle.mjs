import assert from "node:assert/strict";

const caseState = {
  case_id: "WT-DEMO-001",
  origin_issue: "unitedadi/dardoc-checkout#demo",
  state: "QUEUED",
  route: null,
  approvals: { prepare: false, ship: false },
  tasks: {
    backend: "WAITING",
    watchtower: "WAITING",
  },
  verification: "pending",
};

function show(label) {
  process.stdout.write(`${label.padEnd(24)} ${JSON.stringify(caseState)}\n`);
}

show("1. product issue");
caseState.state = "INVESTIGATED";
caseState.route = "multi_repo";
show("2. evidence diagnosis");

caseState.approvals.prepare = true;
caseState.tasks.backend = "QUEUED";
caseState.tasks.watchtower = "QUEUED";
show("3. /repair approve");

caseState.tasks.backend = "PATCH_READY";
caseState.tasks.watchtower = "PATCH_READY";
caseState.state = "PATCH_READY";
show("4. local patches tested");

caseState.approvals.ship = true;
caseState.tasks.backend = "SHIP_APPROVED";
caseState.tasks.watchtower = "SHIP_APPROVED";
show("5. /repair ship");

caseState.tasks.backend = "SHIPPED";
caseState.tasks.watchtower = "SHIPPED";
caseState.state = "SHIPPED";
caseState.verification = "verifying";
show("6. releases recorded");

caseState.tasks.backend = "VERIFIED";
caseState.tasks.watchtower = "VERIFIED";
caseState.state = "RECOVERED";
caseState.verification = "verified";
show("7. fresh evidence green");

assert.equal(caseState.state, "RECOVERED");
assert.equal(caseState.approvals.prepare, true);
assert.equal(caseState.approvals.ship, true);
assert.equal(caseState.verification, "verified");
process.stdout.write("\nDemo only: no GitHub, repository, deployment, or production write occurred.\n");
