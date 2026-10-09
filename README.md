# codex-zero-kb02-host

[日本語](README_JA.md) · [Full setup and controls](https://github.com/hoki621/codex-zero-kb02/blob/main/README_EN.md)

The Mac application that connects zero-kb02 to Herdr and Codex CLI. It displays up to six conversation states on the device, switches Herdr panes, and adjusts Codex reasoning effort.

## Setup

Install Herdr, Homebrew Codex CLI and the tools specified by the parent repository's `mise.toml` first. Use Node.js 22. From this directory:

```sh
npm ci
npm run build
herdr plugin link --enabled "$PWD"
```

## Run

Start Herdr normally. Use three separate terminals or panes:

1. In a normal Terminal, from this directory, start the Codex App Server and keep it running:

   ```sh
   node dist/src/codex-micro.js server
   ```

2. In each Herdr pane, start Codex using the launcher. Replace `/absolute/path/to/host` with this directory's path:

   ```sh
   node /absolute/path/to/host/dist/src/codex-micro.js
   ```

   The launcher connects the conversation to its Herdr pane. Append `resume` to resume a conversation, or `fork` to branch one. It uses Homebrew Codex CLI and preserves your existing Codex configuration.

3. In another normal Terminal, from this directory, start the device connection:

   ```sh
   HERDR_SOCKET_PATH="$HOME/.config/herdr/herdr.sock" \
   ZERO_KB02_PORT=/dev/cu.usbmodemzero_kb02_v21 node dist/src/main.js
   ```

   Replace the USB port with your device's exact path. Close any serial monitor using that port.

Finish the Codex CLI sessions and stop the bridge before stopping App Server with Ctrl-C. Restart the server and CLI sessions after updating Codex CLI.

## Compatibility and troubleshooting

Reasoning and approval controls require conversations started with the launcher. Reasoning changes preserve the selected model.

K9/K10 approval controls support Codex CLI **0.155.1 and 0.160.0 only**. They require a single command approval and a matching conversation, pane and visible prompt. Questions and file/network approvals are not supported. **Approval keys are disabled on 0.162.0.** K4 controls Herdr's shared popup and may close another plugin's popup.

To check the installed Codex version and connection paths:

```sh
node dist/src/codex-micro.js doctor
```

This check does not open USB or control Herdr. The bridge reconnects to the configured device port automatically; release any held keys before using them again. See [troubleshooting](docs/troubleshooting.md) for stale server or registration errors.

## Development checks

```sh
npm run typecheck
npm test
npm run dry-run -- WIBDUE
npm run device:check -- input
npm run device:check -- display
npm run device:check -- faults
```

Device checks use mocks by default. For hardware checks, stop the bridge and serial monitors, then append `--device --port /exact/device/path` to one check at a time. `input` records keys and encoder movement; `display` tests slot selection and offline display; `faults` sends an overlong line and stops communication for 13 seconds. These checks do not operate Herdr.

Optional `npm run smoke:codex` tests reasoning changes with an isolated Codex App Server without starting a model turn. The [verification record](https://github.com/hoki621/codex-zero-kb02/blob/main/docs/verification.md) lists software checks and hardware observations separately.

## Attribution

This project adapts House of Herdr Codex Micro. Source comments identify adapted files; [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) retains its MIT license and source revision.
