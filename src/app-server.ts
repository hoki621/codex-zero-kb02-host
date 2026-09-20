import WebSocket from "ws";
import { REQUEST_TIMEOUT_MS } from "./socket.js";

export function connectWebSocket(socketPath: string): WebSocket {
  return new WebSocket(`ws+unix://${socketPath}:/`, {
    handshakeTimeout: REQUEST_TIMEOUT_MS,
    maxPayload: 16 * 1024 * 1024,
    perMessageDeflate: false,
  });
}

// Only outstanding requests are retained; notifications never accumulate.
export class AppServerSession {
  private nextId = 1;
  private failure: Error | null = null;
  private pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data, binary) => {
      try {
        if (binary) throw new Error("Codex returned a binary RPC message");
        const message = JSON.parse(data.toString());
        if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Invalid Codex RPC message");
        const request = this.pending.get(message.id);
        if (!request) return;
        if (message.error) request.reject(new Error(`Codex RPC: ${JSON.stringify(message.error)}`));
        else if (!message.result || typeof message.result !== "object" || Array.isArray(message.result)) {
          request.reject(new Error("Codex RPC returned no object result"));
        } else request.resolve(message.result);
      } catch (error) {
        this.fail(error as Error);
      }
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("Codex App Server disconnected")));
  }

  static async connect(socketPath: string): Promise<AppServerSession> {
    const socket = connectWebSocket(socketPath);
    const session = new AppServerSession(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("Codex App Server disconnected during connection")));
    });
    return session;
  }

  notify(method: string): void {
    this.socket.send(JSON.stringify({ method }));
  }

  async request(method: string, params: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Record<string, unknown>> {
    if (this.failure) throw this.failure;
    const id = this.nextId++;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        timer = setTimeout(() => {
          this.fail(new Error(`Codex ${method} timed out`));
        }, timeoutMs);
        this.socket.send(JSON.stringify({ id, method, params }), (error) => {
          if (error) this.fail(error);
        });
      });
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
    }
  }

  close(): void {
    this.fail(new Error("Codex App Server connection closed"));
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.socket.terminate();
  }
}
