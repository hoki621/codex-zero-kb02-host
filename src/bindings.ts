import type { DeviceMessage } from "./cdc.js";
import type { HerdrClient, RawAgent } from "./herdr.js";
import type { UsbInputContext } from "./usb.js";

type FocusClient = Pick<HerdrClient, "agentList" | "request">;

function currentPaneId(result: Record<string, unknown>): string | null {
  if (result.type !== "pane_current" || typeof result.pane !== "object" || result.pane === null) {
    return null;
  }
  const paneId = (result.pane as Record<string, unknown>).pane_id;
  return typeof paneId === "string" && paneId.length > 0 ? paneId : null;
}

function focusedCodexAgent(agents: readonly RawAgent[], paneId: string): RawAgent | null {
  const matches = agents.filter((agent) => agent.agent === "codex" && agent.pane_id === paneId);
  if (matches.length !== 1) return null;
  const terminalId = matches[0]!.terminal_id;
  if (typeof terminalId !== "string" || terminalId.length === 0) return null;
  const identities = agents.filter(
    (agent) => agent.agent === "codex" && agent.terminal_id === terminalId,
  );
  return identities.length === 1 ? matches[0]! : null;
}

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

function acceptsTextInput(agent: RawAgent): boolean {
  return agent.agent_status === "idle" || agent.agent_status === "done";
}

export class SafeBindings {
  constructor(private readonly herdr: FocusClient) {}

  async handle(message: DeviceMessage, context: UsbInputContext): Promise<boolean> {
    if (message.type === "pong") return false;
    if (message.generation !== context.generation || !context.state?.online) {
      context.retransmit();
      return false;
    }
    if (message.type === "escape" || message.type === "newChat") {
      if (message.action !== "DOWN") return false;
      const paneId = currentPaneId(await this.herdr.request("pane.current", {}));
      if (!paneId) return false;
      const agent = focusedCodexAgent(await this.herdr.agentList(), paneId);
      if (!agent) return false;
      const terminalId = agent.terminal_id as string;
      if (context.state.slots.filter((slot) => slot?.terminalId === terminalId).length !== 1) {
        return false;
      }
      if (message.type === "newChat" && !acceptsTextInput(agent)) return false;
      const finalPaneId = currentPaneId(await this.herdr.request("pane.current", {}));
      if (finalPaneId !== paneId) return false;
      if (message.type === "newChat") {
        const finalAgent = focusedCodexAgent(await this.herdr.agentList(), paneId);
        if (
          !finalAgent ||
          finalAgent.terminal_id !== terminalId ||
          !acceptsTextInput(finalAgent) ||
          !context.isCurrent()
        ) return false;
      } else if (!context.isCurrent()) {
        return false;
      }
      if (message.type === "escape") {
        await this.herdr.request("agent.send_keys", { target: paneId, keys: ["esc"] });
      } else {
        await this.herdr.request("agent.prompt", { target: paneId, text: "/new" });
      }
      return true;
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
