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

Run the bridge from a normal terminal outside Herdr-managed panes after
installing dependencies:

```sh
npm ci
npm run build
codex app-server daemon start
herdr plugin link --enabled "$(pwd)"
herdr integration install codex
npm run install-codex-hook
HERDR_SOCKET_PATH="$HOME/.config/herdr/herdr.sock" ZERO_KB02_PORT=/dev/cu.usbmodemzero_kb02_v11 npm start
```

The link command installs the fixed `hoki621.zero-kb02` manifest from this
repository. The bridge never links or enables plugins automatically.

`herdr integration install codex` is a one-time setup step. Herdr preserves
unrelated entries while adding its `SessionStart` command to
`~/.codex/hooks.json` and enabling Codex hooks. `npm run install-codex-hook`
then preserves those entries while adding the zero-kb02 fallback for Codex
remote sessions where `transcript_path` is null or absent. Review the resulting hooks,
`~/.codex/herdr-agent-state.sh`, and the added command for
`dist/src/codex-hook.js`, then approve Codex's hook trust prompt on the next
launch. Do not use `--dangerously-bypass-hook-trust`.

Encoder control requires Codex CLI 0.149.1 or 0.150.1 managed by its built-in
local App Server. From a Herdr pane, start Codex with
`npm --prefix /absolute/path/to/codex-zero-kb02/host run codex-herdr -- --remote unix://`;
the bridge uses the
same `$CODEX_HOME/app-server-control/app-server-control.sock`. It neither
starts a second daemon nor supports desktop App or non-managed CLI panes.
In a Herdr pane, the integration reports the exact Codex `SessionStart`
`session_id`; the bridge accepts only one UUIDv7 identity that is still loaded.
No `/status` lookup or manual `pane report-agent-session` step is needed.

The launcher keeps the documented `core` inheritance, existing Browser/Codex/Node/Sky
allowlist, and AWS/Azure/token/secret/key exclusions. It adds only the three exact
Herdr values through a per-run `-c shell_environment_policy=...` override and disables
shell snapshots for that run so the override cannot be bypassed. It does not edit
`~/.codex/config.toml`.

Set `HERDR_SOCKET_PATH` explicitly so the bridge can reconnect after a Herdr
server restart. `ZERO_KB02_PORT` is optional when exactly one connected USB CDC
device answers the v1 handshake. Stop the bridge with Ctrl-C. It sends
`OFFLINE` while Herdr is unavailable, retries USB and Herdr connections, and
reconciles missed Herdr events every five seconds.

At runtime, `/dev/cu.usbmodem*` devices must answer `HELLO ZERO-KB02 1`.
If more than one does, set `ZERO_KB02_PORT` to the intended path.

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
