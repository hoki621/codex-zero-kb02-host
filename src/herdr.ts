// Adapted from House of Herdr Codex Micro at 50b24e3 (Herdr client, MIT).
// See THIRD_PARTY_NOTICES.md for the pinned source and complete license.
import {
  connectSocket,
  readLines,
  requestLine,
  REQUEST_TIMEOUT_MS,
} from "./socket.js";

export interface RawAgent {
  agent?: unknown;
  agent_session?: unknown;
  terminal_id?: unknown;
  pane_id?: unknown;
  workspace_id?: unknown;
  tab_id?: unknown;
  agent_status?: unknown;
  state_change_seq?: unknown;
}

export type Subscription = { type: string; pane_id?: string };
export interface HerdrEvent {
  event: string;
  data: Record<string, unknown>;
}

interface ResponseEnvelope {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

export class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "HerdrError";
  }
}

function parseLine(line: string): ResponseEnvelope {
  const value = JSON.parse(line) as unknown;
  if (typeof value !== "object" || value === null) {
    throw new Error("Herdr response is not an object");
  }
  return value as ResponseEnvelope;
}

export class HerdrClient {
  private nextId = 1;

  constructor(readonly socketPath: string) {}

  async request(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const id = `zkb:${this.nextId++}`;
    const socket = await connectSocket(this.socketPath);
    const line = await requestLine(
      socket,
      JSON.stringify({ id, method, params }),
    );
    const response = parseLine(line);
    if (response.id !== id) throw new Error("Herdr response id mismatch");
    if (response.error) {
      throw new HerdrError(
        typeof response.error.code === "string" ? response.error.code : "error",
        typeof response.error.message === "string"
          ? response.error.message
          : method,
      );
    }
    if (typeof response.result !== "object" || response.result === null) {
      throw new Error(`Herdr ${method} returned no result`);
    }
    return response.result as Record<string, unknown>;
  }

  async checkProtocol(): Promise<void> {
    const result = await this.request("ping");
    const actual = result.protocol;
    if (result.type !== "pong" || !Number.isSafeInteger(actual) || (actual as number) < 0) {
      throw new Error("Herdr ping returned an invalid result");
    }
    // ping.protocol describes Herdr internals, not JSON API compatibility.
    // Validate the required response shape at each API boundary instead.
  }

  async agentList(): Promise<RawAgent[]> {
    const result = await this.request("agent.list");
    if (result.type !== "agent_list" || !Array.isArray(result.agents)) {
      throw new Error("Herdr agent.list returned an invalid result");
    }
    if (result.agents.some((agent) => typeof agent !== "object" || agent === null || Array.isArray(agent))) {
      throw new Error("Herdr agent.list returned an invalid agent");
    }
    return result.agents as RawAgent[];
  }

  async subscribe(
    subscriptions: readonly Subscription[],
    onEvent: (event: HerdrEvent) => void,
    onClose: () => void,
  ): Promise<() => void> {
    const id = `zkb:${this.nextId++}`;
    const socket = await connectSocket(this.socketPath);
    return new Promise((resolve, reject) => {
      let acknowledged = false;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new Error("Herdr subscription acknowledgement timed out")),
        REQUEST_TIMEOUT_MS,
      );
      readLines(socket, (line) => {
        let message: ResponseEnvelope & { event?: unknown; data?: unknown };
        try {
          message = parseLine(line);
        } catch {
          return;
        }
        if (!acknowledged && message.id === id) {
          if (message.error) {
            fail(
              new HerdrError(
                typeof message.error.code === "string"
                  ? message.error.code
                  : "error",
                typeof message.error.message === "string"
                  ? message.error.message
                  : "events.subscribe",
              ),
            );
            return;
          }
          if (
            typeof message.result !== "object" ||
            message.result === null ||
            (message.result as Record<string, unknown>).type !==
              "subscription_started"
          ) {
            fail(new Error("Herdr returned an invalid subscription acknowledgement"));
            return;
          }
          acknowledged = true;
          settled = true;
          clearTimeout(timer);
          resolve(() => socket.destroy());
          return;
        }
        if (
          typeof message.event === "string" &&
          typeof message.data === "object" &&
          message.data !== null
        ) {
          onEvent({
            event: message.event,
            data: message.data as Record<string, unknown>,
          });
        }
      });
      socket.on("close", () => {
        if (acknowledged) onClose();
        else fail(new Error("Herdr closed before subscription acknowledgement"));
      });
      socket.on("error", (error) => fail(error));
      socket.write(
        JSON.stringify({
          id,
          method: "events.subscribe",
          params: { subscriptions },
        }) + "\n",
      );
    });
  }
}
