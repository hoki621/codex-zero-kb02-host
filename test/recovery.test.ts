import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as turn } from "node:timers/promises";
import test from "node:test";
import { openSerial, type SerialConnection } from "../src/usb.js";
import { HerdrStateSource } from "../src/state.js";
import type { HerdrClient, HerdrEvent, RawAgent } from "../src/herdr.js";
import { claimRegistration } from "../src/codex-micro.js";

test("serial timeout consumes a late OS error", async () => {
  const port = Object.assign(new EventEmitter(), { isOpen: false, close: () => {}, write: () => true });
  await assert.rejects(openSerial({ list: async () => [], open: () => port as SerialConnection }, "/mock/test", 1), /timed out/);
  assert.doesNotThrow(() => port.emit("error", new Error("late OS open failure")));
});
function client(source: HerdrStateSource): HerdrClient {
  return (source as unknown as { client: HerdrClient }).client;
}
test("failure of an old Herdr establishment cannot disconnect its replacement", async () => {
  let rejectOld!: (error: Error) => void;
  let calls = 0;
  const states: boolean[] = [];
  const source = new HerdrStateSource({ socketPath: "/mock/test", onState: (s) => states.push(s.online) });
  client(source).checkProtocol = () => ++calls === 1 ? new Promise((_, reject) => { rejectOld = reject; }) : Promise.resolve();
  client(source).agentList = async () => [];
  client(source).subscribe = async () => () => {};
  client(source).request = async () => ({ type: "pane_current", pane: { pane_id: "p" } });
  try {
    const oldStart = source.start(); source.stop(); await source.start();
    rejectOld(new Error("old session")); await oldStart;
    assert.deepEqual(states, [true]);
  } finally { source.stop(); }
});
test("a delayed startup snapshot cannot overwrite a newer event snapshot", async () => {
  const agent = (status: string): RawAgent => ({ agent: "codex", terminal_id: "t", pane_id: "p", workspace_id: "w", tab_id: "tab", agent_status: status });
  let resolveOld!: (agents: RawAgent[]) => void;
  let callback!: (event: HerdrEvent) => void;
  let calls = 0;
  const states: unknown[] = [];
  const source = new HerdrStateSource({ socketPath: "/mock/test", onState: (s) => states.push(s.slots.find(Boolean)?.status) });
  client(source).checkProtocol = async () => {};
  client(source).agentList = async () => ++calls === 2 ? new Promise((resolve) => { resolveOld = resolve; }) : [agent(calls === 1 ? "idle" : "working")];
  client(source).subscribe = async (_, cb) => { callback = cb; return () => {}; };
  client(source).request = async () => ({ type: "pane_current", pane: { pane_id: "p" } });
  try {
    const start = source.start(); await turn(); callback({ event: "pane.agent_status_changed", data: {} }); await turn();
    resolveOld([agent("idle")]); await start;
    assert.deepEqual(states, ["working"]);
  } finally { source.stop(); }
});
test("registration reclaims only a dead owner and serializes concurrent claims", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kb02-claim-"));
  const target = path.join(dir, "thread.json");
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  try {
    await writeFile(target, JSON.stringify({ pid: child.pid }));
    await writeFile(`${target}.approval`, "stale");
    const record = { pid: process.pid, epoch: "live" };
    const results = await Promise.allSettled([claimRegistration(target, record), claimRegistration(target, record)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), record);
    await assert.rejects(readFile(`${target}.approval`), { code: "ENOENT" });
    await assert.rejects(claimRegistration(target, record), /live or unknown/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("stalled serial write has a finite deadline", async () => {
  const { writeSerial } = await import("../src/usb.js");
  const port = Object.assign(new EventEmitter(), { isOpen: true, close: () => {}, write: () => true });
  await assert.rejects(writeSerial(port as SerialConnection, "PING 0\n", 1), /write timed out/);
});
