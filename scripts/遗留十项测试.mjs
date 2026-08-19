import assert from "node:assert/strict";
import { listConnectors, beginConnectorAuth } from "../server/connectors.mjs";
import { parseReferences } from "../server/context.mjs";
import { listWorkflows, workflowSteps } from "../server/workflows.mjs";

const connectors = listConnectors();
assert.ok(connectors.find((x) => x.id === "local" && x.status === "ready"));
assert.equal(beginConnectorAuth("google-drive").status, "authorization_required");
const refs = parseReferences("@文件[report.pdf#page=3] @文件[data.xlsx#Sheet1!A1:B2]");
assert.equal(refs[0].range.page, 3);
assert.equal(refs[1].range.sheet, "Sheet1");
const wf = listWorkflows([]).find((x) => x.id === "wf-plan-doc");
assert.equal(workflowSteps(wf).length, wf.steps.length);
assert.equal(workflowSteps(wf)[0].status, "ready");
console.log("legacy-10 closure contract: ok");
