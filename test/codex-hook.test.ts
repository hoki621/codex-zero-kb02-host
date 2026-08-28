import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { codexLaunchArgs, installCodexHook, registrationCommand, sessionStartContext } from "../src/codex-hook.js";

const SESSION_ID = "01a0469f-fdd6-72c3-98c8-6f0ab8067b80";

test("SessionStart emits only an exact UUIDv7 registration context", () => {
  const input = { hook_event_name: "SessionStart", session_id: SESSION_ID, transcript_path: null };
  const context = sessionStartContext(input);
  assert.ok(context?.includes(registrationCommand(SESSION_ID) as string));
  assert.equal(sessionStartContext({ ...input, hook_event_name: "Stop" }), null);
  assert.equal(sessionStartContext({ ...input, session_id: "01a0469f-fdd6-42c3-98c8-6f0ab8067b80" }), null);
  assert.equal(registrationCommand("not-a-session"), null);
});

test("fixed registration command reports exact identity and otherwise no-ops", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zero-kb02-register-"));
  const herdr = path.join(directory, "herdr");
  const capture = path.join(directory, "capture");
  const command = registrationCommand(SESSION_ID);
  assert.ok(command);
  try {
    await writeFile(herdr, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CAPTURE_PATH\"\n");
    await chmod(herdr, 0o755);
    const validEnv = {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ""}`,
      CAPTURE_PATH: capture,
      HERDR_ENV: "1",
      HERDR_PANE_ID: "wR:p6",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      CODEX_THREAD_ID: SESSION_ID,
    };
    assert.equal(spawnSync("sh", ["-c", command], { env: validEnv }).status, 0);
    assert.deepEqual((await readFile(capture, "utf8")).trim().split("\n"), [
      "pane", "report-agent-session", "wR:p6",
      "--source", "herdr:codex",
      "--agent", "codex",
      "--agent-session-id", SESSION_ID,
    ]);

    await rm(capture);
    for (const env of [
      { ...validEnv, HERDR_ENV: "0" },
      { ...validEnv, HERDR_SOCKET_PATH: "" },
      { ...validEnv, HERDR_PANE_ID: "not a pane" },
      { ...validEnv, CODEX_THREAD_ID: "01a0469f-fdd6-72c3-98c8-6f0ab8067b81" },
      { ...validEnv, CODEX_THREAD_ID: "not-a-session" },
    ]) {
      assert.equal(spawnSync("sh", ["-c", command], { env }).status, 0);
      await assert.rejects(access(capture));
    }
  } finally {
    await rm(directory, { recursive: true });
  }
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
