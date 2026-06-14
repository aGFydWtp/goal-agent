# Implementation Plan

- [ ] 1. Foundation: Discord 依存・環境設定・型基盤
- [x] 1.1 Discord ライブラリ依存と Env 拡張を整備
  - `discord-interactions` と `discord-api-types` をプロジェクト依存に追加する(full `discord.js` は追加しない)
  - infra-foundation の `Env` を拡張し、`DISCORD_PUBLIC_KEY` / `DISCORD_APPLICATION_ID` / `DISCORD_BOT_TOKEN` と任意の個人用フォールバックチャンネル設定を型として宣言する
  - 完了状態: 型チェックが通り、Discord secrets が型レベルで参照可能(欠落を型/起動時に検出できる)になっている
  - _Requirements: 1.5, 2.2, 5.4, 6.3_
  - _Boundary: Discord Env 拡張_

- [x] 1.2 interaction 文脈とハンドラ登録規約の型を定義
  - 実行ユーザー ID・コマンド名/custom_id・引数・チャンネル/DM 文脈・follow-up token を含む interaction 文脈型を定義する
  - ハンドラが「即時応答型(reply)」「deferred 型」「modal を開く型(modal: customId/title/components)」を宣言できる結果型と、ハンドラインターフェイスを定義する
  - modal の components は Discord modal payload(action row 内の text input)に準拠した型とする
  - 完了状態: 下位スペックが import できる文脈・ハンドラ・結果型(modal 変種を含む)が公開され、`discord-api-types` で interaction payload が型付けされている
  - _Requirements: 3.5, 3.6, 4.1, 4.7, 6.1, 7.4_
  - _Boundary: Interaction 型・ハンドラ規約_
  - _Depends: 1.1_

- [ ] 2. Core: 検証・応答・REST・送信ヘルパー
- [x] 2.1 (P) Ed25519 署名検証を実装
  - raw body と署名ヘッダ(signature/timestamp)を公開鍵で Ed25519 検証する処理を実装する
  - ヘッダ欠落と検証失敗を判別可能な結果として返す(成功時はパース済み interaction を返す)
  - 完了状態: 正しい署名で検証成功、改竄署名で `invalid_signature`、ヘッダ欠落で `missing_headers` を返すユニットテストが通る
  - _Requirements: 1.1, 1.2, 1.3, 1.5_
  - _Boundary: Signature Verify_
  - _Depends: 1.1_

- [x] 2.2 (P) 応答ユーティリティを実装
  - PING に対する PONG(type1)、即時応答(type4)、deferred 応答(type5)、modal を開く応答(type9)、ephemeral フラグ付与の応答ボディ生成を実装する
  - modal 応答は custom_id・title・components(action row 内の text input)を Discord modal payload に整形する
  - 完了状態: PONG/type4/type5/type9 の各ボディが生成され、type9 が customId/title/text input を含む payload を生成し、ephemeral 指定でフラグ(64)が立つことをユニットテストで確認できる
  - _Requirements: 1.4, 4.1, 4.5, 4.6, 4.7, 6.2_
  - _Boundary: Response Utilities_
  - _Depends: 1.2_

- [x] 2.3 (P) Discord REST クライアントを実装
  - `fetch` + bot token 認証ヘッダの薄い REST クライアントを実装し、webhook 編集/送信・DM チャンネル open・チャンネルメッセージ送信を呼び出せるようにする
  - 非 2xx 応答を判別可能な結果(forbidden/not_found/rest_error)へ正規化する
  - 完了状態: 各 REST 呼び出しが正しいエンドポイント・認証ヘッダ・ボディで発行され、403 が forbidden に正規化されることを確認できる
  - _Requirements: 4.2, 5.1, 5.4_
  - _Boundary: Discord REST Client_
  - _Depends: 1.1_

- [x] 2.4 follow-up 送信ユーティリティを実装
  - 本応答編集(@original の PATCH)と追加 follow-up(POST)を提供し、失敗を判別可能に返す
  - 完了状態: deferred ハンドラが follow-up 経由で本応答および失敗通知を送れる手段が公開され、token 失効時に not_found を返す
  - _Requirements: 4.2, 4.4_
  - _Boundary: Followup Utility_
  - _Depends: 2.3_

- [x] 2.5 プロアクティブ送信ヘルパーを実装
  - DM チャンネル open → メッセージ送信を行い、403(DM 不可)時に指定された個人用フォールバックチャンネルへ送信する
  - フォールバック未指定の DM 失敗時は判別可能な失敗を返す。公開チャンネル宛の任意送信経路は提供しない
  - 完了状態: DM 成功で ok、403+fallback でフォールバック送信、403+fallback 無しで forbidden を返すユニットテストが通る
  - _Requirements: 5.1, 5.2, 5.3, 5.5, 6.3, 6.4_
  - _Boundary: Proactive Send Helper_
  - _Depends: 2.3_

- [ ] 3. Core: ディスパッチとコマンド登録
- [x] 3.1 ハンドラレジストリを実装
  - 種別(command/component/modal)と識別子(コマンド名/custom_id)をキーにハンドラを登録・照合する規約を実装する
  - 同一キーの重複登録を検出する
  - 完了状態: 登録/照合の往復が成立し、未登録キーで null、重複登録が検出されるユニットテストが通る
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.6, 7.4_
  - _Boundary: Handler Registry_
  - _Depends: 1.2_

- [x] 3.2 interaction ディスパッチャを実装
  - 検証済み非 PING interaction を種別判定し文脈を構築、レジストリ照合してハンドラを実行する
  - deferred 宣言ハンドラは type5 を即返し、重い処理を初期応答後も継続実行(waitUntil)し follow-up で本応答を送る配線にする。即時応答ハンドラは type4 を返す。modal 宣言ハンドラは type9(MODAL)を初期応答として返す配線にする
  - 未登録ハンドラ時は判別可能なエラー応答を返す
  - 完了状態: command が対応ハンドラへ振り分けられ、deferred 経路で type5 即返→follow-up 送信、modal 経路で type9 が返り、未登録で判別可能エラーが返ることを確認できる
  - _Requirements: 1.6, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.7_
  - _Boundary: Interaction Dispatcher_
  - _Depends: 3.1, 2.2, 2.4_

- [x] 3.3 (P) コマンド定義の集約点を確立
  - 各機能スペックが自分のコマンド定義を追加する単一集約点(初期は空の集約)を確立する
  - 完了状態: 下位スペックが import して定義を追加できる集約点が公開され、ゲートウェイ自身はコマンドの中身を保持しない
  - _Requirements: 2.1, 2.5, 7.4_
  - _Boundary: Command Definitions_
  - _Depends: 1.1_

- [x] 3.4 (P) コマンド登録スクリプトを実装
  - 集約されたコマンド定義をアプリケーション ID と bot token で Discord API へ登録する(bulk overwrite による冪等登録)
  - 認証情報欠落時は何も登録せずエラーを返す。ギルド指定時は当該ギルドへ登録する
  - 完了状態: スクリプト実行で集約コマンドがグローバル/指定ギルドへ登録され、認証情報欠落時に登録せずエラーになることを確認できる
  - _Requirements: 2.2, 2.3, 2.4_
  - _Boundary: Command Register_
  - _Depends: 3.3_

- [ ] 4. Integration: Worker エントリーへの統合
- [x] 4.1 interactions パスを Worker エントリーへ統合
  - infra-foundation の Worker エントリーに interactions パスを追加し、raw body を一度だけ取得→署名検証→PING なら PONG、非 PING はディスパッチャへ委譲する
  - 既存の Agent 配線・ルーティングは変更しない
  - 完了状態: interactions POST が検証→PING/PONG または種別ディスパッチへ流れ、署名不正で 401 を返す動作が疎通する
  - _Requirements: 1.4, 1.6_
  - _Boundary: Worker Entry 統合, Signature Verify, Interaction Dispatcher_
  - _Depends: 2.1, 2.2, 3.2_

- [ ] 5. Validation: 統合テストとスモーク
- [ ] 5.1 検証〜ディスパッチ統合テスト
  - 署名済み command/component/modal interaction が各対応ハンドラへ振り分けられること、未登録で判別可能エラーが返ることを検証する
  - deferred ハンドラで type5 即返後に follow-up REST(@original PATCH)が呼ばれること、即時ハンドラで type4 が返ること、modal ハンドラで type9(MODAL)応答(customId/title/text input を含む)が返ることを検証する
  - 完了状態: 上記ディスパッチ/deferred/modal/未登録パスの統合テストが通る
  - _Requirements: 1.6, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.7_
  - _Depends: 4.1_

- [ ] 5.2 PING スモークとコマンド登録スモーク
  - PING リクエストに対し Worker が PONG を返し、Discord エンドポイント登録検証相当が通ることを確認する
  - 登録スクリプト実行で集約コマンドが(モック/テスト用 API に)bulk overwrite 登録されることを確認する
  - 完了状態: PING→PONG スモークと登録スモークが通る
  - _Requirements: 1.4, 2.1, 2.2, 2.4_
  - _Depends: 4.1, 3.4_

- [ ] 5.3 プロアクティブ送信のプライバシー境界テスト
  - プロアクティブ送信が DM/指定された個人用フォールバックチャンネルに限定され、公開チャンネル宛の任意送信経路が存在しないことを検証する
  - 完了状態: DM 成功・403 フォールバック・fallback 無し失敗の各パスと、公開チャンネル送信経路が公開されていないことを確認するテストが通る
  - _Requirements: 5.1, 5.2, 5.3, 5.5, 6.3, 6.4_
  - _Depends: 2.5_

## Implementation Notes
- discord-api-types@0.38.48 では modal action row 子要素の v10 エクスポートは `APIComponentInModalActionRow`(design L287 の `APIModalActionRowComponent` は v8 のみで v10 に存在しない)。modal payload 型を扱う後続タスク(2.2 response, 3.2 dispatch)は v10 名を使うこと。`discord-interactions` は `dependencies`、`discord-api-types` は型のみで `devDependencies`。
- 新規テストは `vitest.config.ts` の `node`/`workers` プロジェクト `include` 配列へ登録必須。`node` プロジェクトのテストは `tsconfig.test.json` の `include` にも追加が必要(型チェック対象に含めるため)。Workers ランタイム/ExecutionContext/DO を要するテストは `workers` プロジェクト。
- infra-foundation の `test/boundary.test.ts` は当初 `src/` 全体から Discord パターン(verifyKey/Ed25519/InteractionType 等)と discord-interactions/discord-api-types 依存を禁止していたが、discord-gateway design と衝突するため基盤自レイヤ限定に再スコープ済み(commit 1313b7e、ユーザー承認)。`src/discord/` と統合点 `src/index.ts` は対象外。よって task 3.2(InteractionType 利用)・4.1(index.ts への interactions 統合)は boundary 検査に抵触しない。
- **【P0・必読】discord-api-types/v10 の enum「値」(InteractionType.*/InteractionResponseType.*/MessageFlags.*)は本番 workerd ランタイム(@cloudflare/vitest-pool-workers)上で `undefined` に解決され実行時 TypeError を起こす(CJS __exportStar 再エクスポートの interop 問題)。node プロジェクトのテストでは CJS interop で動くため見逃される。応答 type 値・interaction type 判定・ephemeral flag 等の**実行時 enum 値は必ず `discord-interactions`(workerd で正しく解決。verify.ts/index.ts/response.ts/dispatch.ts が使用)から取る**こと(InteractionResponseType.PONG/CHANNEL_MESSAGE_WITH_SOURCE/DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE/MODAL、InteractionType.PING/APPLICATION_COMMAND/MESSAGE_COMPONENT/MODAL_SUBMIT、InteractionResponseFlags.EPHEMERAL=64)。`discord-api-types` は**型のみ**使用(design §Technology Stack と一致)。task 4.1 で response.ts/dispatch.ts を是正済み。**Discord ランタイム挙動を伴うテストは workers プロジェクトで実行すること**(node のみだと workerd 不具合を見逃す)。
