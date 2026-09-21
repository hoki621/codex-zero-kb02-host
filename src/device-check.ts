#!/usr/bin/env node
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { LineDecoder, HELLO_DEVICE, PROTOCOL_MAJOR, AGENT_KEYS } from "./cdc.js";
import { MockDevice, MOCK_PORT } from "./mock-device.js";
import { UsbCdc, handshake, openSerial, closeSerial, writeSerial, serialApi, explicitPort } from "./usb.js";
import type { HerdrState } from "./state.js";
import { doctor } from "./runtime.js";

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  device: { type: "boolean", default: false }, port: { type: "string" },
} });
const mode = positionals[0] ?? "input";
if (positionals.length > 1 || !["input", "display", "faults", "raw", "doctor"].includes(mode)) throw new Error("Usage: kb02-check [input|display|faults|raw|doctor] [--device --port /exact/port]");
if (mode === "doctor") {
  console.log(`USB protocol: ${PROTOCOL_MAJOR}; real serial requires --device --port; no serial or Herdr socket opened`);
  await doctor();
} else {
  if (!values.device && values.port) throw new Error("--port requires --device; mock is the default");
  const mock = values.device ? null : new MockDevice();
  const api = mock ?? serialApi;
  const portPath = mock ? MOCK_PORT : explicitPort(values.port);
  console.log(`${mock ? "MOCK" : "DEVICE"} ${mode}: ${portPath}; Ctrl-C stops; no Herdr operations`);
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const pause = async (ms: number) => { for (let n = 0; n < ms && !stopped; n += 50) await delay(Math.min(50, ms - n)); };
  try {
    if (mode === "raw" || (mode === "faults" && !mock)) {
      const port = await openSerial(api, portPath);
      port.on("error", (error) => { console.error(error.message); stopped = true; });
      port.on("close", stop);
      const decoder = new LineDecoder((line) => console.log(line));
      port.on("data", (data) => decoder.push(data));
      try {
        if (mock) { mock.port.inject("KEYLOG 1 DOWN\nKEYLOG 1 UP\n"); }
        else if (mode === "faults") {
          console.log(`Expect ${HELLO_DEVICE}; then online, ignore overlong line, and offline after 12 seconds without valid traffic.`);
          await handshake(port, 1_000);
          await pause(500);
          await writeSerial(port, "STATE 1 0 WIBDUE\n" + "x".repeat(129) + "\n");
          await pause(13_000);
          console.log("Heartbeat silence complete; device should now display offline. Closing port.");
        } else { while (!stopped) await pause(250); }
      } finally { await closeSerial(port); }
    } else {
      const slots: HerdrState["slots"] = ["working", "idle", "blocked", "done", "unknown", null].map((status, index) => status === null ? null : ({ index, terminalId: `mock-${index}`, paneId: `mock-${index}`, workspaceId: "mock", tabId: "mock", sequence: 0, status: status as "working" | "idle" | "blocked" | "done" | "unknown" }));
      const online: HerdrState = { online: true, selected: 0, slots };
      let total = 0;
      const usb = new UsbCdc({ api, portPath,
        stateIntervalMs: mock ? 20 : 5_000, pongTimeoutMs: mock ? 100 : 12_000, retryMs: mock ? 10 : 1_000,
        onMessage: (message) => {
          if (message.type === "pong") return;
          if (message.type === "encoder") { total += message.steps * (message.action === "CW" ? 1 : -1); console.log(`ENC ${message.action} steps=${message.steps} total=${total}`); }
          else {
            const key = message.type === "key" ? AGENT_KEYS[message.slot] : ({ escape: 1, popup: 4, approve: 9, reject: 10, unassigned: 11, newChat: 12 } as const)[message.type];
            console.log(`KEY ${key} ${message.action}`);
          }
        },
        onError: (error) => console.log(`USB: ${error.message}`),
      });
      if (mock) mock.onWrite = (line) => { if (!line.startsWith("PING")) console.log(`HOST> ${line}`); };
      usb.updateState(online);
      await usb.start();
      try {
        if (mode === "display") {
          for (let selected = 0; selected < 6 && !stopped; selected++) {
            // Include six nonempty slots for a visible selection test, then restore E.
            const visible = [...slots];
            if (selected === 5) visible[5] = { ...visible[4]!, index: 5, terminalId: "mock-5", paneId: "mock-5" };
            usb.updateState({ online: true, selected, slots: visible });
            console.log(`DISPLAY selected=${selected}; W/I/B/D/U/E`);
            await pause(mock ? 50 : 1_000);
          }
          usb.updateState({ online: false, slots: [] });
          await pause(mock ? 50 : 1_000);
        } else if (mock) {
          await pause(50);
          const generation = mock.port.generation;
          for (let key = 1; key <= 12; key++) mock.port.inject(`KEY ${generation} ${key} DOWN\nKEY ${generation} ${key} UP\n`);
          mock.port.inject(`ENC ${generation} 3\nENC ${generation} -2\n`);
          if (mode === "faults") {
            console.log("FAULT: fragmented/overlong/malformed/stale input; none may create extra key actions");
            mock.port.inject(`KEY ${generation} 2 DO`); mock.port.inject("WN\n");
            mock.port.inject("x".repeat(129) + "\nKEY 0 9 DOWN\nKEY 1 9 DOWN\nENC 1 33\n");
            mock.port.close(); await pause(50);
            mock.heartbeat = false; console.log("FAULT: device stops answering heartbeat");
            await pause(200);
          }
        } else { while (!stopped) await pause(250); }
      } finally { usb.stop(); }
    }
  } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
