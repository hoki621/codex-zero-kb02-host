import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { DeviceMessage } from "./cdc.js";
import type { HerdrClient, RawAgent } from "./herdr.js";
import { connectSocket, REQUEST_TIMEOUT_MS } from "./socket.js";
import type { UsbInputContext } from "./usb.js";

const CODEX_USER_AGENT = /(?:^|\/)0\.149\.1(?:\s|$)/;
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type JsonObject = Record<string, unknown>;
type Direction = "CW" | "CCW";
type ReasoningClient = Pick<CodexAppServer, "changeEffort">;
type ReasoningHerdr = Pick<HerdrClient, "agentList" | "request">;

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null
    ? value as JsonObject
    : null;
}

class AppServerSession {
  private nextId = 1;

  constructor(private readonly socket: WebSocketSession) {}

  notify(method: string): void {
    this.socket.send(JSON.stringify({ method }));
  }

  async request(method: string, params: JsonObject): Promise<JsonObject> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ method, id, params }));
    for (let skipped = 0; skipped < 64; skipped++) {
      const line = await this.nextLine();
      let message: JsonObject;
      try {
        const parsed = object(JSON.parse(line));
        if (!parsed) throw new Error();
        message = parsed;
      } catch {
        throw new Error("Codex App Server returned invalid JSON");
      }
      if (message.id !== id) continue;
      if (object(message.error)) {
        const error = message.error as JsonObject;
        throw new Error(
          `Codex App Server ${String(error.code ?? "error")}: ${String(error.message ?? method)}`,
        );
      }
      const result = object(message.result);
      if (!result) throw new Error(`Codex App Server ${method} returned no result`);
      return result;
    }
    throw new Error(`Codex App Server ${method} returned too many unrelated messages`);
  }

  close(): void {
    this.socket.close();
  }

  private async nextLine(): Promise<string> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.socket.receive(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Codex App Server request timed out")),
            REQUEST_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

class WebSocketSession {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private messages: string[] = [];
  private waiter: ((value: string) => void) | null = null;
  private failure: Error | null = null;

  private constructor(private readonly socket: import("node:net").Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.parse();
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("Codex App Server closed before responding")));
  }

  static async connect(socketPath: string): Promise<WebSocketSession> {
    const socket = await connectSocket(socketPath);
    const key = randomBytes(16).toString("base64");
    socket.write([
      "GET / HTTP/1.1",
      "Host: localhost",
      "Connection: Upgrade",
      "Upgrade: websocket",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      "\r\n",
    ].join("\r\n"));
    const response = await readUpgrade(socket);
    const accept = createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
    if (
      !/^HTTP\/1\.1 101\b/.test(response.head) ||
      !response.head.toLowerCase().includes("upgrade: websocket") ||
      !response.head.toLowerCase().includes(`sec-websocket-accept: ${accept.toLowerCase()}`)
    ) {
      socket.destroy();
      throw new Error("Codex App Server rejected WebSocket upgrade");
    }
    const session = new WebSocketSession(socket);
    session.buffer = response.rest;
    session.parse();
    return session;
  }

  send(text: string): void {
    this.sendFrame(0x1, Buffer.from(text));
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    const mask = randomBytes(4);
    const header = payload.length < 126
      ? Buffer.from([0x80 | opcode, 0x80 | payload.length])
      : Buffer.from([0x80 | opcode, 0xfe, payload.length >> 8, payload.length & 0xff]);
    const masked = Buffer.alloc(payload.length);
    for (let index = 0; index < payload.length; index++) {
      masked[index] = payload[index]! ^ mask[index % 4]!;
    }
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  receive(): Promise<string> {
    const message = this.messages.shift();
    if (message !== undefined) return Promise.resolve(message);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  close(): void {
    this.socket.destroy();
  }

  private parse(): void {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0]!;
      const second = this.buffer[1]!;
      let length = second & 0x7f;
      let offset = 2;
      if ((first & 0x80) === 0 || (second & 0x80) !== 0) {
        return this.fail(new Error("Codex App Server returned an invalid WebSocket frame"));
      }
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const wideLength = this.buffer.readBigUInt64BE(2);
        if (wideLength > 1_048_576n) {
          return this.fail(new Error("Codex App Server frame is too large"));
        }
        length = Number(wideLength);
        offset = 10;
      }
      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      const opcode = first & 0x0f;
      if (opcode === 0x8) return this.fail(new Error("Codex App Server closed before responding"));
      if (opcode === 0x9) {
        this.sendFrame(0xa, payload);
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode !== 0x1) return this.fail(new Error("Codex App Server returned a non-text frame"));
      this.push(payload.toString("utf8"));
    }
  }

  private push(message: string): void {
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) waiter(message);
    else this.messages.push(message);
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.socket.destroy();
  }
}

function readUpgrade(socket: import("node:net").Socket): Promise<{ head: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => finish(() => reject(new Error("Codex App Server upgrade timed out"))), REQUEST_TIMEOUT_MS);
    const finish = (done: () => void) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      done();
    };
    const onError = (error: Error) => finish(() => reject(error));
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end !== -1) finish(() => resolve({
        head: buffer.subarray(0, end).toString("ascii"),
        rest: buffer.subarray(end + 4),
      }));
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

export function defaultAppServerSocket(): string {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "app-server-control", "app-server-control.sock");
}

export class CodexAppServer {
  constructor(readonly socketPath = defaultAppServerSocket()) {}

  async changeEffort(
    threadId: string,
    direction: Direction,
    beforeUpdate: () => Promise<boolean>,
  ): Promise<boolean> {
    const session = new AppServerSession(await WebSocketSession.connect(this.socketPath));
    try {
      const initialized = await session.request("initialize", {
        clientInfo: { name: "zero-kb02", title: "zero-kb02", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      if (
        initialized.platformOs !== "macos" ||
        typeof initialized.userAgent !== "string" ||
        !CODEX_USER_AGENT.test(initialized.userAgent)
      ) {
        return false;
      }
      session.notify("initialized");

      const loaded = await session.request("thread/loaded/list", {});
      if (
        !Array.isArray(loaded.data) ||
        loaded.data.filter((id) => id === threadId).length !== 1 ||
        loaded.nextCursor != null
      ) {
        return false;
      }
      const resumed = await session.request("thread/resume", {
        threadId,
        excludeTurns: true,
      });
      const thread = object(resumed.thread);
      if (
        thread?.id !== threadId ||
        typeof resumed.model !== "string" ||
        typeof resumed.reasoningEffort !== "string"
      ) {
        return false;
      }
      const models = await session.request("model/list", {
        limit: 100,
        includeHidden: true,
      });
      if (!Array.isArray(models.data) || models.nextCursor != null) return false;
      const matches = models.data
        .map(object)
        .filter((model): model is JsonObject =>
          model !== null &&
          (model.id === resumed.model || model.model === resumed.model),
        );
      if (matches.length !== 1) return false;
      const rawEfforts = matches[0]!.supportedReasoningEfforts;
      if (!Array.isArray(rawEfforts)) return false;
      const efforts = rawEfforts.map((entry) => object(entry)?.reasoningEffort);
      if (
        efforts.some((effort) => typeof effort !== "string" || effort.length === 0) ||
        new Set(efforts).size !== efforts.length
      ) {
        return false;
      }
      const current = efforts.indexOf(resumed.reasoningEffort);
      if (current === -1) return false;
      const nextIndex = Math.max(
        0,
        Math.min(efforts.length - 1, current + (direction === "CW" ? 1 : -1)),
      );
      const effort = efforts[nextIndex];
      if (effort === resumed.reasoningEffort) return true;
      if (typeof effort !== "string" || !(await beforeUpdate())) return false;
      const updated = await session.request("thread/settings/update", {
        threadId,
        effort,
      });
      if (Object.keys(updated).length !== 0) {
        throw new Error("Codex App Server thread/settings/update returned an invalid result");
      }
      return true;
    } finally {
      session.close();
    }
  }
}

function currentPaneId(result: JsonObject): string | null {
  const pane = object(result.pane);
  return result.type === "pane_current" && typeof pane?.pane_id === "string"
    ? pane.pane_id
    : null;
}

function managedThreadId(agents: readonly RawAgent[], paneId: string): string | null {
  const matches = agents.filter((agent) => agent.agent === "codex" && agent.pane_id === paneId);
  if (matches.length !== 1) return null;
  const session = object(matches[0]!.agent_session);
  const threadId = session?.value;
  if (
    session?.source !== "herdr:codex" ||
    session?.agent !== "codex" ||
    session.kind !== "id" ||
    typeof threadId !== "string" ||
    !THREAD_ID.test(threadId)
  ) {
    return null;
  }
  const identities = agents.filter((agent) => {
    const candidate = object(agent.agent_session);
    return agent.agent === "codex" && candidate?.kind === "id" && candidate.value === threadId;
  });
  return identities.length === 1 ? threadId : null;
}

export class ReasoningController {
  private busy = false;

  constructor(
    private readonly herdr: ReasoningHerdr,
    private readonly codex: ReasoningClient,
  ) {}

  async handle(message: DeviceMessage, context: UsbInputContext): Promise<boolean> {
    if (message.type !== "encoder") return false;
    if (message.generation !== context.generation || !context.state?.online) {
      context.retransmit();
      return false;
    }
    if ((message.action !== "CW" && message.action !== "CCW") || this.busy) return false;

    this.busy = true;
    try {
      const paneId = currentPaneId(await this.herdr.request("pane.current", {}));
      if (!paneId) return false;
      const threadId = managedThreadId(await this.herdr.agentList(), paneId);
      if (!threadId) return false;
      return await this.codex.changeEffort(threadId, message.action, async () => {
        const finalPaneId = currentPaneId(await this.herdr.request("pane.current", {}));
        if (finalPaneId !== paneId) return false;
        const finalThreadId = managedThreadId(await this.herdr.agentList(), paneId);
        return finalThreadId === threadId && context.isCurrent();
      });
    } finally {
      this.busy = false;
    }
  }
}
