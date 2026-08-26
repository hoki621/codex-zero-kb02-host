import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DeviceMessage } from "./cdc.js";
import type { HerdrClient } from "./herdr.js";
import type { HerdrState } from "./state.js";
import type { UsbInputContext } from "./usb.js";
import {
  OWNERSHIP_PATH,
  PLUGIN_ENTRYPOINT,
  PLUGIN_ID,
} from "./status.js";

const PLUGIN_NAME = "zero-kb02 Status";
const PLUGIN_VERSION = "0.1.0";
const MIN_HERDR_VERSION = "0.8.2";
const POPUP_COMMAND = ["node", "dist/src/status-popup.js"] as const;

type PopupClient = Pick<HerdrClient, "request">;
type OwnershipPhase = "closed" | "opening" | "owned" | "stale";

interface OpeningRecord {
  version: 1;
  phase: "opening";
  daemonSession: string;
  herdrEpoch: number;
}

interface OwnedRecord extends Omit<OpeningRecord, "phase"> {
  phase: "owned";
  paneId: string;
}

type OwnershipRecord = OpeningRecord | OwnedRecord;

export interface OwnershipStore {
  hasRecord(): boolean;
  write(record: OwnershipRecord): void;
  clear(): void;
}

export class FileOwnershipStore implements OwnershipStore {
  constructor(readonly recordPath = OWNERSHIP_PATH) {}

  hasRecord(): boolean {
    try {
      fs.readFileSync(this.recordPath);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
  }

  write(record: OwnershipRecord): void {
    const directory = path.dirname(this.recordPath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const temporary = `${this.recordPath}.${record.daemonSession}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(record) + "\n", {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      fs.renameSync(temporary, this.recordPath);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  clear(): void {
    fs.unlinkSync(this.recordPath);
  }
}

interface CurrentPane {
  paneId: string;
  workspaceId: string;
}

function currentPane(result: Record<string, unknown>): CurrentPane | null {
  if (
    result.type !== "pane_current" ||
    typeof result.pane !== "object" ||
    result.pane === null
  ) {
    return null;
  }
  const pane = result.pane as Record<string, unknown>;
  return typeof pane.pane_id === "string" &&
    pane.pane_id.length > 0 &&
    typeof pane.workspace_id === "string" &&
    pane.workspace_id.length > 0
    ? { paneId: pane.pane_id, workspaceId: pane.workspace_id }
    : null;
}

function sameCommand(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) &&
    value.length === expected.length &&
    value.every((part, index) => part === expected[index]);
}

function exactPlugin(
  result: Record<string, unknown>,
  hostRoot: string,
): boolean {
  if (result.type !== "plugin_list" || !Array.isArray(result.plugins)) {
    return false;
  }
  if (result.plugins.length !== 1) return false;
  const plugin = result.plugins[0];
  if (
    typeof plugin !== "object" ||
    plugin === null ||
    (plugin as Record<string, unknown>).plugin_id !== PLUGIN_ID
  ) return false;
  const exact = plugin as Record<string, unknown>;
  const source = exact.source as Record<string, unknown> | undefined;
  const panes = exact.panes;
  const build = exact.build;
  if (
    exact.name !== PLUGIN_NAME ||
    exact.version !== PLUGIN_VERSION ||
    exact.min_herdr_version !== MIN_HERDR_VERSION ||
    exact.enabled !== true ||
    source?.kind !== "local" ||
    !Array.isArray(exact.warnings) ||
    exact.warnings.length !== 0 ||
    !Array.isArray(exact.platforms) ||
    exact.platforms.length !== 1 ||
    exact.platforms[0] !== "macos" ||
    !Array.isArray(build) ||
    build.length !== 2 ||
    !sameCommand((build[0] as Record<string, unknown>)?.command, ["npm", "ci"]) ||
    !sameCommand((build[1] as Record<string, unknown>)?.command, ["npm", "run", "build"]) ||
    !Array.isArray(panes) ||
    panes.length !== 1
  ) {
    return false;
  }
  const pane = panes[0] as Record<string, unknown>;
  if (
    pane.id !== PLUGIN_ENTRYPOINT ||
    pane.title !== "zero-kb02 status" ||
    pane.placement !== "popup" ||
    pane.width !== 160 ||
    pane.height !== 22 ||
    !sameCommand(pane.command, POPUP_COMMAND)
  ) {
    return false;
  }
  try {
    const expectedRoot = fs.realpathSync(hostRoot);
    return (
      typeof exact.plugin_root === "string" &&
      fs.realpathSync(exact.plugin_root) === expectedRoot &&
      typeof exact.manifest_path === "string" &&
      fs.realpathSync(exact.manifest_path) ===
        fs.realpathSync(path.join(expectedRoot, "herdr-plugin.toml")) &&
      ["actions", "events", "link_handlers", "startup"].every((field) => {
        const value = exact[field];
        return value === undefined || (Array.isArray(value) && value.length === 0);
      })
    );
  } catch {
    return false;
  }
}

function openedPane(
  result: Record<string, unknown>,
  workspaceId: string,
): string | null {
  if (
    result.type !== "plugin_pane_opened" ||
    typeof result.plugin_pane !== "object" ||
    result.plugin_pane === null
  ) {
    return null;
  }
  const pluginPane = result.plugin_pane as Record<string, unknown>;
  if (
    pluginPane.plugin_id !== PLUGIN_ID ||
    pluginPane.entrypoint !== PLUGIN_ENTRYPOINT ||
    typeof pluginPane.pane !== "object" ||
    pluginPane.pane === null
  ) {
    return null;
  }
  const pane = pluginPane.pane as Record<string, unknown>;
  return typeof pane.pane_id === "string" &&
    pane.pane_id.length > 0 &&
    pane.workspace_id === workspaceId
    ? pane.pane_id
    : null;
}

export class PopupController {
  private readonly daemonSession: string;
  private phase: OwnershipPhase;
  private paneId: string | null = null;
  private herdrEpoch = 1;
  private herdrOnline = false;
  private busy = false;

  constructor(
    private readonly herdr: PopupClient,
    private readonly store: OwnershipStore,
    private readonly hostRoot: string,
    sessionId: string = randomUUID(),
  ) {
    this.daemonSession = sessionId;
    this.phase = store.hasRecord() ? "stale" : "closed";
  }

  get ownershipState(): OwnershipPhase {
    return this.phase;
  }

  observeState(state: HerdrState): void {
    if (this.herdrOnline && !state.online) {
      this.herdrEpoch++;
      if (this.phase === "opening" || this.phase === "owned") {
        this.phase = "stale";
        this.paneId = null;
      }
    }
    this.herdrOnline = state.online;
  }

  async handle(
    message: DeviceMessage,
    context: UsbInputContext,
  ): Promise<boolean> {
    const staleContext =
      message.type === "popup" &&
      (message.generation !== context.generation || !context.state?.online);
    if (staleContext) context.retransmit();
    if (
      message.type !== "popup" ||
      message.action !== "DOWN" ||
      staleContext ||
      !this.herdrOnline ||
      this.phase === "stale" ||
      this.busy
    ) {
      return false;
    }
    this.busy = true;
    try {
      return this.phase === "owned"
        ? await this.close(context)
        : await this.open(context);
    } finally {
      this.busy = false;
    }
  }

  async shutdown(): Promise<void> {
    if (this.phase !== "owned" || !this.paneId || !this.herdrOnline) return;
    const paneId = this.paneId;
    try {
      const result = await this.herdr.request("plugin.pane.close", { pane_id: paneId });
      if (result.type !== "plugin_pane_closed" || result.pane_id !== paneId) {
        this.phase = "stale";
        this.paneId = null;
        return;
      }
      this.store.clear();
      this.phase = "closed";
      this.paneId = null;
    } catch {
      this.phase = "stale";
      this.paneId = null;
    }
  }

  private async open(context: UsbInputContext): Promise<boolean> {
    const first = currentPane(await this.herdr.request("pane.current", {}));
    if (!first) return false;
    const plugins = await this.herdr.request("plugin.list", { plugin_id: PLUGIN_ID });
    if (!exactPlugin(plugins, this.hostRoot)) return false;
    const final = currentPane(await this.herdr.request("pane.current", {}));
    if (
      !final ||
      final.paneId !== first.paneId ||
      final.workspaceId !== first.workspaceId ||
      !context.isCurrent()
    ) {
      return false;
    }
    const epoch = this.herdrEpoch;
    const opening: OpeningRecord = {
      version: 1,
      phase: "opening",
      daemonSession: this.daemonSession,
      herdrEpoch: epoch,
    };
    this.store.write(opening);
    this.phase = "opening";

    let result: Record<string, unknown>;
    try {
      result = await this.herdr.request("plugin.pane.open", {
        plugin_id: PLUGIN_ID,
        entrypoint: PLUGIN_ENTRYPOINT,
        placement: "popup",
        target_pane_id: final.paneId,
        focus: false,
      });
    } catch {
      this.phase = "stale";
      return false;
    }
    const paneId = openedPane(result, final.workspaceId);
    if (
      !paneId ||
      this.phase !== "opening" ||
      this.herdrEpoch !== epoch ||
      !context.isCurrent()
    ) {
      this.phase = "stale";
      return false;
    }
    try {
      this.store.write({ ...opening, phase: "owned", paneId });
    } catch {
      await this.bestEffortClose(paneId);
      this.phase = "stale";
      return false;
    }
    this.phase = "owned";
    this.paneId = paneId;
    return true;
  }

  private async close(context: UsbInputContext): Promise<boolean> {
    const paneId = this.paneId;
    if (!paneId || !context.isCurrent()) return false;
    let result: Record<string, unknown>;
    try {
      result = await this.herdr.request("plugin.pane.close", { pane_id: paneId });
    } catch {
      this.phase = "stale";
      this.paneId = null;
      return false;
    }
    if (result.type !== "plugin_pane_closed" || result.pane_id !== paneId) {
      this.phase = "stale";
      this.paneId = null;
      return false;
    }
    try {
      this.store.clear();
    } catch {
      this.phase = "stale";
      this.paneId = null;
      return false;
    }
    this.phase = "closed";
    this.paneId = null;
    return true;
  }

  private async bestEffortClose(paneId: string): Promise<void> {
    try {
      await this.herdr.request("plugin.pane.close", { pane_id: paneId });
    } catch {
      // The stale marker remains the authority after ambiguous cleanup.
    }
  }
}
