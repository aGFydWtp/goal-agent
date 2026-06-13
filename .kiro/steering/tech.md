# Technology Stack

## Architecture

Cloudflare のエッジ上で完結するサーバーレス Agent。ステートレスな Worker が Discord HTTP interactions のエントリ層となり、署名検証・ルーティング・応答整形を担当。ビジネスロジックと状態は Cloudflare Agents SDK の Durable Object(`EvaluationCycleAgent` / `GoalAgent`)が保持し、永続化は Durable Object 埋め込み SQLite。LLM は Workers AI を抽象化レイヤ越しに呼ぶ。

常駐 Gateway WebSocket は持てないため、slash command / modal / button はすべて HTTP POST(interactions)で受ける。重い処理(LLM 呼び出し)は deferred 応答(type5)+ follow-up webhook パターンで吸収する。

## Core Technologies

- **Language**: TypeScript(strict)
- **実行ランタイム**: Cloudflare Workers(`workerd`)+ Cloudflare Agents SDK(`agents` パッケージ、Durable Objects ベース)
- **永続化**: Durable Object SQLite(`this.sql`)
- **LLM**: Cloudflare Workers AI(抽象化レイヤ経由・差し替え可能)
- **ローカルツール用 Node.js**: **v24**(ビルド/スクリプト/CI のホスト実行系)

## Key Libraries

開発パターンに影響する主要ライブラリのみ:

- `agents` — Durable Object ベースの Agent(`this.sql` / `this.schedule()`)。※非推奨の `@cloudflare/agents` は使わない
- `discord-interactions` — Ed25519 署名検証
- `discord-api-types` — Discord ペイロード型
- `@discordjs/rest`(または `fetch`)— REST 呼び出し。※Gateway 指向の full `discord.js` は使わない
- `zod`(**v4**)— ランタイムスキーマ検証。LLM 構造化出力・modal/command 入力の境界検証に使用
- `wrangler` — ビルド・ローカル開発・デプロイ

## Development Standards

### Package Manager
**pnpm を使用**(npm / bun は使わない)。lockfile は `pnpm-lock.yaml` をコミット。Cloudflare 公式テンプレート/ドキュメントが pnpm を一級サポートし、複数 Discord/Agents パッケージの厳格な依存解決に適する。将来のモノレポ化は pnpm workspace で伸ばす。

### Type Safety
TypeScript strict。`any` を避け、Discord/LLM の境界では `discord-api-types` と自前の構造化出力型で型を付ける。共有ドメイン型は `infra-foundation` が単独所有し、各機能スペックはそれを消費する(再定義しない)。

### Runtime Validation(zod v4)
信頼できない入力(LLM 構造化出力・modal/command 入力)は **zod v4 スキーマで検証**する。型(`T`)とランタイム検証を二重管理しない:zod スキーマを単一の真実とし、`z.infer` で型を導出する。
- LLM クライアントの `completeJson` は **zod スキーマを引数に取り**、`safeParse` で検証した結果を返す(検証失敗は `invalid_output`)。これにより各機能の手書き `verify.ts` は「zod スキーマ定義 + ドメイン固有の追加チェック(未分類抽出・空入力ガード等)」に縮小する。
- 検証スキーマは各機能スペックが所有(`ClassificationResult` / `StatusVerdict` / `DraftContent` など)。LLM クライアント契約は `infra-foundation` 所有。

### Lint / Format
**Biome を使用**(ESLint / Prettier は使わない)。lint と format を単一ツールで統一し、設定は `biome.json` をリポジトリ直下に置きコミットする。
- **タスク完了ゲート**: 各タスクの最後に必ず `pnpm biome check --write` を実行し、エラーが残っていないことを確認してからタスクを完了とする。自動修正(`--write`)で解消しない違反は手で直す。lint/format エラーが残った状態でタスクを完了扱いにしない。

### Testing
ユニットテスト中心(分類/判定/ドラフトのプロンプト後処理、ルール判定、トリガ評価など純関数を優先的にテスト)。各スペックの design.md にテスト戦略を記載。

## Development Environment

### Required Tools
- Node.js **v24**
- pnpm
- wrangler(Cloudflare アカウント / Discord アプリ認証情報は環境変数・Secrets で管理。steering には記載しない)

### Common Commands
```bash
# 依存導入: pnpm install
# ローカル開発: pnpm wrangler dev   (または package.json の dev スクリプト)
# デプロイ:    pnpm wrangler deploy
# テスト:      pnpm test
# lint/format: pnpm biome check --write   (各タスク末尾で実行・エラー0を確認)
```

## Key Technical Decisions

- **Agent トポロジ**: `EvaluationCycleAgent` をサイクル単位 SQLite のデータ権威、`GoalAgent` を目標単位ロジックの論理 Agent(データは親へ RPC 委譲)とするハイブリッド。クロス目標の `/status` 集計を単一 SQLite 内で完結させ、分散一貫性問題を回避(`infra-foundation/research.md` に記録)。
- **SQLite スキーマ単独所有**: `goal-agent-spec.md` §11 の全テーブルは `infra-foundation` が所有。下流スペックは `Repository` 経由で消費し、列を追加しない(必要時は infra への revalidation trigger)。例外: `notifications` が状態遷移検出用に独立マイグレーションで自前テーブルを追加。
- **LLM 抽象化**: Workers AI を初期実装としつつ、日本語のニュアンス分類・評価文生成の品質は未検証リスク。`createLlmClient` の1箇所でモデル/プロバイダを差し替え可能にし、実データで早期ベンチマークする。
- **薄いハンドラ + Agent ドメインメソッド**: コマンドハンドラは I/O 変換に徹し、ビジネスロジックは Agent のメソッドに置く。`StatusVerdict` など下流が消費する判定は再利用可能な Agent メソッドとして公開する。

---
_主要な決定と標準のみ記載。全依存やファイル単位の説明はしない_
