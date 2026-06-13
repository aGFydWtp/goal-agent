# Research & Design Decisions: checkin-classification

## Summary
- **Feature**: `checkin-classification`
- **Discovery Scope**: Extension(infra-foundation / discord-gateway / goal-management の確立済み契約上に、`/checkin` フローと分類・証跡化・週次レビューを追加)
- **Key Findings**:
  - Discord slash command は「自由文の返信を待つ」ネイティブ機構を持たない。`/checkin` の促し → 自由文入力は **ボタンで modal を開き、複数行テキスト入力を受ける** 形が interactions モデル上もっとも確実(discord-gateway の modal ディスパッチを消費)。
  - 分類は LLM レイテンシを伴うため、modal submit を **deferred + follow-up** で処理する(discord-gateway 規約)。コンテキスト(目標一覧 + 達成条件)は goal-management が確立した EvaluationCycleAgent ドメインメソッド経由で取得する。
  - 分類案は確定前に保持する必要がある(保存/修正/破棄ボタンをまたぐ)。pending 分類は EvaluationCycleAgent(データ権威)に一時状態として保持し、custom_id に pending ID を埋めて確定操作と紐付ける。
  - 週次レビューの見立て(ステータス)は status-and-draft 所有。本スペックは判定ルールを持たず、保存後メッセージでは summary/risks/next_actions を自前生成しつつ、ステータス見立ては status-and-draft 提供分を参照(MVP では未連携時に省略可能なオプショナル表示)。

## Research Log

### `/checkin` の自由文入力をどう受けるか
- **Context**: §8.3 は `/checkin` → Bot 促し → ユーザーが自由文返信、というフローを示す。Discord HTTP interactions では slash command 応答後に「次の通常メッセージ」をハンドラが受け取る経路がない(Gateway WebSocket を持たない Worker 制約)。
- **Sources Consulted**: discord-gateway/design.md(InteractionContext / modal ディスパッチ / deferred+follow-up)、goal-agent-spec.md §8.3・§14。
- **Findings**:
  - interactions で複数行の自由テキストを確実に受け取る手段は modal(`TextInput` paragraph スタイル)。discord-gateway は `kind: "modal"` のディスパッチと modal を開く応答手段を提供済み。
  - `/checkin` 即時応答で促し + [入力する] ボタンを ephemeral 提示 → ボタン押下で modal を開く → modal submit を deferred 処理、が gateway 契約に整合する。
- **Implications**: 本スペックは「`/checkin` コマンドハンドラ(促し+ボタン)」「[入力する] ボタンハンドラ(modal を開く)」「checkin modal submit ハンドラ(分類実行 = deferred)」を持つ。自由文を直接コマンドオプションで受ける代替も可能だが、複数行・雑メモ前提のため modal を採用。

### 分類コンテキストの取得元
- **Context**: §13.1 入力は「目標一覧・各目標の達成条件・今週の入力」。目標定義は goal-management が EvaluationCycleAgent に保持。
- **Sources Consulted**: goal-management/design.md(`listGoals`/`getGoal`、所有者スコープ)、infra-foundation/design.md(Repository、Agent 権威)。
- **Findings**: goal-management の `CycleDomainOperations.listGoals(userId, cycleId)` で目標一覧(title/description/success_criteria 等)を取得できる。所有者スコープは既に強制済み。
- **Implications**: 本スペックは目標取得 API を再実装せず消費する。対象サイクルは goal-management 同様「実行ユーザーが所有する最新サイクル」。

### LLM 構造化出力(§13.1)の信頼性
- **Context**: Workers AI の日本語品質・JSON 構造化出力の安定性は未検証リスク(roadmap)。
- **Sources Consulted**: infra-foundation/design.md(`LlmClient.completeJson<T>` は失敗時 `invalid_output` を返す、再試行強化は利用側)。
- **Findings**: `completeJson` は JSON パース失敗を判別可能に返す契約のみ提供。プロンプト・スキーマ検証・空入力ガードは利用側(本スペック)所有。
- **Implications**: 本スペックは分類プロンプト本体と構造化出力スキーマ + パース後の妥当性検証を所有。`invalid_output`/検証失敗時はユーザーに再試行案内し、誤った証跡を保存しない(Req 2.6)。プロバイダ差し替えは factory に委譲(Req 6.6)。

### pending 分類状態の保持
- **Context**: 分類後、保存/修正/破棄まで分類結果(relevanceScore・reason・usefulness・suggestedEvidenceTitle・未分類)を失わず保持する必要がある。
- **Findings**: EvaluationCycleAgent(DO SQLite + DO 単一実行)はサイクル単位の権威。pending 分類を一時的に保持し、ボタンの custom_id に pending 識別子を埋めて確定時に取り出す。確定/破棄で破棄。
- **Implications**: 永続化は §11 の確定テーブル(checkins/evidence/evidence_goal_links/weekly_reviews)のみ。pending は揮発的な作業状態として Agent インスタンスに保持(再起動消失は許容、MVP)。スキーマ追加は行わない(infra 境界尊重)。

### 週次レビュー生成とステータス見立て
- **Context**: §14.2 保存後メッセージは「見立て(ステータス)+ 理由 + 来週やるとよいこと」。ステータス判定は status-and-draft 所有(roadmap)。
- **Findings**: weekly_reviews は summary/risks/next_actions を持つ(§11.7)。本スペックはこれを LLM で生成・保存。ステータス Green/Yellow/Red の判定ルールは持たない。
- **Implications**: 保存後メッセージの summary/risks/next_actions は本スペックが生成。ステータス見立ては status-and-draft の判定を参照する(Where 条件、Req 5.4)。MVP で未連携の場合は見立て行を省略し、レビュー本体で価値を成立させる。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| 薄いハンドラ層 + Agent ドメインメソッド | goal-management と同型: handlers は Discord I/O、分類/証跡化ロジックは EvaluationCycleAgent ドメインメソッド | 上流 Agent 権威方針に整合、並行実装容易、所有者強制を一点に集約 | Agent メソッドが肥大化しうる | **採用**。goal-management の確立パターンを踏襲 |
| ハンドラ内に分類ロジック直書き | handler が LLM/Repository を直接操作 | 短期的に単純 | データ権威分散・所有者強制漏れ・テスト困難 | 却下 |
| 自由文をコマンドオプションで受領 | `/checkin text:...` | modal 不要 | 複数行/雑メモに不向き、UX が §8.3 と乖離 | 却下(modal 採用) |

## Design Decisions

### Decision: `/checkin` 自由文入力は modal 経由で受ける
- **Context**: HTTP interactions では slash 応答後の通常メッセージを受けられない。
- **Alternatives Considered**:
  1. modal(複数行 TextInput)で受ける
  2. コマンドオプション `text` で受ける
- **Selected Approach**: `/checkin` が促し + [入力する] ボタン(ephemeral)→ ボタンで modal を開く → modal submit を deferred 処理し分類実行。
- **Rationale**: 雑な複数行メモを自然に受けられ、discord-gateway の modal/deferred 契約に完全整合。
- **Trade-offs**: 1 ステップ(ボタン)増えるが、UX と実装確実性を優先。
- **Follow-up**: modal の TextInput 文字数上限(Discord: 4000)で長文時の切り詰め挙動を実装時に確認。

### Decision: 分類・証跡化・週次レビューは EvaluationCycleAgent ドメインメソッドに実装
- **Context**: データ権威は EvaluationCycleAgent(infra)。所有者スコープと単一権威を尊重。
- **Selected Approach**: `classifyCheckin`/`saveClassifiedCheckin`/`generateWeeklyReview` を Cycle ドメインメソッドとして実装(infra 骨格の中身を埋める)。ハンドラは I/O 変換のみ。
- **Rationale**: goal-management と同一パターン。所有者強制・Repository アクセス・LLM 呼び出しを Agent に集約。
- **Trade-offs**: Agent クラスの責務が増えるが、境界は分類/証跡化に限定。
- **Follow-up**: pending 分類保持のメモリ増を監視(MVP 規模では許容)。

### Decision: pending 分類は揮発的 Agent 状態 + custom_id 紐付け
- **Context**: 保存前確認(§15)のため分類結果を確定操作まで保持。
- **Selected Approach**: 分類完了時に pending ID を採番し Agent メモリに保持、確認メッセージのボタン custom_id に埋める。保存/破棄で破棄。修正は modal 再提示 → 再分類 or 直接編集値で上書き。
- **Rationale**: §11 スキーマに pending 用テーブルを追加せず(infra 境界尊重)、MVP の揮発許容で単純化。
- **Trade-offs**: DO 再起動で pending 消失 → ユーザーは再実行。確定済み証跡には影響しない。
- **Follow-up**: 必要なら将来 pending を checkins ドラフトとして永続化(infra 拡張扱い)。

## Risks & Mitigations
- Workers AI の日本語分類/JSON 品質不足 — プロンプト + スキーマ検証を本スペックが所有し、`invalid_output`/検証失敗で再試行案内。モデル差し替えは infra factory に集約(Req 6.6)。
- 分類の関連度誤判定 — 保存前に必ず確認 UX(保存/修正/破棄)を通す(§15、Req 3)。未分類項目も破棄せず提示(Req 2.5)。
- 証跡保存の部分失敗 — checkins/evidence/evidence_goal_links を単一権威(DO SQLite)上で一括処理し、不整合レコードを残さない(Req 4.6)。
- 週次レビュー生成失敗 — 証跡保存は確定済みとして保持し、レビュー失敗のみ通知(Req 5.5)。
- ステータス見立ての所有越境 — 判定ルールは持たず status-and-draft 参照に限定(Req 5.4)。

## References
- `goal-agent-spec.md` §8.3 / §11.4-11.7 / §13.1 / §14.1-14.2 / §15 — 出典仕様(権威)
- `.kiro/specs/infra-foundation/design.md` — Repository / LlmClient / Agent 権威・ルーティング
- `.kiro/specs/discord-gateway/design.md` — InteractionContext / modal・component ディスパッチ / deferred+follow-up / ephemeral
- `.kiro/specs/goal-management/design.md` — `listGoals`/`getGoal`、所有者スコープ、対象サイクル決定規約
