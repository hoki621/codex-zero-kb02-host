// Optional integration check: no user Codex home, model turn, Herdr or USB access.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AppServerSession } from "../dist/src/app-server.js";
import { CodexAppServer } from "../dist/src/reasoning.js";
import { brewCodex } from "../dist/src/runtime.js";

const binary = await brewCodex();
const directory = await mkdtemp(path.join(os.tmpdir(), "zkb-smoke-"));
const socket = path.join(directory, "app.sock");
const child = spawn(binary.binary, ["app-server", "--listen", `unix://${socket}`], {
  env: { ...process.env, CODEX_HOME: directory }, stdio: "ignore",
});
const done = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
void done.catch(() => {});
let session;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await stat(socket); ready = true; break; }
    catch { await delay(50); }
  }
  assert.ok(ready, "Isolated App Server did not start");
  session = await AppServerSession.connect(socket);
  await session.request("initialize", {
    clientInfo: { name: "zero-kb02-smoke", version: "0.1.0" }, capabilities: { experimentalApi: true },
  });
  session.notify("initialized");
  const models = await session.request("model/list", { limit: 100, includeHidden: true });
  const model = models.data.find((entry) => entry.supportedReasoningEfforts?.length > 1);
  assert.ok(model, "No model with multiple reasoning levels");
  const started = await session.request("thread/start", { model: model.model, ephemeral: true, cwd: directory });
  const threadId = started.thread.id;
  const before = (await session.request("thread/read", { threadId, includeTurns: false })).thread;
  const efforts = model.supportedReasoningEfforts.map((entry) => entry.reasoningEffort);
  const index = efforts.indexOf(before.reasoningEffort ?? model.defaultReasoningEffort);
  assert.ok(index >= 0);
  const direction = index < efforts.length - 1 ? "CW" : "CCW";
  assert.equal(await new CodexAppServer(socket).changeEffort(threadId, direction, async () => true), true);
  const after = (await session.request("thread/read", { threadId, includeTurns: false })).thread;
  assert.equal(after.model, before.model);
  assert.equal(after.reasoningEffort, efforts[index + (direction === "CW" ? 1 : -1)]);
  assert.equal(after.turns.length, 0);
  console.log(JSON.stringify({ ...binary, model: after.model, before: before.reasoningEffort, after: after.reasoningEffort, turns: 0 }, null, 2));
} finally {
  session?.close();
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  await done.catch(() => {});
  clearTimeout(killTimer);
  await rm(directory, { recursive: true, force: true });
}
