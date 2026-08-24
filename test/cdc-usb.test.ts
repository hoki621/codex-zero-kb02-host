import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { SerialPortMock } from "serialport";
import {
  AmbiguousDeviceError,
  DeviceNotFoundError,
  LineDecoder,
  UsbCdc,
  parseDeviceMessage,
  selectDevice,
  stateLine,
  type SerialApi,
  type SerialConnection,
  type UsbInputContext,
} from "../src/index.js";
import type { HerdrState, SlotState } from "../src/state.js";

const A = "/dev/cu.usbmodemA";
const B = "/dev/cu.usbmodemB";

class MockSerialApi implements SerialApi {
  readonly opened: SerialPortMock[] = [];

  constructor(private readonly replies: Readonly<Record<string, string>>) {
    SerialPortMock.binding.reset();
    for (const path of Object.keys(replies)) {
      SerialPortMock.binding.createPort(path, { record: true });
    }
  }

  list() {
    return SerialPortMock.list();
  }

  open(path: string): SerialConnection {
    const port = new SerialPortMock({ path, baudRate: 115_200 });
    this.opened.push(port);
    port.once("open", () => {
      const start = port.port!.recording.length;
      const timer = setInterval(() => {
        if (port.port!.recording.length === start) return;
        clearInterval(timer);
        port.port!.emitData(`${this.replies[path] ?? "WRONG"}\n`);
      }, 1);
      port.once("close", () => clearInterval(timer));
    });
    return port as SerialConnection;
  }
}

function slot(index: number, terminalId: string, status: SlotState["status"]): SlotState {
  return {
    index,
    terminalId,
    paneId: `pane-${index}`,
    workspaceId: "workspace",
    tabId: "tab",
    status,
    sequence: 1,
  };
}

function state(status: SlotState["status"] = "working"): HerdrState {
  return { online: true, slots: [slot(0, "agent-a", status), null, null, null, null, null] };
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await delay(2);
  }
  assert.fail("condition was not reached");
}

test("bounded decoder restores split/multiple lines and drops invalid or oversized input", () => {
  const lines: string[] = [];
  const decoder = new LineDecoder((line) => lines.push(line));
  decoder.push(Buffer.from("KEY 7 0 DO"));
  decoder.push(Buffer.from("WN\r\nJOY 7 UP\n\x01bad\n"));
  decoder.push(Buffer.from(`${"x".repeat(128)}\nPONG 9\n`));
  assert.deepEqual(lines, ["KEY 7 0 DOWN", "JOY 7 UP", "PONG 9"]);
});

test("device parser accepts only strict protocol events", () => {
  assert.deepEqual(parseDeviceMessage("KEY 7 5 UP"), { type: "key", generation: 7n, slot: 5, action: "UP" });
  assert.deepEqual(parseDeviceMessage("ENC 7 CCW"), { type: "encoder", generation: 7n, action: "CCW" });
  assert.deepEqual(parseDeviceMessage("JOY 7 LEFT"), { type: "joystick", generation: 7n, action: "LEFT" });
  assert.equal(parseDeviceMessage("KEY 7 6 DOWN"), null);
  assert.equal(parseDeviceMessage("KEY 7 0  DOWN"), null);
  assert.equal(parseDeviceMessage("PONG 01"), null);
  assert.equal(parseDeviceMessage("KEY 01 0 DOWN"), null);
  assert.equal(parseDeviceMessage("KEY 7 00 DOWN"), null);
  assert.equal(parseDeviceMessage("KEY 7 +0 DOWN"), null);
  assert.equal(parseDeviceMessage("KEY 0 0 DOWN"), null);
  assert.deepEqual(parseDeviceMessage("PONG 4294967295"), { type: "pong", sequence: 4_294_967_295 });
  assert.equal(parseDeviceMessage("PONG 4294967296"), null);
  assert.equal(parseDeviceMessage("KEY 18446744073709551616 0 DOWN"), null);
});

test("selection ignores a wrong HELLO and refuses multiple verified devices", async () => {
  const none = new MockSerialApi({ [A]: "NOT ZERO-KB02" });
  await assert.rejects(selectDevice(none, undefined, 50), DeviceNotFoundError);
  assert.equal(none.opened[0]!.port!.recording.toString(), "HELLO HOST 1\n");

  const one = new MockSerialApi({ [A]: "NOT ZERO-KB02", [B]: "HELLO ZERO-KB02 1" });
  assert.equal(await selectDevice(one, undefined, 50), B);
  assert.equal(one.opened[0]!.port!.recording.toString(), "HELLO HOST 1\n");

  const two = new MockSerialApi({ [A]: "HELLO ZERO-KB02 1", [B]: "HELLO ZERO-KB02 1" });
  await assert.rejects(selectDevice(two, undefined, 50), AmbiguousDeviceError);
  assert.equal(await selectDevice(two, B, 50), B);
});

test("USB CDC sends complete state, parses split events, and reconnects", async () => {
  const api = new MockSerialApi({ [A]: "HELLO ZERO-KB02 1" });
  const messages: { message: unknown; context: UsbInputContext }[] = [];
  const errors: Error[] = [];
  let generation = 40n;
  const usb = new UsbCdc({
    api,
    onMessage: (message, context) => messages.push({ message, context }),
    onError: (error) => errors.push(error),
    helloTimeoutMs: 50,
    retryMs: 2,
    stateIntervalMs: 10,
    generation: () => ++generation,
  });
  usb.updateState(state());
  await usb.start();
  await until(() => api.opened.length === 2 && api.opened[1]!.port!.recording.includes(Buffer.from("STATE 41 - WEEEEE\n")));
  await until(() => api.opened[1]!.port!.recording.toString().split("STATE 41 - WEEEEE\n").length >= 3);
  assert.match(api.opened[1]!.port!.recording.toString(), /PING \d+\n/);

  api.opened[1]!.port!.emitData("KEY 41 0 DO");
  api.opened[1]!.port!.emitData("WN\nJOY 41 LEFT\ninvalid\n");
  await until(() => messages.length === 2);
  assert.deepEqual(messages.map(({ message }) => message), [
    { type: "key", generation: 41n, slot: 0, action: "DOWN" },
    { type: "joystick", generation: 41n, action: "LEFT" },
  ]);
  assert.equal(messages[0]!.context.generation, 41n);
  assert.equal(messages[0]!.context.state?.online, true);
  assert.equal(messages[0]!.context.isCurrent(), true);

  usb.updateState(state("done"));
  assert.equal(messages[0]!.context.isCurrent(), false);
  await until(() => api.opened[1]!.port!.recording.includes(Buffer.from("STATE 41 - DEEEEE\n")));
  await new Promise<void>((resolve) => api.opened[1]!.close(() => resolve()));
  await until(() => api.opened.length >= 4 && api.opened[3]!.port!.recording.includes(Buffer.from("STATE 42 - DEEEEE\n")));
  assert.ok(errors.some((error) => error.message.includes("disconnected")));
  usb.stop();
});

test("state formatter emits all six slots or OFFLINE", () => {
  assert.equal(stateLine(state(), 7n), "STATE 7 - WEEEEE");
  assert.equal(stateLine({ online: false, slots: [] }, 7n), "OFFLINE 7");
});

test("heartbeat ignores wrong PONG and accepts only the pending sequence", async () => {
  const wrongApi = new MockSerialApi({ [A]: "HELLO ZERO-KB02 1" });
  const wrong = new UsbCdc({
    api: wrongApi,
    onMessage: () => {},
    helloTimeoutMs: 50,
    retryMs: 2,
    stateIntervalMs: 5,
    pongTimeoutMs: 25,
  });
  await wrong.start();
  wrongApi.opened[1]!.port!.emitData("PONG 1\n");
  await until(() => wrongApi.opened[1]!.port!.recording.includes(Buffer.from("PING 1\n")));
  wrongApi.opened[1]!.port!.emitData("PONG 2\n");
  await until(() => wrongApi.opened.length >= 4);
  wrong.stop();

  const matchingApi = new MockSerialApi({ [A]: "HELLO ZERO-KB02 1" });
  const matching = new UsbCdc({
    api: matchingApi,
    onMessage: () => {},
    helloTimeoutMs: 50,
    retryMs: 2,
    stateIntervalMs: 5,
    pongTimeoutMs: 25,
  });
  await matching.start();
  const port = matchingApi.opened[1]!;
  let acknowledged = 0;
  const responder = setInterval(() => {
    const sequences = [...port.port!.recording.toString().matchAll(/PING (\d+)\n/g)];
    const latest = Number(sequences.at(-1)?.[1] ?? 0);
    if (latest > acknowledged) {
      acknowledged = latest;
      port.port!.emitData(`PONG ${latest}\n`);
    }
  }, 1);
  await delay(60);
  clearInterval(responder);
  assert.ok(acknowledged > 0);
  assert.equal(matchingApi.opened.length, 2);
  matching.stop();
});
