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
- [x] 5.1 検証〜ディスパッチ統合テスト
  - 署名済み command/component/modal interaction が各対応ハンドラへ振り分けられること、未登録で判別可能エラーが返ることを検証する
  - deferred ハンドラで type5 即返後に follow-up REST(@original PATCH)が呼ばれること、即時ハンドラで type4 が返ること、modal ハンドラで type9(MODAL)応答(customId/title/text input を含む)が返ることを検証する
  - 完了状態: 上記ディスパッチ/deferred/modal/未登録パスの統合テストが通る
  - _Requirements: 1.6, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.7_
  - _Depends: 4.1_

- [x] 5.2 PING スモークとコマンド登録スモーク
  - PING リクエストに対し Worker が PONG を返し、Discord エンドポイント登録検証相当が通ることを確認する
  - 登録スクリプト実行で集約コマンドが(モック/テスト用 API に)bulk overwrite 登録されることを確認する
  - 完了状態: PING→PONG スモークと登録スモークが通る
  - _Requirements: 1.4, 2.1, 2.2, 2.4_
  - _Depends: 4.1, 3.4_

- [x] 5.3 プロアクティブ送信のプライバシー境界テスト
  - プロアクティブ送信が DM/指定された個人用フォールバックチャンネルに限定され、公開チャンネル宛の任意送信経路が存在しないことを検証する
  - 完了状態: DM 成功・403 フォールバック・fallback 無し失敗の各パスと、公開チャンネル送信経路が公開されていないことを確認するテストが通る
  - _Requirements: 5.1, 5.2, 5.3, 5.5, 6.3, 6.4_
  - _Depends: 2.5_

- [x] 6. message component button 契約
- [x] 6.1 button 応答契約の型を追加
  - MessageButton(type2: custom_id/label/style 1-4/disabled)・MessageActionRow(type1: MessageButton[])・MessageOptions(ephemeral?/components?) を types に追加する
  - HandlerResult の reply 変種に任意の components(MessageActionRow[])を追加する(既存フィールドへの純加算)
  - message 用 MessageActionRow と modal 用 ModalActionRow を型レベルで区別する。本タスクでは Followup インターフェイスは変更しない(6.3 で実装と同時に拡張する)
  - 完了状態: MessageButton/MessageActionRow/MessageOptions が公開され reply 変種が components を持つ。追加は型への純加算で、既存実装に手を入れずプロジェクト全体の型チェックが緑のまま通る
  - _Requirements: 4.8, 4.11_
  - _Boundary: Interaction 型・ハンドラ規約_
  - _Depends: 1.2_

- [x] 6.2 (P) 即時応答(reply)に button を載せる
  - response の reply オプションを MessageOptions の components 対応にし、components 指定時に応答 data.components へ message 用 action row/button を出力する
  - button style は 1-4 に限定し modal 用 component と混同しない
  - 完了状態: reply に MessageActionRow を渡すと type4 応答の data.components に action row/button が含まれ、ephemeral と併用できることをユニットテストで確認できる
  - _Requirements: 4.8_
  - _Boundary: Response Utilities_
  - _Depends: 6.1_

- [x] 6.3 (P) follow-up に button を載せ Followup 契約を拡張
  - Followup.editOriginal/send の opts を MessageOptions(ephemeral + components)へ拡張し(契約の型と followup/rest の実装を同一タスクで一括変更)、MessageOptions.components を webhook body の components に含める
  - 完了状態: editOriginal/send が components を受け取り webhook body に action row/button が含まれること、および変更後もプロジェクト全体の型チェックが緑のまま通ることをユニットテストで確認できる
  - _Requirements: 4.9_
  - _Boundary: Followup Utility, Discord REST Client, Followup 契約型_
  - _Depends: 6.1_

- [x] 6.4 button 応答と component ディスパッチを配線
  - dispatch の reply 経路が HandlerResult.components を response の reply に MessageOptions として渡す配線にする
  - button 押下による message component interaction(type3)が既存の custom_id ディスパッチ規約で対応ハンドラへ戻ることを保証し、button 固有の業務判断はゲートウェイに置かない
  - 完了状態: components 付き reply が type4 応答に反映され、同一 custom_id の type3 interaction が component handler へ振り分けられる
  - _Requirements: 4.10, 4.11_
  - _Boundary: Interaction Dispatcher_
  - _Depends: 6.1, 6.2, 3.2_

- [x] 6.5 button 契約の統合テスト
  - mode:"reply" + components で type4 応答に action row/button が含まれること、deferred の followup.editOriginal/send で webhook body に button が含まれること、button custom_id の type3 interaction が component handler へ振り分けられることを検証する
  - 完了状態: button 即時応答・button follow-up・button→component ディスパッチの統合テストが通る
  - _Requirements: 4.8, 4.9, 4.10, 4.11_
  - _Depends: 6.4, 6.3_

- [ ] 7. Req 8: DO-backed 永続的 deferred 継続 substrate
- [x] 7.1 永続的継続の型契約を追加
  - HandlerResult に DO-backed deferred 変種(`mode:"deferred-persistent"`: 継続キー + シリアライズ可能 payload)を純加算し、既存の reply/deferred/modal 変種は変更しない
  - 継続業務関数型 `Continuation`(env + payload + Followup を受ける)、DO alarm へ運ぶ封筒 `DeferredContinuationEnvelope`(interactionToken/applicationId/continuationKey/payload)、JSON シリアライズ可能な `ContinuationPayload`/`JsonValue` 型を公開する
  - 完了状態: 下位スペックが import できる deferred-persistent 変種・Continuation・envelope・payload 型が公開され、追加は型への純加算でプロジェクト全体の型チェックが緑のまま通る
  - _Requirements: 8.1, 8.3, 8.6, 8.8_
  - _Boundary: Interaction 型・ハンドラ規約_
  - _Depends: 1.2_

- [x] 7.2 (P) ユーザー単位データホーム鍵を infra routing へ昇格
  - 現状 goal-management が所有するユーザー単位データホーム鍵 `PRIMARY_CYCLE_KEY`(`"primary"`)を infra-foundation の `agents/routing.ts` へ移動・export し、ゲートウェイの継続 enqueue が上流から consume できるようにする
  - 既存 consumer(goal-management / status-and-draft)の import 元を infra routing へ差し替える(規約の意味は不変・追加的変更で、リテラル `"primary"` を各所で再定義しない)
  - 完了状態: `PRIMARY_CYCLE_KEY` が infra routing から export され、全 consumer が同一鍵を上流から参照し、プロジェクト全体の型チェックと既存テストが緑のまま通る
  - _Requirements: 8.2_
  - _Boundary: infra routing (agents/routing.ts)_

- [x] 7.3 永続的継続 substrate を実装
  - 継続レジストリ(`registerContinuation`/`lookupContinuation`: 継続キー → `Continuation`、未登録キーで null)を module スコープの登録状態として実装する
  - enqueue ヘルパーを実装し、`getCycleAgent(env, userId, PRIMARY_CYCLE_KEY)` でユーザー自身のホーム Agent を取得して seam メソッド(7.4 で追加)へ envelope を渡し `this.schedule(0, ...)` 登録を依頼する(所有者スコープは Agent 名の userId で構造的に閉じる)
  - substrate runner を実装し、alarm 実行時に envelope の interactionToken/applicationId から Followup を再構築 → 継続キーで Continuation を照合・実行 → 成功で本応答 follow-up(editOriginal)を送出。継続キー未登録・継続例外・token 失効はいずれも失敗 follow-up を送り「考え中…」固着を防ぐ
  - pending KV 保持には触れず、継続関数の内部で各機能が既存規約のまま保持できるよう Followup と payload のみを渡す
  - 完了状態: 継続レジストリの登録/照合往復が成立し、enqueue が primary cycle agent seam へ envelope を渡し、runner が成功時のみ本応答 follow-up・失敗時は失敗 follow-up を送る substrate が公開される。enqueue は seam メソッド(7.4 追加)を呼ぶ wiring-root 相互参照で、7.4 完了で疎通が閉じる
  - _Requirements: 8.1, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8_
  - _Boundary: Persistent Continuation Substrate_
  - _Depends: 7.1, 7.2, 2.4_

- [x] 7.4 infra Agent に deferred-continuation seam を追加
  - `EvaluationCycleAgent` に `@callable` の登録メソッド(envelope を受け `this.schedule(0, "runDeferredContinuation", envelope)`)と alarm callback `runDeferredContinuation(envelope)` を追加する。callback 本体はゲートウェイ substrate runner(`runScheduledContinuation`)へ委譲する薄い配線で、`fireWeeklyCheckin` と同型・業務ロジックを持たない
  - この変更は infra-foundation への revalidation trigger であり、`this.schedule()` 実行基盤自体は再定義しない
  - 完了状態: enqueue 経由で seam の登録メソッドが envelope 付きで呼ばれ alarm が登録され、alarm 発火時に callback が substrate runner へ委譲する疎通が成立する(seam は業務ロジックを持たない)
  - _Requirements: 8.2, 8.8_
  - _Boundary: Deferred Continuation Seam (infra agents/evaluation-cycle-agent)_
  - _Depends: 7.3_

- [x] 7.5 deferred-persistent を dispatch に配線
  - ディスパッチャが `mode:"deferred-persistent"` を受けた際に type5(DEFERRED)を即返し、`ctx.waitUntil` 内で enqueue ヘルパーを呼んで primary cycle agent へ継続を登録する
  - envelope を `ctx.token`・`env.DISCORD_APPLICATION_ID`・継続キー・payload から組み立て、enqueue 自体の失敗時は失敗 follow-up へフォールバックして deferred 固着を防ぐ
  - 完了状態: deferred-persistent ハンドラで type5 が 3 秒以内に即返り、waitUntil で enqueue が呼ばれ、enqueue 失敗時に失敗 follow-up が送られることを確認できる
  - _Requirements: 8.1, 8.5_
  - _Boundary: Interaction Dispatcher_
  - _Depends: 7.3, 3.2_

- [ ] 7.6 継続レジストリと substrate のユニットテスト
  - 継続レジストリの register/lookup 往復・未登録キーで null を検証する
  - `runScheduledContinuation` が継続成功で本応答 editOriginal を呼ぶ、継続例外で失敗 follow-up を送る、継続キー未登録で失敗 follow-up を送る、envelope の token/applicationId から Followup を構築することを検証する
  - 継続登録の isolate 存在保証: DO を export するモジュールグラフ(`src/index.ts`)を評価した後、top-level 登録した継続キーが `lookupContinuation` で解決できることを workers/DO 実行コンテキスト相当で固定し、lazy/fetch 経路限定登録への退行を防ぐ
  - 完了状態: 上記レジストリ・runner・isolate 存在保証のユニットテストが workers プロジェクトで通る
  - _Requirements: 8.3, 8.4, 8.5, 8.6_
  - _Depends: 7.3, 7.5_

- [ ] 7.7 永続的継続の統合テスト
  - ハンドラが `mode:"deferred-persistent"` を返すと type5 が即返り、waitUntil で primary cycle agent の seam メソッドが envelope 付きで呼ばれることを検証する
  - seam の alarm callback が `runScheduledContinuation` へ委譲し、継続成功で本応答 follow-up・継続失敗/キー未登録で失敗 follow-up が送られること、seam が業務ロジックを持たず substrate へ委譲するだけであることを検証する
  - 完了状態: enqueue→seam→substrate→follow-up の成功/失敗パスを通す統合テストが通る
  - _Requirements: 8.1, 8.2, 8.4, 8.5, 8.8_
  - _Depends: 7.4, 7.5_

## Implementation Notes
- discord-api-types@0.38.48 では modal action row 子要素の v10 エクスポートは `APIComponentInModalActionRow`(design L287 の `APIModalActionRowComponent` は v8 のみで v10 に存在しない)。modal payload 型を扱う後続タスク(2.2 response, 3.2 dispatch)は v10 名を使うこと。`discord-interactions` は `dependencies`、`discord-api-types` は型のみで `devDependencies`。
- 新規テストは `vitest.config.ts` の `node`/`workers` プロジェクト `include` 配列へ登録必須。`node` プロジェクトのテストは `tsconfig.test.json` の `include` にも追加が必要(型チェック対象に含めるため)。Workers ランタイム/ExecutionContext/DO を要するテストは `workers` プロジェクト。【更新】現在 `node` プロジェクトは `test/**/*.test.ts` の glob 自動取り込みのため、純ロジックの node テストは `vitest.config.ts` への登録不要(`tsconfig.test.json` への追加のみ必要)。workers ランタイムを要するテストだけ vitest.config の workers include と node exclude へ登録する。
- task 6.1-6.5(button 契約)は型と各実装への純加算で完了。message 用 `MessageActionRow`(button=type2)と modal 用 `ModalActionRow`(text input=type4)は内包要素で型レベル区別され、`MessageButton`/`MessageActionRow` の Discord payload 互換性は types.ts の compile-time assertion(`APIButtonComponentWithCustomId`/`APIComponentInMessageActionRow`)で担保。button は plain data のため P0 の workerd enum 値問題には抵触しない(新規 discord-api-types の実行時 enum 値追加なし)。deferred 初期応答(type5)には button を載せず follow-up(`editOriginal`/`send` の `MessageOptions.components`)で送る(design L358/L373)。`reply` は `MessageOptions`、`deferred` は ephemeral 限定 `ResponseOptions` のまま分離。
- infra-foundation の `test/boundary.test.ts` は当初 `src/` 全体から Discord パターン(verifyKey/Ed25519/InteractionType 等)と discord-interactions/discord-api-types 依存を禁止していたが、discord-gateway design と衝突するため基盤自レイヤ限定に再スコープ済み(commit 1313b7e、ユーザー承認)。`src/discord/` と統合点 `src/index.ts` は対象外。よって task 3.2(InteractionType 利用)・4.1(index.ts への interactions 統合)は boundary 検査に抵触しない。
- **【P0・必読】discord-api-types/v10 の enum「値」(InteractionType.*/InteractionResponseType.*/MessageFlags.*)は本番 workerd ランタイム(@cloudflare/vitest-pool-workers)上で `undefined` に解決され実行時 TypeError を起こす(CJS __exportStar 再エクスポートの interop 問題)。node プロジェクトのテストでは CJS interop で動くため見逃される。応答 type 値・interaction type 判定・ephemeral flag 等の**実行時 enum 値は必ず `discord-interactions`(workerd で正しく解決。verify.ts/index.ts/response.ts/dispatch.ts が使用)から取る**こと(InteractionResponseType.PONG/CHANNEL_MESSAGE_WITH_SOURCE/DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE/MODAL、InteractionType.PING/APPLICATION_COMMAND/MESSAGE_COMPONENT/MODAL_SUBMIT、InteractionResponseFlags.EPHEMERAL=64)。`discord-api-types` は**型のみ**使用(design §Technology Stack と一致)。task 4.1 で response.ts/dispatch.ts を是正済み。**Discord ランタイム挙動を伴うテストは workers プロジェクトで実行すること**(node のみだと workerd 不具合を見逃す)。
- **task 7.1-7.7(Req 8 永続的継続 substrate)は既存 task 1-6 完了後の追加**。design.md の Req 8 追加に対応する(現行 `~24s` の LLM 推論が `waitUntil` budget 超過で follow-up 不達 → 「考え中…」固着を解消)。継続業務の中身(checkin 分類 / `/status` / `/draft` の `mode:"deferred"`→`mode:"deferred-persistent"` 移行と `registerContinuation` 呼び出し)は**下位機能スペックの adoption** であり本スペック対象外(design L644)。本スペックは substrate(切り離し・token 受け渡し・follow-up 送出・失敗フォールバック)のみ所有(Req 8.8)。週次レビュー生成は既に `fireWeeklyCheckin`(cron scheduled callback)上で DO 実行されるため本 substrate 対象外。
- **task 7.2/7.4 は infra-foundation 所有ファイルへの変更 = revalidation trigger**。`PRIMARY_CYCLE_KEY` 昇格(`agents/routing.ts`)は goal-management / status-and-draft の import 元差し替えを伴う(規約の意味は不変・追加的)。`EvaluationCycleAgent` seam(`@callable scheduleDeferredContinuation` + alarm callback `runDeferredContinuation`)は `fireWeeklyCheckin` と同型の wiring-root 例外で、ゲートウェイ `continuation.ts` の `runScheduledContinuation` を import する薄い委譲のみ(業務ロジック非実装)。
- **task 7.3 enqueue と 7.4 seam は module 間相互参照(wiring-root)**。enqueue が agent seam メソッドを呼び、seam callback が substrate runner を呼ぶ。順序は 7.3(substrate)→7.4(seam)とし、7.4 完了で疎通が閉じる。継続登録(`registerContinuation`)は handler registry と同様 `src/index.ts` 起動時 top-level 副作用で行い、`index.ts` が `export { EvaluationCycleAgent }` するため Worker fetch / DO 双方の isolate に反映される。lazy/fetch 経路限定登録は**禁止**(DO isolate で lookup-miss → 失敗 follow-up 誤発火が常態化する。task 7.6 で回帰固定)。
