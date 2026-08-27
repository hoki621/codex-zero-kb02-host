import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
    agent_session: { source: "managed", agent: "codex", kind: "id", value: THREAD },
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

function response(request: Rpc, effort = "medium", version = "0.149.1") {
  switch (request.method) {
    case "initialize": return { platformOs: "macos", userAgent: `codex-cli/${version}` };
    case "thread/loaded/list": return { data: [THREAD], nextCursor: null };
    case "thread/resume": return { thread: { id: THREAD }, model: "gpt-5.6", reasoningEffort: effort };
    case "model/list": return {
      data: [{
        id: "gpt-5.6", model: "gpt-5.6",
        supportedReasoningEfforts: ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort })),
      }],
      nextCursor: null,
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

test("App Server version mismatch and unavailable endpoint fail before update", async () => {
  const mismatch = await fakeAppServer((request) => response(request, "medium", "0.150.0"));
  try {
    assert.equal(await new CodexAppServer(mismatch.path).changeEffort(THREAD, "CW", async () => true), false);
    assert.equal(mismatch.requests.some(({ method }) => method === "thread/settings/update"), false);
  } finally {
    await mismatch.close();
  }
  await assert.rejects(
    new CodexAppServer(path.join(os.tmpdir(), "zero-kb02-missing.sock")).changeEffort(THREAD, "CW", async () => true),
  );
});
