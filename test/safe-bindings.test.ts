import assert from "node:assert/strict";
import test from "node:test";
import {
  SafeBindings,
  parseDeviceMessage,
  type HerdrState,
  type RawAgent,
  type SlotState,
  type UsbInputContext,
} from "../src/index.js";

function slot(index: number): SlotState {
  return {
    index,
    terminalId: `terminal-${index}`,
    paneId: `cached-pane-${index}`,
    workspaceId: "workspace",
    tabId: "tab",
    status: "idle",
    sequence: 1,
  };
}

function online(slots: readonly (SlotState | null)[] = Array.from({ length: 6 }, (_, index) => slot(index))): HerdrState {
  return { online: true, slots };
}

function agent(index: number, paneId = `live-pane-${index}`): RawAgent {
  return { agent: "codex", terminal_id: `terminal-${index}`, pane_id: paneId };
}

function parsed(line: string) {
  const message = parseDeviceMessage(line);
  assert.ok(message);
  return message;
}

function inputContext(state: HerdrState, generation = 7n) {
  let current = true;
  let retransmits = 0;
  const context: UsbInputContext = {
    generation,
    state,
    isCurrent: () => current,
    retransmit: () => { retransmits += 1; },
  };
  return {
    context,
    invalidate: () => { current = false; },
    retransmits: () => retransmits,
  };
}

test("K2,K3,K5-K8 route slots 0-5 through fresh terminal-to-pane resolution", async () => {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const herdr = {
    agentList: async () => Array.from({ length: 6 }, (_, index) => agent(index)),
    request: async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      return {};
    },
  };
  const router = new SafeBindings(herdr);
  const { context } = inputContext(online());

  for (let index = 0; index < 6; index++) {
    assert.equal(await router.handle(parsed(`KEY 7 ${index} DOWN`), context), true);
  }
  assert.deepEqual(requests, Array.from({ length: 6 }, (_, index) => ({
    method: "agent.focus",
    params: { target: `live-pane-${index}` },
  })));
});

test("stale, offline, empty, UP, ENC, and JOY inputs perform no operation", async () => {
  let lists = 0;
  const requests: string[] = [];
  const router = new SafeBindings({
    agentList: async () => { lists += 1; return [agent(0)]; },
    request: async (method: string) => { requests.push(method); return {}; },
  });
  const current = inputContext(online());
  assert.equal(await router.handle(parsed("KEY 6 0 DOWN"), current.context), false);
  assert.equal(current.retransmits(), 1);

  const offline = inputContext({ online: false, slots: [] });
  assert.equal(await router.handle(parsed("KEY 7 0 DOWN"), offline.context), false);
  assert.equal(offline.retransmits(), 1);

  const empty = inputContext(online([null, null, null, null, null, null]));
  assert.equal(await router.handle(parsed("KEY 7 0 DOWN"), empty.context), false);
  assert.equal(await router.handle(parsed("KEY 7 0 UP"), current.context), false);
  assert.equal(await router.handle(parsed("ENC 7 CW"), current.context), false);
  assert.equal(await router.handle(parsed("JOY 7 LEFT"), current.context), false);
  assert.equal(lists, 0);
  assert.deepEqual(requests, []);
});

test("disappeared, duplicate, or remapped agents are rejected before focus", async () => {
  const requests: string[] = [];
  const missingRouter = new SafeBindings({
    agentList: async () => [],
    request: async (method: string) => { requests.push(method); return {}; },
  });
  assert.equal(await missingRouter.handle(parsed("KEY 7 0 DOWN"), inputContext(online()).context), false);

  const duplicateRouter = new SafeBindings({
    agentList: async () => [agent(0, "pane-a"), agent(0, "pane-b")],
    request: async (method: string) => { requests.push(method); return {}; },
  });
  assert.equal(await duplicateRouter.handle(parsed("KEY 7 0 DOWN"), inputContext(online()).context), false);

  const changed = inputContext(online());
  const changedRouter = new SafeBindings({
    agentList: async () => { changed.invalidate(); return [agent(0)]; },
    request: async (method: string) => { requests.push(method); return {}; },
  });
  assert.equal(await changedRouter.handle(parsed("KEY 7 0 DOWN"), changed.context), false);
  assert.deepEqual(requests, []);
});
