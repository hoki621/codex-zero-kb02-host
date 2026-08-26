import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseStatus, renderStatus, runStatusPopup } from "../src/status-popup.js";
import { StatusPublisher } from "../src/status.js";
import type { HerdrState } from "../src/state.js";

function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zero-kb02-status-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, "status.sock");
}

function lineReader(socket: net.Socket) {
  const waiting: ((line: string) => void)[] = [];
  const queued: string[] = [];
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const resolve = waiting.shift();
      resolve ? resolve(line) : queued.push(line);
    }
  });
  return () => new Promise<string>((resolve) => {
    const line = queued.shift();
    line === undefined ? waiting.push(resolve) : resolve(line);
  });
}

function state(): HerdrState {
  return {
    online: true,
    slots: [{
      index: 0,
      terminalId: "agent-1",
      paneId: "pane-1",
      workspaceId: "workspace-1",
      tabId: "tab-1",
      status: "working",
      sequence: 4,
    }, null, null, null, null, null],
  };
}

test("status socket sends immediate six-slot snapshots and mode 0600", async (t) => {
  const socketPath = fixture(t);
  const publisher = new StatusPublisher(socketPath);
  publisher.update(state());
  await publisher.start();
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(socketPath)).mode & 0o777, 0o700);

  const socket = net.createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const nextLine = lineReader(socket);
  socket.write('{"cmd":"watch"}\n');
  const first = parseStatus(await nextLine());
  assert.equal(first?.version, 1);
  assert.equal(first?.slots.length, 6);
  assert.equal(first?.slots[0]?.terminalId, "agent-1");

  publisher.update({ online: false, slots: Array.from({ length: 6 }, () => null) });
  const second = parseStatus(await nextLine());
  assert.equal(second?.online, false);
  assert.equal(second?.slots.every((slot) => slot === null), true);
  socket.destroy();
  await publisher.stop();
  assert.equal(fs.existsSync(socketPath), false);
});

test("status socket rejects commands other than the exact watch line", async (t) => {
  const socketPath = fixture(t);
  const publisher = new StatusPublisher(socketPath);
  await publisher.start();
  const socket = net.createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.write('{"cmd":"status"}\n');
  await closed;
  await publisher.stop();
});

test("popup validates snapshots, sanitizes text, and exits on daemon EOF", async (t) => {
  const clean = state();
  const malicious: HerdrState = {
    ...clean,
    slots: [{ ...clean.slots[0]!, terminalId: "bad\x1b[31m\nagent" }, ...clean.slots.slice(1)],
  };
  const payload = { version: 1 as const, ...malicious };
  const parsed = parseStatus(JSON.stringify(payload));
  assert.ok(parsed);
  const rendered = renderStatus(parsed);
  assert.equal(rendered.includes("\x1b"), false);
  assert.equal(rendered.includes("\nagent"), false);
  assert.equal(parseStatus(JSON.stringify({ ...payload, slots: [] })), null);

  const socketPath = fixture(t);
  const publisher = new StatusPublisher(socketPath);
  publisher.update(state());
  await publisher.start();
  let output = "";
  const running = runStatusPopup(socketPath, (value) => { output += value; });
  while (!output.includes("agent-1")) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await publisher.stop();
  await running;
  assert.match(output, /zero-kb02 status/);
});
