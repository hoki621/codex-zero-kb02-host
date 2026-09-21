import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { WebSocketServer } from "ws";
import { AppServerSession } from "../src/app-server.js";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LifecycleObserver, startRelay } from "../src/codex-micro.js";
import {
  CodexAppServer,
  ReasoningController,
  parseDeviceMessage,
  type HerdrState,
  type RawAgent,
  type UsbInputContext,
} from "../src/index.js";

const THREAD = "018f1234-5678-7abc-8def-0123456789ab";

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

  assert.equal(await controller.handle(message("ENC 7 1"), context().value), true);
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
  assert.equal(await controller.handle(message("ENC 6 1"), stale.value), false);
  assert.equal(stale.retransmits(), 1);
  const offline = context({ online: false, slots: [] });
  assert.equal(await controller.handle(message("ENC 7 1"), offline.value), false);
  assert.equal(offline.retransmits(), 1);
  assert.equal(await controller.handle(message("KEY 7 11 DOWN"), context().value), false);
  assert.equal(await controller.handle(message("KEY 7 11 UP"), context().value), false);

  agents = [{ agent: "codex", pane_id: "focused" }];
  assert.equal(await controller.handle(message("ENC 7 -1"), context().value), false);
  for (const source of ["managed", 1]) {
    agents = [{ ...managed(), agent_session: { ...managed().agent_session, source } }];
    assert.equal(await controller.handle(message("ENC 7 -1"), context().value), false);
  }
  agents = [{ ...managed(), agent_session: { ...managed().agent_session, value: "not-a-uuidv7" } }];
  assert.equal(await controller.handle(message("ENC 7 -1"), context().value), false);
  agents = [managed(), managed()];
  assert.equal(await controller.handle(message("ENC 7 -1"), context().value), false);
  agents = [managed()];
  panes = ["focused", "other"];
  assert.equal(await controller.handle(message("ENC 7 1"), context().value), false);
  assert.equal(appCalls, 1);
});

type Rpc = { id?: number; method: string; params?: Record<string, unknown> };

async function fakeAppServer(
  responder: (request: Rpc, requests: Rpc[]) => unknown,
): Promise<{ path: string; requests: Rpc[]; close(): Promise<void> }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zero-kb02-reasoning-"));
  const socketPath = path.join(directory, "app.sock");
  const requests: Rpc[] = [];
  let appliedEffort: unknown;
  const server = http.createServer();
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => {
    socket.on("error", () => {});
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as Rpc;
      requests.push(request);
      if (request.id === undefined) return;
      const result = responder(request, requests);
      if (request.method === "thread/settings/update") appliedEffort = request.params?.effort;
      if (request.method === "thread/read" && appliedEffort && typeof result === "object" && result !== null) {
        const thread = (result as { thread?: Record<string, unknown> }).thread;
        if (thread) thread.reasoningEffort = appliedEffort;
      }
      if (result === "disconnect") { socket.terminate(); return; }
      if (result === "timeout") return;
      socket.send(JSON.stringify({ method: "unrelated/notification" }));
      const response = JSON.stringify({ id: request.id, result });
      socket.send(response.slice(0, 5), { fin: false });
      socket.send(response.slice(5), { fin: true });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    path: socketPath, requests,
    close: async () => {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true });
    },
  };
}

function response(request: Rpc, effort = "medium", version = "0.149.1", userAgent = `codex-cli/${version}`) {
  switch (request.method) {
    case "initialize": return { platformOs: "macos", userAgent };
    case "thread/loaded/list": return { data: [THREAD] };
    case "thread/read": return { thread: { id: THREAD, model: "gpt-5.6", reasoningEffort: effort } };
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
    { threadId: nextThread },
    { threadId: forkedThread },
  ]);
});

test("App Server validates response capabilities across CLI upgrades", async () => {
  for (const version of ["0.155.1", "0.156.0"]) {
    const server = await fakeAppServer((request) => response(request, "medium", version));
    try {
      assert.equal(await new CodexAppServer(server.path).changeEffort(THREAD, "CW", async () => true), true);
      assert.equal(server.requests.some(({ method }) => method === "thread/resume"), false);
    } finally { await server.close(); }
  }
  const unsupported = await fakeAppServer((request) => request.method === "thread/read"
    ? { thread: { id: THREAD } } : response(request));
  try {
    assert.equal(await new CodexAppServer(unsupported.path).changeEffort(THREAD, "CW", async () => true), false);
    assert.equal(unsupported.requests.some(({ method }) => method === "thread/settings/update"), false);
  } finally { await unsupported.close(); }
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

test("RPC rejects disconnects immediately and bounds silent response waits", async () => {
  for (const failure of ["disconnect", "timeout"]) {
    const server = await fakeAppServer(() => failure);
    const session = await AppServerSession.connect(server.path);
    try { await assert.rejects(session.request("initialize", {}, 30), /disconnected|timed out/); }
    finally { session.close(); await server.close(); }
  }
});

test("pending lifecycle invalidates old identity and ignores reversed stale responses", () => {
  const states: string[] = [];
  const observer = new LifecycleObserver((state) => states.push(state.threadId), () => states.push("invalid"));
  observer.client(JSON.stringify({ id: 1, method: "thread/start" }));
  observer.client(JSON.stringify({ id: 2, method: "thread/resume" }));
  observer.server(JSON.stringify({ id: 1, result: { thread: { id: THREAD }, model: "x", reasoningEffort: "low" } }));
  observer.server(JSON.stringify({ id: 2, error: { code: -1 } }));
  assert.deepEqual(states, ["invalid", "invalid"]);
});

test("relay forwards fragmented responses and cleans up an active client", async () => {
  const server = await fakeAppServer(() => ({ thread: { id: THREAD }, model: "x", reasoningEffort: "low" }));
  const directory = await mkdtemp(path.join(os.tmpdir(), "relay-test-"));
  const relayPath = path.join(directory, "relay.sock");
  const states: string[] = [];
  let closed = 0;
  const close = await startRelay(relayPath, server.path, () => ({
    observer: new LifecycleObserver((state) => states.push(state.threadId)),
    settled: async () => {}, close: () => { closed++; },
  }));
  const session = await AppServerSession.connect(relayPath);
  try {
    await session.request("thread/start", {});
    assert.deepEqual(states, [THREAD]);
    await close();
    assert.equal(closed, 1);
  } finally { session.close(); await server.close(); await rm(directory, { recursive: true }); }
});

test("encoder queues rotations, preserves order and drops invalidated context", async () => {
  const directions: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const controller = new ReasoningController({
    request: async () => ({ type: "pane_current", pane: { pane_id: "focused" } }),
    agentList: async () => [managed()],
  }, { changeEffort: async (_id, direction, guard) => {
    directions.push(direction);
    if (directions.length === 1) { entered(); await blocked; }
    return guard();
  } });
  const first = controller.handle(message("ENC 7 1"), context().value);
  await started;
  const second = controller.handle(message("ENC 7 -1"), context().value);
  const stale = context().value;
  const third = controller.handle(message("ENC 7 1"), stale);
  stale.isCurrent = () => false;
  release();
  assert.deepEqual(await Promise.all([first, second, third]), [true, true, false]);
  assert.deepEqual(directions, ["CW", "CCW"]);
});

test("effort update refuses settings changed while fetching the model", async () => {
  let reads = 0;
  const server = await fakeAppServer((request) => response(request,
    request.method === "thread/read" && ++reads > 1 ? "low" : "medium"));
  try {
    assert.equal(await new CodexAppServer(server.path).changeEffort(THREAD, "CW", async () => true), false);
    assert.equal(server.requests.some(({ method }) => method === "thread/settings/update"), false);
  } finally { await server.close(); }
});

test("unset effort uses the model default before the first turn", async () => {
  const server = await fakeAppServer((request) => {
    if (request.method === "thread/read") return { thread: { id: THREAD, model: "gpt-5.6", reasoningEffort: null } };
    if (request.method === "model/list") return { data: [{ model: "gpt-5.6", defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort })) }] };
    return response(request);
  });
  try {
    assert.equal(await new CodexAppServer(server.path).changeEffort(THREAD, "CW", async () => true), true);
    assert.equal(server.requests.find(({ method }) => method === "thread/settings/update")?.params?.effort, "high");
  } finally { await server.close(); }
});

test("a refused focus guard invalidates rotations queued before focus returns", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const controller = new ReasoningController({
    request: async () => ({ type: "pane_current", pane: { pane_id: "focused" } }),
    agentList: async () => [managed()],
  }, { changeEffort: async () => { calls++; await gate; return false; } });
  const first = controller.handle(message("ENC 7 1"), context().value);
  const second = controller.handle(message("ENC 7 1"), context().value);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(calls, 1);
});
