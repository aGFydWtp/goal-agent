# Research & Design Decisions

## Summary
- **Feature**: `discord-gateway`
- **Discovery Scope**: Extension(既存 discord-gateway 契約に reply/follow-up の message component button payload を追加)
- **Key Findings**:
  - Discord interactions エンドポイントは Ed25519 署名検証(`X-Signature-Ed25519` / `X-Signature-Timestamp` + raw body)と PING(type1)→PONG(type1) を必須とする。検証は raw リクエストボディに対して行う必要があり、JSON パース前に raw body を保持しなければならない。
  - Worker は WebSocket Gateway を常駐できないため interactions(HTTP POST)方式が唯一の正攻法(roadmap で確定済み)。初期応答は 3 秒以内、deferred(type5)後の follow-up は最大 15 分。`ctx.waitUntil()` で初期応答後の処理継続を担保する。
  - Discord の interaction callback data と follow-up webhook body は message `components` をサポートする。button は message 用 Action Row(type1)内の Button(type2)として送信し、custom_id を持つ非 Link/Premium button(style 1-4)のみが後続の message component interaction(type3)として戻る。
  - 署名検証・プロアクティブ送信は upstream infra-foundation の Agent/型/LLM 契約とは独立した「Worker エントリー層 + 純粋ヘルパー」で完結でき、infra-foundation の `Env`・ルーティングヘルパーを消費するだけで境界が閉じる。

## Research Log

### Discord HTTP interactions プロトコル
- **Context**: 署名検証・PING/PONG・応答型・follow-up の正確な契約を確定する必要があった。
- **Sources Consulted**: goal-agent-spec.md §7(Discord インターフェイス基本方針)・§14(Message UX)・§15(プライバシー)、Discord Developer Docs(Interactions / Receiving and Responding / Message Components / REST Webhook の一般的契約)、brief.md の Approach/Constraints。
- **Findings**:
  - 署名検証: `X-Signature-Ed25519`(hex)と `X-Signature-Timestamp` を取得し、`timestamp + rawBody` を Discord アプリ公開鍵(`DISCORD_PUBLIC_KEY`)で Ed25519 検証する。失敗・欠落は 401。
  - interaction type: 1=PING, 2=APPLICATION_COMMAND, 3=MESSAGE_COMPONENT, 5=MODAL_SUBMIT。応答 type: 1=PONG, 4=CHANNEL_MESSAGE_WITH_SOURCE, 5=DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, 6=DEFERRED_UPDATE_MESSAGE, 7=UPDATE_MESSAGE。
  - ephemeral は `data.flags` に `1<<6`(64)を立てる。
  - follow-up は `PATCH /webhooks/{application_id}/{interaction_token}/messages/@original`(本応答編集)または `POST /webhooks/{application_id}/{interaction_token}`(追加 follow-up)。token は最大 15 分有効。
  - プロアクティブ送信: `POST /users/@me/channels`(body `{recipient_id}`)で DM チャンネルを open → `POST /channels/{channel_id}/messages`。bot token は `Authorization: Bot {token}` ヘッダ。DM 不可ユーザーは 403(`Cannot send messages to this user`)。
- **Implications**: Worker エントリーは raw body を一度だけ読み、検証後に JSON 解析する単一フローにする。deferred 後処理は `executionCtx.waitUntil()` で継続。follow-up とプロアクティブ送信は同じ REST 呼び出し基盤(fetch ベース)に集約できる。

### Message component button payload 契約
- **Context**: `/checkin` 開始ハンドラが ephemeral prompt と `[入力する]` button を返す必要があるが、旧 `HandlerResult.reply` / `Followup` 契約は content と ephemeral しか表現できなかった。
- **Sources Consulted**:
  - [Discord Developer Docs: Component Reference](https://docs.discord.com/developers/components/reference)
  - [Discord Developer Docs: Receiving and Responding to Interactions](https://docs.discord.com/developers/interactions/receiving-and-responding)
- **Findings**:
  - Interaction callback data の message body は `components` を持てる。follow-up message も webhook message として components を送れる。
  - Button は message でのみ使える interactive component で、Action Row(type1)または Section accessory に配置する。MVP では legacy action row 形式を採用する。
  - custom_id は開発者定義の 1-100 文字で、ユーザーが component を操作した際に interaction payload として返る。message 上の複数 component は custom_id を共有してはならない。
  - Primary/Secondary/Success/Danger(style 1-4)は custom_id を必要とし、Link(style 5)と Premium(style 6)は custom_id を持たず app へ interaction を返さない。
  - `DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE` の初期 callback data は実質 ephemeral flag のみを扱うべきで、components は deferred 後の edit original / follow-up message で送る。
- **Implications**: `types.ts` に `MessageActionRow` / `MessageButton` / `MessageOptions` を追加し、`HandlerResult.reply` と `Followup.editOriginal/send` が同じ `MessageOptions.components` を受け取る設計にする。deferred 初期応答の components は非対応とし、button は本応答または追加 follow-up に載せる。button の custom_id と押下後の業務処理は下位機能スペックが所有する。

### ライブラリ選定(discord-interactions / discord-api-types / @discordjs/rest)
- **Context**: brief.md が `discord-interactions` / `discord-api-types` / `@discordjs/rest`(または fetch)を提案。Workers ランタイム互換と最小依存を確認する。
- **Findings**:
  - `discord-interactions`: `verifyKey`(Web Crypto 互換の Ed25519 検証ヘルパー)と type 定数を提供。Workers 上で動作実績あり。署名検証の自前実装(`crypto.subtle.verify('Ed25519', ...)`)も可能だが、検証ロジックは枯れたライブラリ採用が妥当(build-vs-adopt → adopt)。
  - `discord-api-types`: 型のみ(ランタイムコストゼロ)。interaction payload・REST body の型安全に有用。採用。
  - `@discordjs/rest`: full discord.js とは別パッケージで REST のみ。ただし Worker では `fetch` 直叩きで十分かつ依存最小。MVP は `fetch` ベースの薄い REST クライアントを自前実装し、`discord-api-types` の型で固める(simplification)。
- **Implications**: 採用 = `discord-interactions`(検証)+ `discord-api-types`(型)。REST は `fetch` ベースの薄い内部クライアント。full `discord.js` は不使用(roadmap 制約)。

### infra-foundation 契約の消費点
- **Context**: 本スペックは upstream の Agent トポロジ・共有型・LLM を再定義しない。
- **Findings**: infra-foundation は `Env`(`AI` / `EvaluationCycleAgent` / `GoalAgent` バインディング)、`getCycleAgent`/`getGoalAgent` ルーティング、`parseAgentName`、共有ドメイン型を公開。Worker エントリーは infra-foundation が `src/index.ts` で確立した `fetch` 委譲点に Discord interactions パスを統合する。
- **Implications**: ゲートウェイは `Env` を拡張(Discord 用 secrets を追加)し、interaction の実行ユーザー/コマンド名から下位ハンドラへ渡すコンテキストを組み立てるが、Agent 取得自体は各機能ハンドラ側が infra-foundation のルーティングヘルパーで行う。ゲートウェイはハンドラ登録規約とコンテキスト供給に責務を限定する。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Worker エントリー層 + ハンドラレジストリ | 署名検証→種別判定→レジストリ照合→ハンドラ実行の薄い層 | 境界が明確・各機能が並行実装可・テスト容易 | レジストリのキー衝突管理が必要 | 採用 |
| 各機能が個別に検証/応答を実装 | コマンドごとに完結 | ゲートウェイ不要 | 署名検証重複・事故の温床(brief の問題そのもの) | 却下 |
| full discord.js Gateway Bot | 常駐 WebSocket | リッチな抽象化 | Worker で WebSocket 常駐不可 | 却下(roadmap) |

## Design Decisions

### Decision: 署名検証は `discord-interactions` の verifyKey を採用
- **Context**: Ed25519 検証は誤実装が即セキュリティ事故になる(Req 1)。
- **Alternatives Considered**:
  1. `crypto.subtle.verify('Ed25519')` 自前実装
  2. `discord-interactions` の `verifyKey`
- **Selected Approach**: `discord-interactions` の `verifyKey(rawBody, signature, timestamp, publicKey)` を Worker エントリーで使用。
- **Rationale**: 枯れた実装で Workers 互換。検証ロジックを自前で持たないことで事故面積を縮小。
- **Trade-offs**: 依存追加 1 つ。許容。
- **Follow-up**: raw body を JSON パース前に確実に取得していること、検証失敗時に確実に 401 を返すことをテストで担保。

### Decision: deferred 後処理は executionCtx.waitUntil で継続
- **Context**: LLM を伴うコマンドは 3 秒以内に応答できない(Req 4)。
- **Selected Approach**: ハンドラが「deferred 宣言」した場合、ゲートウェイは即 type5 を返し、重い処理を `ctx.waitUntil(handler.run(...))` で継続。完了時に follow-up webhook で本応答を PATCH。
- **Rationale**: Discord の 3 秒制約と follow-up 15 分窓に整合。Worker のライフサイクルに沿った標準パターン。
- **Trade-offs**: ハンドラは「即時応答型」か「deferred 型」かを宣言する必要がある(規約として明示)。
- **Follow-up**: follow-up token 失効(15 分)時の失敗ハンドリングを送信ヘルパーで判別可能にする。

### Decision: REST は fetch ベースの薄い内部クライアント(@discordjs/rest 不採用)
- **Context**: follow-up とプロアクティブ送信に Discord REST が必要(Req 4, 5)。
- **Selected Approach**: `fetch` + `Authorization: Bot {token}` の薄いラッパを内部に置き、`discord-api-types` の body 型で固める。
- **Rationale**: 依存最小・Workers 互換が確実・MVP に十分。
- **Trade-offs**: レート制限の高度な扱いは持たない(MVP 規模で許容)。
- **Follow-up**: 429 応答時の最小リトライ要否は実装時に確認(MVP は単純伝播で開始)。

### Decision: message component button は `MessageOptions.components` に集約
- **Context**: 即時 reply と deferred 後の follow-up の両方で button を送る必要がある(Req 4.8, 4.9)。
- **Alternatives Considered**:
  1. `HandlerResult.reply` と `Followup` に別々の components 型を追加する
  2. 共通の `MessageOptions` を導入して reply / follow-up / REST body で共有する
  3. Discord payload 型を各下位ハンドラへ直接露出する
- **Selected Approach**: `MessageOptions` に `ephemeral?: boolean` と `components?: MessageActionRow[]` を持たせ、`HandlerResult.reply.components` と `Followup.editOriginal/send(content, opts)` で同じ message component 契約を使う。`MessageButton` は custom_id を持つ style 1-4 に限定する。
- **Rationale**: reply と follow-up はどちらも Discord message body を作るため、同一契約にすると実装とテストが重複しない。Link/Premium button を除外することで、custom_id ディスパッチへ戻る button だけを扱える。
- **Trade-offs**: URL button 等の汎用 Discord components は扱わない。現行 requirements は custom_id ディスパッチを前提とするため許容。
- **Follow-up**: 実装時は `discord-api-types` の `APIActionRowComponent<APIButtonComponent>` と構造互換であることを型テストまたはコンパイル時検証で固定する。

### Decision: プライバシー(§15)はコンテキストとヘルパーで構造的に強制
- **Context**: 個人評価データは DM/個人用非公開チャンネル限定(Req 5, 6)。
- **Selected Approach**: ハンドラへ渡すコンテキストに実行ユーザー ID を必須で含め、プロアクティブ送信ヘルパーは DM open → 失敗時に「指定された個人用フォールバックチャンネル」へのみフォールバックする。公開チャンネル宛の任意送信 API を公開しない。ephemeral 送信手段を応答ヘルパーに用意。
- **Rationale**: 送信先を構造的に限定し、誤って公開チャンネルへ個人データを出す経路を作らない。
- **Trade-offs**: 汎用送信ではなく用途限定 API になる(意図通り)。
- **Follow-up**: フォールバックチャンネルが個人用非公開である保証は運用設定(env)に依存。ドキュメントで明示。

## Risks & Mitigations
- raw body 取得漏れで署名検証が常に失敗 — Worker エントリーで body を一度だけ `text()` 取得し検証→パースの順を固定。ユニットテストで担保。
- follow-up token 失効(15 分超の処理) — MVP の LLM 処理は数十秒想定で逸脱しない。失効時は送信ヘルパーが失敗を返し呼び出し元が判別。
- DM 不可ユーザー(403)で通知が届かない — フォールバックチャンネル指定でカバー。未指定時は失敗を返す(Req 5.3)。
- ハンドラ未登録 interaction — レジストリ未ヒット時に判別可能なエラー応答(Req 3.4)。
- button custom_id の重複や長さ超過 — gateway 型では custom_id 必須を固定し、重複/命名規約は custom_id を所有する下位機能スペックのテストで担保する。必要なら将来 gateway 側に軽量検証を追加する。

## References
- goal-agent-spec.md §7 / §14 / §15 — Discord インターフェイス・Message UX・プライバシー(authoritative)
- `.kiro/specs/infra-foundation/design.md` — `Env`・ルーティングヘルパー・共有型契約
- [Discord Developer Docs: Receiving and Responding to Interactions](https://docs.discord.com/developers/interactions/receiving-and-responding) — interaction callback data / follow-up webhook / 3 秒・15 分制約
- [Discord Developer Docs: Component Reference](https://docs.discord.com/developers/components/reference) — Action Row / Button / custom_id / button style
- `discord-interactions`(verifyKey)・`discord-api-types`(型)
