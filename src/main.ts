import { SafeBindings } from "./bindings.js";
import { HerdrClient } from "./herdr.js";
import { PopupController } from "./popup.js";
import { CodexReasoningClient, ReasoningController } from "./reasoning.js";
import { HerdrStateSource, type HerdrState } from "./state.js";
import { StatusPublisher } from "./status.js";
import { UsbCdc } from "./usb.js";

const socketPath = process.env.HERDR_SOCKET_PATH;
if (!socketPath) {
  throw new Error("HERDR_SOCKET_PATH is required; set it to the Herdr socket");
}

const report = (source: string, error: Error) => {
  console.error(`[zero-kb02] ${source}: ${error.message}`);
};
const offline: HerdrState = {
  online: false,
  slots: Array.from({ length: 6 }, () => null),
};
const bindingClient = new HerdrClient(socketPath);
const bindings = new SafeBindings(bindingClient);
const popup = new PopupController(bindingClient);
const reasoning = new ReasoningController(bindingClient, new CodexReasoningClient());
const status = new StatusPublisher();
const usb = new UsbCdc({
  portPath: process.env.ZERO_KB02_PORT,
  onMessage: (message, context) => {
    const work = message.type === "popup"
      ? popup.handle(message, context)
      : message.type === "encoder"
        ? reasoning.handle(message, context)
        : bindings.handle(message, context);
    void work.then((handled) => {
      if (!handled && message.type === "encoder" && (message.action === "CW" || message.action === "CCW")) {
        console.error("[zero-kb02] Encoder ignored: stale focus/input, no active codex-micro registration, or unsupported thread/model response. Run codex-micro doctor.");
      }
    }).catch((error: Error) =>
      report("binding", error),
    );
  },
  onError: (error) => report("USB", error),
});
const herdr = new HerdrStateSource({
  socketPath,
  onState: (state) => {
    status.update(state);
    usb.updateState(state);
  },
  onError: (error) => report("Herdr", error),
});

usb.updateState(offline);
status.update(offline);
await status.start();
try {
  await usb.start();
  await herdr.start();
} catch (error) {
  usb.stop();
  await status.stop();
  throw error;
}

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  herdr.stop();
  usb.stop();
  await status.stop();
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
