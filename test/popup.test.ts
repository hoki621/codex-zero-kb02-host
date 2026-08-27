import assert from "node:assert/strict";
import test from "node:test";
import { HerdrError } from "../src/herdr.js";
import { PopupController } from "../src/popup.js";
import type { HerdrState } from "../src/state.js";
import type { UsbInputContext } from "../src/usb.js";

const online: HerdrState = {
  online: true,
  slots: Array.from({ length: 6 }, () => null),
};
const down = { type: "popup", generation: 7n, action: "DOWN" } as const;
const up = { type: "popup", generation: 7n, action: "UP" } as const;

function context(current = true): UsbInputContext {
  return {
    generation: 7n,
    state: online,
    isCurrent: () => current,
    retransmit: () => {},
  };
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

test("K4 closes the active popup and stops when close succeeds", async () => {
  const herdr = new FakeHerdr(() => ({ type: "ok" }));
  const popup = new PopupController(herdr);

  assert.equal(await popup.handle(down, context()), true);
  assert.deepEqual(herdr.calls, [{ method: "popup.close", params: {} }]);
});

test("K4 opens the fixed popup only after exact popup_not_open", async () => {
  const herdr = new FakeHerdr((method) => {
    if (method === "popup.close") {
      throw new HerdrError("popup_not_open", "no popup is open");
    }
    return { type: "ok" };
  });
  const popup = new PopupController(herdr);

  assert.equal(await popup.handle(down, context()), true);
  assert.deepEqual(herdr.calls, [
    { method: "popup.close", params: {} },
    {
      method: "plugin.pane.open",
      params: {
        plugin_id: "hoki621.zero-kb02",
        entrypoint: "status",
        placement: "popup",
      },
    },
  ]);
});

test("other close errors do not open a popup", async (t) => {
  for (const error of [
    new HerdrError("invalid_params", "bad close"),
    new Error("transport failed"),
  ]) {
    await t.test(error.message, async () => {
      const herdr = new FakeHerdr(() => { throw error; });
      const popup = new PopupController(herdr);
      await assert.rejects(popup.handle(down, context()), error);
      assert.deepEqual(herdr.calls, [{ method: "popup.close", params: {} }]);
    });
  }
});

test("open errors and invalid responses are reported without retry", async (t) => {
  for (const result of [new Error("open failed"), { type: "wrong" }]) {
    await t.test(result instanceof Error ? result.message : "invalid response", async () => {
      const herdr = new FakeHerdr((method) => {
        if (method === "popup.close") {
          throw new HerdrError("popup_not_open", "no popup is open");
        }
        if (result instanceof Error) throw result;
        return result;
      });
      const popup = new PopupController(herdr);
      await assert.rejects(popup.handle(down, context()));
      assert.deepEqual(herdr.calls.map(({ method }) => method), [
        "popup.close",
        "plugin.pane.open",
      ]);
    });
  }
});

test("UP, stale generation, offline, and replaced contexts send no popup method", async () => {
  const herdr = new FakeHerdr(() => { throw new Error("must not call Herdr"); });
  const popup = new PopupController(herdr);
  let retransmits = 0;

  assert.equal(await popup.handle(up, context()), false);
  assert.equal(await popup.handle(
    { ...down, generation: 8n },
    { ...context(), retransmit: () => retransmits++ },
  ), false);
  assert.equal(await popup.handle(
    down,
    {
      ...context(),
      state: { online: false, slots: Array.from({ length: 6 }, () => null) },
      retransmit: () => retransmits++,
    },
  ), false);
  assert.equal(await popup.handle(down, context(false)), false);
  assert.equal(retransmits, 2);
  assert.equal(herdr.calls.length, 0);
});
