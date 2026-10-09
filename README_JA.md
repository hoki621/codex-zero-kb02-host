# codex-zero-kb02-host

[English](README.md) · [システム全体の導入・操作](https://github.com/hoki621/codex-zero-kb02#readme)

zero-kb02をHerdrとCodex CLIに接続するMac側のアプリケーションです。最大6つの会話の状態をデバイスに表示し、Herdrのペイン切替とCodexの推論の強さの変更を行います。

## 初期設定

Herdr、Homebrew版Codex CLI、親リポジトリの`mise.toml`で指定したツールを先に導入します。Node.js 22を使い、このディレクトリで実行してください。

```sh
npm ci
npm run build
herdr plugin link --enabled "$PWD"
```

## 起動

Herdrを通常どおり起動し、3つのTerminal・ペインを使います。

1. 通常のTerminalで、このディレクトリからCodex App Serverを起動し、そのままにします。

   ```sh
   node dist/src/codex-micro.js server
   ```

2. Herdrの各ペインで、起動用プログラムからCodexを起動します。`/absolute/path/to/host`はこのディレクトリの絶対パスに置き換えてください。

   ```sh
   node /absolute/path/to/host/dist/src/codex-micro.js
   ```

   このプログラムが会話とHerdrのペインを結びつけます。再開は末尾に`resume`、分岐は`fork`を付けます。Homebrew版Codex CLIを使用し、既存のCodex設定を保持します。

3. 別の通常Terminalで、このディレクトリからデバイスとの接続を起動します。

   ```sh
   HERDR_SOCKET_PATH="$HOME/.config/herdr/herdr.sock" \
   ZERO_KB02_PORT=/dev/cu.usbmodemzero_kb02_v21 node dist/src/main.js
   ```

   USBポートは自分のデバイスの完全なパスに置き換え、そのポートを使うserial monitorは閉じてください。

終了するときは各Codex CLIとbridgeを終了してから、App ServerをCtrl-Cで止めます。Codex CLIの更新後はserverと各CLIを再起動してください。

## 対応範囲・トラブルシューティング

推論変更・承認操作は、起動用プログラムから開始した会話で使用できます。推論の強さを変えても選択中のモデルは変わりません。

K9/K10の承認操作はCodex CLI **0.155.1・0.160.0のみ対応**します。単独のコマンド承認で、会話・ペイン・画面上の承認内容を確認できる場合に有効です。質問やファイル・ネットワークの承認には対応しません。**0.162.0では承認キーは無効**です。K4はHerdr共通のpopupを操作するため、別pluginのpopupを閉じる場合があります。

Codexのバージョンや接続先を確認するには、次を実行します。

```sh
node dist/src/codex-micro.js doctor
```

この確認ではUSBを開いたりHerdrを操作したりしません。bridgeは指定したUSBポートに自動で再接続します。再接続後は押していたキーを離してから使ってください。serverや会話登録の残存エラーは[トラブルシューティング](docs/troubleshooting.md)を参照してください。

## 開発時の確認

```sh
npm run typecheck
npm test
npm run dry-run -- WIBDUE
npm run device:check -- input
npm run device:check -- display
npm run device:check -- faults
```

デバイス確認は実機を使わないmockが既定です。実機ではbridgeとserial monitorを閉じ、各コマンドに`--device --port /exact/device/path`を付けて1つずつ実行します。`input`はキー・Encoderの記録、`display`は枠の選択とoffline表示、`faults`は過長行と13秒の通信停止を確認します。これらはHerdrを操作しません。

任意の`npm run smoke:codex`は独立したCodex App Serverで、モデルへの依頼を開始せず推論変更を確認します。[検証記録](https://github.com/hoki621/codex-zero-kb02/blob/main/docs/verification.md)ではソフトウェアの確認と実機の観測を分けています。

## 出典

House of Herdr Codex Microを利用しています。派生ファイルの出典コメントと[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)に、元のMITライセンスと使用リビジョンを記載しています。
