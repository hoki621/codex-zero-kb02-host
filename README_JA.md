# codex-zero-kb02-host

[English](README.md) · [システムの導入・操作](https://github.com/hoki621/codex-zero-kb02#readme)

Herdr・USB CDC major 2・専用Codex App Serverを接続するNode.js 22 / TypeScript bridgeです。最大6つのAgent枠を維持し、固定操作の前に対象を確認します。

## 導入・起動

親repoのmise指定ツール、Herdr、Homebrew版Codex CLIを導入してから、このディレクトリで実行します。

```sh
npm ci
npm run build
herdr plugin link --enabled "$PWD"
TMPDIR=/tmp node dist/src/codex-micro.js doctor
```

すべて同じ`TMPDIR=/tmp`を使い、別々のTerminalで実行します。

```sh
# 通常Terminal: serverを起動したままにする
TMPDIR=/tmp node dist/src/codex-micro.js server
# Herdrの各ペイン: 再開はresume、分岐はforkを末尾に付ける
TMPDIR=/tmp node /absolute/path/to/host/dist/src/codex-micro.js
# 別の通常Terminal: 実機の完全なport名を指定する
TMPDIR=/tmp HERDR_SOCKET_PATH="$HOME/.config/herdr/herdr.sock" \
ZERO_KB02_PORT=/dev/cu.usbmodemzero_kb02_v21 node dist/src/main.js
```

Launcherはbrew caskの実体を選び、既存のCodex設定を変更しません。start/resume/forkの応答から正確な会話UUIDを登録します。利用中のCLIを終了してからserverをCtrl-Cで止めます。bridgeだけなら独立して止められます。brew更新後はserverを再起動して各CLIを再開してください。

## 検証

```sh
npm run typecheck
npm test
npm run dry-run -- WIBDUE
npm run device:check -- input
npm run device:check -- display
npm run device:check -- faults
```

確認ツールはmockが既定です。`doctor`はUSB・Herdrを開かずpathと版を調べます。実機ではbridgeとmonitorを閉じ、各コマンドに`--device --port /exact/device/path`を付けます。`input`はキー・Encoderの記録、`display`は6枠の選択とoffline、`faults`は過長行と13秒の通信停止を試します。確認ツールはHerdrへ操作を送りません。

任意の`npm run smoke:codex`は隔離したbrew App Serverで、model turnを行わず推論の強さを変更します。[検証記録](https://github.com/hoki621/codex-zero-kb02/blob/main/docs/verification.md)ではmock・buildと実機結果を分けています。

## 操作の条件・復旧

K9/K10はCodex CLI **0.155.1・0.160.0のみ対応**。単独command承認、正確な会話・terminal登録、2回確認した画面が一致する場合だけ有効です。未知の版・質問・複数承認・file/network承認では無効です。y/nはプロセス限定で固定し、永続承認は選びません。0.162.0では承認キーは無効です。

推論変更は会話IDとeffortだけを更新し、modelは変更しません。待機は32stepまでで対象が変わると破棄します。Herdr送信とCodex状態確認は別APIなので、最後の短い競合は残ります。K4は共通popupを操作し、別pluginのpopupを閉じる場合があります。

bridgeは指定したport・socketへ再接続し、状態を再送します。再接続後は押していたキーを離してから使います。port使用中は`lsof /exact/port`で所有者を確認して、自分のmonitorを終了してください。

serverの残存ディレクトリが報告されたら、`server.json`のPID/socketを`ps -p PID -o pid=,command=`と`lsof /exact/path/app.sock`で確認します。どちらも使われていない場合だけ、そのディレクトリを削除します。稼働中のserverは削除しません。Launcherの異常終了で`.json.lock`が残った場合も、隣の登録ファイルのPIDと稼働中Launcherを確認してから該当lockだけ削除します。

## 旧hookの移行

以前`npm run install-codex-hook`を使った場合はCodexを閉じ、`~/.codex/hooks.json`をバックアップします。`/absolute/path/to/host/dist/src/codex-hook.js`を呼ぶSessionStart hookだけを削除し、他のhookを残してJSONを検証します。新規導入ではhook不要です。

## 出典

[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)にHouse of Herdr Codex Micro `50b24e3f334a38a84bfa356f154d49835dff2499`のMIT表記を保持しています。派生ファイルは先頭に出典コメントがあります。workshopのソースはコピーしていません。
