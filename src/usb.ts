import { randomBytes } from "node:crypto";
import path from "node:path";
import { SerialPort } from "serialport";
import { HELLO_DEVICE, HELLO_HOST, LineDecoder, parseDeviceMessage, stateLine, type DeviceMessage } from "./cdc.js";
import type { HerdrState } from "./state.js";

export const DEFAULT_STATE_INTERVAL_MS = 5_000;
export const DEFAULT_PONG_TIMEOUT_MS = 12_000;
export interface SerialConnection {
  readonly isOpen: boolean;
  on(event: "open" | "close", listener: () => void): this;
  on(event: "data", listener: (data: Buffer) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
  write(data: string, callback: (error: Error | null | undefined) => void): boolean;
  close(callback?: (error: Error | null | undefined) => void): void;
}
export interface SerialApi {
  list(): Promise<{ path: string }[]>;
  open(path: string): SerialConnection;
}
export const serialApi: SerialApi = {
  list: () => SerialPort.list(),
  open: (path) => new SerialPort({ path, baudRate: 115_200, lock: true }) as SerialConnection,
};
export class DeviceNotFoundError extends Error {}

export function explicitPort(value: string | undefined): string {
  if (!value || !path.isAbsolute(value) || /[*?\[\]\r\n\0]/.test(value)) {
    throw new Error("An exact absolute port path is required; automatic serial probing is disabled");
  }
  return value;
}
export function writeSerial(port: SerialConnection, line: string, timeoutMs = 1_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Serial write timed out")), timeoutMs);
    try {
      port.write(line, (error) => { clearTimeout(timer); error ? reject(error) : resolve(); });
    } catch (error) { clearTimeout(timer); reject(error); }
  });
}
export function closeSerial(port: SerialConnection): Promise<void> {
  if (!port.isOpen) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 1_000);
    port.close(() => { clearTimeout(timer); resolve(); });
  });
}
export async function openSerial(api: SerialApi, portPath: string, timeoutMs = 1_000): Promise<SerialConnection> {
  const port = api.open(explicitPort(portPath));
  port.on("error", () => {}); // Late OS errors remain consumed after an open timeout.
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Serial open timed out")), timeoutMs);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      port.off("open", ready);
      port.off("error", failed);
      if (error) {
        // An OS open may complete after the timeout; close that late handle too.
        port.on("open", () => void closeSerial(port));
        void closeSerial(port);
        reject(error);
      } else resolve();
    };
    const ready = () => finish();
    const failed = (error: Error) => finish(error);
    port.on("error", failed);
    port.on("open", ready);
    if (port.isOpen) finish();
  });
  return port;
}
export async function handshake(port: SerialConnection, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new DeviceNotFoundError("USB major 2 handshake timed out")), timeoutMs);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      port.off("data", data);
      port.off("error", failed);
      port.off("close", closed);
      error ? reject(error) : resolve();
    };
    const decoder = new LineDecoder((line) => finish(line === HELLO_DEVICE ? undefined : new DeviceNotFoundError(`Incompatible device response: ${line}`)));
    const data = (chunk: Buffer) => decoder.push(chunk);
    const failed = (error: Error) => finish(error);
    const closed = () => finish(new Error("Serial disconnected during handshake"));
    port.on("data", data);
    port.on("error", failed);
    port.on("close", closed);
    void writeSerial(port, `${HELLO_HOST}\n`).catch(failed);
  });
}
export interface UsbCdcOptions {
  onMessage: (message: DeviceMessage, context: UsbInputContext) => void;
  onError?: (error: Error) => void;
  api?: SerialApi;
  portPath?: string;
  helloTimeoutMs?: number;
  retryMs?: number;
  stateIntervalMs?: number;
  pongTimeoutMs?: number;
  generation?: () => bigint;
}
export interface UsbInputContext {
  generation: bigint;
  state: HerdrState | null;
  isCurrent(): boolean;
  retransmit(): void;
}
export class UsbCdc {
  private port: SerialConnection | null = null;
  private state: HerdrState | null = null;
  private mapping = "";
  private revision = 0;
  private currentGeneration = 1n;
  private pingSequence = 0;
  private pendingPing: number | null = null;
  private pendingSince = 0;
  private timer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private lifecycle = 0;
  private held = new Set<string>();
  private pendingWrites = 0;
  constructor(private readonly options: UsbCdcOptions) {}
  private nextGeneration(): void {
    const value = this.options.generation?.() ?? (randomBytes(8).readBigUInt64BE() || 1n);
    this.currentGeneration = value === this.currentGeneration ? value % 0xffff_ffff_ffff_ffffn + 1n : value;
    this.held.clear();
  }
  async start(): Promise<void> {
    if (!this.stopped) return;
    explicitPort(this.options.portPath);
    this.stopped = false;
    const lifecycle = ++this.lifecycle;
    await this.connect(lifecycle).catch((error: Error) => this.disconnected(error, lifecycle));
  }
  stop(): void {
    this.stopped = true;
    this.lifecycle++;
    if (this.timer) clearInterval(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.timer = this.retryTimer = null;
    this.pendingPing = null;
    this.held.clear();
    const port = this.port;
    this.port = null;
    if (port) void closeSerial(port);
  }
  updateState(state: HerdrState): void {
    const mapping = `${state.online}:` + state.slots.map((slot) => slot?.terminalId ?? "").join("\n");
    if (this.mapping && this.mapping !== mapping) this.nextGeneration();
    this.mapping = mapping;
    if (JSON.stringify(this.state) !== JSON.stringify(state)) this.revision++;
    this.state = state;
    this.sendState();
  }
  private async connect(lifecycle: number): Promise<void> {
    const port = await openSerial(this.options.api ?? serialApi, this.options.portPath!, this.options.helloTimeoutMs);
    // Keep error handling installed even between asynchronous handshake steps.
    const fail = (error: Error) => { if (this.port === port) this.disconnected(error, lifecycle); };
    port.on("error", fail);
    try {
      await handshake(port, this.options.helloTimeoutMs ?? 1_000);
      if (this.stopped || lifecycle !== this.lifecycle) { await closeSerial(port); return; }
      this.port = port;
      this.nextGeneration();
      this.pendingPing = null;
      this.lastState = 0;
      this.pendingWrites = 0;
      const decoder = new LineDecoder((line) => {
        if (this.port !== port || lifecycle !== this.lifecycle) return;
        if (line === HELLO_DEVICE) { this.disconnected(new Error("Device reset; re-handshake required"), lifecycle); return; }
        const message = parseDeviceMessage(line);
        if (!message) return;
        if (message.type === "pong") {
          if (message.sequence === this.pendingPing) this.pendingPing = null;
          return;
        }
        if (!this.state?.online || message.generation !== this.currentGeneration) { this.sendState(); return; }
        if (message.type !== "encoder") {
          const key = message.type === "key" ? `key-${message.slot}` : message.type;
          if (message.action === "UP") this.held.delete(key);
          else { if (this.held.has(key)) return; this.held.add(key); }
        }
        const generation = this.currentGeneration;
        const revision = this.revision;
        this.options.onMessage(message, {
          generation, state: this.state,
          isCurrent: () => this.port === port && lifecycle === this.lifecycle && this.currentGeneration === generation && this.revision === revision,
          retransmit: () => this.sendState(),
        });
      });
      port.on("data", (data) => decoder.push(data));
      port.on("close", () => { if (this.port === port) this.disconnected(new Error("USB disconnected"), lifecycle); });
      this.sendState();
      this.heartbeat();
      this.timer = setInterval(() => this.heartbeat(), Math.min(this.options.stateIntervalMs ?? DEFAULT_STATE_INTERVAL_MS, 250));
    } catch (error) { await closeSerial(port); throw error; }
  }
  private lastState = 0;
  private heartbeat(): void {
    if (!this.port) return;
    const now = Date.now();
    if (this.pendingPing !== null && now - this.pendingSince >= (this.options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS)) {
      this.disconnected(new Error("USB heartbeat timed out"), this.lifecycle); return;
    }
    if (now - this.lastState < (this.options.stateIntervalMs ?? DEFAULT_STATE_INTERVAL_MS)) return;
    this.lastState = now;
    this.sendState();
    if (this.pendingPing === null) {
      this.pingSequence = (this.pingSequence + 1) >>> 0;
      this.pendingPing = this.pingSequence;
      this.pendingSince = now;
    }
    this.send(`PING ${this.pendingPing}`);
  }
  private send(line: string): void {
    const port = this.port;
    if (!port) return;
    const lifecycle = this.lifecycle;
    if (this.pendingWrites >= 32) { this.disconnected(new Error("USB write queue full"), lifecycle); return; }
    this.pendingWrites++;
    void writeSerial(port, `${line}\n`)
      .catch((error: Error) => { if (this.port === port) this.disconnected(error, lifecycle); })
      .finally(() => { if (this.port === port) this.pendingWrites--; });
  }
  private sendState(): void {
    if (this.state) this.send(stateLine(this.state, this.currentGeneration));
  }
  private disconnected(error: Error, lifecycle: number): void {
    if (this.stopped || lifecycle !== this.lifecycle || this.retryTimer) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const port = this.port;
    this.port = null;
    this.pendingPing = null;
    this.held.clear();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect(lifecycle).catch((nextError: Error) => this.disconnected(nextError, lifecycle));
    }, this.options.retryMs ?? 1_000);
    if (port) void closeSerial(port);
    this.options.onError?.(error);
  }
}
