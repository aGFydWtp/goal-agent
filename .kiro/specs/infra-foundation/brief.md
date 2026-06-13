# Brief: infra-foundation

## Problem
評価目標フォロー Agent の全機能(Discord I/O、目標管理、分類、判定、通知)は、共通の実行基盤・永続化層・Agent トポロジ・LLM クライアントの上に成り立つ。これらが未確定のままでは上位スペックを独立実装できない。

## Current State
グリーンフィールド。仕様書 `goal-agent-spec.md` のみ存在し、コードベース・ステアリングは未作成。

## Desired Outcome
- `wrangler` でデプロイ可能な Cloudflare Worker + Agents SDK プロジェクト雛形が動く。
- 仕様書 §11 の全テーブルが DO SQLite スキーマ + マイグレーションとして定義され、初期化される。
- Agent トポロジ(EvaluationCycleAgent / GoalAgent、ID 規約 §6)の骨格と Agent 間ルーティングが確立する。
- Workers AI を呼ぶ LLM 抽象化レイヤ(プロバイダ差し替え可能)が共有ユーティリティとして提供される。
- 共有型(Cycle/Goal/Milestone/Checkin/Evidence/Draft 等)が定義され、全スペックから参照可能。

## Approach
Cloudflare `agents` パッケージで EvaluationCycleAgent / GoalAgent を Durable Object として実装。`this.sql` に §11 スキーマをマイグレーション適用。LLM は `LlmClient` インターフェイス越しに Workers AI を呼び、モデル/プロバイダを 1 箇所で差し替え可能にする。

## Scope
- **In**: プロジェクト雛形(wrangler.toml, TS, ビルド)、DO SQLite スキーマ + マイグレーション(全 §11 テーブル)、Agent 骨格と ID ルーティング、LLM 抽象化レイヤ + Workers AI 実装、共有型、ローカル開発手順。
- **Out**: 具体的な slash command 処理(discord-gateway)、ドメイン CRUD ロジック(goal-management)、各機能のプロンプト本体(各機能スペックが所有)。

## Boundary Candidates
- 永続化層(SQLite スキーマ + マイグレーション + リポジトリ的アクセス)
- Agent トポロジ(EvaluationCycleAgent / GoalAgent の責務分担と ID 規約)
- LLM 抽象化レイヤ(`LlmClient` + Workers AI 実装)
- 共有ドメイン型

## Out of Boundary
- Discord interactions の検証・ルーティング(discord-gateway が所有)
- コマンド単位のビジネスロジックや UX 文言
- ステータス判定ルール・分類プロンプト・評価文プロンプト(各機能スペック)

## Upstream / Downstream
- **Upstream**: なし(基盤)
- **Downstream**: discord-gateway, goal-management, checkin-classification, status-and-draft, notifications すべてが依存

## Existing Spec Touchpoints
- **Extends**: なし
- **Adjacent**: discord-gateway(基盤の Agent/型を直接利用)

## Constraints
- `agents` パッケージを使用(`@cloudflare/agents` は非推奨)。
- DO SQLite は GA だが 2026-01-07 以降ストレージ課金対象(本用途は小規模)。
- **要設計判断**: Agent トポロジは仕様書の「EvaluationCycleAgent + 目標ごと GoalAgent」か、調査が示す「ユーザー単位 Agent」か。design フェーズで確定する。
- LLM 抽象化は Workers AI を初期実装としつつ、日本語品質リスクに備え差し替え可能にする。
