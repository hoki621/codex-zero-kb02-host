import { approvalEvidence } from "./approval.js";
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
  const matches = agents.filter((agent) => agent.pane_id === paneId);
  if (matches.length !== 1 || matches[0]!.agent !== "codex") return null;
  const terminalId = matches[0]!.terminal_id;
  if (typeof terminalId !== "string" || terminalId.length === 0) return null;
  const identities = agents.filter(
    (agent) => agent.terminal_id === terminalId,
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
  return matches.length === 1 && agents.filter((candidate) => candidate.terminal_id === terminalId).length === 1 && agents.filter((candidate) => candidate.pane_id === matches[0]!.pane_id).length === 1 ? matches[0]! : null;
}

function acceptsTextInput(agent: RawAgent): boolean {
  return agent.agent_status === "idle" || agent.agent_status === "done";
}

export class SafeBindings {
  private busy = false;
  private used = new Map<string, string>();
  constructor(private readonly herdr: FocusClient, private readonly evidence = approvalEvidence) {}

  async handle(message: DeviceMessage, context: UsbInputContext): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try { return await this.dispatch(message, context); }
    finally { this.busy = false; }
  }

  private async dispatch(message: DeviceMessage, context: UsbInputContext): Promise<boolean> {
    if (message.type === "pong") return false;
    if (message.generation !== context.generation || !context.state?.online) {
      context.retransmit();
      return false;
    }
    if (
      message.type === "escape" ||
      message.type === "newChat" ||
      message.type === "approve" ||
      message.type === "reject"
    ) {
      if (message.action !== "DOWN") return false;
      const approvalKey = message.type === "approve" ? "y" : message.type === "reject" ? "n" : null;
      const paneId = currentPaneId(await this.herdr.request("pane.current", {}));
      if (!paneId) return false;
      const agent = focusedCodexAgent(await this.herdr.agentList(), paneId);
      if (!agent) return false;
      const terminalId = agent.terminal_id as string;
      if (context.state.slots.filter((slot) => slot?.terminalId === terminalId).length !== 1) {
        return false;
      }
      if (message.type === "newChat" && !acceptsTextInput(agent)) return false;
      if (approvalKey !== null && agent.agent_status !== "blocked") return false;
      const evidence = approvalKey === null ? null : await this.evidence(this.herdr, agent);
      if (approvalKey !== null && (!evidence || this.used.get(terminalId) === evidence.token)) {
        console.error("[zero-kb02] Approval key disabled: unsupported or ambiguous pending command/prompt, or already attempted");
        return false;
      }
      const finalPaneId = currentPaneId(await this.herdr.request("pane.current", {}));
      if (finalPaneId !== paneId) return false;
      const finalAgent = focusedCodexAgent(await this.herdr.agentList(), paneId);
      if (!finalAgent || finalAgent.terminal_id !== terminalId ||
          (message.type === "newChat" && !acceptsTextInput(finalAgent)) ||
          (approvalKey !== null && finalAgent.agent_status !== "blocked")) return false;
      if (approvalKey !== null) {
        if (JSON.stringify(finalAgent.agent_session) !== JSON.stringify(agent.agent_session) ||
            JSON.stringify(await this.evidence(this.herdr, finalAgent)) !== JSON.stringify(evidence)) return false;
        for (const terminal of this.used.keys()) if (!context.state.slots.some((slot) => slot?.terminalId === terminal)) this.used.delete(terminal);
        this.used.set(terminalId, evidence!.token);
      }
      if (!context.isCurrent()) return false;
      if (message.type === "escape") {
        await this.herdr.request("agent.send_keys", { target: paneId, keys: ["esc"] });
      } else if (message.type === "newChat") {
        await this.herdr.request("agent.prompt", { target: paneId, text: "/new" });
      } else {
        await this.herdr.request("agent.send_keys", { target: paneId, keys: [approvalKey] });
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
