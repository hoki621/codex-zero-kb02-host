import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  DEFAULT_RECONCILE_MS,
  HerdrStateSource,
  normalizeStatus,
  type HerdrState,
  type RawAgent,
  type Subscription,
} from "../src/index.js";

function agent(
  id: number,
  status: unknown = "idle",
  kind = "codex",
  paneId = `p${id}`,
): RawAgent {
  return {
    agent: kind,
    terminal_id: `t${id}`,
    pane_id: paneId,
    workspace_id: "w1",
    tab_id: "tab1",
    agent_status: status,
    state_change_seq: id,
  };
}

async function waitFor(check: () => boolean, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await delay(10);
  }
}

class FakeHerdr {
  protocol: unknown = 22;
  version = "0.8.2-test";
  agents: RawAgent[] = [];
  requests: string[] = [];
  subscriptionBatches: Subscription[][] = [];
  onSubscribe: (() => void) | null = null;

  private readonly sockets = new Set<net.Socket>();
  private readonly subscriptions = new Set<net.Socket>();

  private constructor(
    readonly directory: string,
    readonly socketPath: string,
    private readonly server: net.Server,
  ) {}

  static async start(): Promise<FakeHerdr> {
    const directory = await mkdtemp(path.join(tmpdir(), "zero-kb02-herdr-"));
    const socketPath = path.join(directory, "herdr.sock");
    const server = net.createServer();
    const fake = new FakeHerdr(directory, socketPath, server);
    server.on("connection", (socket) => fake.handle(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    return fake;
  }

  emit(event: string): void {
    const line = JSON.stringify({ event, data: {} }) + "\n";
    for (const socket of this.subscriptions) socket.write(line);
  }

  dropSubscriptions(): void {
    for (const socket of [...this.subscriptions]) socket.destroy();
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await rm(this.directory, { recursive: true, force: true });
  }

  private handle(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline)) as {
        id: string;
        method: string;
        params: { subscriptions?: Subscription[] };
      };
      this.requests.push(request.method);
      switch (request.method) {
        case "ping":
          this.reply(socket, request.id, {
            type: "pong",
            version: this.version,
            protocol: this.protocol,
          });
          socket.end();
          break;
        case "agent.list":
          this.reply(socket, request.id, {
            type: "agent_list",
            agents: this.agents,
          });
          socket.end();
          break;
        case "events.subscribe":
          this.subscriptions.add(socket);
          this.subscriptionBatches.push(request.params.subscriptions ?? []);
          this.onSubscribe?.();
          this.onSubscribe = null;
          this.reply(socket, request.id, { type: "subscription_started" });
          break;
        default:
          socket.write(
            JSON.stringify({
              id: request.id,
              error: { code: "unknown_method", message: request.method },
            }) + "\n",
          );
          socket.end();
      }
    });
    socket.on("close", () => {
      this.sockets.delete(socket);
      this.subscriptions.delete(socket);
    });
  }

  private reply(
    socket: net.Socket,
    id: string,
    result: Record<string, unknown>,
  ): void {
    socket.write(JSON.stringify({ id, result }) + "\n");
  }
}

test("startup uses snapshot, subscribe ACK, snapshot and normalizes Codex agents", async (t) => {
  const fake = await FakeHerdr.start();
  const states: HerdrState[] = [];
  fake.agents = [
    agent(1, "idle"),
    agent(2, "working"),
    agent(3, "blocked"),
    agent(4, "done"),
    agent(5, "unknown"),
    agent(99, "working", "claude"),
  ];
  fake.onSubscribe = () => {
    fake.agents = fake.agents.map((entry) =>
      entry.terminal_id === "t1" ? { ...entry, agent_status: "working" } : entry,
    );
  };
  const source = new HerdrStateSource({
    socketPath: fake.socketPath,
    onState: (state) => states.push(state),
  });
  t.after(() => source.stop());
  t.after(() => fake.close());

  await source.start();

  assert.deepEqual(fake.requests.slice(0, 4), [
    "ping",
    "agent.list",
    "events.subscribe",
    "agent.list",
  ]);
  const first = states.at(-1)!;
  assert.equal(first.online, true);
  assert.equal(first.slots.filter(Boolean).length, 5);
  assert.equal(
    first.slots.find((slot) => slot?.terminalId === "t1")?.status,
    "working",
  );
  assert.equal(first.slots.some((slot) => slot?.terminalId === "t99"), false);
  assert.deepEqual(
    ["idle", "working", "blocked", "done", "unknown", "other"].map(
      normalizeStatus,
    ),
    ["idle", "working", "blocked", "done", "unknown", "unknown"],
  );

  fake.agents = Array.from({ length: 8 }, (_, index) =>
    agent(index + 1, "working"),
  );
  fake.emit("pane.created");
  await waitFor(() => states.at(-1)?.slots.filter(Boolean).length === 6);

  fake.agents = [];
  fake.emit("pane.closed");
  await waitFor(() => states.at(-1)?.slots.every((slot) => slot === null) === true);
});

test("terminal slots stay sticky and pane topology rebuilds subscriptions", async (t) => {
  const fake = await FakeHerdr.start();
  const states: HerdrState[] = [];
  fake.agents = [agent(1), agent(2), agent(3)];
  const source = new HerdrStateSource({
    socketPath: fake.socketPath,
    onState: (state) => states.push(state),
  });
  t.after(() => source.stop());
  t.after(() => fake.close());
  await source.start();
  const original = states.at(-1)!.slots.map((slot) => slot?.terminalId ?? null);

  fake.agents = [
    agent(3, "blocked", "codex", "moved-p3"),
    agent(1, "done", "codex", "moved-p1"),
    agent(2, "working", "codex", "moved-p2"),
  ];
  fake.emit("pane.moved");

  await waitFor(
    () =>
      states.at(-1)?.slots.find((slot) => slot?.terminalId === "t1")?.paneId ===
        "moved-p1" && fake.subscriptionBatches.length >= 2,
  );
  assert.deepEqual(
    states.at(-1)!.slots.map((slot) => slot?.terminalId ?? null),
    original,
  );
  assert.equal(
    fake.subscriptionBatches.at(-1)!.some(
      (subscription) => subscription.pane_id === "moved-p1",
    ),
    true,
  );
});

test("periodic reconcile repairs missed events and reconnects a dropped subscription", async (t) => {
  const fake = await FakeHerdr.start();
  const states: HerdrState[] = [];
  fake.agents = [agent(1, "idle")];
  const source = new HerdrStateSource({
    socketPath: fake.socketPath,
    onState: (state) => states.push(state),
    reconcileMs: 40,
    retryMs: 20,
  });
  t.after(() => source.stop());
  t.after(() => fake.close());
  await source.start();
  assert.equal(DEFAULT_RECONCILE_MS, 5_000);

  fake.agents = [agent(1, "working")];
  await waitFor(
    () => states.at(-1)?.slots.find(Boolean)?.status === "working",
  );

  const batchesBeforeDrop = fake.subscriptionBatches.length;
  fake.dropSubscriptions();
  await waitFor(() => states.some((state) => state.online === false));
  await waitFor(
    () =>
      fake.subscriptionBatches.length > batchesBeforeDrop &&
      states.at(-1)?.online === true,
  );
});

test("JSON API accepts internal protocol changes but rejects malformed ping", async (t) => {
  const fake = await FakeHerdr.start();
  const errors: Error[] = [];
  const source = new HerdrStateSource({ socketPath: fake.socketPath, onState: () => {}, onError: (error) => errors.push(error) });
  t.after(() => source.stop());
  t.after(() => fake.close());
  fake.protocol = 999;
  await source.start();
  source.stop();
  fake.protocol = "22";
  await source.start();
  assert.match(errors.at(-1)!.message, /invalid result/);
});

test("ambiguous terminal and pane identities are excluded completely", async (t) => {
  const fake = await FakeHerdr.start();
  const states: HerdrState[] = [];
  fake.agents = [agent(1), agent(1, "blocked", "codex", "moved"),
    agent(2, "idle", "codex", "shared"), agent(3, "idle", "codex", "shared"), agent(4)];
  const source = new HerdrStateSource({ socketPath: fake.socketPath, onState: (state) => states.push(state) });
  t.after(() => source.stop());
  t.after(() => fake.close());
  await source.start();
  assert.deepEqual(states.at(-1)!.slots.filter(Boolean).map((slot) => slot!.terminalId), ["t4"]);
});
