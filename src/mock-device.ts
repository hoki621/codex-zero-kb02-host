import { EventEmitter } from "node:events";
import { HELLO_DEVICE, HELLO_HOST, LineDecoder } from "./cdc.js";
import type { SerialApi, SerialConnection } from "./usb.js";

export const MOCK_PORT = "/mock/zero-kb02";
export class MockPort extends EventEmitter implements SerialConnection {
  isOpen = false;
  generation = "0";
  online = false;
  readonly writes: string[] = [];
  private decoder = new LineDecoder((line) => {
    if (line === HELLO_HOST) { this.online = false; this.inject(`${this.device.hello}\n`); }
    else if (/^STATE \d+ [0-5-] [WIBDUE]{6}$/.test(line)) { this.generation = line.split(" ")[1]!; this.online = true; }
    else if (line.startsWith("OFFLINE ")) { this.online = false; this.generation = line.split(" ")[1]!; }
    else if (/^PING \d+$/.test(line) && this.device.heartbeat) this.inject(line.replace("PING", "PONG") + "\n");
  });
  constructor(private readonly device: MockDevice) {
    super();
    queueMicrotask(() => { this.isOpen = true; this.emit("open"); });
  }
  write(data: string, callback: (error: Error | null) => void): boolean {
    if (!this.isOpen) { queueMicrotask(() => callback(new Error("Mock port closed"))); return false; }
    this.writes.push(data);
    this.device.onWrite?.(data.trimEnd());
    queueMicrotask(() => { if (this.isOpen) this.decoder.push(Buffer.from(data)); callback(null); });
    return true;
  }
  inject(data: string): void { if (this.isOpen) this.emit("data", Buffer.from(data)); }
  close(callback?: (error: Error | null) => void): void {
    this.isOpen = false;
    queueMicrotask(() => { this.emit("close"); callback?.(null); });
  }
}
export class MockDevice implements SerialApi {
  hello = HELLO_DEVICE;
  heartbeat = true;
  readonly ports: MockPort[] = [];
  onWrite?: (line: string) => void;
  async list(): Promise<{ path: string }[]> { throw new Error("No automatic probing in mock or real mode"); }
  open(portPath: string): MockPort {
    if (portPath !== MOCK_PORT || this.ports.some((port) => port.isOpen)) throw new Error("Unknown or busy mock port");
    const port = new MockPort(this);
    this.ports.push(port);
    return port;
  }
  get port(): MockPort { return this.ports.at(-1)!; }
}
