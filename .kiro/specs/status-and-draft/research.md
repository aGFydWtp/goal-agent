# Research & Design Decisions: status-and-draft

## Summary
- **Feature**: `status-and-draft`
- **Discovery Scope**: Extension(確立済みの 4 上流スペック契約の上に乗る機能追加。integration-focused discovery)
- **Key Findings**:
  - 状態判定はコマンドハンドラと notifications の両方から呼ばれるため、Agent ドメインメソッド(`determineGoalStatus`/`determineAllStatuses`)+ 共有型(`StatusVerdict`)として公開するのが唯一の整合的な配置。インライン実装は notifications 再利用を壊す。
  - 上流の goal-management / checkin-classification が同型の「薄いハンドラ層 + Agent ドメインメソッド」パターンを確立済み。本スペックも同型に揃えることで境界・所有者強制・deferred 規約を再発明しない。
  - §10.2 はルールベース、§13.2 は LLM 見立て。両者を `combineVerdict` で統合し、LLM 失敗時はルール候補へフォールバックすることで Workers AI の日本語/JSON 品質リスクを吸収しつつ状態を必ず成立させられる。

## Research Log

### ステータス判定の責務配置(再利用契約)
- **Context**: brief / 指示で「notifications が判定結果を購読する。インラインではなく再利用可能な Agent メソッドにせよ」と明示。
- **Sources Consulted**: infra-foundation design(EvaluationCycleAgent 権威 / GoalAgent ステートレス委譲)、roadmap(notifications Dependencies: status-and-draft)、goal-agent-spec §10.2 / §13.2。
- **Findings**: 単一目標判定は GoalAgent、全目標集約は EvaluationCycleAgent に置くと、notifications は既存の `getGoalAgent`/`getCycleAgent` で同一契約を呼べる。`StatusVerdict` を `status/schema.ts` に共有型として公開。
- **Implications**: `StatusVerdict` 型と 2 メソッドのシグネチャ変更は revalidation trigger。design の Boundary Commitments / Data Contracts に明記。

### ドラフトの揮発 pending と保存
- **Context**: 生成 → 4 種調整(再生成)→ 保存のフローで、確定前内容を保持しつつ [保存] でのみ drafts へ書く必要がある。
- **Sources Consulted**: checkin-classification design(pending 分類の揮発状態 + custom_id 紐付け)、goal-agent-spec §11.8(drafts schema)、§8.7(ボタン)、§15(ドラフト扱い)。
- **Findings**: checkin-classification の pending パターンを踏襲。draftPendingId を custom_id に埋め、調整/保存で再取得。type は調整 kind から決定(manager→manager_summary、shorten→short_summary、初期/強調/課題明確化→self_evaluation)。
- **Implications**: pending は DO インスタンスメモリ揮発(再起動で消失 → 再生成)。確定済み drafts に影響なし。one_on_one は §11.8 に存在するが §8.7 のボタンに対応操作が無いため MVP の保存 type には使わない。

### 誇張抑制と推測明示(§13.3)
- **Context**: §13.3「誇張しすぎない」「証跡にない内容は推測扱い」、§15「生成評価文は必ずドラフト扱い」。
- **Sources Consulted**: goal-agent-spec §13.3 / §15、roadmap(日本語生成品質リスク)。
- **Findings**: `DraftContent` に facts/interpretation/issues/nextActions の 4 分離 + `speculativeNotes`(推測明示)を持たせ、プロンプトで誇張抑制を指示し検証で構造を担保。LLM の意味的誇張は完全には防げないため、ドラフト扱い + 本人確認 + 調整 UX で緩和。
- **Implications**: 完全保証は不可能と design の Security に明記。strengthen 調整でも事実捏造禁止をプロンプト + 検証で維持。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| 薄いハンドラ層 + Agent ドメインメソッド(採用) | 上流 2 スペックと同型 | 境界・所有者強制・deferred を再利用、notifications 再利用が自然 | Goal→Cycle データ委譲の RPC | 採用。整合性最優先 |
| コマンドハンドラ内インライン判定 | ハンドラに判定を直書き | 短期的に少コード | notifications 再利用不可(指示違反) | 却下 |
| 判定結果を goals.status に永続化 | 判定を都度書込 | 再計算不要 | 書込権威・整合・所有が複雑化、MVP 不要 | 却下。MVP は都度算出(read-only) |

## Design Decisions

### Decision: 状態判定を read-only の都度算出にする
- **Context**: `goals.status` 列は存在するが、本スペックが判定のたびに更新すると書込権威・整合が複雑化する。
- **Alternatives Considered**:
  1. 判定結果を `goals.status` へ永続化
  2. 判定は read-only で都度 goals + evidence + cycle から導出
- **Selected Approach**: 2。`determineGoalStatus`/`determineAllStatuses` は読み取りのみで `StatusVerdict` を返し永続化しない。
- **Rationale**: MVP 規模では再計算コストは許容。書込責務を持たないことで所有者強制と境界が単純化。notifications も同じ read-only 契約を呼べる。
- **Trade-offs**: 毎回 LLM 呼び出しコスト。deferred + follow-up で吸収。
- **Follow-up**: 規模拡大時の判定結果キャッシュ/永続化は将来拡張(infra スキーマ変更を伴う)。

### Decision: LLM 失敗時はルール候補へフォールバック
- **Context**: Workers AI の日本語/JSON 品質が未検証(roadmap 既知リスク)。
- **Selected Approach**: `combineVerdict` が LLM 失敗/検証 NG 時にルール候補で status を確定し `reasonMissing: true` を返す。
- **Rationale**: 見立て文が無くても状態(色)は提示でき、ユーザー価値が落ちにくい。判断材料不足は Gray に正規化。
- **Trade-offs**: 見立て文が欠ける場合がある。呼び出し側が `reasonMissing` で識別し文言調整。
- **Follow-up**: Claude API 等への差し替えは infra `createLlmClient` の 1 箇所。

## Risks & Mitigations
- Workers AI 日本語生成品質不足 — ステータス判定はルールフォールバック、ドラフトは再試行案内 + ドラフト扱い + モデル差し替え(infra factory)で緩和。
- 評価文の意味的誇張 — プロンプト + 構造検証 + 推測明示 + ドラフト扱い + 本人確認で緩和(完全保証不可と明記)。
- 全目標 × LLM のレイテンシ — deferred + follow-up(最大 15 分 token)で吸収、MVP 規模で許容。
- draft pending 揮発による再生成 — MVP 許容。確定済み drafts には影響なし。

## References
- `goal-agent-spec.md` §8.4-8.7(コマンド)、§10(状態判定)、§11.8(drafts)、§13.2(判定出力)、§13.3(ドラフト生成)、§14/§15(UX/プライバシー)— 本スペックの権威仕様。
- `.kiro/specs/infra-foundation/design.md` — Repository / Agent 権威 / LlmClient / 共有型 / drafts スキーマ。
- `.kiro/specs/discord-gateway/design.md` — deferred + follow-up / ephemeral / ボタンルーティング / コマンド登録。
- `.kiro/specs/goal-management/design.md` — listGoals/getGoal / 所有者スコープ / 対象サイクル決定。
- `.kiro/specs/checkin-classification/design.md` — evidence/evidence_goal_links/weekly_reviews の供給源、pending パターンの先例。
