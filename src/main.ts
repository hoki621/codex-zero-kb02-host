import { SafeBindings } from "./bindings.js";
import { HerdrClient } from "./herdr.js";
import { HerdrStateSource, type HerdrState } from "./state.js";
import { UsbCdc } from "./usb.js";

const socketPath = process.env.HERDR_SOCKET_PATH;
if (!socketPath) {
  throw new Error("HERDR_SOCKET_PATH is required; run the host inside Herdr");
}

const report = (source: string, error: Error) => {
  console.error(`[zero-kb02] ${source}: ${error.message}`);
};
const offline: HerdrState = {
  online: false,
  slots: Array.from({ length: 6 }, () => null),
};
const bindings = new SafeBindings(new HerdrClient(socketPath));
const usb = new UsbCdc({
  portPath: process.env.ZERO_KB02_PORT,
  onMessage: (message, context) => {
    void bindings.handle(message, context).catch((error: Error) =>
      report("binding", error),
    );
  },
  onError: (error) => report("USB", error),
});
const herdr = new HerdrStateSource({
  socketPath,
  onState: (state) => usb.updateState(state),
  onError: (error) => report("Herdr", error),
});

usb.updateState(offline);
await usb.start();
try {
  await herdr.start();
} catch (error) {
  usb.stop();
  throw error;
}

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  herdr.stop();
  usb.stop();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
