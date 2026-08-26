import { SafeBindings } from "./bindings.js";
import { HerdrClient } from "./herdr.js";
import { FileOwnershipStore, PopupController } from "./popup.js";
import { HerdrStateSource, type HerdrState } from "./state.js";
import { fileURLToPath } from "node:url";
import { OWNERSHIP_PATH, StatusPublisher } from "./status.js";
import { UsbCdc } from "./usb.js";

const socketPath = process.env.HERDR_SOCKET_PATH;
if (!socketPath) {
  throw new Error("HERDR_SOCKET_PATH is required; set it to the Herdr socket");
}

const report = (source: string, error: Error) => {
  console.error(`[zero-kb02] ${source}: ${error.message}`);
};
const hostRoot = fileURLToPath(new URL("../..", import.meta.url));
const offline: HerdrState = {
  online: false,
  slots: Array.from({ length: 6 }, () => null),
};
const bindingClient = new HerdrClient(socketPath);
const bindings = new SafeBindings(bindingClient);
const popup = new PopupController(
  bindingClient,
  new FileOwnershipStore(OWNERSHIP_PATH),
  hostRoot,
);
const status = new StatusPublisher();
const usb = new UsbCdc({
  portPath: process.env.ZERO_KB02_PORT,
  onMessage: (message, context) => {
    const work = message.type === "popup"
      ? popup.handle(message, context)
      : bindings.handle(message, context);
    void work.catch((error: Error) =>
      report("binding", error),
    );
  },
  onError: (error) => report("USB", error),
});
const herdr = new HerdrStateSource({
  socketPath,
  onState: (state) => {
    popup.observeState(state);
    status.update(state);
    usb.updateState(state);
  },
  onError: (error) => report("Herdr", error),
});

usb.updateState(offline);
popup.observeState(offline);
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
  await popup.shutdown();
  herdr.stop();
  usb.stop();
  await status.stop();
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
