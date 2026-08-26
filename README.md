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
herdr plugin link --enabled "$(pwd)"
HERDR_SOCKET_PATH="$HOME/.config/herdr/herdr.sock" ZERO_KB02_PORT=/dev/cu.usbmodemzero_kb02_v11 npm start
```

The link command installs the fixed `hoki621.zero-kb02` manifest from this
repository. The bridge checks that exact enabled local plugin before opening
the read-only `status` popup; it never links or enables plugins automatically.

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
| K4 | `POPUP <generation> DOWN` | toggle only the popup pane opened and owned by this bridge session |
| K5 | `KEY <generation> 2 DOWN` | focus agent slot 2 |
| K6 | `KEY <generation> 3 DOWN` | focus agent slot 3 |
| K7 | `KEY <generation> 4 DOWN` | focus agent slot 4 |
| K8 | `KEY <generation> 5 DOWN` | focus agent slot 5 |
| K9–K12 | unavailable | reserved; no operation |

`ESC UP`, `POPUP UP`, `KEY UP`, `ENC`, `JOY`, and joystick push perform no
operation in v1. K4 never uses global `popup.close`: it closes only the
`pane_id` returned by its own successful `plugin.pane.open`.

If the bridge or Herdr disconnects while a popup ownership record exists, K4
locks instead of guessing whether that pane survived. Stop the bridge, close
the old popup or restart Herdr and verify it is gone, remove only
`$HOME/.local/state/herdr/plugins/hoki621.zero-kb02/owned-pane.json`, then
restart the bridge. The bridge must stay outside Herdr-managed panes.
