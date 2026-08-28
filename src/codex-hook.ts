import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PANE_ID = /^(?:[A-Za-z0-9]+:[A-Za-z0-9]+|[0-9]+-[0-9]+)$/;
const SHELL_ENVIRONMENT_INCLUDE_ONLY = [
  "PATH", "HOME", "USER", "BROWSER_USE_*", "CODEX_CLI_PATH", "CODEX_HOME",
  "NODE_REPL_*", "SKY_CUA_*", "HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH",
];

type Reporter = (paneId: string, sessionId: string) => boolean;
type Spawn = (
  command: string,
  args: string[],
  options: { stdio: "ignore"; timeout: number },
) => { status: number | null };
type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

export function reportToHerdr(
  paneId: string,
  sessionId: string,
  spawn: Spawn = spawnSync,
): boolean {
  const result = spawn("herdr", [
    "pane", "report-agent-session",
    paneId,
    "--source", "herdr:codex",
    "--agent", "codex",
    "--agent-session-id", sessionId,
  ], { stdio: "ignore", timeout: 2_000 });
  return result.status === 0;
}

export function reportSessionStart(
  input: unknown,
  env: NodeJS.ProcessEnv = process.env,
  report: Reporter = reportToHerdr,
): boolean {
  const payload = object(input);
  const paneId = env.HERDR_PANE_ID;
  const sessionId = payload?.session_id;
  if (
    env.HERDR_ENV !== "1" ||
    !env.HERDR_SOCKET_PATH ||
    typeof paneId !== "string" ||
    !PANE_ID.test(paneId) ||
    payload?.hook_event_name !== "SessionStart" ||
    typeof sessionId !== "string" ||
    !UUID_V7.test(sessionId)
  ) {
    return false;
  }
  return report(paneId, sessionId);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function codexLaunchArgs(env: NodeJS.ProcessEnv): string[] | null {
  if (
    env.HERDR_ENV !== "1" ||
    !env.HERDR_SOCKET_PATH ||
    !env.HERDR_PANE_ID ||
    !PANE_ID.test(env.HERDR_PANE_ID)
  ) {
    return null;
  }

  return [
    "--disable", "shell_snapshot",
    "-c", `shell_environment_policy.include_only=${JSON.stringify(SHELL_ENVIRONMENT_INCLUDE_ONLY)}`,
    "-c", `shell_environment_policy.set.HERDR_ENV=${JSON.stringify(env.HERDR_ENV)}`,
    "-c", `shell_environment_policy.set.HERDR_PANE_ID=${JSON.stringify(env.HERDR_PANE_ID)}`,
    "-c", `shell_environment_policy.set.HERDR_SOCKET_PATH=${JSON.stringify(env.HERDR_SOCKET_PATH)}`,
  ];
}

export async function installCodexHook(hooksPath: string, commandPath: string): Promise<void> {
  const config = object(JSON.parse(await readFile(hooksPath, "utf8")));
  const hooks = object(config?.hooks);
  if (!config || !hooks) throw new Error(`${hooksPath} does not contain a hooks object`);

  const sessionStart = hooks.SessionStart;
  if (sessionStart !== undefined && !Array.isArray(sessionStart)) {
    throw new Error(`${hooksPath} has an invalid SessionStart hook list`);
  }
  const command = `node ${shellQuote(commandPath)}`;
  const entries = sessionStart ?? [];
  const installed = entries.some((entry) => {
    const commands = object(entry)?.hooks;
    return Array.isArray(commands) && commands.some((hook) => object(hook)?.command === command);
  });
  if (!installed) {
    entries.push({ hooks: [{ type: "command", command, timeout: 10 }] });
    hooks.SessionStart = entries;
    await writeFile(hooksPath, `${JSON.stringify(config, null, 2)}\n`);
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === "--launch") {
    const args = codexLaunchArgs(process.env);
    if (!args) throw new Error("codex-herdr requires HERDR_ENV=1, HERDR_PANE_ID, and HERDR_SOCKET_PATH");
    const result = spawnSync("codex", [...args, ...process.argv.slice(3)], { stdio: "inherit" });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    return;
  }

  if (process.argv[2] === "--install") {
    const codexHome = process.env.CODEX_HOME || path.join(homedir(), ".codex");
    await installCodexHook(path.join(codexHome, "hooks.json"), fileURLToPath(import.meta.url));
    return;
  }

  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  try {
    reportSessionStart(JSON.parse(input));
  } catch {
    // Session identity reporting is advisory and must fail closed.
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    if (process.argv[2] === "--install" || process.argv[2] === "--launch") {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });
}
