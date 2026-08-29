import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LifecycleObserver, WebSocketTap } from "../src/codex-micro.js";
import {
  CodexAppServer,
  ReasoningController,
  parseDeviceMessage,
  type HerdrState,
  type RawAgent,
  type UsbInputContext,
} from "../src/index.js";

const THREAD = "018f1234-5678-7abc-8def-0123456789ab";
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function context(state: HerdrState | null = { online: true, slots: [] }) {
  let retransmits = 0;
  const value: UsbInputContext = {
    generation: 7n,
    state,
    isCurrent: () => true,
    retransmit: () => { retransmits += 1; },
  };
  return { value, retransmits: () => retransmits };
}

function message(line: string) {
  const parsed = parseDeviceMessage(line);
  assert.ok(parsed);
  return parsed;
}

function managed(paneId = "focused") {
  return {
    agent: "codex",
    pane_id: paneId,
    agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: THREAD },
  };
}

test("ENC changes only the uniquely focused managed thread after a final recheck", async () => {
  const calls: string[] = [];
  const herdr = {
    request: async () => {
      calls.push("pane.current");
      return { type: "pane_current", pane: { pane_id: "focused" } };
    },
    agentList: async () => {
      calls.push("agent.list");
      return [managed(), { agent: "codex", pane_id: "other" }];
    },
  };
  const codex = {
    changeEffort: async (threadId: string, direction: string, beforeUpdate: () => Promise<boolean>) => {
      calls.push(`${threadId}:${direction}`);
      return beforeUpdate();
    },
  };
  const controller = new ReasoningController(herdr, codex);

  assert.equal(await controller.handle(message("ENC 7 CW"), context().value), true);
  assert.deepEqual(calls, [
    "pane.current", "agent.list", `${THREAD}:CW`, "pane.current", "agent.list",
  ]);
});

test("ENC fails closed for stale, offline, non-rotation, ambiguous, and raced input", async () => {
  let appCalls = 0;
  let agents: RawAgent[] = [managed()];
  let panes = ["focused"];
  const herdr = {
    request: async () => ({
      type: "pane_current",
      pane: { pane_id: panes.length > 1 ? panes.shift() : panes[0] },
    }),
    agentList: async () => agents,
  };
  const codex = {
    changeEffort: async (_id: string, _direction: string, beforeUpdate: () => Promise<boolean>) => {
      appCalls += 1;
      return beforeUpdate();
    },
  };
  const controller = new ReasoningController(herdr, codex);

  const stale = context();
  assert.equal(await controller.handle(message("ENC 6 CW"), stale.value), false);
  assert.equal(stale.retransmits(), 1);
  const offline = context({ online: false, slots: [] });
  assert.equal(await controller.handle(message("ENC 7 CW"), offline.value), false);
  assert.equal(offline.retransmits(), 1);
  assert.equal(await controller.handle(message("ENC 7 DOWN"), context().value), false);
  assert.equal(await controller.handle(message("ENC 7 UP"), context().value), false);

  agents = [{ agent: "codex", pane_id: "focused" }];
  assert.equal(await controller.handle(message("ENC 7 CCW"), context().value), false);
  for (const source of ["managed", 1]) {
    agents = [{ ...managed(), agent_session: { ...managed().agent_session, source } }];
    assert.equal(await controller.handle(message("ENC 7 CCW"), context().value), false);
  }
  agents = [{ ...managed(), agent_session: { ...managed().agent_session, value: "not-a-uuidv7" } }];
  assert.equal(await controller.handle(message("ENC 7 CCW"), context().value), false);
  agents = [managed(), managed()];
  assert.equal(await controller.handle(message("ENC 7 CCW"), context().value), false);
  agents = [managed()];
  panes = ["focused", "other"];
  assert.equal(await controller.handle(message("ENC 7 CW"), context().value), false);
  assert.equal(appCalls, 1);
});

type Rpc = { id?: number; method: string; params?: Record<string, unknown> };

function serverFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  const header = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([header, payload]);
}

function readClientFrame(buffer: Buffer): { value: Rpc; rest: Buffer } | null {
  if (buffer.length < 2) return null;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  }
  if (buffer.length < offset + 4 + length) return null;
  const mask = buffer.subarray(offset, offset + 4);
  const payload = buffer.subarray(offset + 4, offset + 4 + length);
  const decoded = Buffer.alloc(length);
  for (let index = 0; index < length; index++) decoded[index] = payload[index]! ^ mask[index % 4]!;
  return {
    value: JSON.parse(decoded.toString("utf8")) as Rpc,
    rest: buffer.subarray(offset + 4 + length),
  };
}

async function fakeAppServer(
  responder: (request: Rpc, requests: Rpc[]) => unknown,
): Promise<{ path: string; requests: Rpc[]; close(): Promise<void> }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zero-kb02-reasoning-"));
  const socketPath = path.join(directory, "app.sock");
  const requests: Rpc[] = [];
  const server = net.createServer((socket) => {
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let upgraded = false;
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end === -1) return;
        const head = buffer.subarray(0, end).toString("ascii");
        const key = /^Sec-WebSocket-Key: (.+)$/mi.exec(head)?.[1];
        assert.ok(key);
        const accept = createHash("sha1").update(key + GUID).digest("base64");
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        buffer = buffer.subarray(end + 4);
        upgraded = true;
      }
      for (let frame = readClientFrame(buffer); frame; frame = readClientFrame(buffer)) {
        buffer = frame.rest;
        requests.push(frame.value);
        if (frame.value.id !== undefined) {
          socket.write(serverFrame({ id: frame.value.id, result: responder(frame.value, requests) }));
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    path: socketPath,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true });
    },
  };
}

function response(request: Rpc, effort = "medium", version = "0.149.1", userAgent = `codex-cli/${version}`) {
  switch (request.method) {
    case "initialize": return { platformOs: "macos", userAgent };
    case "thread/loaded/list": return { data: [THREAD] };
    case "thread/resume": return { thread: { id: THREAD }, model: "gpt-5.6", reasoningEffort: effort };
    case "model/list": return {
      data: [{
        id: "gpt-5.6", model: "gpt-5.6",
        supportedReasoningEfforts: ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort })),
      }],
    };
    case "thread/settings/update": return {};
    default: throw new Error(`unexpected ${request.method}`);
  }
}

test("App Server moves one supported effort and clamps without model changes", async () => {
  const moving = await fakeAppServer((request) => response(request));
  try {
    assert.equal(await new CodexAppServer(moving.path).changeEffort(THREAD, "CW", async () => true), true);
    assert.deepEqual(moving.requests.find(({ method }) => method === "thread/settings/update")?.params, {
      threadId: THREAD,
      effort: "high",
    });
  } finally {
    await moving.close();
  }

  const clamped = await fakeAppServer((request) => response(request, "low"));
  try {
    assert.equal(await new CodexAppServer(clamped.path).changeEffort(THREAD, "CCW", async () => true), true);
    assert.equal(clamped.requests.some(({ method }) => method === "thread/settings/update"), false);
  } finally {
    await clamped.close();
  }
});

test("App Server changes a relay-known effort without resuming the thread", async () => {
  const server = await fakeAppServer((request) => response(request));
  try {
    assert.equal(
      await new CodexAppServer(server.path).changeKnownEffort(
        THREAD, "gpt-5.6", "medium", "CW", async () => true,
      ),
      "high",
    );
    assert.equal(server.requests.some(({ method }) => method === "thread/resume"), false);
  } finally {
    await server.close();
  }
});

test("codex-micro correlates lifecycle responses by id and observes /new settings", () => {
  const nextThread = "01901234-5678-7abc-8def-0123456789ab";
  const forkedThread = "01911234-5678-7abc-8def-0123456789ab";
  const observed: unknown[] = [];
  const observer = new LifecycleObserver((state) => observed.push(state));

  observer.client(JSON.stringify({ id: 1, method: "thread/start", params: { cwd: "/same" } }));
  observer.client(JSON.stringify({ id: 2, method: "thread/start", params: { cwd: "/same" } }));
  observer.server(JSON.stringify({ id: 2, result: {
    thread: { id: nextThread }, model: "gpt-5.6", reasoningEffort: "low",
  } }));
  observer.server(JSON.stringify({ id: 1, result: {
    thread: { id: THREAD }, model: "gpt-5.6", reasoningEffort: "medium",
  } }));
  observer.server(JSON.stringify({ method: "thread/settings/updated", params: {
    threadId: nextThread, threadSettings: { model: "gpt-5.6", effort: "high" },
  } }));
  observer.client(JSON.stringify({ id: 3, method: "thread/resume" }));
  observer.server(JSON.stringify({ id: 3, result: {
    thread: { id: "not-a-uuidv7" }, model: "gpt-5.6", reasoningEffort: "high",
  } }));
  observer.client(JSON.stringify({ id: 4, method: "thread/fork" }));
  observer.server(JSON.stringify({ id: 4, result: {
    thread: { id: forkedThread }, model: "gpt-5.6", reasoningEffort: "medium",
  } }));

  assert.deepEqual(observed, [
    { threadId: nextThread, model: "gpt-5.6", effort: "low" },
    { threadId: nextThread, model: "gpt-5.6", effort: "high" },
    { threadId: forkedThread, model: "gpt-5.6", effort: "medium" },
  ]);
});

test("codex-micro observes split masked and fragmented WebSocket text", () => {
  const observed: string[] = [];
  const client = new WebSocketTap(true, (text) => observed.push(text));
  const payload = Buffer.from("client");
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]!));
  const request = Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
  const upgrade = Buffer.from("GET / HTTP/1.1\r\nUpgrade: websocket\r\n\r\n");
  client.push(Buffer.concat([upgrade, request.subarray(0, 3)]));
  client.push(request.subarray(3));

  const server = new WebSocketTap(false, (text) => observed.push(text));
  server.push(Buffer.concat([
    Buffer.from("HTTP/1.1 101 Switching Protocols\r\n\r\n"),
    Buffer.from([0x01, 3]), Buffer.from("ser"),
    Buffer.from([0x80, 3]), Buffer.from("ver"),
  ]));
  assert.deepEqual(observed, ["client", "server"]);
});

test("App Server accepts only the supported exact CLI versions", async () => {
  for (const { version, userAgent } of [
    { version: "0.149.1" },
    { version: "0.150.1", userAgent: "zero-kb02/0.150.1 (Mac OS 26.6.2; arm64) ghostty/1.3.1 (zero-kb02-diagnostic; 0.1.0)" },
  ]) {
    const accepted = await fakeAppServer((request) => response(request, "medium", version, userAgent));
    try {
      assert.equal(await new CodexAppServer(accepted.path).changeEffort(THREAD, "CW", async () => true), true);
    } finally {
      await accepted.close();
    }
  }
  for (const { version, userAgent } of [
    { version: "0.150.2" },
    { version: "0.151.0" },
    { version: "0.149.1", userAgent: "invalid" },
    { version: "0.150.1", userAgent: "zero-kb02/0.150.1/evil" },
    { version: "0.150.1", userAgent: "zero-kb02/0.150.1_evil" },
  ]) {
    const rejected = await fakeAppServer((request) => response(request, "medium", version, userAgent));
    try {
      assert.equal(await new CodexAppServer(rejected.path).changeEffort(THREAD, "CW", async () => true), false);
      assert.equal(rejected.requests.some(({ method }) => method === "thread/settings/update"), false);
    } finally {
      await rejected.close();
    }
  }
});

test("App Server unavailable endpoint fails before update", async () => {
  await assert.rejects(
    new CodexAppServer(path.join(os.tmpdir(), "zero-kb02-missing.sock")).changeEffort(THREAD, "CW", async () => true),
  );
});

test("App Server requires exactly one loaded target thread", async () => {
  for (const loaded of [[], [THREAD, THREAD]]) {
    const server = await fakeAppServer((request) => request.method === "thread/loaded/list"
      ? { data: loaded }
      : response(request));
    try {
      assert.equal(await new CodexAppServer(server.path).changeEffort(THREAD, "CW", async () => true), false);
      assert.equal(server.requests.some(({ method }) => method === "thread/settings/update"), false);
    } finally {
      await server.close();
    }
  }
});

test("App Server rejects pagination cursors from loaded threads and models", async () => {
  for (const paginatedMethod of ["thread/loaded/list", "model/list"]) {
    const server = await fakeAppServer((request) => request.method === paginatedMethod
      ? { ...response(request), nextCursor: "more" }
      : response(request));
    try {
      assert.equal(await new CodexAppServer(server.path).changeEffort(THREAD, "CW", async () => true), false);
      assert.equal(server.requests.some(({ method }) => method === "thread/settings/update"), false);
    } finally {
      await server.close();
    }
  }
});
