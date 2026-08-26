import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { HerdrState } from "./state.js";

export const PLUGIN_ID = "hoki621.zero-kb02";
export const PLUGIN_ENTRYPOINT = "status";
export const PLUGIN_STATE_DIR = path.join(
  os.homedir(),
  ".local",
  "state",
  "herdr",
  "plugins",
  PLUGIN_ID,
);
export const STATUS_SOCKET_PATH = path.join(PLUGIN_STATE_DIR, "status.sock");
export const OWNERSHIP_PATH = path.join(PLUGIN_STATE_DIR, "owned-pane.json");

export interface StatusPayload extends HerdrState {
  version: 1;
}

function socketIdentity(socketPath: string): string | null {
  const stat = fs.statSync(socketPath, { throwIfNoEntry: false });
  return stat ? `${stat.dev}:${stat.ino}` : null;
}

export class StatusPublisher {
  private server: net.Server | null = null;
  private clients = new Set<net.Socket>();
  private identity: string | null = null;
  private latest: StatusPayload = {
    version: 1,
    online: false,
    slots: Array.from({ length: 6 }, () => null),
  };

  constructor(readonly socketPath = STATUS_SOCKET_PATH) {}

  update(state: HerdrState): void {
    this.latest = { version: 1, online: state.online, slots: state.slots };
    const line = JSON.stringify(this.latest) + "\n";
    for (const client of this.clients) client.write(line);
  }

  async start(): Promise<void> {
    if (this.server) return;
    const directory = path.dirname(this.socketPath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);

    const server = net.createServer((socket) => this.accept(socket));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.socketPath);
      });
      fs.chmodSync(this.socketPath, 0o600);
      this.identity = socketIdentity(this.socketPath);
    } catch (error) {
      this.server = null;
      server.close();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const client of this.clients) client.destroy();
    this.clients.clear();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (
      this.identity !== null &&
      socketIdentity(this.socketPath) === this.identity
    ) {
      fs.rmSync(this.socketPath, { force: true });
    }
    this.identity = null;
  }

  private accept(socket: net.Socket): void {
    socket.setEncoding("utf8");
    let buffer = "";
    let watching = false;
    const drop = () => {
      this.clients.delete(socket);
      socket.destroy();
    };
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 1_024) {
        drop();
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (watching || line !== '{"cmd":"watch"}') {
          drop();
          return;
        }
        watching = true;
        this.clients.add(socket);
        socket.write(JSON.stringify(this.latest) + "\n");
      }
    });
    socket.on("close", () => this.clients.delete(socket));
    socket.on("error", () => this.clients.delete(socket));
  }
}
