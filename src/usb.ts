import { randomBytes } from "node:crypto";
import { SerialPort } from "serialport";
import { LineDecoder, parseDeviceMessage, stateLine, type DeviceMessage } from "./cdc.js";
import type { HerdrState } from "./state.js";

const HELLO_HOST = "HELLO HOST 1\n";
const HELLO_DEVICE = "HELLO ZERO-KB02 1";
const USB_MODEM = /^\/dev\/cu\.usbmodem/;

export const DEFAULT_STATE_INTERVAL_MS = 5_000;
export const DEFAULT_PONG_TIMEOUT_MS = 12_000;

export interface SerialConnection {
  readonly isOpen: boolean;
  on(event: "open" | "close", listener: () => void): this;
  on(event: "data", listener: (data: Buffer) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  write(data: string, callback: (error: Error | null | undefined) => void): boolean;
  close(callback?: (error: Error | null | undefined) => void): void;
}

export interface SerialApi {
  list(): Promise<{ path: string }[]>;
  open(path: string): SerialConnection;
}

const serialApi: SerialApi = {
  list: () => SerialPort.list(),
  open: (path) => new SerialPort({ path, baudRate: 115_200 }) as SerialConnection,
};

export class DeviceNotFoundError extends Error {}
export class AmbiguousDeviceError extends Error {}

function write(port: SerialConnection, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    port.write(line, (error) => error ? reject(error) : resolve());
  });
}

function close(port: SerialConnection): Promise<void> {
  if (!port.isOpen) return Promise.resolve();
  return new Promise((resolve) => port.close(() => resolve()));
}

async function open(port: SerialConnection): Promise<void> {
  if (port.isOpen) return;
  await new Promise<void>((resolve, reject) => {
    port.on("open", resolve);
    port.on("error", reject);
  });
}

async function verifiedPort(api: SerialApi, path: string, timeoutMs: number): Promise<SerialConnection | null> {
  const port = api.open(path);
  let verified = false;
  try {
    await open(port);
    const response = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      const decoder = new LineDecoder((line) => {
        clearTimeout(timer);
        resolve(line === HELLO_DEVICE);
      });
      port.on("data", (data) => decoder.push(data));
      port.on("close", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    await write(port, HELLO_HOST);
    verified = await response;
    return verified ? port : null;
  } catch {
    return null;
  } finally {
    if (!verified) await close(port);
  }
}

export async function selectDevice(
  api: SerialApi = serialApi,
  explicitPath = process.env.ZERO_KB02_PORT,
  timeoutMs = 1_000,
): Promise<string> {
  const candidates = explicitPath
    ? [explicitPath]
    : (await api.list()).map(({ path }) => path).filter((path) => USB_MODEM.test(path));
  const verified: string[] = [];
  for (const path of candidates) {
    const port = await verifiedPort(api, path, timeoutMs);
    if (port) {
      verified.push(path);
      await close(port);
    }
  }
  if (verified.length === 0) throw new DeviceNotFoundError("ZERO-KB02 USB CDC device not found");
  if (verified.length > 1) throw new AmbiguousDeviceError("Multiple ZERO-KB02 USB CDC devices found; set ZERO_KB02_PORT");
  return verified[0]!;
}

function newGeneration(): bigint {
  return randomBytes(8).readBigUInt64BE() || 1n;
}

export interface UsbCdcOptions {
  onMessage: (message: DeviceMessage) => void;
  onError?: (error: Error) => void;
  api?: SerialApi;
  portPath?: string;
  helloTimeoutMs?: number;
  retryMs?: number;
  stateIntervalMs?: number;
  pongTimeoutMs?: number;
  generation?: () => bigint;
}

export class UsbCdc {
  private readonly api: SerialApi;
  private readonly helloTimeoutMs: number;
  private readonly retryMs: number;
  private readonly stateIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly nextGeneration: () => bigint;
  private port: SerialConnection | null = null;
  private state: HerdrState | null = null;
  private mapping: string | null = null;
  private currentGeneration = 1n;
  private pingSequence = 0;
  private pendingPing: number | null = null;
  private pendingSince = 0;
  private timer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(private readonly options: UsbCdcOptions) {
    this.api = options.api ?? serialApi;
    this.helloTimeoutMs = options.helloTimeoutMs ?? 1_000;
    this.retryMs = options.retryMs ?? 1_000;
    this.stateIntervalMs = options.stateIntervalMs ?? DEFAULT_STATE_INTERVAL_MS;
    this.pongTimeoutMs = options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
    this.nextGeneration = options.generation ?? newGeneration;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.connect().catch((error: Error) => this.disconnected(error));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.timer = null;
    this.retryTimer = null;
    this.pendingPing = null;
    this.pendingSince = 0;
    const port = this.port;
    this.port = null;
    if (port) void close(port);
  }

  updateState(state: HerdrState): void {
    const mapping = state.slots.map((slot) => slot?.terminalId ?? "").join("\n");
    if (this.mapping !== null && mapping !== this.mapping) this.currentGeneration = this.nextGeneration();
    this.mapping = mapping;
    this.state = state;
    this.sendState();
  }

  private async connect(): Promise<void> {
    const path = await selectDevice(this.api, this.options.portPath, this.helloTimeoutMs);
    if (this.stopped) return;
    const port = await verifiedPort(this.api, path, this.helloTimeoutMs);
    if (!port) throw new DeviceNotFoundError("ZERO-KB02 USB CDC handshake failed");
    if (this.stopped) {
      await close(port);
      return;
    }
    const decoder = new LineDecoder((line) => {
      const message = parseDeviceMessage(line);
      if (message?.type === "pong" && message.sequence === this.pendingPing) {
        this.pendingPing = null;
        this.pendingSince = 0;
      }
      if (message) this.options.onMessage(message);
    });
    port.on("data", (data) => decoder.push(data));
    port.on("close", () => this.disconnected(new Error("ZERO-KB02 USB CDC disconnected")));
    port.on("error", (error) => this.disconnected(error));
    this.port = port;
    this.currentGeneration = this.nextGeneration();
    this.pendingPing = null;
    this.pendingSince = 0;
    this.sendState();
    this.timer = setInterval(() => this.heartbeat(), this.stateIntervalMs);
  }

  private heartbeat(): void {
    if (!this.port) return;
    if (this.pendingPing !== null && Date.now() - this.pendingSince >= this.pongTimeoutMs) {
      this.disconnected(new Error("ZERO-KB02 USB CDC heartbeat timed out"));
      return;
    }
    this.sendState();
    if (this.pendingPing === null) {
      this.pingSequence = (this.pingSequence + 1) >>> 0;
      this.pendingPing = this.pingSequence;
      this.pendingSince = Date.now();
    }
    void write(this.port, `PING ${this.pendingPing}\n`).catch((error: Error) => this.disconnected(error));
  }

  private sendState(): void {
    if (!this.port || !this.state) return;
    void write(this.port, `${stateLine(this.state, this.currentGeneration)}\n`).catch((error: Error) => this.disconnected(error));
  }

  private disconnected(error: Error): void {
    if (this.stopped || this.retryTimer) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const port = this.port;
    this.port = null;
    this.pendingPing = null;
    this.pendingSince = 0;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect().catch((nextError: Error) => this.disconnected(nextError));
    }, this.retryMs);
    if (port) void close(port);
    this.options.onError?.(error);
  }
}
