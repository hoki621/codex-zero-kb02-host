import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { DeviceMessage } from "./cdc.js";
import type { HerdrClient, RawAgent } from "./herdr.js";
import { AppServerSession } from "./app-server.js";
import type { UsbInputContext } from "./usb.js";

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type JsonObject = Record<string, unknown>;
type Direction = "CW" | "CCW";
type ReasoningClient = Pick<CodexAppServer, "changeEffort">;
type ReasoningHerdr = Pick<HerdrClient, "agentList" | "request">;

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

export function defaultAppServerSocket(): string {
  return path.join(os.tmpdir(), `zero-kb02-server-${process.getuid?.() ?? "user"}`, "app.sock");
}

export function codexMicroStatePath(threadId: string): string {
  return path.join(os.tmpdir(), `zero-kb02-codex-${process.getuid?.() ?? "user"}`, `${threadId}.json`);
}

type CodexMicroState = {
  threadId: string;
  socketPath: string;
  pid: number;
};

export function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class CodexAppServer {
  constructor(readonly socketPath = defaultAppServerSocket()) {}

  async changeEffort(
    threadId: string,
    direction: Direction,
    beforeUpdate: () => Promise<boolean>,
  ): Promise<boolean> {
    const session = await AppServerSession.connect(this.socketPath);
    try {
      const initialized = await session.request("initialize", {
        clientInfo: { name: "zero-kb02", title: "zero-kb02", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      if (
        initialized.platformOs !== "macos" ||
        typeof initialized.userAgent !== "string"
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
      const snapshot = await session.request("thread/read", { threadId, includeTurns: false });
      const thread = object(snapshot.thread);
      if (
        thread?.id !== threadId ||
        typeof thread.model !== "string" ||
        (thread.reasoningEffort !== null && typeof thread.reasoningEffort !== "string")
      ) {
        return false;
      }
      return (await this.update(session, threadId, thread.model, thread.reasoningEffort, direction, beforeUpdate)) !== null;
    } finally {
      session.close();
    }
  }

  private async update(
    session: AppServerSession,
    threadId: string,
    modelId: string,
    configuredEffort: string | null,
    direction: Direction,
    beforeUpdate: () => Promise<boolean>,
  ): Promise<string | null> {
    const models = await session.request("model/list", {
      limit: 100,
      includeHidden: true,
    });
    if (!Array.isArray(models.data) || models.nextCursor != null) return null;
    const matches = models.data
      .map(object)
      .filter((model): model is JsonObject =>
        model !== null &&
        (model.id === modelId || model.model === modelId),
      );
    if (matches.length !== 1) return null;
    const rawEfforts = matches[0]!.supportedReasoningEfforts;
    if (!Array.isArray(rawEfforts)) return null;
    const efforts = rawEfforts.map((entry) => object(entry)?.reasoningEffort);
    if (
      efforts.some((effort) => typeof effort !== "string" || effort.length === 0) ||
      new Set(efforts).size !== efforts.length
    ) return null;
    const currentEffort = configuredEffort ?? matches[0]!.defaultReasoningEffort;
    if (typeof currentEffort !== "string") return null;
    const current = efforts.indexOf(currentEffort);
    if (current === -1) return null;
    const nextIndex = Math.max(
      0,
      Math.min(efforts.length - 1, current + (direction === "CW" ? 1 : -1)),
    );
    const effort = efforts[nextIndex];
    if (effort === currentEffort) return currentEffort;
    const latest = object((await session.request("thread/read", { threadId, includeTurns: false })).thread);
    if (latest?.id !== threadId || latest.model !== modelId || latest.reasoningEffort !== configuredEffort) return null;
    if (typeof effort !== "string" || !(await beforeUpdate())) return null;
    const updated = await session.request("thread/settings/update", { threadId, effort });
    if (Object.keys(updated).length !== 0) {
      throw new Error("Codex App Server thread/settings/update returned an invalid result");
    }
    // The update response acknowledges enqueueing; metadata changes asynchronously.
    // Wait for confirmation before accepting the next encoder step.
    for (let attempt = 0; attempt < 20; attempt++) {
      const applied = object((await session.request("thread/read", { threadId, includeTurns: false })).thread);
      if (applied?.id !== threadId || applied.model !== modelId) return null;
      if (applied.reasoningEffort === effort) return effort;
      if (applied.reasoningEffort !== configuredEffort) return null;
      await delay(50);
    }
    throw new Error("Codex did not confirm the reasoning setting; encoder queue cancelled");
  }
}

export class CodexReasoningClient {
  constructor(private readonly appServer = new CodexAppServer()) {}

  async changeEffort(
    threadId: string,
    direction: Direction,
    beforeUpdate: () => Promise<boolean>,
  ): Promise<boolean> {
    if (!THREAD_ID.test(threadId)) return false;
    const target = codexMicroStatePath(threadId);
    let original: string;
    try { original = await readFile(target, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    const state = object(JSON.parse(original)) as Partial<CodexMicroState> | null;
    if (!state || state.threadId !== threadId || state.socketPath !== this.appServer.socketPath ||
        typeof state.pid !== "number" || !processExists(state.pid)) return false;
    return this.appServer.changeEffort(threadId, direction, async () => {
      try {
        if (await readFile(target, "utf8") !== original || !processExists(state.pid!)) return false;
      } catch { return false; }
      return beforeUpdate();
    });
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
  private queue = Promise.resolve();
  private pending = 0;
  private queueEpoch = 0;

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
    if (message.action !== "CW" && message.action !== "CCW") return false;

    // ponytail: bounded global queue; one physical encoder has one input stream.
    if (this.pending >= 32) throw new Error("Encoder queue full; rotation discarded");
    this.pending++;
    const epoch = this.queueEpoch;
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    try {
      const paneId = currentPaneId(await this.herdr.request("pane.current", {}));
      if (!paneId) return false;
      const threadId = managedThreadId(await this.herdr.agentList(), paneId);
      if (!threadId) return false;
      await previous;
      if (epoch !== this.queueEpoch || !context.isCurrent()) return false;
      return await this.codex.changeEffort(threadId, message.action, async () => {
        const finalPaneId = currentPaneId(await this.herdr.request("pane.current", {}));
        if (finalPaneId !== paneId) return false;
        const finalThreadId = managedThreadId(await this.herdr.agentList(), paneId);
        return finalThreadId === threadId && context.isCurrent();
      });
    } catch (error) {
      this.queueEpoch++;
      throw error;
    } finally {
      await previous;
      this.pending--;
      release();
    }
  }
}
