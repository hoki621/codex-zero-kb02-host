import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { codexLaunchArgs, installCodexHook, reportSessionStart, reportToHerdr } from "../src/codex-hook.js";

const SESSION_ID = "01a0469f-fdd6-72c3-98c8-6f0ab8067b80";

test("Herdr CLI receives the pane ID before report options", () => {
  let invocation: unknown;
  const spawn = (command: string, args: string[]) => {
    invocation = [command, ...args];
    return { status: 0 };
  };

  assert.equal(reportToHerdr("wR:p6", SESSION_ID, spawn), true);
  assert.deepEqual(invocation, [
    "herdr", "pane", "report-agent-session", "wR:p6",
    "--source", "herdr:codex",
    "--agent", "codex",
    "--agent-session-id", SESSION_ID,
  ]);
});

test("SessionStart reports only an exact Herdr pane UUIDv7 identity", () => {
  const calls: string[][] = [];
  const report = (paneId: string, sessionId: string) => {
    calls.push([paneId, sessionId]);
    return true;
  };
  const input = { hook_event_name: "SessionStart", session_id: SESSION_ID, transcript_path: null };
  const env = {
    HERDR_ENV: "1",
    HERDR_PANE_ID: "wR:p6",
    HERDR_SOCKET_PATH: "/tmp/herdr.sock",
  };

  assert.equal(reportSessionStart(input, env, report), true);
  assert.deepEqual(calls, [["wR:p6", SESSION_ID]]);

  for (const [candidateInput, candidateEnv] of [
    [input, { ...env, HERDR_ENV: "0" }],
    [input, { ...env, HERDR_SOCKET_PATH: "" }],
    [input, { ...env, HERDR_PANE_ID: "not a pane" }],
    [{ ...input, hook_event_name: "Stop" }, env],
    [{ ...input, session_id: "01a0469f-fdd6-42c3-98c8-6f0ab8067b80" }, env],
  ] as const) {
    assert.equal(reportSessionStart(candidateInput, candidateEnv, report), false);
  }
  assert.equal(calls.length, 1);
});

test("installer preserves existing hooks and is idempotent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zero-kb02-hook-"));
  const hooksPath = path.join(directory, "hooks.json");
  const existing = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "existing", timeout: 10 }] }],
      Stop: [{ hooks: [{ type: "command", command: "stop" }] }],
    },
  };
  try {
    await writeFile(hooksPath, JSON.stringify(existing));
    await installCodexHook(hooksPath, "/repo/dist/src/codex-hook.js");
    await installCodexHook(hooksPath, "/repo/dist/src/codex-hook.js");
    const installed = JSON.parse(await readFile(hooksPath, "utf8"));
    assert.equal(installed.hooks.SessionStart.length, 2);
    assert.equal(installed.hooks.SessionStart[0].hooks[0].command, "existing");
    assert.equal(installed.hooks.SessionStart[1].hooks[0].command, "node '/repo/dist/src/codex-hook.js'");
    assert.deepEqual(installed.hooks.Stop, existing.hooks.Stop);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("Herdr launcher overrides only include_only and exact Herdr set keys", () => {
  const args = codexLaunchArgs({
    HERDR_ENV: "1",
    HERDR_PANE_ID: "wR:p6",
    HERDR_SOCKET_PATH: "/tmp/herdr.sock",
  });
  assert.ok(args);
  assert.deepEqual(args, [
    "--disable", "shell_snapshot",
    "-c", 'shell_environment_policy.include_only=["PATH","HOME","USER","BROWSER_USE_*","CODEX_CLI_PATH","CODEX_HOME","NODE_REPL_*","SKY_CUA_*","HERDR_ENV","HERDR_PANE_ID","HERDR_SOCKET_PATH"]',
    "-c", 'shell_environment_policy.set.HERDR_ENV="1"',
    "-c", 'shell_environment_policy.set.HERDR_PANE_ID="wR:p6"',
    "-c", 'shell_environment_policy.set.HERDR_SOCKET_PATH="/tmp/herdr.sock"',
  ]);

  assert.equal(codexLaunchArgs({ HERDR_ENV: "0", HERDR_PANE_ID: "wR:p6", HERDR_SOCKET_PATH: "/tmp/herdr.sock" }), null);
  assert.equal(codexLaunchArgs({ HERDR_ENV: "1", HERDR_PANE_ID: "not a pane", HERDR_SOCKET_PATH: "/tmp/herdr.sock" }), null);
});
