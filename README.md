# codex-zero-kb02-host

Herdr and USB CDC Host bridge for the unofficial
[`codex-zero-kb02`](https://github.com/hoki621/codex-zero-kb02) project.

Implementation work is tracked in the parent repository. This repository owns
Herdr state collection, stable agent-slot assignment, USB CDC transport, and
safe allow-listed physical controls. It does not own TinyGo firmware.

Print a complete CDC state frame without opening a serial device:

```sh
npm run dry-run -- WIBDUE
```

## PC setup and startup

Use Node.js 22 and the Homebrew Codex cask (`brew install --cask codex`).
The launcher resolves `brew --prefix` → `bin/codex` → the cask's real binary;
other `codex` entries in PATH are reported but are never used. Existing Codex
settings, credentials, history and standalone installations are left in place.

```sh
npm ci
npm run build
npm link
codex-micro doctor
herdr plugin link --enabled "$(pwd)"
```

The plugin command registers this repository's fixed `hoki621.zero-kb02`
manifest. Run it once; the bridge does not modify the registry automatically.

1. In a separate normal Terminal, run `codex-micro server` and leave it open.
   It starts the brew binary's `app-server --listen unix://...` on a private,
   dedicated socket. It does not use `app-server daemon start` or another
   application's daemon. A second start fails without replacing the owner.
2. In each Herdr pane that needs reasoning control, run `codex-micro`
   (or `codex-micro resume`, `codex-micro fork`). It uses the exact binary and
   version recorded by the server; after a brew upgrade restart the server.
3. When the hardware is ready and device access has been approved, start the
   bridge from another normal Terminal, outside Herdr-managed panes:

   ```sh
   HERDR_SOCKET_PATH="$HOME/.config/herdr/herdr.sock" ZERO_KB02_PORT=/dev/cu.usbmodemzero_kb02_v11 npm start
   ```

Finish remote Codex sessions, then Ctrl-C the `codex-micro server` Terminal to
stop it. To restart, run the same command. Stopping/restarting the Host bridge
or one CLI pane leaves this server and other CLI sessions running. A server
restart requires restarting remote CLI connections and resuming their threads.
Do not stop the server while another pane is using it.

`codex-micro doctor` prints the resolved cask path/version, existing PATH
binaries and the recorded server PID/socket. It opens no Herdr or USB device.
If a crash leaves a stale server directory, use the exact directory and PID
shown in its `server.json`: verify with `ps -p PID -o pid=,command=` and
`lsof /exact/path/app.sock` that the recorded process/socket is no longer in
use, then remove **only that directory** and start the server again. Never
remove an active server's directory. A different cask version requires stopping
the original owner first. The launcher refuses automatic stale-path deletion.

## Compatibility and validation

- Herdr JSON responses are validated at each used method. Its internal
  `ping.protocol` number is informational; protocol 20 and 22 are not separate
  JSON API versions. Unknown fields are tolerated. Invalid ping, missing
  methods, malformed agent lists and ambiguous identities fail closed.
- Codex CLI 0.155.1 (brew, macOS) was exercised in an isolated `CODEX_HOME` with
  a new ephemeral thread and no model turn. `initialize`, `thread/loaded/list`,
  `thread/read`, `model/list`, and experimental `thread/settings/update` worked
  before the first message. Future versions must provide these response shapes;
  missing capabilities disable reasoning control and log an error.
- The launcher correlates start/resume/fork responses by request ID and records
  only their exact UUIDv7. Starting another lifecycle request and disconnecting
  remove the previous registration. No cwd, timestamp or list-order inference.
- The `ws` library handles WebSocket framing, fragmentation and connection
  closure. RPC requests have deadlines; notifications do not accumulate.
- Each reasoning operation reads fresh metadata. A null effort uses the model's
  advertised default; missing/unknown values are rejected. Updates include only
  the thread ID and effort. The next rotation waits for the setting to become
  visible. At most 32 operations wait; stale context and errors discard work.
- Focus/identity/settings are checked just before sending. Herdr and Codex do
  not offer a cross-process atomic compare-and-update; a final tiny race remains.
- USB major 2 sends physical keys 1–12 and signed encoder deltas. Firmware
  major 1 is incompatible; use the parent PROTOCOL.md when implementing firmware.
- K9/K10 require a single supported command approval observed on this launcher
  connection, an exact live thread/terminal registration, and the matching visible
  TUI prompt twice. Unknown versions, multiple requests, questions, file/network
  approvals and changed evidence disable these keys with a reason. A request is
  attempted only once, including a failed send.
- Approval keys are supported only for `codex-cli 0.155.1`. The launcher pins
  `tui.keymap.approval.approve=["y"]` and `decline=["n","esc"]` with process-only
  `-c` overrides. User configuration files are not edited. Native TUI controls
  remain available for unsupported prompts.
- A dead launcher registration is reclaimed on resume; a live/unknown owner is
  refused. A crash during the short registration claim may leave a `.json.lock`
  directory. Inspect the adjacent registration PID and running launchers before
  removing only that lock. Approval persistence failure terminates the owning
  launcher and its remote CLI to invalidate stale evidence; the shared App Server
  stays running.

```sh
npm run typecheck
npm test
npm run dry-run -- WIBDUE
# Optional: starts only an isolated brew App Server, with no model turn or device.
npm run smoke:codex
```

The build deletes `dist` first, so removed test files cannot silently run.
Unit/integration tests use fake Herdr/USB/App Server and a fake brew-only
installation (including a conflicting PATH codex). No live Herdr pane input,
USB open, firmware flash, physical display or interactive TUI verification was
performed for this update. Full hardware acceptance remains in parent #32.

Set `HERDR_SOCKET_PATH` explicitly so the bridge can reconnect after a Herdr
server restart. `ZERO_KB02_PORT` is **required** and must be an exact absolute
port path. There is no automatic serial probing. Stop with Ctrl-C. The bridge
sends `OFFLINE` while Herdr is unavailable and retries both connections.

## Device development tools

All commands default to an in-memory mock; they do not open real USB or Herdr.

```sh
npm run device:check -- raw
npm run device:check -- input
npm run device:check -- display
npm run device:check -- faults
npm run device:check -- doctor
```

`raw` prints early `KEYLOG 1 DOWN/UP` lines without a handshake. `input` prints
all twelve physical keys and `ENC CW steps=3 total=3`, followed by CCW total=1.
`display` sends W/I/B/D/U/E, selection 0–5 (slot 5 temporarily U), then OFFLINE.
`faults` exercises fragmented/invalid/stale input, reconnection and heartbeat loss.
`doctor` prints the brew binary/version, socket, protocol major and supported
approval version without opening a device or Herdr socket.

For your own firmware, stop the bridge and other serial monitors first, then
choose the exact port and run one tool at a time:

```sh
npm run device:check -- raw --device --port /dev/cu.usbmodemYOUR_DEVICE
npm run device:check -- input --device --port /dev/cu.usbmodemYOUR_DEVICE
npm run device:check -- display --device --port /dev/cu.usbmodemYOUR_DEVICE
npm run device:check -- faults --device --port /dev/cu.usbmodemYOUR_DEVICE
```

These examples **open/control the selected device**. No real-device commands
were run during PC verification. `raw` needs no protocol; the others require
major 2. In real `input`, press keys and turn the encoder; Ctrl-C stops and
closes the port. `display` completes its sequence and exits. Real `faults`
first checks major 2, sends a state and an overlong line, then stays silent
for 13 seconds: confirm the display becomes offline after 12 seconds. Repeat
`input` after unplug/replug to check recovery and suppression of held keys.
Use mock `faults` for stale-generation injection. If the port is busy, close
the bridge/other monitor; inspect `lsof /exact/port` and do not kill an unknown
owner. Never replace the exact path with a wildcard.

API references: [Codex App Server](https://developers.openai.com/codex/app-server),
[Herdr socket API](https://herdr.dev/docs/socket-api/),
[ws](https://github.com/websockets/ws). The Codex checks use schemas generated by
`codex-cli 0.155.1 app-server generate-json-schema --experimental`.

## Physical controls (USB major 2)

Every key sends `KEY <generation> <physical number> DOWN` and a matching UP.
The firmware sends no semantic Escape/approval/new-chat commands.

| Physical key | Host action |
| --- | --- |
| K1 | Escape to the focused, mapped Codex pane |
| K2, K3, K5, K6, K7, K8 | Focus agent slots 0–5 |
| K4 | Toggle session-wide Status popup |
| K9 / K10 | Fixed y/n once, only with supported pending approval evidence |
| K11 | Reserved, no operation |
| K12 | Fixed /new only when the focused mapped Codex is idle/done |

`ENC <generation> <delta>` changes reasoning effort by signed detents (-32..-1,
1..32). A positive delta raises it, a negative delta lowers it; endpoints clamp.
At most 32 steps wait. UP events and both pushes do nothing. Concurrent key
operations are dropped while another key operation is being verified; they are
never retried automatically. Duplicate DOWN waits for UP before another action.

K4 calls global `popup.close`; only exact `popup_not_open` opens the fixed
read-only `hoki621.zero-kb02` `status` popup. Herdr exposes one session-wide popup,
so K4 can close another plugin's popup. The bridge tracks no popup pane ID.

Approval UI/keymap references are pinned to
[Codex rust-v0.155.1](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__approval_modal_exec.snap)
and [keymap configuration](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/config/src/tui_keymap.rs).
The visible prompt check supplements the exact pending RPC and does not treat
Herdr `blocked` alone as approval evidence. Herdr send and Codex request state
are not atomic; tests cannot establish physical or live TUI acceptance.

## Legacy hook migration

If you previously ran `npm run install-codex-hook`, close Codex and back up
`~/.codex/hooks.json`. Remove only the SessionStart hook whose command runs
`/absolute/path/to/host/dist/src/codex-hook.js`, then validate the JSON. Keep
other hooks (including Herdr and Serena). New installations need no hook.

```sh
cp -ip "$HOME/.codex/hooks.json" "$HOME/.codex/hooks.json.before-zero-kb02-manual"
# Edit only the matching hook object, then:
python3 -m json.tool "$HOME/.codex/hooks.json" >/dev/null
```
