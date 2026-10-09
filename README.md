# codex-zero-kb02-host

[日本語](README_JA.md) · [System setup and controls](https://github.com/hoki621/codex-zero-kb02#readme)

Node.js 22 / TypeScript bridge between Herdr, USB CDC major 2 and a dedicated Codex App Server. It maintains six stable agent slots and checks the live target before fixed operations.

## Setup and run

Install the parent's mise tools, Herdr and Homebrew Codex CLI first. From this directory:

```sh
npm ci
npm run build
herdr plugin link --enabled "$PWD"
TMPDIR=/tmp node dist/src/codex-micro.js doctor
```

Use the same `TMPDIR=/tmp` everywhere. In separate terminals:

```sh
# Normal Terminal: keep the server running.
TMPDIR=/tmp node dist/src/codex-micro.js server
# Each Herdr pane: append resume or fork when needed.
TMPDIR=/tmp node /absolute/path/to/host/dist/src/codex-micro.js
# Another normal Terminal: specify the exact device port.
TMPDIR=/tmp HERDR_SOCKET_PATH="$HOME/.config/herdr/herdr.sock" \
ZERO_KB02_PORT=/dev/cu.usbmodemzero_kb02_v21 node dist/src/main.js
```

The launcher selects the brew cask binary without editing existing Codex configuration. It registers the exact thread UUID returned by start/resume/fork. Finish remote CLI sessions before stopping the server with Ctrl-C. The bridge can stop independently. After a brew upgrade, restart the server and resume each CLI session.

## Checks

```sh
npm run typecheck
npm test
npm run dry-run -- WIBDUE
npm run device:check -- input
npm run device:check -- display
npm run device:check -- faults
```

Device tools default to mocks. `doctor` inspects paths/version without opening USB or Herdr. For a real device, stop the bridge/monitors and append `--device --port /exact/device/path` to one tool at a time. `input` records keys/encoder, `display` runs six-slot selection/offline, and `faults` sends an overlong line then stays silent for 13 seconds. These tools send no Herdr actions.

Optional `npm run smoke:codex` starts an isolated brew App Server and changes effort before any model turn. [Verification](https://github.com/hoki621/codex-zero-kb02/blob/main/docs/verification.md) separates mock/build checks from physical observations.

## Operation boundaries and recovery

K9/K10 support Codex CLI **0.155.1 and 0.160.0 only**. They require one pending command approval, exact live thread/terminal registration and a matching visible prompt checked twice. Unknown versions, questions, multiple and file/network approvals disable these keys. Process-only overrides fix y/n bindings; persistent approval is never selected. On 0.162.0 approval keys remain disabled.

Effort updates include only thread ID and effort, never the model. Queues are bounded at 32 steps; stale context discards work. Herdr send and Codex state checks are separate APIs, leaving a final small race. K4 uses a session-wide popup and can close another plugin's popup.

The bridge reconnects to the exact configured port/socket and resends state. Release held keys after reconnect. Use `lsof /exact/port` to identify your own monitor before closing it.

For a stale server directory, inspect the PID/socket in its `server.json` with `ps -p PID -o pid=,command=` and `lsof /exact/path/app.sock`. Remove only that directory after confirming neither is in use. Never remove an active server directory. A launcher crash can leave a `.json.lock`; inspect the adjacent registration PID and running launchers before removing that lock.

## Legacy hook migration

If you previously ran `npm run install-codex-hook`, close Codex and back up `~/.codex/hooks.json`. Remove only the SessionStart hook running `/absolute/path/to/host/dist/src/codex-hook.js`, keep other hooks and validate the JSON. New installations need no hook.

## Attribution

[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) retains the MIT notice for House of Herdr Codex Micro at `50b24e3f334a38a84bfa356f154d49835dff2499`. Adapted files carry source comments. No workshop source is copied.
