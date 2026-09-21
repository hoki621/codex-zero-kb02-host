import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { LineDecoder, parseDeviceMessage, stateLine } from "../src/cdc.js";
import { UsbCdc, type UsbInputContext } from "../src/usb.js";
import { MOCK_PORT, MockDevice } from "../src/mock-device.js";
import type { HerdrState } from "../src/state.js";

const state: HerdrState = { online: true, selected: 0, slots: [{ index: 0, terminalId: "t", paneId: "p", tabId: "tab", workspaceId: "w", sequence: 1, status: "working" }, null, null, null, null, null] };
async function until(check: () => boolean): Promise<void> {
  for (let n = 0; n < 100; n++) { if (check()) return; await delay(3); }
  assert.fail("condition not reached");
}
test("bounded decoder handles fragmented, concatenated, CRLF and overlong lines", () => {
  const lines: string[] = [];
  const decoder = new LineDecoder((line) => lines.push(line));
  decoder.push(Buffer.from("KEY 7 2 DO"));
  decoder.push(Buffer.from(`WN\r\nENC 7 -2\n${"x".repeat(128)}\nPONG 9\n\x01bad\n`));
  assert.deepEqual(lines, ["KEY 7 2 DOWN", "ENC 7 -2", "PONG 9"]);
  decoder.push(Buffer.from("x".repeat(127) + "\n"));
  assert.equal(lines.at(-1)?.length, 127);
});
test("major 2 physical keys and bounded signed encoder delta", () => {
  const types = ["escape", "key", "key", "popup", "key", "key", "key", "key", "approve", "reject", "unassigned", "newChat"];
  for (let key = 1; key <= 12; key++) for (const action of ["UP", "DOWN"]) assert.equal(parseDeviceMessage(`KEY 7 ${key} ${action}`)?.type, types[key - 1]);
  assert.deepEqual(parseDeviceMessage("KEY 7 8 UP"), { type: "key", generation: 7n, slot: 5, action: "UP" });
  assert.deepEqual(parseDeviceMessage("ENC 7 -32"), { type: "encoder", generation: 7n, action: "CCW", steps: 32 });
  for (const line of ["KEY 7 0 DOWN", "KEY 7 13 DOWN", "KEY 7 02 DOWN", "KEY 07 2 DOWN", "KEY 0 2 UP", "KEY 7 2  UP", "KEY 7 2 DOWN extra", "KEY 18446744073709551616 1 UP", "ENC 7 0", "ENC 7 -0", "ENC 7 +1", "ENC 7 01", "ENC 7 33", "ENC 7 CW", "ESC 7 DOWN", "JOY 7 LEFT", "PONG 4294967296", "PONG 01"]) assert.equal(parseDeviceMessage(line), null, line);
  assert.deepEqual(parseDeviceMessage("PONG 4294967295"), { type: "pong", sequence: 4294967295 });
  assert.equal(stateLine(state, 7n), "STATE 7 0 WEEEEE");
  assert.equal(stateLine({ online: false, slots: [] }, 8n), "OFFLINE 8");
});
test("serial requires an exact port and rejects a major mismatch without actions", async () => {
  const api = new MockDevice();
  const missing = new UsbCdc({ api, onMessage: () => assert.fail("input") });
  await assert.rejects(missing.start(), /exact absolute port/);
  assert.equal(api.ports.length, 0);
  api.hello = "HELLO ZERO-KB02 1";
  const errors: Error[] = [];
  const usb = new UsbCdc({ api, portPath: MOCK_PORT, onMessage: () => assert.fail("input"), onError: (error) => errors.push(error) });
  await usb.start(); usb.stop();
  assert.match(errors[0]!.message, /Incompatible/);
  assert.deepEqual(api.port.writes, ["HELLO HOST 2\n"]);
});
test("one open per session, duplicate edges, stale input, offline generations and reconnect", async () => {
  const api = new MockDevice();
  const events: { type: string; context: UsbInputContext }[] = [];
  let generation = 40n;
  const usb = new UsbCdc({ api, portPath: MOCK_PORT, generation: () => ++generation,
    onMessage: (message, context) => events.push({ type: message.type, context }), retryMs: 2, stateIntervalMs: 10 });
  usb.updateState(state);
  await usb.start();
  try {
    await until(() => api.port.online);
    assert.equal(api.ports.length, 1);
    assert.equal(api.port.generation, "41");
    api.port.inject("KEY 41 2 DO"); api.port.inject("WN\nKEY 41 2 DOWN\nKEY 41 2 UP\nENC 41 -3\nKEY 40 9 DOWN\n");
    assert.deepEqual(events.map((event) => event.type), ["key", "key", "encoder"]);
    assert.equal(events[0]!.context.isCurrent(), true);
    usb.updateState({ ...state });
    assert.equal(events[0]!.context.isCurrent(), true, "unchanged snapshot must not drop queued input");
    usb.updateState({ online: false, slots: state.slots });
    assert.equal(events[0]!.context.isCurrent(), false);
    await until(() => api.port.writes.includes("OFFLINE 42\n"));
    usb.updateState(state);
    await until(() => api.port.generation === "43");
    api.port.close();
    await until(() => api.ports.length === 2 && api.port.online);
    assert.equal(api.port.generation, "44");
  } finally { usb.stop(); }
});
test("missing matching heartbeat and spontaneous reboot reconnect safely", async () => {
  const api = new MockDevice();
  const usb = new UsbCdc({ api, portPath: MOCK_PORT, onMessage: () => {}, retryMs: 2, stateIntervalMs: 5, pongTimeoutMs: 20 });
  await usb.start();
  try {
    api.heartbeat = false;
    api.port.inject("PONG 4294967295\n");
    await until(() => api.ports.length >= 2);
    api.heartbeat = true;
    await until(() => api.port.writes.some((line) => line.startsWith("PING ")));
    const count = api.ports.length;
    api.port.inject("HELLO ZERO-KB02 2\n");
    await until(() => api.ports.length > count);
  } finally { usb.stop(); }
});

test("all published device-to-host protocol vectors", async () => {
  const vectors = await import("./protocol-vectors.js");
  for (const line of vectors.accepted) assert.ok(parseDeviceMessage(line), line);
  for (const line of vectors.rejected) assert.equal(parseDeviceMessage(line), null, line);
});

test("reconnect immediately pings and malformed hello cannot trigger a reset", async () => {
  const api = new MockDevice();
  const usb = new UsbCdc({ api, portPath: MOCK_PORT, retryMs: 2, onMessage: () => {} });
  usb.updateState(state); await usb.start();
  try {
    api.port.inject("HELLO invalid\n");
    await delay(5); assert.equal(api.ports.length, 1);
    api.port.close();
    await until(() => api.ports.length === 2 && api.port.writes.some((line) => line.startsWith("PING ")));
  } finally { usb.stop(); }
});
