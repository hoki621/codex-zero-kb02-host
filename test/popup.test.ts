import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileOwnershipStore, PopupController, type OwnershipStore } from "../src/popup.js";
import type { HerdrState } from "../src/state.js";
import type { UsbInputContext } from "../src/usb.js";

const online: HerdrState = { online: true, slots: Array.from({ length: 6 }, () => null) };
const down = { type: "popup", generation: 7n, action: "DOWN" } as const;
const up = { type: "popup", generation: 7n, action: "UP" } as const;

function context(current = true): UsbInputContext {
  return { generation: 7n, state: online, isCurrent: () => current, retransmit: () => {} };
}

function currentPane(paneId = "focus", workspaceId = "workspace") {
  return { type: "pane_current", pane: { pane_id: paneId, workspace_id: workspaceId } };
}

function plugin(root: string, overrides: Record<string, unknown> = {}) {
  return {
    plugin_id: "hoki621.zero-kb02",
    name: "zero-kb02 Status",
    version: "0.1.0",
    min_herdr_version: "0.8.2",
    enabled: true,
    source: { kind: "local" },
    plugin_root: root,
    manifest_path: path.join(root, "herdr-plugin.toml"),
    warnings: [],
    platforms: ["macos"],
    build: [{ command: ["npm", "ci"] }, { command: ["npm", "run", "build"] }],
    panes: [{
      id: "status",
      title: "zero-kb02 status",
      placement: "popup",
      width: 160,
      height: 22,
      command: ["node", "dist/src/status-popup.js"],
    }],
    ...overrides,
  };
}

function opened(paneId = "owned", workspaceId = "workspace") {
  return {
    type: "plugin_pane_opened",
    plugin_pane: {
      plugin_id: "hoki621.zero-kb02",
      entrypoint: "status",
      pane: { pane_id: paneId, workspace_id: workspaceId },
    },
  };
}

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zero-kb02-popup-"));
  fs.writeFileSync(path.join(root, "herdr-plugin.toml"), "id='test'\n");
  const record = path.join(root, "state", "owned-pane.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, record };
}

class FakeHerdr {
  calls: { method: string; params: Record<string, unknown> }[] = [];
  constructor(private readonly respond: (
    method: string,
    params: Record<string, unknown>,
    call: number,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>) {}
  async request(method: string, params: Record<string, unknown> = {}) {
    this.calls.push({ method, params });
    return this.respond(method, params, this.calls.length);
  }
}

test("K4 opens the exact plugin and closes only its returned pane id", async (t) => {
  const { root, record } = fixture(t);
  const herdr = new FakeHerdr((method) => {
    if (method === "pane.current") return currentPane();
    if (method === "plugin.list") {
      const exact = plugin(root);
      Reflect.deleteProperty(exact, "warnings");
      return { type: "plugin_list", plugins: [exact] };
    }
    if (method === "plugin.pane.open") return opened();
    if (method === "plugin.pane.close") return { type: "plugin_pane_closed", pane_id: "owned" };
    throw new Error(`unexpected ${method}`);
  });
  const controller = new PopupController(herdr, new FileOwnershipStore(record), root, "session");
  assert.equal(await controller.handle(down, context()), false);
  assert.equal(herdr.calls.length, 0);
  controller.observeState(online);

  assert.equal(await controller.handle(up, context()), false);
  assert.equal(await controller.handle(down, context()), true);
  assert.equal(controller.ownershipState, "owned");
  assert.equal(JSON.parse(fs.readFileSync(record, "utf8")).paneId, "owned");
  assert.equal(await controller.handle(down, context()), true);
  assert.equal(controller.ownershipState, "closed");
  assert.equal(fs.existsSync(record), false);
  assert.deepEqual(herdr.calls.map(({ method }) => method), [
    "pane.current", "plugin.list", "pane.current", "plugin.pane.open", "plugin.pane.close",
  ]);
  assert.deepEqual(herdr.calls[3]!.params, {
    plugin_id: "hoki621.zero-kb02",
    entrypoint: "status",
    placement: "popup",
    target_pane_id: "focus",
    focus: false,
  });
  assert.deepEqual(herdr.calls[4]!.params, { pane_id: "owned" });
  assert.equal(herdr.calls.some(({ method }) => method === "popup.close"), false);
});

test("missing, disabled, duplicate, or mismatched plugins fail before open", async (t) => {
  const cases: [string, (root: string) => Record<string, unknown>[]][] = [
    ["missing", () => []],
    ["disabled", (root) => [plugin(root, { enabled: false })]],
    ["duplicate", (root) => [plugin(root), plugin(root)]],
    ["foreign extra", (root) => [plugin(root), { plugin_id: "foreign.plugin" }]],
    ["mismatched pane", (root) => [plugin(root, { panes: [] })]],
  ];
  for (const [name, entries] of cases) {
    await t.test(name, async (t) => {
      const { root, record } = fixture(t);
      const herdr = new FakeHerdr((method) => {
        if (method === "pane.current") return currentPane();
        if (method === "plugin.list") return { type: "plugin_list", plugins: entries(root) };
        throw new Error(`unexpected ${method}`);
      });
      const controller = new PopupController(herdr, new FileOwnershipStore(record), root);
      controller.observeState(online);
      assert.equal(await controller.handle(down, context()), false);
      assert.deepEqual(herdr.calls.map(({ method }) => method), ["pane.current", "plugin.list"]);
      assert.equal(fs.existsSync(record), false);
    });
  }
});

test("focus and generation races do not create an ownership record", async (t) => {
  const { root, record } = fixture(t);
  let paneReads = 0;
  const herdr = new FakeHerdr((method) => {
    if (method === "pane.current") return currentPane(++paneReads === 1 ? "first" : "second");
    if (method === "plugin.list") return { type: "plugin_list", plugins: [plugin(root)] };
    throw new Error(`unexpected ${method}`);
  });
  const controller = new PopupController(herdr, new FileOwnershipStore(record), root);
  controller.observeState(online);
  assert.equal(await controller.handle(down, context()), false);
  assert.equal(fs.existsSync(record), false);
  let retransmits = 0;
  assert.equal(await controller.handle(
    { ...down, generation: 8n },
    { ...context(), retransmit: () => retransmits++ },
  ), false);
  assert.equal(retransmits, 1);
  assert.equal(await controller.handle(
    down,
    { ...context(), state: { online: false, slots: [] }, retransmit: () => retransmits++ },
  ), false);
  assert.equal(retransmits, 2);
});

test("invalid open and failed targeted close lock without replacement open", async (t) => {
  const { root, record } = fixture(t);
  let invalidOpen = true;
  const herdr = new FakeHerdr((method) => {
    if (method === "pane.current") return currentPane();
    if (method === "plugin.list") return { type: "plugin_list", plugins: [plugin(root)] };
    if (method === "plugin.pane.open") return invalidOpen ? { type: "wrong" } : opened();
    if (method === "plugin.pane.close") throw new Error("close failed");
    throw new Error(`unexpected ${method}`);
  });
  let controller = new PopupController(herdr, new FileOwnershipStore(record), root);
  controller.observeState(online);
  assert.equal(await controller.handle(down, context()), false);
  assert.equal(controller.ownershipState, "stale");
  const calls = herdr.calls.length;
  assert.equal(await controller.handle(down, context()), false);
  assert.equal(herdr.calls.length, calls);

  fs.rmSync(record);
  invalidOpen = false;
  controller = new PopupController(herdr, new FileOwnershipStore(record), root);
  controller.observeState(online);
  assert.equal(await controller.handle(down, context()), true);
  assert.equal(await controller.handle(down, context()), false);
  assert.equal(controller.ownershipState, "stale");
  assert.equal(fs.existsSync(record), true);
  assert.equal(herdr.calls.some(({ method }) => method === "popup.close"), false);
});

test("stale records and Herdr reconnects never close or reopen panes", async (t) => {
  const { root, record } = fixture(t);
  fs.mkdirSync(path.dirname(record), { recursive: true });
  fs.writeFileSync(record, "stale\n");
  const herdr = new FakeHerdr(() => { throw new Error("must not call Herdr"); });
  let controller = new PopupController(herdr, new FileOwnershipStore(record), root);
  controller.observeState(online);
  assert.equal(await controller.handle(down, context()), false);
  assert.equal(herdr.calls.length, 0);

  fs.rmSync(record);
  const active = new FakeHerdr((method) => {
    if (method === "pane.current") return currentPane();
    if (method === "plugin.list") return { type: "plugin_list", plugins: [plugin(root)] };
    if (method === "plugin.pane.open") return opened();
    throw new Error(`unexpected ${method}`);
  });
  controller = new PopupController(active, new FileOwnershipStore(record), root);
  controller.observeState(online);
  assert.equal(await controller.handle(down, context()), true);
  controller.observeState({ online: false, slots: Array.from({ length: 6 }, () => null) });
  controller.observeState(online);
  const calls = active.calls.length;
  assert.equal(controller.ownershipState, "stale");
  assert.equal(await controller.handle(down, context()), false);
  assert.equal(active.calls.length, calls);
});

test("record write failures fail closed; owned persistence cleanup is targeted", async (t) => {
  const { root } = fixture(t);
  class FailingStore implements OwnershipStore {
    writes = 0;
    constructor(private readonly failAt: number) {}
    hasRecord() { return false; }
    write() {
      this.writes++;
      if (this.writes === this.failAt) throw new Error("persist failed");
    }
    clear() {}
  }
  const herdr = new FakeHerdr((method, params) => {
    if (method === "pane.current") return currentPane();
    if (method === "plugin.list") return { type: "plugin_list", plugins: [plugin(root)] };
    if (method === "plugin.pane.open") return opened();
    if (method === "plugin.pane.close") {
      assert.deepEqual(params, { pane_id: "owned" });
      return { type: "plugin_pane_closed", pane_id: "owned" };
    }
    throw new Error(`unexpected ${method}`);
  });
  let controller = new PopupController(herdr, new FailingStore(1), root);
  controller.observeState(online);
  await assert.rejects(controller.handle(down, context()), /persist failed/);
  assert.equal(herdr.calls.some(({ method }) => method === "plugin.pane.open"), false);

  controller = new PopupController(herdr, new FailingStore(2), root);
  controller.observeState(online);
  assert.equal(await controller.handle(down, context()), false);
  assert.equal(controller.ownershipState, "stale");
  assert.equal(herdr.calls.at(-1)!.method, "plugin.pane.close");
});
