# Troubleshooting / トラブルシューティング

[English README](../README.md) · [日本語 README](../README_JA.md)

## English

For a stale server directory, inspect the PID/socket in its `server.json` with `ps -p PID -o pid=,command=` and `lsof /exact/path/app.sock`. Remove only that directory after confirming neither is in use. Never remove an active server directory. A launcher crash can leave a `.json.lock`; inspect the adjacent registration PID and running launchers before removing that lock.

Server and thread registrations use `~/.local/state/herdr/plugins/hoki621.zero-kb02/`, shared with the status plugin. After updating from the TMPDIR-based version, finish the old CLI sessions and stop the old bridge/server, then restart all three. Existing processes are not migrated or stopped automatically.

### Legacy hook migration

If you previously ran `npm run install-codex-hook`, close Codex and back up `~/.codex/hooks.json`. Remove only the SessionStart hook running `/absolute/path/to/host/dist/src/codex-hook.js`, keep other hooks and validate the JSON. New installations need no hook.

## 日本語

serverの残存ディレクトリが報告されたら、`server.json`のPID/socketを`ps -p PID -o pid=,command=`と`lsof /exact/path/app.sock`で確認します。どちらも使われていない場合だけ、そのディレクトリを削除します。稼働中のserverは削除しません。Launcherの異常終了で`.json.lock`が残った場合も、隣の登録ファイルのPIDと稼働中Launcherを確認してから該当lockだけ削除します。

serverと会話登録は状態pluginと同じ`~/.local/state/herdr/plugins/hoki621.zero-kb02/`を使います。旧TMPDIR版から更新する場合は利用中のCLIを終了し、旧bridge/serverを止めてからすべて再起動します。既存プロセスの自動移行・停止はしません。

### 旧hookの移行

以前`npm run install-codex-hook`を使った場合はCodexを閉じ、`~/.codex/hooks.json`をバックアップします。`/absolute/path/to/host/dist/src/codex-hook.js`を呼ぶSessionStart hookだけを削除し、他のhookを残してJSONを検証します。新規導入ではhook不要です。

