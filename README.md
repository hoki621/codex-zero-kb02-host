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
- Physical keyboard mappings, USB v1 and firmware are unchanged. Approval-prompt
  verification and the new USB contract remain tracked in parent #23–#25.

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
server restart. `ZERO_KB02_PORT` is optional when exactly one connected USB CDC
device answers the v1 handshake. Stop the bridge with Ctrl-C. It sends
`OFFLINE` while Herdr is unavailable, retries USB and Herdr connections, and
reconciles missed Herdr events every five seconds.

At runtime, `/dev/cu.usbmodem*` devices must answer `HELLO ZERO-KB02 1`.
If more than one does, set `ZERO_KB02_PORT` to the intended path.

API references: [Codex App Server](https://developers.openai.com/codex/app-server),
[Herdr socket API](https://herdr.dev/docs/socket-api/),
[ws](https://github.com/websockets/ws). The Codex checks use schemas generated by
`codex-cli 0.155.1 app-server generate-json-schema --experimental`.

## v1 input mapping

| Physical key | CDC event | Host action |
| --- | --- | --- |
| K1 | `ESC <generation> DOWN` | send Escape to the focused mapped Codex pane |
| K2 | `KEY <generation> 0 DOWN` | focus agent slot 0 |
| K3 | `KEY <generation> 1 DOWN` | focus agent slot 1 |
| K4 | `POPUP <generation> DOWN` | toggle the Herdr session's active popup globally |
| K5 | `KEY <generation> 2 DOWN` | focus agent slot 2 |
| K6 | `KEY <generation> 3 DOWN` | focus agent slot 3 |
| K7 | `KEY <generation> 4 DOWN` | focus agent slot 4 |
| K8 | `KEY <generation> 5 DOWN` | focus agent slot 5 |
| K9 | `APPROVE <generation> DOWN` | send fixed `y` to the focused mapped blocked Codex pane |
| K10 | `REJECT <generation> DOWN` | send fixed `n` to the focused mapped blocked Codex pane |
| K11 | unavailable | reserved; no operation |
| K12 | `NEW <generation> DOWN` | send fixed `/new` to the focused mapped idle/done Codex pane |

Encoder `CW` raises the focused managed Codex CLI thread's reasoning effort by
one supported level; `CCW` lowers it by one. Both clamp at the model's endpoint.

`ESC UP`, `POPUP UP`, `KEY UP`, `NEW UP`, `APPROVE UP`, `REJECT UP`, Encoder
`DOWN/UP`, `JOY`, and joystick push perform no operation in v1. K4 first calls
global `popup.close`; only exact
`popup_not_open` opens the fixed read-only `hoki621.zero-kb02` `status` popup.
Because Herdr 0.8.2 exposes one session-wide popup without public ownership,
K4 can close another plugin's active popup. The bridge tracks no popup pane ID
and persists no popup state. It must stay outside Herdr-managed panes.
