# Agent instructions

- Work from one parent issue and keep the change inside this repository.
- Use Node.js 22, TypeScript ESM, Node's `net` module, and the minimum required
  SerialPort surface.
- Do not import the official Codex Micro HID framing, `node-hid`, global key
  synthesis, arbitrary shell execution, or a settings GUI.
- Treat Herdr `pane_id` as transient. Keep slot identity by `terminal_id` and
  resolve the current pane immediately before an operation.
- Use mocks before a live Herdr socket or physical serial device.
- Preserve complete MIT notices and pinned provenance for imported upstream code.
- Run focused type, unit, and build checks before committing.
- Do not update the parent submodule pointer; the integration owner does that.
