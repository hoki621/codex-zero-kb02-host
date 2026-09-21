import { readFile } from "node:fs/promises";
import { codexMicroStatePath, processExists } from "./reasoning.js";
import type { HerdrClient, RawAgent } from "./herdr.js";

export const APPROVAL_VERSION = "codex-cli 0.155.1";
export const APPROVAL_KEYMAP_ARGS = ["-c", 'tui.keymap.approval.approve=["y"]', "-c", 'tui.keymap.approval.decline=["n","esc"]'];
export const approvalPath = (id: string) => `${codexMicroStatePath(id)}.approval`;
export type PendingApproval = { requestId: string | number; threadId: string; method: string; decisions: unknown[]; token: string };

// All server requests count: questions and multiple requests disable approval keys.
export class ApprovalObserver {
  private pending = new Map<string, PendingApproval>();
  private sequence = 0;
  constructor(private readonly changed: (pending: PendingApproval | null) => void) {}
  reset(): void { this.pending.clear(); this.changed(null); }
  client(text: string): void {
    const value = JSON.parse(text);
    if (value.method) return;
    if (this.pending.delete(JSON.stringify(value.id))) this.emit();
  }
  server(text: string): void {
    const value = JSON.parse(text);
    if (value.method === "serverRequest/resolved") {
      this.pending.delete(JSON.stringify(value.params?.requestId)); this.emit(); return;
    }
    if (value.method === "turn/completed" || value.method === "thread/closed") {
      // Only an explicit response/resolution or connection lifecycle resolves a request.
      // Other threads can finish while this thread still has a pending approval.
      return;
    }
    if (typeof value.method !== "string" || !("id" in value)) return;
    if (this.pending.size >= 32) throw new Error("Too many outstanding server requests");
    this.pending.set(JSON.stringify(value.id), {
      requestId: value.id, threadId: value.params?.threadId, method: value.method,
      decisions: value.params?.availableDecisions ?? [], token: String(++this.sequence),
    });
    this.emit();
  }
  private emit(): void {
    const value = this.pending.size === 1 ? [...this.pending.values()][0]! : null;
    this.changed(value?.method === "item/commandExecution/requestApproval" &&
      Array.isArray(value.decisions) && value.decisions.includes("accept") && value.decisions.includes("cancel") ? value : null);
  }
}

export type ApprovalEvidence = { token: string; screen: string };
export async function approvalEvidence(herdr: Pick<HerdrClient, "request">, agent: RawAgent): Promise<ApprovalEvidence | null> {
  const session = agent.agent_session as Record<string, unknown> | undefined;
  const id = session?.value;
  if (session?.source !== "herdr:codex" || session.agent !== "codex" || session.kind !== "id" ||
      typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return null;
  try {
    const registrationText = await readFile(codexMicroStatePath(id), "utf8");
    const pendingText = await readFile(approvalPath(id), "utf8");
    const registration = JSON.parse(registrationText);
    const pending = JSON.parse(pendingText);
    if (registration.threadId !== id || registration.terminalId !== agent.terminal_id ||
        !processExists(registration.pid) || pending.pid !== registration.pid || pending.epoch !== registration.epoch ||
        pending.version !== APPROVAL_VERSION || pending.keymap !== "fixed-y-n-v1" ||
        pending.threadId !== id || pending.method !== "item/commandExecution/requestApproval" ||
        !["string", "number"].includes(typeof pending.requestId) || typeof pending.token !== "string") return null;
    const result = await herdr.request("pane.read", { pane_id: agent.pane_id, source: "visible", format: "text", strip_ansi: true });
    const read = result.read as Record<string, unknown> | undefined;
    if (result.type !== "pane_read" || !read || read.pane_id !== agent.pane_id || read.source !== "visible" ||
        read.format !== "text" || read.truncated !== false || !Number.isSafeInteger(read.revision) || typeof read.text !== "string") return null;
    const lines = read.text.split("\n").map((line) => line.trim());
    const yes = lines.filter((line) => /^(?:›\s*)?1\. Yes, proceed \(y\)$/.test(line));
    const no = lines.filter((line) => /^(?:›\s*)?\d+\. No, and tell Codex what to do differently \((?:n|esc)\)$/.test(line));
    if (yes.length !== 1 || no.length !== 1 || !lines.includes("Would you like to run the following command?")) return null;
    if (await readFile(codexMicroStatePath(id), "utf8") !== registrationText ||
        await readFile(approvalPath(id), "utf8") !== pendingText || !processExists(registration.pid)) return null;
    return { token: `${pending.epoch}:${pending.token}`, screen: JSON.stringify([read.revision, read.text]) };
  } catch { return null; }
}
