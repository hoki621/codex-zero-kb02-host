import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ApprovalObserver, APPROVAL_VERSION, approvalEvidence, approvalPath, type PendingApproval } from "../src/approval.js";
import { codexMicroStatePath } from "../src/reasoning.js";
import { SafeBindings } from "../src/bindings.js";
import { parseDeviceMessage } from "../src/cdc.js";

const id = `01901234-5678-7abc-8def-${randomUUID().slice(-12)}`;
const command = (requestId = 1) => JSON.stringify({ id: requestId, method: "item/commandExecution/requestApproval", params: { threadId: id, availableDecisions: ["accept", "acceptForSession", "cancel"] } });
const screen = "Would you like to run the following command?\n$ echo test\n› 1. Yes, proceed (y)\n2. No, and tell Codex what to do differently (n)";
test("approval observer requires exactly one command request and clears on response, lifecycle and server resolution", () => {
  const updates: (PendingApproval | null)[] = [];
  const observer = new ApprovalObserver((value) => updates.push(value));
  observer.server(command());
  const token = updates.at(-1)!.token;
  observer.server(JSON.stringify({ id: 2, method: "item/tool/requestUserInput", params: { threadId: id } }));
  assert.equal(updates.at(-1), null);
  observer.client(JSON.stringify({ id: 2, result: {} }));
  assert.equal(updates.at(-1)!.token, token);
  observer.client(JSON.stringify({ id: 1, result: { decision: "accept" } }));
  assert.equal(updates.at(-1), null);
  observer.server(command(3));
  observer.server(JSON.stringify({ method: "serverRequest/resolved", params: { requestId: 3, threadId: id } }));
  assert.equal(updates.at(-1), null);
  observer.server(command(4)); observer.reset();
  assert.equal(updates.at(-1), null);
  observer.server(JSON.stringify({ id: 5, method: "item/commandExecution/requestApproval", params: { threadId: id, availableDecisions: ["acceptForSession", "cancel"] } }));
  assert.equal(updates.at(-1), null);
});
test("approval evidence binds a supported prompt to the live exact thread and terminal", async () => {
  const target = codexMicroStatePath(id);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const registration = { threadId: id, terminalId: "terminal", pid: process.pid, epoch: "epoch" };
  const pending = { ...registration, requestId: 1, method: "item/commandExecution/requestApproval", version: APPROVAL_VERSION, keymap: "fixed-y-n-v1", token: "1" };
  const agent = { agent: "codex", pane_id: "pane", terminal_id: "terminal", agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: id } };
  let text = screen;
  let truncated = false;
  const herdr = { request: async () => ({ type: "pane_read", read: { pane_id: "pane", source: "visible", format: "text", text, revision: 3, truncated } }) };
  try {
    await writeFile(target, JSON.stringify(registration), { flag: "wx", mode: 0o600 });
    await writeFile(approvalPath(id), JSON.stringify(pending), { flag: "wx", mode: 0o600 });
    assert.ok(await approvalEvidence(herdr, agent));
    text = "What would you like me to do?"; assert.equal(await approvalEvidence(herdr, agent), null);
    text = screen.replace("Yes, proceed (y)", "Yes, proceed (p)"); assert.equal(await approvalEvidence(herdr, agent), null);
    text = screen; truncated = true; assert.equal(await approvalEvidence(herdr, agent), null);
    truncated = false;
    assert.equal(await approvalEvidence(herdr, { ...agent, terminal_id: "reused" }), null);
    for (const change of [{ version: "codex-cli 999.0.0" }, { epoch: "old" }, { pid: -1 }, { method: "item/tool/requestUserInput" }]) {
      await writeFile(approvalPath(id), JSON.stringify({ ...pending, ...change }));
      assert.equal(await approvalEvidence(herdr, agent), null);
    }
  } finally { await rm(target, { force: true }); await rm(approvalPath(id), { force: true }); }
});
test("K9/K10 require stable evidence and consume a request only once, including failed sends", async () => {
  const agent = { agent: "codex", pane_id: "pane", terminal_id: "terminal", agent_status: "blocked" };
  let token = "1";
  let fail = false;
  const sent: unknown[] = [];
  const router = new SafeBindings({
    agentList: async () => [agent],
    request: async (method, params) => {
      if (method === "agent.send_keys") { sent.push(params); if (fail) throw new Error("timeout"); }
      return { type: "pane_current", pane: { pane_id: "pane" } };
    },
  }, async () => ({ token, screen: "unchanged" }));
  const context = { generation: 7n, state: { online: true, slots: [{ index: 0, terminalId: "terminal", paneId: "pane", tabId: "tab", workspaceId: "ws", status: "blocked" as const, sequence: 1 }] }, isCurrent: () => true, retransmit: () => {} };
  assert.equal(await router.handle(parseDeviceMessage("KEY 7 9 DOWN")!, context), true);
  assert.equal(await router.handle(parseDeviceMessage("KEY 7 10 DOWN")!, context), false);
  token = "2"; fail = true;
  await assert.rejects(router.handle(parseDeviceMessage("KEY 7 10 DOWN")!, context), /timeout/);
  assert.equal(await router.handle(parseDeviceMessage("KEY 7 10 DOWN")!, context), false);
  assert.deepEqual(sent, [{ target: "pane", keys: ["y"] }, { target: "pane", keys: ["n"] }]);
});

test("another thread completing never hides an unresolved approval", () => {
  const updates: (PendingApproval | null)[] = [];
  const observer = new ApprovalObserver((value) => updates.push(value));
  observer.server(command(1));
  observer.server(JSON.stringify({ id: 2, method: "item/commandExecution/requestApproval", params: { threadId: "other", availableDecisions: ["accept", "cancel"] } }));
  observer.server(JSON.stringify({ method: "turn/completed", params: { threadId: "other" } }));
  observer.server(command(3));
  assert.equal(updates.at(-1), null);
});

test("approval evidence is invalidated if registration disappears during pane.read", async () => {
  const thread = `01901234-5678-7abc-8def-${randomUUID().slice(-12)}`;
  const target = codexMicroStatePath(thread);
  await mkdir(path.dirname(target), { recursive: true });
  const record = { threadId: thread, terminalId: "terminal", pid: process.pid, epoch: "epoch" };
  const agent = { agent: "codex", pane_id: "pane", terminal_id: "terminal", agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: thread } };
  try {
    await writeFile(target, JSON.stringify(record));
    await writeFile(approvalPath(thread), JSON.stringify({ ...record, requestId: 1, method: "item/commandExecution/requestApproval", version: APPROVAL_VERSION, keymap: "fixed-y-n-v1", token: "1" }));
    const evidence = await approvalEvidence({ request: async () => {
      await rm(target); await rm(approvalPath(thread));
      return { type: "pane_read", read: { pane_id: "pane", source: "visible", format: "text", text: screen, revision: 1, truncated: false } };
    } }, agent);
    assert.equal(evidence, null);
  } finally { await rm(target, { force: true }); await rm(approvalPath(thread), { force: true }); }
});

test("changed approval token, screen, or missing final evidence prevents sending", async () => {
  for (const final of [null, { token: "2", screen: "same" }, { token: "1", screen: "changed" }]) {
    let reads = 0;
    let sends = 0;
    const router = new SafeBindings({
      agentList: async () => [{ agent: "codex", pane_id: "p", terminal_id: "t", agent_status: "blocked" }],
      request: async (method) => { if (method === "agent.send_keys") sends++; return { type: "pane_current", pane: { pane_id: "p" } }; },
    }, async () => ++reads === 1 ? { token: "1", screen: "same" } : final);
    const context = { generation: 7n, state: { online: true, slots: [{ index: 0, terminalId: "t", paneId: "p", tabId: "tab", workspaceId: "w", status: "blocked" as const, sequence: 0 }] }, isCurrent: () => true, retransmit: () => {} };
    assert.equal(await router.handle(parseDeviceMessage("KEY 7 9 DOWN")!, context), false);
    assert.equal(reads, 2); assert.equal(sends, 0);
  }
});
