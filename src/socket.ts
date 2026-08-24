// Adapted from House of Herdr's Codex Micro socket client. See
// THIRD_PARTY_NOTICES.md for the pinned source and MIT license.
import net from "node:net";

const CONNECT_TIMEOUT_MS = 5_000;
export const REQUEST_TIMEOUT_MS = 10_000;

export function readLines(
  socket: net.Socket,
  onLine: (line: string) => void,
): void {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      onLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  });
}

export function connectSocket(path: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`connect to ${path} timed out`));
    }, CONNECT_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function requestLine(
  socket: net.Socket,
  request: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      finish();
    };
    const timer = setTimeout(
      () => settle(() => reject(new Error("Herdr request timed out"))),
      REQUEST_TIMEOUT_MS,
    );
    readLines(socket, (line) => settle(() => resolve(line)));
    socket.on("close", () =>
      settle(() => reject(new Error("Herdr closed before responding"))),
    );
    socket.on("error", (error) => settle(() => reject(error)));
    socket.write(request + "\n");
  });
}
