import type { DeviceMessage } from "./cdc.js";
import type { HerdrClient, RawAgent } from "./herdr.js";
import type { UsbInputContext } from "./usb.js";

type FocusClient = Pick<HerdrClient, "agentList" | "request">;

function liveAgent(agents: readonly RawAgent[], terminalId: string): RawAgent | null {
  const matches = agents.filter(
    (agent) =>
      agent.agent === "codex" &&
      agent.terminal_id === terminalId &&
      typeof agent.pane_id === "string" &&
      agent.pane_id.length > 0,
  );
  return matches.length === 1 ? matches[0]! : null;
}

export class SafeBindings {
  constructor(private readonly herdr: FocusClient) {}

  async handle(message: DeviceMessage, context: UsbInputContext): Promise<boolean> {
    if (message.type === "pong") return false;
    if (message.generation !== context.generation || !context.state?.online) {
      context.retransmit();
      return false;
    }
    if (message.type !== "key" || message.action !== "DOWN") return false;

    const terminalId = context.state.slots[message.slot]?.terminalId;
    if (!terminalId) return false;
    const agent = liveAgent(await this.herdr.agentList(), terminalId);
    if (!agent || !context.isCurrent()) return false;
    await this.herdr.request("agent.focus", { target: agent.pane_id });
    return true;
  }
}
