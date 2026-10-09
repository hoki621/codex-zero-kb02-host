import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const execute = promisify(execFile);
const launcher = fileURLToPath(new URL("../src/codex-micro.js", import.meta.url));
const wsModule = fileURLToPath(new URL("../../node_modules/ws/index.js", import.meta.url));

test("brew-only launcher and dedicated server share a binary and clean up their own state", async () => {
  const directory = await mkdtemp("/tmp/zkb-runtime-");
  const prefix = path.join(directory, "brew");
  const bin = path.join(prefix, "bin");
  const cask = path.join(prefix, "Caskroom/codex/0.155.1/bin");
  const trace = path.join(directory, "trace.jsonl");
  await mkdir(bin, { recursive: true });
  await mkdir(cask, { recursive: true });
  await writeFile(path.join(bin, "brew"), `#!/bin/sh\nprintf '%s\\n' '${prefix}'\n`, { mode: 0o755 });
  const binary = path.join(cask, "codex");
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const { WebSocket, WebSocketServer } = require(${JSON.stringify(wsModule)});
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 0.160.0'); process.exit(); }
fs.appendFileSync(process.env.TRACE, JSON.stringify({binary:process.argv[1],args})+'\\n');
if (args[0] === 'app-server') {
  const server = require('node:http').createServer();
  const wss = new WebSocketServer({server});
  wss.on('connection', ws => ws.on('message', data => {
    const message = JSON.parse(data.toString());
    if(message.method==='probe/fail-persistence') {
      ws.send(JSON.stringify({id:99,method:'item/commandExecution/requestApproval',params:{threadId:'01901234-5678-7abc-8def-0123456789ab',availableDecisions:['accept','cancel']}}));
      return;
    }
    ws.send(JSON.stringify({id:message.id,result:{thread:{id:'01901234-5678-7abc-8def-0123456789ab'},model:'m',reasoningEffort:null}}));
  }));
  server.listen(args[2].slice(7));
  process.on('SIGTERM', () => { for(const ws of wss.clients) ws.terminate(); wss.close(); server.close(()=>process.exit()); });
} else {
  if(args[0]!=='--remote')process.exit(3);
  const ws = new WebSocket('ws+unix://'+args[1].slice(7)+':/');
  ws.on('open',()=>ws.send(JSON.stringify({id:1,method:'thread/start'})));
  ws.on('message',()=>{
    if(args.includes('persist-failure')) {
      const dir=require('node:path').join(process.env.TMPDIR,'zero-kb02-codex-'+process.getuid());
      fs.mkdirSync(require('node:path').join(dir,'01901234-5678-7abc-8def-0123456789ab.json.approval'));
      ws.send(JSON.stringify({method:'probe/fail-persistence'}));
    } else ws.close();
  });
  ws.on('close',()=>process.exit());
  ws.on('error',()=>process.exit(4));
}
`, { mode: 0o755 });
  await symlink(binary, path.join(bin, "codex"));
  const trap = path.join(directory, "standalone");
  await mkdir(trap);
  await writeFile(path.join(trap, "codex"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  const socketPath = path.join(directory, "herdr.sock");
  const reports: unknown[] = [];
  const herdr = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const end = buffer.indexOf("\n");
      if (end === -1) return;
      const request = JSON.parse(buffer.slice(0, end));
      if (request.method === "pane.report_agent_session") reports.push(request.params);
      socket.end(JSON.stringify({ id: request.id, result: request.method === "pane.get"
        ? { type: "pane_get", pane: { pane_id: "1-1", terminal_id: "stable" } }
        : { type: "ok" } }) + "\n");
    });
  });
  await new Promise<void>((resolve) => herdr.listen(socketPath, resolve));
  const env = { ...process.env, TMPDIR: directory, PATH: `${trap}:${bin}:${process.env.PATH}`,
    TRACE: trace, HERDR_ENV: "1", HERDR_PANE_ID: "1-1", HERDR_SOCKET_PATH: socketPath };
  const server = spawn(process.execPath, [launcher, "server"], { env, stdio: ["ignore", "ignore", "pipe"] });
  let errors = "";
  server.stderr.on("data", (chunk) => { errors += chunk; });
  const exited = new Promise((resolve) => server.once("exit", resolve));
  const ownedDirectory = path.join(directory, `zero-kb02-server-${process.getuid?.() ?? "user"}`);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await readFile(path.join(ownedDirectory, "server.json")); ready = true; break; }
      catch { await delay(20); }
    }
    assert.ok(ready, errors);
    // Server startup and socket binding are independent of metadata publication.
    for (let attempt = 0; attempt < 100; attempt++) {
      const connected = await new Promise<boolean>((resolve) => {
        const socket = net.createConnection(path.join(ownedDirectory, "app.sock"));
        socket.on("error", () => resolve(false));
        socket.on("connect", () => { socket.destroy(); resolve(true); });
      });
      if (connected) break;
      await delay(20);
    }
    await assert.rejects(execute(process.execPath, [launcher, "server"], { env }), /Server already running/);
    const diagnostic = await execute(process.execPath, [launcher, "doctor"], { env });
    assert.ok(diagnostic.stdout.includes(binary));
    await execute(process.execPath, [launcher], { env, timeout: 5_000 });
    assert.deepEqual(reports, [{ pane_id: "1-1", source: "herdr:codex", agent: "codex", agent_session_id: "01901234-5678-7abc-8def-0123456789ab" }]);
    const commands = (await readFile(trace, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(commands.length, 2);
    const resolvedBinary = await realpath(binary);
    assert.ok(commands.every((command) => command.binary === resolvedBinary));
    assert.deepEqual(commands[0].args.slice(0, 2), ["app-server", "--listen"]);
    assert.equal(commands[1].args[0], "--remote");
    assert.ok(commands[1].args.includes('tui.keymap.approval.approve=["y"]'));
    assert.equal(server.exitCode, null, "CLI exit must not stop the dedicated server");
    await assert.rejects(readFile(path.join(directory, `zero-kb02-codex-${process.getuid?.() ?? "user"}`, "01901234-5678-7abc-8def-0123456789ab.json")), /ENOENT/);
    await assert.rejects(execute(process.execPath, [launcher, "persist-failure"], { env, timeout: 5_000 }),
      (error: unknown) => {
        const failed = error as { code: number; stderr: string };
        assert.equal(failed.code, 1);
        assert.match(failed.stderr, /registration persistence failed; stopping launcher/);
        return true;
      });
    assert.equal(server.exitCode, null, "persistence failure must leave shared server running");
  } finally {
    server.kill("SIGTERM");
    await exited;
    await new Promise<void>((resolve) => herdr.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
