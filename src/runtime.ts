import { PROTOCOL_MAJOR } from "./cdc.js";
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { defaultAppServerSocket, processExists } from "./reasoning.js";

const execute = promisify(execFile);
type Binary = { binary: string; version: string };
type Server = Binary & { pid: number; socketPath: string };

export async function brewCodex(): Promise<Binary> {
  const { stdout } = await execute("brew", ["--prefix"], { timeout: 10_000 });
  const prefix = stdout.trim();
  if (!path.isAbsolute(prefix)) throw new Error("brew --prefix did not return an absolute path");
  const binary = await realpath(path.join(prefix, "bin", "codex"));
  const cask = await realpath(path.join(prefix, "Caskroom", "codex"));
  if (!binary.startsWith(cask + path.sep)) throw new Error("Homebrew bin/codex does not point to the codex cask; run brew install --cask codex");
  const { stdout: version } = await execute(binary, ["--version"], { timeout: 10_000 });
  if (!/^codex-cli \d+\.\d+\.\d+\s*$/.test(version)) throw new Error("Unexpected brew Codex version output");
  return { binary, version: version.trim() };
}

export async function runningServer(binary: Binary, socketPath = defaultAppServerSocket()): Promise<Server> {
  let server: Server;
  try { server = JSON.parse(await readFile(path.join(path.dirname(socketPath), "server.json"), "utf8")); }
  catch { throw new Error("Start codex-micro server in a separate terminal first"); }
  if (!server || server.binary !== binary.binary || server.version !== binary.version ||
      server.socketPath !== socketPath || !processExists(server.pid)) {
    throw new Error("Dedicated server is stale or uses another Codex version; stop it and restart codex-micro server");
  }
  return server;
}

// The foreground supervisor owns this server. Restarting the USB bridge never stops it.
export async function runServer(binary: Binary, socketPath = defaultAppServerSocket()): Promise<number> {
  const directory = path.dirname(socketPath);
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Server already running or stale directory: ${directory}. See README recovery steps; refusing to replace it.`);
    }
    throw error;
  }
  const child = spawn(binary.binary, ["app-server", "--listen", `unix://${socketPath}`], { stdio: "inherit" });
  const completion = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  // Attach immediately, including while server.json is being written.
  void completion.catch(() => {});
  let killTimer: NodeJS.Timeout | undefined;
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null || killTimer) return;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    killTimer.unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    if (!child.pid) return await completion;
    await writeFile(path.join(directory, "server.json"), JSON.stringify({ ...binary, pid: child.pid, socketPath }), { mode: 0o600 });
    console.error(`[codex-micro] ${binary.version}: ${binary.binary}\nServer: unix://${socketPath}\nStop: Ctrl-C (finish remote Codex sessions first)`);
    return await completion;
  } finally {
    stop();
    await completion.catch(() => {});
    clearTimeout(killTimer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await rm(directory, { recursive: true, force: true });
  }
}

export async function doctor(): Promise<void> {
  const binary = await brewCodex();
  console.log(JSON.stringify({ ...binary, protocolMajor: PROTOCOL_MAJOR, herdrSocket: process.env.HERDR_SOCKET_PATH ?? "not configured", approval: binary.version === "codex-cli 0.155.1" ? "requires live relay request + verified command prompt" : "disabled: unsupported Codex approval UI version" }, null, 2));
  console.log(`Dedicated socket: ${defaultAppServerSocket()}`);
  const candidates = await Promise.allSettled((process.env.PATH ?? "").split(path.delimiter).map((entry) => realpath(path.join(entry, "codex"))));
  console.log(`PATH codex binaries: ${[...new Set(candidates.flatMap((result) => result.status === "fulfilled" ? [result.value] : []))].join(", ")}`);
  try { console.log(JSON.stringify(await runningServer(binary), null, 2)); }
  catch (error) { console.log((error as Error).message); }
}
