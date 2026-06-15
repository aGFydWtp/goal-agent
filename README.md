# goal-agent

半期の評価目標を Discord Bot 経由で継続追跡する個人向け Agent です。Cloudflare Workers + Agents SDK 上で動作し、Discord の slash command / modal / button から、目標管理・週次チェックイン・証跡管理・状態確認・自己評価ドラフト生成を扱います。

## 現在の主な機能

- `/cycle` — 評価サイクルを作成する
- `/goal add` — 評価目標を modal 入力で追加する
- `/goal status` — 指定した目標の状態と次アクションを表示する
- `/evidence delete` — 保存済み証跡を削除する
- `/evidence list` — 保存済み証跡を一覧表示する
- `/checkin` — 今週やったことを入力し、目標へ分類して確認後に証跡化する
- `/status` — 半期全体の各目標の状態を一覧表示する
- `/draft goal` / `/draft all` — 保存済み証跡から自己評価ドラフトを生成する

Discord コマンドは global 登録を基本にします。開発時だけ guild 登録を使う場合は、global と guild の両方に同名コマンドを残すと Discord UI に 2 個ずつ表示されます。

## 前提条件

- Node.js v24
- pnpm
- Cloudflare アカウントと Wrangler 認証
- Discord Application / Bot

## セットアップ

```bash
pnpm install
```

ローカル実行とコマンド登録では `.dev.vars` から Discord 設定を読みます。シークレットはコミットしないでください。

```dotenv
DISCORD_PUBLIC_KEY=...
DISCORD_APPLICATION_ID=...
DISCORD_BOT_TOKEN=...
# 任意: guild 単位でコマンド登録したい場合だけ指定
# DISCORD_GUILD_ID=...
# 任意: DM 失敗時の個人用フォールバック先
# DISCORD_FALLBACK_CHANNEL_ID=...
```

本番の Worker には Wrangler secret / Cloudflare dashboard で同等の値を設定します。

```bash
pnpm wrangler secret put DISCORD_PUBLIC_KEY
pnpm wrangler secret put DISCORD_APPLICATION_ID
pnpm wrangler secret put DISCORD_BOT_TOKEN
```

## ローカル開発

```bash
pnpm dev
```

主なエンドポイント:

- `GET /` — `goal-agent: ok`
- `GET /__health/wiring` — Durable Object / LLM クライアント配線の疎通確認
- `POST /interactions` — Discord interactions 受信口

Cloudflare 認証が使えない環境では、ローカルエミュレーションで起動できます。

```bash
pnpm dev --local
```

Workers AI は `wrangler.jsonc` で `remote: true` のため、AI 推論を実際に呼ぶには Cloudflare 側の認証とリモートバインディングが必要です。

## Discord コマンド登録

global に登録する通常手順:

```bash
pnpm run register:commands
```

開発用 guild にだけ登録する場合:

```bash
pnpm run register:commands -- --guild-id <guild-id>
```

`DISCORD_GUILD_ID` が `.dev.vars` にある場合も guild 登録になります。global だけで運用したい場合は `DISCORD_GUILD_ID` を外してください。

現在の登録スクリプトは以下をまとめて Discord API へ bulk overwrite します。

- `/cycle`
- `/goal` (`add`, `status`)
- `/evidence` (`delete`, `list`)
- `/checkin`
- `/status`
- `/draft` (`goal`, `all`)

## デプロイ

```bash
pnpm run deploy
```

`pnpm deploy` は pnpm の組み込み deploy と解釈されるため、このリポジトリでは `pnpm run deploy` を使います。

デプロイ後、Discord Developer Portal の Interactions Endpoint URL には Worker の `/interactions` を設定します。

```text
https://<worker-domain>/interactions
```

## 開発コマンド

```bash
pnpm run typecheck
pnpm test
pnpm biome check --write
```

- `pnpm run typecheck` — `tsc --noEmit` と test 用 tsconfig の型チェック
- `pnpm test` — Vitest
- `pnpm biome check --write` — Lint / Format

タスク完了時は、対象テスト・型チェック・Biome を通してから完了扱いにします。

## アーキテクチャ概要

- `src/index.ts` — Worker entry。Discord 署名検証、PING/PONG、interaction dispatch を行う
- `src/discord/` — Discord gateway。コマンド登録、handler registry、reply/deferred/follow-up/modal/button、REST 送信を扱う
- `src/agents/` — `EvaluationCycleAgent` / `GoalAgent`
- `src/goal-management/` — cycle / goal / evidence のコマンド・ハンドラ・ドメイン処理
- `src/checkin-classification/` — `/checkin`、分類、pending 保存、確認ボタン、週次レビュー
- `src/status-and-draft/` — `/status`、`/draft`、`/goal status`、`/evidence list`
- `src/notifications/` — DM / 個人用フォールバックチャンネルへの通知送信

永続化は Durable Object SQLite、LLM は Cloudflare Workers AI 抽象化レイヤ経由です。個人評価データは DM または個人用非公開チャンネル、ephemeral 応答を前提に扱います。
