# Research & Design Decisions

## Summary
- **Feature**: `notifications`
- **Discovery Scope**: Extension(確立済みの infra-foundation / discord-gateway / status-and-draft 契約の上に、スケジューリング・状態遷移検出・アラート評価・通知文組み立てを追加する)
- **Key Findings**:
  - status-and-draft はステータス判定を**オンデマンドで算出し永続化しない**(design.md L626「本スペックは status を永続化しない」、L713「判定は読み取りのみで永続化しない」)。したがって Green→Yellow / Yellow→Red の遷移検出には**本機能が直近判定状態を保持**する必要がある。これが本スペック最大の設計論点。
  - infra-foundation の `this.schedule()` は DO alarm ベースの分粒度 cron で週次通知に十分。EvaluationCycleAgent がサイクル単位 DO SQLite の単一権威であり、状態遷移検出用の小テーブルもこの権威 SQLite に同居させるのが一貫性上自然。
  - discord-gateway の `sendDirectMessage(env, userId, content, fallbackChannelId?)` が DM open → 送信 → 403 フォールバック → 判別可能 `SendResult` を既に提供。本機能は配信機構を再実装せず消費するのみ。
  - status-and-draft の `determineAllStatuses(userId)` / `determineGoalStatus(userId, cycleId, goalId)` は notifications 再利用を明示した安定公開契約(design.md L589, L796, L840)。`StatusVerdict { status, reason, risks, nextActions, reasonMissing }` を返す。

## Research Log

### 状態遷移検出に必要な「前回状態」の出所
- **Context**: §9.3 のアラートトリガ(Green→Yellow、Yellow→Red)は前回と今回の状態比較を要する。指示書 CRITICAL 注記でも明示されている。
- **Sources Consulted**: `.kiro/specs/status-and-draft/design.md`(L589, L613-628, L713-719, L768-770, L796, L840)、`goal-agent-spec.md` §9.3(L495-520)、§10(L524-573)。
- **Findings**:
  - status-and-draft は `goals.status` を更新しない(L626「`goals.status` の更新は本スペックの責務外。MVP では判定は都度算出」)。
  - したがって「前回状態」を読める永続ソースは存在しない。`goals.status` 列の既定値は `'gray'`(infra-foundation L449)だが status-and-draft はこれを書き換えないため、信頼できる遷移元として使えない。
- **Implications**: 本機能が「目標ごとの直近判定状態」を**所有・永続化**する。比較元は本機能の保持状態のみ(Req 3.5)。

### スケジューリング基盤
- **Context**: 週次 cron(金曜 16:30)をどう登録・維持・冪等化するか。
- **Sources Consulted**: `roadmap.md`(L14 `this.schedule()` は DO alarm ベース cron 分粒度)、infra-foundation design(EvaluationCycleAgent が DO 権威・`onStart` で migrate)、brief.md(L40 分粒度 cron は週次に十分、DO 内 SQLite に永続化・冪等)。
- **Findings**: `this.schedule()` は cron 文字列で繰り返し発火を登録できる。EvaluationCycleAgent はユーザー×サイクル単位のインスタンスで、そのライフサイクル(`onStart`)に通知スケジュール登録を結び付けられる。
- **Implications**: スケジュール登録は EvaluationCycleAgent に同居。重複登録防止(Req 1.4)は登録済みフラグ/既存スケジュール照会で冪等化する。

### 配信契約
- **Context**: DM 失敗時フォールバックをどう扱うか(§15 DM/個人用非公開チャンネル限定)。
- **Sources Consulted**: discord-gateway design(L399, L408-427 `sendDirectMessage`、`SendResult = { ok:true } | { ok:false; reason:"forbidden"|"not_found"|"rest_error" }`)。
- **Findings**: 403→フォールバックチャンネル送信は送信ヘルパーが内包。フォールバック未指定時は `forbidden` を返す。公開チャンネル宛任意送信は提供されない。
- **Implications**: 本機能は `fallbackChannelId`(個人用非公開チャンネル)を env 設定から渡すだけ。失敗は `SendResult` で受けてログ + アラートの送信済み記録を行わない(Req 6.3, 6.4)。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| 状態履歴テーブルを本機能が新設し EvaluationCycleAgent の権威 DO SQLite に同居 | 目標ごと直近状態 + アラート送信履歴を小テーブルで保持 | 単一権威に同居で一貫性確保、冪等な遷移検出/重複抑止が可能 | infra の §11 スキーマに「追加」する位置づけの整理が必要 | 採用 |
| Agent インスタンスメモリに直近状態を保持(揮発) | 実装が軽い | DO 再起動で消失→初回扱いに戻り遷移検出が壊れる/重複アラート | 週次という長周期で再起動を跨ぐため不適 | 却下 |
| goals.status を本機能が更新して履歴にする | 既存列を流用 | 新テーブル不要 | status-and-draft の責務(status 非永続)と衝突、所有権が曖昧化 | 却下 |

## Design Decisions

### Decision: 直近判定状態とアラート履歴を本スペックが所有する状態テーブルとして持つ
- **Context**: §9.3 の遷移トリガと重複抑止には前回状態と送信履歴が要るが、status-and-draft は判定を永続化しない。
- **Alternatives Considered**:
  1. 揮発メモリ保持 — 週次周期で DO 再起動を跨ぎ消失リスク。
  2. goals.status 流用 — status-and-draft の境界と衝突。
  3. 本機能所有の状態テーブル(EvaluationCycleAgent の権威 DO SQLite に同居)。
- **Selected Approach**: 本機能が「目標ごと直近判定状態」と「アラート送信履歴(目標 × トリガ種別 × サイクル)」を保持する状態を所有する。物理的には infra-foundation が単一権威とする EvaluationCycleAgent の DO SQLite に、本機能が所有する追加状態として配置する(infra の §11 既存 8 テーブルは変更しない。本機能の状態は infra スキーマの「拡張」として明示し、追加マイグレーションを本機能のドメイン初期化で適用する)。
- **Rationale**: 単一権威に同居させることで遷移検出と重複抑止を一貫・冪等に行える。揮発保持の再起動消失リスクを避ける。
- **Trade-offs**: 本機能が永続状態を持つことで「通知は scheduling/state/alert/assembly のみ所有」の境界に状態保持が加わるが、これは指示書 CRITICAL 注記で明示的に本機能の責務とされたもの。infra の §11 コアスキーマには手を入れない。
- **Follow-up**: infra-foundation のマイグレーションランナーと共存できる形(独立 version / IF NOT EXISTS)で追加することを実装時に確認。

### Decision: スケジュール登録は EvaluationCycleAgent のライフサイクルに結合し冪等化する
- **Context**: ユーザー×サイクル単位で週次 cron を1つだけ維持したい(Req 1.1, 1.3, 1.4)。
- **Selected Approach**: EvaluationCycleAgent が `this.schedule()` で金曜 16:30 cron を登録。登録済み判定(既存スケジュール照会 or 保持フラグ)で再初期化時の重複を防ぐ。発火コールバックがチェックイン通知とアラート評価の起動点。
- **Rationale**: サイクル権威 Agent がスケジュール・状態・配信起動を一貫して担える。
- **Trade-offs**: cron 時刻のユーザー個別変更は MVP では固定(初期 金曜 16:30)。変更可能性は将来拡張。
- **Follow-up**: `this.schedule()` の cron 表現とタイムゾーン扱いを実装時に確認(発火時刻のずれ防止)。

### Decision: 週次発火を「チェックイン通知」と「アラート評価」両方の起動点にする
- **Context**: §9.1 週次通知と §9.3 アラートはどちらも定期評価を要する。
- **Selected Approach**: 週次スケジュール発火時に (1) 全目標判定 → 件数集計 → チェックイン文配信、(2) 同じ判定結果を入力に状態遷移/停滞/期限トリガ評価 → 成立分のアラート配信、を順に行う。判定(`determineAllStatuses`)は1回実行し両方で再利用。
- **Rationale**: 判定コスト(全目標 × LLM)を二重に払わない。週次という単一の自然な評価点に集約。
- **Trade-offs**: 期限30日/14日前は「その週の発火時に閾値を跨いだか」を残り日数と送信履歴で判定する(分単位の正確な30日前ではなく、週次評価時点での接近検出)。MVP の通知目的に十分。
- **Follow-up**: 期限トリガの「跨ぎ」判定を残り日数 + 送信履歴で冪等にする実装を確認。

## Risks & Mitigations
- **DO 再起動で直近状態が消える** → 揮発保持を避け権威 DO SQLite に永続化(上記 Decision)。
- **全目標 × LLM 判定のレイテンシ** → 週次バックグラウンド実行(対話応答ではない)で許容。status-and-draft 同様 DO シリアライズに依拠。
- **DM 403 で通知が届かない** → discord-gateway の個人用非公開チャンネルフォールバックを利用(Req 6)。フォールバック未指定時はログのみで処理継続。
- **重複アラート/重複通知** → アラート送信履歴(目標×トリガ×サイクル)とスケジュール冪等化で抑止(Req 1.4, 4.8, 6.4)。

## References
- `goal-agent-spec.md` §9.1 / §9.2 / §9.3 / §10 / §15 — 通知・アラート・状態・プライバシーの権威仕様。
- `.kiro/specs/infra-foundation/design.md` — Agent トポロジ、`this.schedule()`、§11 スキーマ、DO 権威、マイグレーション。
- `.kiro/specs/discord-gateway/design.md` — `sendDirectMessage` プロアクティブ送信ヘルパー、`SendResult`、403 フォールバック。
- `.kiro/specs/status-and-draft/design.md` — `determineAllStatuses` / `determineGoalStatus` / `StatusVerdict`、判定非永続の明示。
