import {
  HerdrClient,
  type HerdrEvent,
  type RawAgent,
  type Subscription,
} from "./herdr.js";
import {
  assignStickySlots,
  normalizeStatus,
  SLOT_COUNT,
  type AgentStatus,
} from "./slots.js";

export const DEFAULT_RECONCILE_MS = 5_000;
const DEFAULT_RETRY_MS = 1_000;

export interface CodexAgent {
  terminalId: string;
  paneId: string;
  workspaceId: string;
  tabId: string;
  status: AgentStatus;
  sequence: number;
}

export interface SlotState extends CodexAgent {
  index: number;
}

export interface HerdrState {
  online: boolean;
  selected?: number | null;
  slots: readonly (SlotState | null)[];
}

export interface HerdrStateOptions {
  socketPath: string;
  onState: (state: HerdrState) => void;
  onError?: (error: Error) => void;
  reconcileMs?: number;
  retryMs?: number;
}

const BASE_SUBSCRIPTIONS: readonly Subscription[] = [
  { type: "pane.created" },
  { type: "pane.closed" },
  { type: "pane.moved" },
  { type: "pane.agent_detected" },
];

function codexAgents(rawAgents: readonly RawAgent[]): CodexAgent[] {
  const agents: CodexAgent[] = [];
  const terminalCounts = new Map<unknown, number>();
  const paneCounts = new Map<unknown, number>();
  for (const raw of rawAgents) {
    terminalCounts.set(raw.terminal_id, (terminalCounts.get(raw.terminal_id) ?? 0) + 1);
    paneCounts.set(raw.pane_id, (paneCounts.get(raw.pane_id) ?? 0) + 1);
  }
  for (const raw of rawAgents) {
    if (
      raw.agent !== "codex" ||
      typeof raw.terminal_id !== "string" ||
      typeof raw.pane_id !== "string" ||
      typeof raw.workspace_id !== "string" ||
      typeof raw.tab_id !== "string" ||
      !raw.terminal_id || !raw.pane_id || !raw.workspace_id || !raw.tab_id ||
      terminalCounts.get(raw.terminal_id) !== 1 || paneCounts.get(raw.pane_id) !== 1
    ) {
      continue;
    }
    agents.push({
      terminalId: raw.terminal_id,
      paneId: raw.pane_id,
      workspaceId: raw.workspace_id,
      tabId: raw.tab_id,
      status: normalizeStatus(raw.agent_status),
      sequence:
        typeof raw.state_change_seq === "number" &&
        Number.isSafeInteger(raw.state_change_seq) &&
        raw.state_change_seq >= 0
          ? raw.state_change_seq
          : 0,
    });
  }
  return agents;
}

function paneKey(agents: readonly CodexAgent[]): string {
  return agents
    .map((agent) => agent.paneId)
    .sort()
    .join("\n");
}

export class HerdrStateSource {
  private readonly client: HerdrClient;
  private readonly reconcileMs: number;
  private readonly retryMs: number;
  private slotIds: (string | null)[] = Array.from(
    { length: SLOT_COUNT },
    () => null,
  );
  private agents = new Map<string, CodexAgent>();
  private closeSubscription: (() => void) | null = null;
  private subscriptionGeneration = 0;
  private subscribedPanes = "";
  private reconcileTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private reconciling: Promise<void> | null = null;
  private reconcileQueued = false;
  private rebuilding = false;
  private snapshotSequence = 0;
  private stopped = true;

  constructor(private readonly options: HerdrStateOptions) {
    this.client = new HerdrClient(options.socketPath);
    this.reconcileMs = options.reconcileMs ?? DEFAULT_RECONCILE_MS;
    this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.establish();
  }

  stop(): void {
    this.stopped = true;
    this.subscriptionGeneration++;
    this.closeSubscription?.();
    this.closeSubscription = null;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.reconcileTimer = null;
    this.retryTimer = null;
  }

  private async establish(): Promise<void> {
    const generation = ++this.subscriptionGeneration;
    try {
      await this.client.checkProtocol();
      const before = codexAgents(await this.client.agentList());
      if (this.stopped || generation !== this.subscriptionGeneration) return;
      const subscriptions = [
        ...BASE_SUBSCRIPTIONS,
        ...before.map((agent) => ({
          type: "pane.agent_status_changed",
          pane_id: agent.paneId,
        })),
      ];
      const close = await this.client.subscribe(
        subscriptions,
        (event) => this.onEvent(generation, event),
        () => this.onSubscriptionClosed(generation),
      );
      if (this.stopped || generation !== this.subscriptionGeneration) {
        close();
        return;
      }
      this.closeSubscription = close;
      this.subscribedPanes = paneKey(before);

      const snapshot = ++this.snapshotSequence;
      const after = codexAgents(await this.client.agentList());
      if (this.stopped || generation !== this.subscriptionGeneration) return;
      await this.applyAgents(after, generation, snapshot);
      if (this.stopped || generation !== this.subscriptionGeneration) return;
      this.startReconcileTimer();
      if (paneKey(after) !== this.subscribedPanes) this.rebuildSubscription();
    } catch (error) {
      if (!this.stopped && generation === this.subscriptionGeneration) this.disconnect(error as Error);
    }
  }

  private startReconcileTimer(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = setInterval(
      () => void this.reconcile(),
      this.reconcileMs,
    );
  }

  private onEvent(generation: number, _event: HerdrEvent): void {
    if (this.stopped || generation !== this.subscriptionGeneration) return;
    void this.reconcile();
  }

  private onSubscriptionClosed(generation: number): void {
    if (this.stopped || generation !== this.subscriptionGeneration) return;
    this.disconnect(new Error("Herdr subscription closed"));
  }

  private reconcile(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.reconciling) {
      this.reconcileQueued = true;
      return this.reconciling;
    }
    const generation = this.subscriptionGeneration;
    const snapshot = ++this.snapshotSequence;
    this.reconciling = this.client
      .agentList()
      .then(async (raw) => {
        if (this.stopped || generation !== this.subscriptionGeneration) return;
        const agents = codexAgents(raw);
        await this.applyAgents(agents, generation, snapshot);
        if (this.stopped || generation !== this.subscriptionGeneration) return;
        if (paneKey(agents) !== this.subscribedPanes) {
          this.rebuildSubscription();
        }
      })
      .catch((error: Error) => { if (generation === this.subscriptionGeneration) this.disconnect(error); })
      .finally(() => {
        this.reconciling = null;
        if (this.reconcileQueued) {
          this.reconcileQueued = false;
          void this.reconcile();
        }
      });
    return this.reconciling;
  }

  private async applyAgents(agents: readonly CodexAgent[], generation: number, snapshot: number): Promise<void> {
    if (this.stopped || generation !== this.subscriptionGeneration || snapshot !== this.snapshotSequence) return;
    let paneId: unknown;
    try {
      const result = await this.client.request("pane.current");
      if (result.type === "pane_current" && typeof result.pane === "object" && result.pane) paneId = (result.pane as Record<string, unknown>).pane_id;
    } catch { /* Selection is optional; state display remains available. */ }
    if (this.stopped || generation !== this.subscriptionGeneration || snapshot !== this.snapshotSequence) return;
    this.agents = new Map(agents.map((agent) => [agent.terminalId, agent]));
    this.slotIds = assignStickySlots(
      this.slotIds,
      agents.map((agent) => ({
        terminalId: agent.terminalId,
        status: agent.status,
        sequence: agent.sequence,
      })),
    );
    this.options.onState({
      online: true,
      selected: (() => {
        const matches = agents.filter((agent) => agent.paneId === paneId);
        const index = matches.length === 1 ? this.slotIds.indexOf(matches[0]!.terminalId) : -1;
        return index >= 0 ? index : null;
      })(),
      slots: this.slotIds.map((terminalId, index) => {
        const agent = terminalId === null ? undefined : this.agents.get(terminalId);
        return agent ? { ...agent, index } : null;
      }),
    });
  }

  private rebuildSubscription(): void {
    if (this.stopped || this.rebuilding) return;
    this.rebuilding = true;
    this.subscriptionGeneration++;
    this.closeSubscription?.();
    this.closeSubscription = null;
    void this.establish()
      .finally(() => {
        this.rebuilding = false;
      });
  }

  private disconnect(error: Error): void {
    if (this.stopped || this.retryTimer) return;
    this.subscriptionGeneration++;
    this.closeSubscription?.();
    this.closeSubscription = null;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    this.options.onState({
      online: false,
      slots: Array.from({ length: SLOT_COUNT }, () => null),
    });
    this.options.onError?.(error);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.establish();
    }, this.retryMs);
  }

}
