// Adapted from House of Herdr Codex Micro at 50b24e3 (MIT).
// Popup-toggle pattern; see THIRD_PARTY_NOTICES.md for the source and full notice.
import type { DeviceMessage } from "./cdc.js";
import { HerdrError, type HerdrClient } from "./herdr.js";
import { PLUGIN_ENTRYPOINT, PLUGIN_ID } from "./status.js";
import type { UsbInputContext } from "./usb.js";

type PopupClient = Pick<HerdrClient, "request">;

export class PopupController {
  private busy = false;

  constructor(private readonly herdr: PopupClient) {}

  async handle(
    message: DeviceMessage,
    context: UsbInputContext,
  ): Promise<boolean> {
    const staleContext =
      message.type === "popup" &&
      (message.generation !== context.generation || !context.state?.online);
    if (staleContext) context.retransmit();
    if (
      message.type !== "popup" ||
      message.action !== "DOWN" ||
      staleContext ||
      !context.isCurrent() ||
      this.busy
    ) {
      return false;
    }

    this.busy = true;
    try {
      try {
        await this.herdr.request("popup.close", {});
        return true;
      } catch (error) {
        if (!(error instanceof HerdrError) || error.code !== "popup_not_open") {
          throw error;
        }
      }
      if (!context.isCurrent()) return false;
      const result = await this.herdr.request("plugin.pane.open", {
        plugin_id: PLUGIN_ID,
        entrypoint: PLUGIN_ENTRYPOINT,
        placement: "popup",
      });
      if (result.type !== "ok") {
        throw new Error("Herdr plugin.pane.open returned an invalid result");
      }
      return true;
    } finally {
      this.busy = false;
    }
  }
}
