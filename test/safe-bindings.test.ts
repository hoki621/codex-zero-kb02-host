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

test("K1 Escape uses focused mapped Codex pane and a final focus recheck", async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const herdr = {
    agentList: async () => {
      calls.push({ method: "agent.list", params: {} });
      return [agent(0, "focused-pane"), agent(1, "other-pane")];
    },
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return method === "pane.current"
        ? { type: "pane_current", pane: { pane_id: "focused-pane" } }
        : {};
    },
  };
  const router = new SafeBindings(herdr);

  assert.equal(await router.handle(parsed("ESC 7 DOWN"), inputContext(online()).context), true);
  assert.deepEqual(calls, [
    { method: "pane.current", params: {} },
    { method: "agent.list", params: {} },
    { method: "pane.current", params: {} },
    { method: "agent.send_keys", params: { target: "focused-pane", keys: ["esc"] } },
  ]);
});

test("K9/K10 send one fixed key to the focused mapped blocked Codex pane", async () => {
  for (const [line, key] of [["APPROVE 7 DOWN", "y"], ["REJECT 7 DOWN", "n"]] as const) {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    let lists = 0;
    const herdr = {
      agentList: async () => {
        lists += 1;
        return [{ ...agent(0, "focused-pane"), agent_status: "blocked" }, agent(1, "other-pane")];
      },
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        return method === "pane.current"
          ? { type: "pane_current", pane: { pane_id: "focused-pane" } }
          : {};
      },
    };
    const router = new SafeBindings(herdr);

    assert.equal(await router.handle(parsed(line), inputContext(online()).context), true);
    assert.equal(lists, 2);
    assert.deepEqual(calls, [
      { method: "pane.current", params: {} },
      { method: "pane.current", params: {} },
      { method: "agent.send_keys", params: { target: "focused-pane", keys: [key] } },
    ]);
  }
});

test("K9/K10 reject non-blocked and changed final agents", async () => {
  for (const line of ["APPROVE 7 DOWN", "REJECT 7 DOWN"]) {
    for (const status of ["idle", "working", "done", "unknown", undefined]) {
      const sent: string[] = [];
      const router = new SafeBindings({
        agentList: async () => [{ ...agent(0, "focused-pane"), agent_status: status }],
        request: async (method: string) => {
          if (method === "agent.send_keys") sent.push(method);
          return { type: "pane_current", pane: { pane_id: "focused-pane" } };
        },
      });
      assert.equal(await router.handle(parsed(line), inputContext(online()).context), false);
      assert.deepEqual(sent, []);
    }

    for (const finalAgent of [
      { ...agent(0, "focused-pane"), agent_status: "idle" },
      { ...agent(1, "focused-pane"), agent_status: "blocked" },
    ]) {
      const sent: string[] = [];
      const agents = [
        [{ ...agent(0, "focused-pane"), agent_status: "blocked" }],
        [finalAgent],
      ];
      const router = new SafeBindings({
        agentList: async () => agents.shift() ?? [],
        request: async (method: string) => {
          if (method === "agent.send_keys") sent.push(method);
          return { type: "pane_current", pane: { pane_id: "focused-pane" } };
        },
      });
      assert.equal(await router.handle(parsed(line), inputContext(online()).context), false);
      assert.deepEqual(sent, []);
    }
  }
});

test("K12 New Chat sends only the fixed command when focused status accepts text", async () => {
  for (const status of ["idle", "done"]) {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    let lists = 0;
    const herdr = {
      agentList: async () => {
        lists += 1;
        return [{ ...agent(0, "focused-pane"), agent_status: status }, agent(1, "other-pane")];
      },
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        return method === "pane.current"
          ? { type: "pane_current", pane: { pane_id: "focused-pane" } }
          : {};
      },
    };
    const router = new SafeBindings(herdr);

    assert.equal(await router.handle(parsed("NEW 7 DOWN"), inputContext(online()).context), true);
    assert.equal(lists, 2);
    assert.deepEqual(calls, [
      { method: "pane.current", params: {} },
      { method: "pane.current", params: {} },
      { method: "agent.prompt", params: { target: "focused-pane", text: "/new" } },
    ]);
  }
});

test("K12 New Chat rejects non-input agent statuses", async () => {
  for (const status of ["working", "blocked", "unknown", undefined]) {
    const sent: string[] = [];
    const router = new SafeBindings({
      agentList: async () => [{ ...agent(0, "focused-pane"), agent_status: status }],
      request: async (method: string) => {
        if (method === "agent.send_keys" || method === "agent.prompt") sent.push(method);
        return { type: "pane_current", pane: { pane_id: "focused-pane" } };
      },
    });
    assert.equal(await router.handle(parsed("NEW 7 DOWN"), inputContext(online()).context), false);
    assert.deepEqual(sent, []);
  }
});

test("K12 New Chat rejects final status or terminal identity changes", async () => {
  for (const finalAgent of [
    { ...agent(0, "focused-pane"), agent_status: "working" },
    { ...agent(1, "focused-pane"), agent_status: "idle" },
  ]) {
    const sent: string[] = [];
    const agents = [
      [{ ...agent(0, "focused-pane"), agent_status: "idle" }],
      [finalAgent],
    ];
    const router = new SafeBindings({
      agentList: async () => agents.shift() ?? [],
      request: async (method: string) => {
        if (method === "agent.send_keys" || method === "agent.prompt") sent.push(method);
        return { type: "pane_current", pane: { pane_id: "focused-pane" } };
      },
    });
    assert.equal(await router.handle(parsed("NEW 7 DOWN"), inputContext(online()).context), false);
    assert.deepEqual(sent, []);
  }
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
  assert.equal(await router.handle(parsed("ESC 6 DOWN"), current.context), false);
  assert.equal(await router.handle(parsed("NEW 6 DOWN"), current.context), false);
  assert.equal(await router.handle(parsed("APPROVE 6 DOWN"), current.context), false);
  assert.equal(await router.handle(parsed("REJECT 6 DOWN"), current.context), false);
  assert.equal(current.retransmits(), 5);

  const offline = inputContext({ online: false, slots: [] });
  assert.equal(await router.handle(parsed("KEY 7 0 DOWN"), offline.context), false);
  assert.equal(await router.handle(parsed("ESC 7 DOWN"), offline.context), false);
  assert.equal(await router.handle(parsed("NEW 7 DOWN"), offline.context), false);
  assert.equal(await router.handle(parsed("APPROVE 7 DOWN"), offline.context), false);
  assert.equal(await router.handle(parsed("REJECT 7 DOWN"), offline.context), false);
  assert.equal(offline.retransmits(), 5);

  const empty = inputContext(online([null, null, null, null, null, null]));
  assert.equal(await router.handle(parsed("KEY 7 0 DOWN"), empty.context), false);
  assert.equal(await router.handle(parsed("KEY 7 0 UP"), current.context), false);
  assert.equal(await router.handle(parsed("ESC 7 UP"), current.context), false);
  assert.equal(await router.handle(parsed("NEW 7 UP"), current.context), false);
  assert.equal(await router.handle(parsed("APPROVE 7 UP"), current.context), false);
  assert.equal(await router.handle(parsed("REJECT 7 UP"), current.context), false);
  assert.equal(await router.handle(parsed("ENC 7 CW"), current.context), false);
  assert.equal(await router.handle(parsed("JOY 7 LEFT"), current.context), false);
  assert.equal(lists, 0);
  assert.deepEqual(requests, []);
});

test("focused text controls reject unsafe focus, identity, mapping, and final recheck states", async () => {
  const cases: {
    name: string;
    agents: RawAgent[];
    panes?: (string | null)[];
    state?: HerdrState;
    invalidateBeforeFinal?: boolean;
  }[] = [
    { name: "no focused pane", agents: [], panes: [null] },
    { name: "missing agent", agents: [] },
    { name: "non-Codex focus", agents: [{ agent: "claude", terminal_id: "terminal-0", pane_id: "focused-pane" }] },
    { name: "empty terminal id", agents: [{ agent: "codex", terminal_id: "", pane_id: "focused-pane" }] },
    { name: "duplicate focused Codex agents", agents: [agent(0, "focused-pane"), agent(1, "focused-pane")] },
    { name: "duplicate terminal identity across panes", agents: [agent(0, "focused-pane"), agent(0, "other-pane")] },
    { name: "agent outside slot mapping", agents: [{ agent: "codex", terminal_id: "other", pane_id: "focused-pane" }] },
    { name: "duplicate slot mapping", agents: [agent(0, "focused-pane")], state: online([slot(0), slot(0), null, null, null, null]) },
    { name: "focus changed", agents: [agent(0, "focused-pane")], panes: ["focused-pane", "other-pane"] },
    { name: "mapping invalidated", agents: [agent(0, "focused-pane")], invalidateBeforeFinal: true },
  ];

  for (const line of ["ESC 7 DOWN", "NEW 7 DOWN", "APPROVE 7 DOWN", "REJECT 7 DOWN"]) {
    for (const testCase of cases) {
      const sent: string[] = [];
      const current = inputContext(testCase.state ?? online());
      let paneRead = 0;
      const status = line.startsWith("NEW") ? "idle" : line.startsWith("APPROVE") || line.startsWith("REJECT") ? "blocked" : undefined;
      const agents = status === undefined
        ? testCase.agents
        : testCase.agents.map((candidate) => ({ ...candidate, agent_status: status }));
      const router = new SafeBindings({
        agentList: async () => agents,
        request: async (method: string) => {
          if (method === "agent.send_keys" || method === "agent.prompt") {
            sent.push(method);
            return {};
          }
          if (testCase.invalidateBeforeFinal && paneRead === 1) current.invalidate();
          const paneId = (testCase.panes ?? ["focused-pane", "focused-pane"])[paneRead++] ?? null;
          return { type: "pane_current", pane: paneId === null ? null : { pane_id: paneId } };
        },
      });
      assert.equal(await router.handle(parsed(line), current.context), false, `${line}: ${testCase.name}`);
      assert.deepEqual(sent, [], `${line}: ${testCase.name}`);
    }
  }
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
