// Adapted from House of Herdr's Codex Micro sticky slot policy. See
// THIRD_PARTY_NOTICES.md for the pinned source and MIT license.
export const SLOT_COUNT = 6;

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface SlotAgent {
  terminalId: string;
  status: AgentStatus;
  sequence: number;
}

export function normalizeStatus(value: unknown): AgentStatus {
  switch (value) {
    case "idle":
    case "working":
    case "blocked":
    case "done":
    case "unknown":
      return value;
    default:
      return "unknown";
  }
}

function attention(status: AgentStatus): number {
  switch (status) {
    case "blocked":
      return 4;
    case "done":
      return 3;
    case "working":
      return 2;
    case "idle":
      return 1;
    case "unknown":
      return 0;
  }
}

function comparePriority(a: SlotAgent, b: SlotAgent): number {
  return (
    attention(b.status) - attention(a.status) ||
    b.sequence - a.sequence ||
    a.terminalId.localeCompare(b.terminalId)
  );
}

export function assignStickySlots(
  previous: readonly (string | null)[],
  agents: readonly SlotAgent[],
): (string | null)[] {
  const sorted = [...agents].sort(comparePriority);
  const byId = new Map(agents.map((agent) => [agent.terminalId, agent]));
  const slots = Array.from({ length: SLOT_COUNT }, (_, index) => {
    const id = previous[index] ?? null;
    return id !== null && byId.has(id) ? id : null;
  });
  const slotted = new Set(slots.filter((id): id is string => id !== null));

  for (const candidate of sorted) {
    if (slotted.has(candidate.terminalId)) continue;
    const empty = slots.indexOf(null);
    if (empty !== -1) {
      slots[empty] = candidate.terminalId;
      slotted.add(candidate.terminalId);
      continue;
    }

    let victim: { index: number; agent: SlotAgent } | null = null;
    for (let index = 0; index < SLOT_COUNT; index++) {
      const id = slots[index];
      const agent = id === null || id === undefined ? undefined : byId.get(id);
      if (!agent) continue;
      if (victim === null || comparePriority(agent, victim.agent) > 0) {
        victim = { index, agent };
      }
    }
    if (
      victim === null ||
      attention(candidate.status) <= attention(victim.agent.status)
    ) {
      break;
    }
    slotted.delete(victim.agent.terminalId);
    slots[victim.index] = candidate.terminalId;
    slotted.add(candidate.terminalId);
  }
  return slots;
}
