import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
const run = promisify(execFile);
const cli = fileURLToPath(new URL("../src/device-check.js", import.meta.url));
test("device check commands default to mock and implement input/display/raw/fault scenarios", async () => {
  for (const [mode, expected] of [["input", /KEY 12 UP[\s\S]*total=1/], ["display", /DISPLAY selected=5[\s\S]*OFFLINE/], ["raw", /KEYLOG 1 DOWN/], ["faults", /heartbeat timed out/]] as const) {
    const { stdout } = await run(process.execPath, [cli, mode], { timeout: 5_000 });
    assert.match(stdout, /^MOCK/); assert.match(stdout, expected);
  }
  await assert.rejects(run(process.execPath, [cli, "input", "--device"], { timeout: 2_000 }), /exact absolute port/);
  await assert.rejects(run(process.execPath, [cli, "raw", "--device", "--port", "/dev/cu.*"]), /exact absolute port/);
  await assert.rejects(run(process.execPath, [cli, "input", "--port", "/dev/cu.example"]), /requires --device/);
});
