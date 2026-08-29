#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codexMicroStatePath, defaultAppServerSocket } from "./reasoning.js";
import { connectSocket } from "./socket.js";

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PANE_ID = /^(?:[A-Za-z0-9]+:[A-Za-z0-9]+|[0-9]+-[0-9]+)$/;
const LIFECYCLE = new Set(["thread/start", "thread/resume", "thread/fork"]);

type JsonObject = Record<string, unknown>;
type ThreadState = { threadId: string; model: string; effort: string };

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null ? value as JsonObject : null;
}

export class LifecycleObserver {
  private readonly requests = new Map<string, number>();
  private sequence = 0;
  private activeSequence = 0;
  private activeThreadId: string | null = null;

  constructor(private readonly onThread: (state: ThreadState) => void) {}

  client(text: string): void {
    const message = this.parse(text);
    if (!message || !("id" in message) || typeof message.method !== "string") return;
    if (LIFECYCLE.has(message.method)) this.requests.set(JSON.stringify(message.id), ++this.sequence);
  }

  server(text: string): void {
    const message = this.parse(text);
    if (!message) return;
    if (message.method === "thread/settings/updated") {
      const params = object(message.params);
      const settings = object(params?.threadSettings);
      if (params?.threadId === this.activeThreadId) {
        this.emit(params.threadId, settings?.model, settings?.effort);
      }
      return;
    }
    if (!("id" in message)) return;
    const key = JSON.stringify(message.id);
    const sequence = this.requests.get(key);
    this.requests.delete(key);
    if (sequence === undefined || sequence < this.activeSequence || object(message.error)) return;
    const result = object(message.result);
    const thread = object(result?.thread);
    if (this.emit(thread?.id, result?.model, result?.reasoningEffort)) {
      this.activeSequence = sequence;
      this.activeThreadId = thread!.id as string;
    }
  }

  private emit(threadId: unknown, model: unknown, effort: unknown): boolean {
    if (typeof threadId === "string" && THREAD_ID.test(threadId) &&
        typeof model === "string" && model.length > 0 &&
        typeof effort === "string" && effort.length > 0) {
      this.onThread({ threadId, model, effort });
      return true;
    }
    return false;
  }

  private parse(text: string): JsonObject | null {
    try { return object(JSON.parse(text)); } catch { return null; }
  }
}

export class WebSocketTap {
  private buffer = Buffer.alloc(0);
  private upgraded = false;
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private disabled = false;

  constructor(
    private readonly masked: boolean,
    private readonly onText: (text: string) => void,
  ) {}

  push(chunk: Buffer): void {
    if (this.disabled) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.upgraded) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      this.buffer = this.buffer.subarray(end + 4);
      this.upgraded = true;
    }
    while (this.frame()) { /* parse complete frames */ }
  }

  private frame(): boolean {
    if (this.buffer.length < 2) return false;
    const first = this.buffer[0]!;
    const second = this.buffer[1]!;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (this.buffer.length < 4) return false;
      length = this.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (this.buffer.length < 10) return false;
      const wide = this.buffer.readBigUInt64BE(2);
      if (wide > 1_048_576n) return this.disable();
      length = Number(wide);
      offset = 10;
    }
    const isMasked = (second & 0x80) !== 0;
    if (isMasked !== this.masked || length > 1_048_576) return this.disable();
    const total = offset + (isMasked ? 4 : 0) + length;
    if (this.buffer.length < total) return false;
    let payload = this.buffer.subarray(offset + (isMasked ? 4 : 0), total);
    if (isMasked) {
      const mask = this.buffer.subarray(offset, offset + 4);
      payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]!));
    }
    this.buffer = this.buffer.subarray(total);
    const opcode = first & 0x0f;
    if (opcode === 0x1) {
      this.fragments = [payload];
      this.fragmentBytes = payload.length;
    } else if (opcode === 0x0 && this.fragments.length > 0) {
      this.fragments.push(payload);
      this.fragmentBytes += payload.length;
    }
    if (this.fragmentBytes > 1_048_576) return this.disable();
    if ((first & 0x80) !== 0 && (opcode === 0x1 || opcode === 0x0) && this.fragments.length > 0) {
      this.onText(Buffer.concat(this.fragments).toString("utf8"));
      this.fragments = [];
      this.fragmentBytes = 0;
    }
    return true;
  }

  private disable(): false {
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.disabled = true;
    return false;
  }
}

async function run(command: string, args: string[], env = process.env): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "ignore", "inherit"] });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

async function ensureAppServer(socketPath: string): Promise<void> {
  try {
    const socket = await connectSocket(socketPath);
    socket.destroy();
    return;
  } catch { /* start below */ }
  await run("codex", ["app-server", "daemon", "start"]);
  const socket = await connectSocket(socketPath);
  socket.destroy();
}

async function main(): Promise<void> {
  const paneId = process.env.HERDR_PANE_ID;
  const herdrSocket = process.env.HERDR_SOCKET_PATH;
  if (process.env.HERDR_ENV !== "1" || !paneId || !PANE_ID.test(paneId) || !herdrSocket || !path.isAbsolute(herdrSocket)) {
    throw new Error("codex-micro must run in a Herdr pane with exact HERDR_PANE_ID and HERDR_SOCKET_PATH");
  }
  if (process.argv.slice(2).some((arg) => arg === "--remote" || arg.startsWith("--remote="))) {
    throw new Error("codex-micro owns --remote; remove that argument");
  }
  await access(herdrSocket);

  const upstreamPath = defaultAppServerSocket();
  await ensureAppServer(upstreamPath);
  const relayDirectory = await mkdtemp(path.join(os.tmpdir(), "zero-kb02-relay-"));
  const relayPath = path.join(relayDirectory, "app.sock");
  const stateDirectory = path.dirname(codexMicroStatePath("x"));
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const owned = new Set<string>();
  let registration = Promise.resolve();

  const observer = new LifecycleObserver((state) => {
    registration = registration.then(async () => {
      const target = codexMicroStatePath(state.threadId);
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify({ ...state, paneId, pid: process.pid }), { mode: 0o600 });
      await rename(temporary, target);
      owned.add(target);
      await run("herdr", [
        "pane", "report-agent-session", paneId,
        "--source", "herdr:codex", "--agent", "codex",
        "--agent-session-id", state.threadId,
      ], { ...process.env, HERDR_SOCKET_PATH: herdrSocket });
    }).catch((error: Error) => console.error(`[codex-micro] registration: ${error.message}`));
  });

  const relay = net.createServer((client) => {
    const upstream = net.createConnection(upstreamPath);
    const clientTap = new WebSocketTap(true, (text) => observer.client(text));
    const serverTap = new WebSocketTap(false, (text) => observer.server(text));
    client.on("data", (chunk) => clientTap.push(chunk));
    upstream.on("data", (chunk) => serverTap.push(chunk));
    client.pipe(upstream).pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    relay.once("error", reject);
    relay.listen(relayPath, resolve);
  });
  let code = 1;
  try {
    const codex = spawn("codex", ["--remote", `unix://${relayPath}`, ...process.argv.slice(2)], { stdio: "inherit" });
    code = await new Promise<number>((resolve, reject) => {
      codex.once("error", reject);
      codex.once("exit", (value) => resolve(value ?? 1));
    });
    await registration;
  } finally {
    await new Promise<void>((resolve) => relay.close(() => resolve()));
    for (const target of owned) {
      try {
        const state = JSON.parse(await readFile(target, "utf8")) as { pid?: number };
        if (state.pid === process.pid) await unlink(target);
      } catch { /* already replaced or removed */ }
    }
    await rm(relayDirectory, { recursive: true });
  }
  process.exitCode = code;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: Error) => {
    console.error(`[codex-micro] ${error.message}`);
    process.exitCode = 1;
  });
}
