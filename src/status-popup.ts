import net from "node:net";
import { pathToFileURL } from "node:url";
import { STATUS_SOCKET_PATH, type StatusPayload } from "./status.js";

const STATUSES = new Set(["idle", "working", "blocked", "done", "unknown"]);

function text(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, "?");
}

export function parseStatus(line: string): StatusPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const payload = value as Record<string, unknown>;
  if (
    payload.version !== 1 ||
    typeof payload.online !== "boolean" ||
    !Array.isArray(payload.slots) ||
    payload.slots.length !== 6
  ) {
    return null;
  }
  for (let index = 0; index < payload.slots.length; index++) {
    const raw = payload.slots[index];
    if (raw === null) continue;
    if (typeof raw !== "object") return null;
    const slot = raw as Record<string, unknown>;
    if (
      slot.index !== index ||
      typeof slot.terminalId !== "string" ||
      typeof slot.paneId !== "string" ||
      typeof slot.workspaceId !== "string" ||
      typeof slot.tabId !== "string" ||
      typeof slot.status !== "string" ||
      !STATUSES.has(slot.status) ||
      typeof slot.sequence !== "number" ||
      !Number.isSafeInteger(slot.sequence) ||
      slot.sequence < 0
    ) {
      return null;
    }
  }
  if (!payload.online && payload.slots.some((slot) => slot !== null)) {
    return null;
  }
  return payload as unknown as StatusPayload;
}

export function renderStatus(payload: StatusPayload): string {
  const lines = [
    `zero-kb02 status — Herdr ${payload.online ? "online" : "offline"}`,
    "",
  ];
  payload.slots.forEach((slot, index) => {
    lines.push(
      slot
        ? `A${index + 1}  ${slot.status.padEnd(7)}  ${text(slot.terminalId)}  workspace=${text(slot.workspaceId)}  tab=${text(slot.tabId)}`
        : `A${index + 1}  empty`,
    );
  });
  return lines.join("\n");
}

export function runStatusPopup(
  socketPath = STATUS_SOCKET_PATH,
  write: (text: string) => void = (value) => process.stdout.write(value),
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      error ? reject(error) : resolve();
    };
    socket.once("connect", () => socket.write('{"cmd":"watch"}\n'));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 64 * 1024) {
        finish(new Error("status payload too large"));
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const payload = parseStatus(line);
        if (!payload) {
          finish(new Error("invalid status payload"));
          return;
        }
        write(`\x1b[2J\x1b[H${renderStatus(payload)}\n`);
      }
    });
    socket.once("end", () => finish());
    socket.once("close", () => finish());
    socket.once("error", (error) => finish(error));
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runStatusPopup().catch((error: Error) => {
    console.error(`[zero-kb02 popup] ${error.message}`);
    process.exitCode = 1;
  });
}
