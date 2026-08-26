import type { HerdrState } from "./state.js";

export const MAX_LINE_BYTES = 128;

export type DeviceMessage =
  | { type: "pong"; sequence: number }
  | { type: "escape"; generation: bigint; action: "DOWN" | "UP" }
  | { type: "key"; generation: bigint; slot: number; action: "DOWN" | "UP" }
  | { type: "encoder"; generation: bigint; action: "CW" | "CCW" | "DOWN" | "UP" }
  | { type: "joystick"; generation: bigint; action: "UP" | "DOWN" | "LEFT" | "RIGHT" };

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
  if (line.trim() !== line || line.includes("  ") || /[^\x20-\x7e]/.test(line)) return null;
  const parts = line.split(" ");
  if (parts[0] === "PONG" && parts.length === 2) {
    const sequence = decimal(parts[1], 0xffff_ffffn);
    return sequence === null ? null : { type: "pong", sequence: Number(sequence) };
  }

  const currentGeneration = generation(parts[1]);
  if (currentGeneration === null) return null;
  if (parts[0] === "ESC" && parts.length === 3) {
    const action = parts[2];
    return action === "DOWN" || action === "UP"
      ? { type: "escape", generation: currentGeneration, action }
      : null;
  }
  if (parts[0] === "KEY" && parts.length === 4) {
    const slot = decimal(parts[2], 5n);
    const action = parts[3];
    return slot !== null && (action === "DOWN" || action === "UP")
      ? { type: "key", generation: currentGeneration, slot: Number(slot), action }
      : null;
  }
  if (parts[0] === "ENC" && parts.length === 3) {
    const action = parts[2];
    return action === "CW" || action === "CCW" || action === "DOWN" || action === "UP"
      ? { type: "encoder", generation: currentGeneration, action }
      : null;
  }
  if (parts[0] === "JOY" && parts.length === 3) {
    const action = parts[2];
    return action === "UP" || action === "DOWN" || action === "LEFT" || action === "RIGHT"
      ? { type: "joystick", generation: currentGeneration, action }
      : null;
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
  return `STATE ${currentGeneration} - ${states}`;
}
