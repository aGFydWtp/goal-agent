# Brief: discord-gateway

## Problem
Discord の slash command / modal / button はすべて HTTP POST で Worker に届くが、署名検証・PING応答・3秒以内の応答・後続 follow-up・プロアクティブ送信といった「Discord I/O 規約」を各機能が個別実装すると重複・事故の温床になる。共通ゲートウェイが必要。

## Current State
infra-foundation により Worker/Agent 骨格・型・LLM クライアントは存在するが、Discord との入出力経路は未実装。

## Desired Outcome
- Discord interactions エンドポイントが Ed25519 署名検証と PING(type1)→PONG を正しく処理し、エンドポイント登録が通る。
- slash command を登録するスクリプトがある。
- interaction を種別(command/modal submit/button)で適切な Agent/ハンドラへルーティングできる。
- 3秒以内に deferred 応答を返し、重い処理(LLM 等)後に follow-up webhook で本応答を PATCH できる共通パターンが提供される。
- bot token で DM/チャンネルへプロアクティブにメッセージ送信するヘルパーがある(DM 失敗時フォールバック含む)。

## Approach
`discord-interactions` / `discord-api-types` を用い、Worker のリクエストハンドラで署名検証 → ルーティング。LLM を伴うコマンドは `DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE`(type5)を返し、`ctx.waitUntil()` で後続処理 → follow-up。送信は `@discordjs/rest`(または fetch)で REST 呼び出し。

## Scope
- **In**: 署名検証、PING/PONG、command 登録スクリプト、interaction ルーター、deferred + follow-up ヘルパー、modal/button ディスパッチ基盤、プロアクティブ送信ヘルパー(DM チャンネル open → 送信、チャンネルフォールバック)。
- **Out**: 個別コマンドのビジネスロジック(/cycle, /goal, /checkin, /status, /draft は各機能スペック)、通知スケジューリング(notifications)。

## Boundary Candidates
- interactions エントリ(検証 + PING)
- ルーティング(command/modal/button → ハンドラ規約)
- deferred 応答 + follow-up ユーティリティ
- プロアクティブ REST 送信ヘルパー

## Out of Boundary
- コマンドごとの処理内容・UX 文言
- `this.schedule()` による通知トリガ(notifications が所有、送信ヘルパーのみ本スペックが提供)
- 永続化スキーマ(infra-foundation が所有)

## Upstream / Downstream
- **Upstream**: infra-foundation(Agent/型)
- **Downstream**: goal-management, checkin-classification, status-and-draft(コマンド処理)、notifications(送信ヘルパー利用)

## Existing Spec Touchpoints
- **Extends**: なし
- **Adjacent**: infra-foundation(Agent ルーティング先)、notifications(送信ヘルパー共有)

## Constraints
- Ed25519 検証必須・PING/PONG 必須(未対応だと Discord がエンドポイント登録を拒否)。
- 初期応答は 3 秒以内。follow-up は最大 15 分、`waitUntil` は応答後 ~30 秒まで延長(LLM 呼び出しを吸収)。
- プロアクティブ DM は対象ユーザーがギルド共有/DM 許可している必要があり、403 時はチャンネルメッセージにフォールバック。
- full `discord.js`(Gateway 指向)は使わない。
- プライバシー: DM/個人用非公開チャンネル限定(§15)。
