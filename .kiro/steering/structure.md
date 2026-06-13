# Project Structure

## Organization Philosophy

レイヤード + 機能境界の併用。`infra-foundation` が共有基盤(Agent・永続化・型・LLM クライアント・Discord I/O 規約)を提供し、各機能スペックは「薄いハンドラ層 + Agent ドメインメソッド」という同一パターンで実装される。責務の境界はスペック境界と一致させ、共有所有を避ける。

実装はまだ存在しない(グリーンフィールド)。以下は確定済みの組織パターンであり、新規ファイルがこのパターンに従う限り steering の更新は不要。

## Directory Patterns

### Worker エントリ層
**Location**: `src/`(エントリ)+ `src/discord/`
**Purpose**: Discord interactions の受信・Ed25519 検証・ルーティング・応答整形・プロアクティブ REST 送信。ビジネスロジックを持たない。
**Example**: `src/discord/dispatch.ts`, `src/discord/response.ts`

### Agent(Durable Object)層
**Location**: `src/agents/`
**Purpose**: 状態保持とドメインロジック。`EvaluationCycleAgent`(サイクル/データ権威)と `GoalAgent`(目標単位ロジック)。
**Example**: `src/agents/evaluation-cycle-agent.ts`, `src/agents/goal-agent.ts`

### コマンドハンドラ
**Location**: `src/handlers/`(機能スペックが追加)
**Purpose**: 各 slash command / modal / button の I/O 変換。Agent メソッドを呼び結果を `HandlerResult` に整形するのみ。
**Example**: `/goal add`, `/checkin`, `/status`, `/draft` の各ハンドラ

### 永続化・型・LLM
**Location**: `src/db/`(スキーマ/マイグレーション/Repository)、`src/types/`(共有ドメイン型)、`src/llm/`(`LlmClient` + Workers AI 実装 + `createLlmClient`)
**Purpose**: `infra-foundation` 単独所有の共有基盤。下流は consume するが再定義しない。

## Naming Conventions

- **ファイル**: kebab-case(例: `evaluation-cycle-agent.ts`, `notification-operations.ts`)
- **型 / クラス**: PascalCase(例: `EvaluationCycleAgent`, `StatusVerdict`, `HandlerResult`)
- **関数 / 変数**: camelCase(例: `determineGoalStatus`, `createLlmClient`)
- **DB テーブル / 列**: snake_case(`goal-agent-spec.md` §11 準拠。例: `evidence_goal_links.relevance_score`)
- **custom_id**: 機能スペックが所有し、識別子に必要なコンテキスト(pendingId 等)を埋め込む

## Code Organization Principles

- **依存方向**: infra-foundation → discord-gateway → goal-management → {checkin-classification, status-and-draft} → notifications。逆流させない。
- **スキーマ単独所有**: §11 テーブルは infra のみが定義。他スペックは Repository 経由で読み書きし列を足さない。
- **producer/consumer 契約**: spec A の出力(`StatusVerdict`、`sendDirectMessage`、`LlmClient` など)を spec B が消費する箇所は契約を厳密一致させ、変更は revalidation trigger として下流へ波及確認する。
- **所有者スコープ**: 構造的分離(Agent 名に userId)+ 行レベル `assertOwned`。所有者不一致は not-found に正規化し他ユーザーデータを漏らさない。
- **LLM を呼ぶコマンド**: deferred + follow-up を使う。LLM 不要なコマンドは即時 ephemeral 応答。

---
_組織パターンと命名規則のみ記載。ディレクトリツリーの列挙はしない。スペック単位の詳細は `.kiro/specs/<feature>/design.md` を参照_
