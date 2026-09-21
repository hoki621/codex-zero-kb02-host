#!/usr/bin/env node
import { ApprovalObserver, APPROVAL_VERSION, APPROVAL_KEYMAP_ARGS, approvalPath } from "./approval.js";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { connectWebSocket } from "./app-server.js";
import { brewCodex, doctor, runningServer, runServer } from "./runtime.js";
import { HerdrClient } from "./herdr.js";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codexMicroStatePath, processExists } from "./reasoning.js";

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PANE_ID = /^(?:[A-Za-z0-9]+:[A-Za-z0-9]+|[0-9]+-[0-9]+)$/;
const LIFECYCLE = new Set(["thread/start", "thread/resume", "thread/fork"]);

type JsonObject = Record<string, unknown>;
type ThreadState = { threadId: string };

export async function claimRegistration(target: string, record: { pid: number; [key: string]: unknown }): Promise<void> {
  // Serialize dead-owner reclamation; never overwrite a concurrent live launcher.
  // A crash during this short claim leaves a lock requiring manual inspection.
  const lock = `${target}.lock`;
  await mkdir(lock, { mode: 0o700 });
  try {
    try {
      const previous = JSON.parse(await readFile(target, "utf8"));
      if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0 || processExists(previous.pid)) {
        throw new Error("Thread already registered; owner is live or unknown");
      }
      await rm(`${target}.approval`, { force: true });
      await unlink(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFile(target, JSON.stringify(record), { flag: "wx", mode: 0o600 });
  } finally { await rm(lock, { recursive: true, force: true }); }
}

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null ? value as JsonObject : null;
}

export class LifecycleObserver {
  private readonly requests = new Map<string, number>();
  private sequence = 0;

  constructor(private readonly onThread: (state: ThreadState) => void, private readonly invalidate = () => {}) {}

  client(text: string): void {
    const message = this.parse(text);
    if (!message || !("id" in message) || typeof message.method !== "string") return;
    if (LIFECYCLE.has(message.method)) {
      this.invalidate();
      this.requests.clear();
      this.requests.set(JSON.stringify(message.id), ++this.sequence);
    }
  }

  server(text: string): void {
    const message = this.parse(text);
    if (!message) return;
    if (!("id" in message)) return;
    const key = JSON.stringify(message.id);
    const sequence = this.requests.get(key);
    this.requests.delete(key);
    if (sequence === undefined || sequence !== this.sequence || object(message.error)) return;
    const result = object(message.result);
    const thread = object(result?.thread);
    if (typeof thread?.id === "string" && THREAD_ID.test(thread.id)) {
      this.onThread({ threadId: thread.id });
    }
  }

  private parse(text: string): JsonObject | null {
    try { return object(JSON.parse(text)); } catch { return null; }
  }
}

export async function startRelay(
  relayPath: string,
  upstreamPath: string,
  observe: () => { observer: LifecycleObserver; approval?: ApprovalObserver; settled(): Promise<void>; close(): void },
): Promise<() => Promise<void>> {
  const server = http.createServer();
  const websockets = new WebSocketServer({ server, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false });
  let connected = false;
  websockets.on("connection", (client) => {
    if (connected) { client.close(1008, "One CLI connection per relay"); return; }
    connected = true;
    const observation = observe();
    const upstream = connectWebSocket(upstreamPath);
    client.pause();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      connected = false;
      observation.close();
      client.terminate();
      upstream.terminate();
    };
    upstream.once("open", () => client.resume());
    for (const socket of [client, upstream]) {
      socket.on("error", close);
      socket.on("close", close);
    }
    for (const [source, target, observeText] of [
      [client, upstream, (text: string) => observation.observer.client(text)],
      [upstream, client, (text: string) => observation.observer.server(text)],
    ] as const) {
      let forwarding = Promise.resolve();
      let queuedBytes = 0;
      source.on("message", (data, binary) => {
        if (binary) { close(); return; }
        const text = data.toString();
        queuedBytes += Buffer.byteLength(text);
        if (queuedBytes + target.bufferedAmount > 16 * 1024 * 1024) { close(); return; }
        forwarding = forwarding.then(async () => {
          if (closed) return;
          if (source === client) observation.approval?.client(text);
          else observation.approval?.server(text);
          observeText(text);
          await observation.settled();
          if (closed || target.readyState !== WebSocket.OPEN) { close(); return; }
          target.send(text, (error) => { if (error) close(); });
          queuedBytes -= Buffer.byteLength(text);
        }).catch(close);
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(relayPath, resolve);
  });
  return async () => {
    for (const socket of websockets.clients) socket.terminate();
    await new Promise<void>((resolve) => websockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "doctor") { await doctor(); return; }
  const binary = await brewCodex();
  if (args[0] === "server") { process.exitCode = await runServer(binary); return; }
  const paneId = process.env.HERDR_PANE_ID;
  const herdrSocket = process.env.HERDR_SOCKET_PATH;
  if (process.env.HERDR_ENV !== "1" || !paneId || !PANE_ID.test(paneId) || !herdrSocket || !path.isAbsolute(herdrSocket)) {
    throw new Error("codex-micro must run in a Herdr pane with exact HERDR_PANE_ID and HERDR_SOCKET_PATH");
  }
  if (process.argv.slice(2).some((arg) => arg === "--remote" || arg.startsWith("--remote="))) {
    throw new Error("codex-micro owns --remote; remove that argument");
  }
  await access(herdrSocket);
  const herdr = new HerdrClient(herdrSocket);
  const initial = object((await herdr.request("pane.get", { pane_id: paneId })).pane);
  const terminalId = initial?.terminal_id;
  if (typeof terminalId !== "string" || !terminalId) throw new Error("Herdr pane.get returned no stable terminal_id");
  const upstreamPath = (await runningServer(binary)).socketPath;
  const relayDirectory = await mkdtemp(path.join(os.tmpdir(), "zero-kb02-relay-"));
  const relayPath = path.join(relayDirectory, "app.sock");
  await mkdir(path.dirname(codexMicroStatePath("x")), { recursive: true, mode: 0o700 });
  let registration = Promise.resolve();
  let active: string | null = null;
  let registered: { threadId: string; pid: number; terminalId: string; epoch: string } | null = null;
  let cli: ChildProcess | undefined;
  const failClosed = (error: Error): never => {
    console.error(`[codex-micro] registration persistence failed; stopping launcher: ${error.message}`);
    cli?.kill("SIGTERM");
    // PID liveness is part of every input check. Never keep a stale approval valid.
    process.exit(1);
  };
  const remove = async () => {
    if (!active) return;
    const target = active;
    const removed = registered;
    try {
      const state = JSON.parse(await readFile(target, "utf8"));
      if (removed && state.pid === process.pid && state.epoch === removed.epoch) {
        await rm(approvalPath(removed.threadId), { force: true });
        await unlink(target);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    active = null;
    registered = null;
  };
  const invalidate = () => {
    registration = registration.then(remove).catch(failClosed);
  };
  const approval = new ApprovalObserver((pending) => {
    registration = registration.then(async () => {
      if (!registered) return;
      const target = approvalPath(registered.threadId);
      if (!pending || pending.threadId !== registered.threadId || binary.version !== APPROVAL_VERSION) {
        await rm(target, { force: true }); return;
      }
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify({ ...pending, ...registered, version: binary.version, keymap: "fixed-y-n-v1" }), { mode: 0o600 });
      await rename(temporary, target);
    }).catch(failClosed);
  });
  const closeRelay = await startRelay(relayPath, upstreamPath, () => ({
    approval,
    observer: new LifecycleObserver((state) => {
      registration = registration.then(async () => {
        await remove().catch(failClosed);
        const currentResult = await herdr.request("pane.get", { pane_id: paneId }).catch(() => ({}));
        const current = object((currentResult as JsonObject).pane);
        const matches = current?.terminal_id === terminalId ? [current] :
          (await herdr.agentList()).filter((agent) => agent.terminal_id === terminalId);
        if (matches.length !== 1 || typeof matches[0]!.pane_id !== "string") {
          throw new Error("Cannot uniquely resolve the launcher terminal in Herdr");
        }
        const target = codexMicroStatePath(state.threadId);
        const record = { threadId: state.threadId, socketPath: upstreamPath, pid: process.pid, terminalId, epoch: randomUUID() };
        await claimRegistration(target, record);
        registered = record;
        active = target;
        try {
          await herdr.request("pane.report_agent_session", {
            pane_id: matches[0]!.pane_id, source: "herdr:codex", agent: "codex", agent_session_id: state.threadId,
          });
        } catch (error) { await remove().catch(failClosed); throw error; }
      }).catch((error: Error) => console.error(`[codex-micro] Encoder disabled: ${error.message}`));
    }, () => { approval.reset(); invalidate(); }),
    settled: () => registration,
    close: () => { approval.reset(); invalidate(); },
  }));
  let code = 1;
  try {
    const codex = spawn(binary.binary, ["--remote", `unix://${relayPath}`, ...args, ...(binary.version === APPROVAL_VERSION ? APPROVAL_KEYMAP_ARGS : [])], { stdio: "inherit" });
    cli = codex;
    const stop = () => { codex.kill("SIGTERM"); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      code = await new Promise<number>((resolve, reject) => {
        codex.once("error", reject);
        codex.once("exit", (value) => resolve(value ?? 1));
      });
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  } finally {
    await closeRelay();
    await registration;
    await remove();
    await rm(relayDirectory, { recursive: true, force: true });
  }
  process.exitCode = code;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: Error) => {
    console.error(`[codex-micro] ${error.message}`);
    process.exitCode = 1;
  });
}
