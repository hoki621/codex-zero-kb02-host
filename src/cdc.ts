import type { HerdrState } from "./state.js";

export const MAX_LINE_BYTES = 128;
export const PROTOCOL_MAJOR = 2;
export const HELLO_HOST = `HELLO HOST ${PROTOCOL_MAJOR}`;
export const HELLO_DEVICE = `HELLO ZERO-KB02 ${PROTOCOL_MAJOR}`;
export const AGENT_KEYS = [2, 3, 5, 6, 7, 8] as const;

export type DeviceMessage =
  | { type: "pong"; sequence: number }
  | { type: "escape"; generation: bigint; action: "DOWN" | "UP" }
  | { type: "popup"; generation: bigint; action: "DOWN" | "UP" }
  | { type: "newChat"; generation: bigint; action: "DOWN" | "UP" }
  | { type: "approve"; generation: bigint; action: "DOWN" | "UP" }
  | { type: "reject"; generation: bigint; action: "DOWN" | "UP" }
  | { type: "key"; generation: bigint; slot: number; action: "DOWN" | "UP" }
  | { type: "encoder"; generation: bigint; action: "CW" | "CCW"; steps: number }
  | { type: "unassigned"; generation: bigint; action: "DOWN" | "UP" };

export class LineDecoder {
  private bytes: number[] = [];
  private discarding = false;

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer): void {
    for (const byte of chunk) {
      if (this.discarding) {
        if (byte === 0x0a) this.discarding = false;
        continue;
      }
      if (byte === 0x0a) {
        const bytes = this.bytes.at(-1) === 0x0d ? this.bytes.slice(0, -1) : this.bytes;
        this.bytes = [];
        if (bytes.length > 0 && bytes.every((value) => value >= 0x20 && value <= 0x7e)) {
          this.onLine(Buffer.from(bytes).toString("ascii"));
        }
      } else if (this.bytes.length === MAX_LINE_BYTES - 1) {
        this.bytes = [];
        this.discarding = true;
      } else {
        this.bytes.push(byte);
      }
    }
  }
}

function decimal(value: string | undefined, max: bigint): bigint | null {
  if (!value || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= max ? parsed : null;
}

function generation(value: string | undefined): bigint | null {
  const parsed = decimal(value, 0xffff_ffff_ffff_ffffn);
  return parsed !== null && parsed > 0n ? parsed : null;
}

export function parseDeviceMessage(line: string): DeviceMessage | null {
  if (line.length >= MAX_LINE_BYTES || line.trim() !== line || line.includes("  ") || /[^\x20-\x7e]/.test(line)) return null;
  const parts = line.split(" ");
  if (parts[0] === "PONG" && parts.length === 2) {
    const sequence = decimal(parts[1], 0xffff_ffffn);
    return sequence === null ? null : { type: "pong", sequence: Number(sequence) };
  }

  const currentGeneration = generation(parts[1]);
  if (currentGeneration === null) return null;
  if (parts[0] === "KEY" && parts.length === 4) {
    const key = decimal(parts[2], 12n);
    const action = parts[3];
    if (key === null || key === 0n || (action !== "DOWN" && action !== "UP")) return null;
    const slot = AGENT_KEYS.indexOf(Number(key) as typeof AGENT_KEYS[number]);
    if (slot >= 0) return { type: "key", generation: currentGeneration, slot, action };
    const type = ({ 1: "escape", 4: "popup", 9: "approve", 10: "reject", 11: "unassigned", 12: "newChat" } as const)[Number(key) as 1 | 4 | 9 | 10 | 11 | 12];
    return { type, generation: currentGeneration, action };
  }
  if (parts[0] === "ENC" && parts.length === 3 && /^-?[1-9][0-9]?$/.test(parts[2]!)) {
    const delta = Number(parts[2]);
    if (Math.abs(delta) <= 32) return { type: "encoder", generation: currentGeneration, action: delta > 0 ? "CW" : "CCW", steps: Math.abs(delta) };
  }
  return null;
}

const STATUS_CODE = {
  working: "W",
  idle: "I",
  blocked: "B",
  done: "D",
  unknown: "U",
} as const;

export function stateLine(state: HerdrState, currentGeneration: bigint): string {
  if (!state.online) return `OFFLINE ${currentGeneration}`;
  const states = Array.from({ length: 6 }, (_, index) => {
    const slot = state.slots[index];
    return slot ? STATUS_CODE[slot.status] : "E";
  }).join("");
  return `STATE ${currentGeneration} ${state.selected ?? "-"} ${states}`;
}
