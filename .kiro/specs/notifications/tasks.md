# Implementation Plan

- [x] 1. 基盤: 本スペック所有の状態スキーマと永続アクセス
- [x] 1.1 直近判定状態・アラート送信履歴の追加マイグレーションを定義する
  - 目標ごとの直近判定状態を保持する表(所有ユーザー・サイクル・目標・状態・更新時刻)と、アラート送信履歴を保持する表(所有ユーザー・サイクル・目標・トリガ種別・送信時刻)の DDL を定義する
  - infra-foundation の §11 既存テーブルを変更せず、独立 version + `IF NOT EXISTS` で既存マイグレーションランナーと共存・冪等適用できるようにする
  - 完了条件: 空 DB から追加2表が生成され、再適用してもエラーなく既存データを保持し、infra の §11 マイグレーションと共存するユニット/結合テストが通る
  - _Requirements: 3.1, 4.8_
  - _Boundary: Alert State Store + Migrations_

- [x] 1.2 直近判定状態と送信履歴の read/update アクセスを実装する
  - 目標ごとの直近判定状態の取得(サイクル単位)と upsert を、所有ユーザーを伴って実装する
  - アラート送信履歴の送信済み判定(目標×トリガ種別×サイクル)と記録を実装する
  - 比較元は本スペック保持状態のみとし、status-and-draft の非永続判定に依存しないことを保証する
  - 完了条件: 直近状態の upsert→get で往復一致、未保持目標は不在を返し、送信履歴の記録後に送信済み判定が真になる結合テストが通る
  - _Requirements: 3.1, 3.3, 3.5, 4.8, 6.4_
  - _Boundary: Alert State Store + Migrations_
  - _Depends: 1.1_

- [x] 2. コア: アラートトリガ評価
- [x] 2.1 (P) 半期終了までの残り日数算出を実装する
  - サイクル終了日と現在日付から残り日数を算出する
  - 完了条件: 既知の終了日・基準日の組で期待残日数が返るユニットテストが通る
  - _Requirements: 4.7_
  - _Boundary: Alert Triggers + Dedup_

- [x] 2.2 (P) §9.3 トリガ評価ロジックを実装する
  - 保持中の直近状態と新判定状態を比較し Green→Yellow / Yellow→Red の悪化遷移を検出する
  - 証跡なし2週間継続、半期終了30日前、14日前のトリガを評価し、成立したトリガと理由行を返す
  - 直近状態が未保持(初回)の場合は悪化遷移を成立させない
  - 完了条件: Green→Yellow/Yellow→Red で対応トリガ成立、初回は遷移トリガ非成立、証跡なし2週で停滞トリガ、残日数30/14以下で期限トリガが成立するユニットテストが通る
  - _Requirements: 3.2, 3.4, 4.2, 4.3, 4.4, 4.5, 4.6_
  - _Boundary: Alert Triggers + Dedup_
  - _Depends: 2.1_

- [x] 2.3 (P) 重複抑止判定を実装する
  - 送信履歴に基づき、同一サイクル内で同一トリガを送信済みの目標を除外する
  - 期限トリガは残り日数閾値の跨ぎと送信履歴で冪等に成立判定する
  - 完了条件: 送信済みトリガが除外され未送信トリガは通過する、期限トリガが同週内に重複しないユニットテストが通る
  - _Requirements: 4.8_
  - _Boundary: Alert Triggers + Dedup_
  - _Depends: 1.2_

- [x] 3. コア: 通知文組み立て
- [x] 3.1 (P) §9.1 チェックイン文と §9.3 アラート文の組み立てを実装する
  - §9.1 のチェックイン文(今週やったことの入力促し)に Green/Yellow/Red 件数を埋め込み、目標0件は全0件として整形する
  - §9.3 のアラート文に目標名・新状態・成立理由(状態悪化/証跡なし継続/残り日数 等)を含め、改善導線として対象目標の `/goal status <id>` 案内を含める
  - 完了条件: チェックイン文が §9.1 構造 + 件数(0件含む)を満たし、アラート文が §9.3 構造 + 理由行 + `/goal status <goalId>` 導線を含むユニットテストが通る
  - _Requirements: 2.2, 2.4, 5.1, 5.2_
  - _Boundary: Message Builder_

- [x] 4. コア: 配信オーケストレーション
- [x] 4.1 (P) discord-gateway 送信ヘルパー経由の配信を実装する
  - 対象ユーザー ID・メッセージ・個人用フォールバックチャンネルを送信ヘルパーへ渡して配信し、結果を判別可能に返す
  - DM 403 時のフォールバックは送信ヘルパーに委ね、フォールバック未指定/失敗時は失敗をログし例外を投げず処理を継続する
  - 配信経路を DM または本人の個人用非公開チャンネルに限定する(公開チャンネル宛送信をしない)
  - 完了条件: DM 成功・フォールバック成功で成功結果、フォールバック無し403/REST 失敗で判別可能な失敗結果を返し処理が中断しない結合テストが通る
  - _Requirements: 2.3, 2.5, 5.3, 5.4, 6.1, 6.2, 6.3_
  - _Boundary: Delivery Orchestrator_

- [x] 5. コア: 週次スケジューラ
- [x] 5.1 金曜16:30 週次 cron の冪等登録を実装する
  - `this.schedule()` で毎週金曜 16:30 に発火する cron を登録する
  - 既存スケジュール照会または登録済み判定で再初期化時の重複登録を防ぎ、登録後は毎週繰り返し発火を維持する
  - 完了条件: 未登録時に週次スケジュールが1つ登録され、再呼び出しで重複登録されない結合テストが通る
  - _Requirements: 1.1, 1.3, 1.4_
  - _Boundary: Weekly Checkin Scheduler_

- [x] 6. 統合: 週次評価ドメインメソッドと Agent 配線
- [x] 6.1 週次チェックイン実行ドメインメソッドを実装する
  - 発火時にアクティブサイクルを確認し、無ければ何も送らず終了する
  - status-and-draft の全目標判定を実行して Green/Yellow/Red 件数を集計し(目標0件は全0)、チェックイン文を組み立てて配信する
  - 判定は status-and-draft へ委譲し再実装しない
  - 完了条件: サイクルありで全目標判定→件数付きチェックイン文が配信され、サイクル無しで何も配信されない結合テストが通る
  - _Requirements: 1.2, 1.5, 2.1, 2.4, 7.1_
  - _Boundary: Notification Domain Operations_
  - _Depends: 1.2, 3.1, 4.1, 5.1_

- [x] 6.2 アラート評価・配信ドメインメソッドを実装する
  - 週次発火で取得済みの全目標判定結果を再利用し、各目標について直近状態を取得してトリガ評価する
  - 証跡なし2週間継続トリガ(4.4)用に、各目標の最新 `evidence.evidence_date` を infra `Repository` 経由で §11.5 `evidence` / §11.6 `evidence_goal_links` から読み取り専用で取得し、現在日付との差で証跡経過日数を自前算出してトリガ評価へ渡す(status-and-draft の `StatusVerdict` には依存せず、§11 への列追加もしない)
  - 比較に用いた新状態を直近状態として更新し、成立かつ未送信のトリガのみアラート文を配信する
  - 配信成功時のみ送信履歴を記録し、失敗時は記録せず再送可能状態を保つ
  - 完了条件: 直近 Green→今回 Yellow で Yellow アラート配信+履歴記録+直近状態更新、同週同トリガ再評価で重複送信なし、配信失敗で履歴未記録となり、最新 evidence_date の Repository 読取から算出した証跡経過2週超で `no_evidence_2w` が成立する結合テストが通る
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 5.1, 5.2, 5.3, 5.4, 6.4, 7.1, 7.2_
  - _Boundary: Notification Domain Operations_
  - _Depends: 2.2, 2.3, 3.1, 4.1, 6.1_

- [x] 6.3 スケジュール登録と発火コールバックを EvaluationCycleAgent へ配線する
  - EvaluationCycleAgent の初期化で週次スケジュール登録を起動し、本スペックの追加マイグレーションを既存ランナーと共存する形で適用する
  - cron 発火コールバックを週次チェックイン実行(内部でアラート評価・配信を起動)へ委譲する
  - 基盤(this.schedule / Agent / DO SQLite)・LLM クライアントは infra の提供物を利用し再定義しない
  - 完了条件: Agent 初期化後に週次スケジュールが登録され追加テーブルが初期化済みとなり、発火でチェックイン+アラート評価が起動する結合テストが通る
  - _Requirements: 1.1, 1.2, 7.3_
  - _Boundary: Notification Domain Operations, Schedule Registration_
  - _Depends: 5.1, 6.1, 6.2_

- [x] 7. 検証: クリティカルパスと境界遵守
- [x] 7.1 週次通知クリティカルパスの E2E スモークテストを実装する
  - サイクル+目標+証跡蓄積済み状態で週次発火させ、件数付きチェックイン通知と成立分の Red/Yellow アラートが本人経路へ配信されることを検証する
  - 状態遷移(Green→Yellow→Red)を跨ぐ複数週の発火で、直近状態の保持・更新と重複抑止が成立することを検証する
  - 完了条件: 複数週の発火シーケンスでチェックインとアラートが期待通り配信・抑止され、本スペック保持の直近状態で遷移が検出される E2E テストが通る
  - _Requirements: 1.2, 2.1, 3.1, 3.2, 3.3, 4.1, 4.8, 5.1_
  - _Depends: 6.1, 6.2, 6.3_

- [ ]* 7.2 境界遵守(上流契約の消費)を検証する
  - 判定は status-and-draft の判定メソッド消費、配信は discord-gateway の送信ヘルパー消費、基盤/スキーマ/LLM は infra 消費で成立し、本スペックがこれらを再実装していないことを確認する
  - `/checkin` 会話処理・Google Calendar 連携・`/prepare 1on1` を実装していないことを確認する
  - 完了条件: 判定・配信・基盤が上流契約経由で呼ばれ、本スペックに重複実装・将来枠機能が含まれないことを確認するテストが通る
  - _Requirements: 7.1, 7.2, 7.3, 7.4_

## Implementation Notes
- 共有依存契約(調査済み): 判定再利用は `src/status-and-draft/domain/status-operations.ts` の純関数 `determineAllStatuses(authority, deps, llm, userId)` / `determineGoalStatus(...)`(`StatusVerdict`/`DetermineAllStatusesResult` を返す)を消費する。配信は `src/discord/proactive.ts` `sendDirectMessage(env, userId, content, fallbackChannelId?)`(`SendResult`)。基盤は `getCycleAgent`/`getUserCycleAuthority`(`src/goal-management/routing.ts`, `PRIMARY_CYCLE_KEY="primary"`)・`createRepository`/`SqlLike`(`src/persistence`)・`createLlmClient(env)`(`src/llm/factory.ts`)・`Env`/`DiscordEnv`。フォールバックチャンネルは `DiscordEnv.DISCORD_FALLBACK_CHANNEL_ID?`(`src/discord/env.ts`)。
- 確立パターン: ドメインは `src/agents/*.ts` を変更せず純関数で実装し、Agent の汎用 passthrough(`CycleDataAuthority`)/`SqlLike` を引数注入する。`boundary.test.ts` が Agent へのドメインメソッド追加(色リテラル/判定名等)を機械検査で禁止。
- notifications 所有テーブル(`last_goal_status`/`alert_sent_log`)は infra `Repository`/`EntityRow`(§11 限定)に無いため、`alert-state.ts` は `SqlLike` へ直接アクセスする同期ストア(`createAlertStateStore(sql, deps)`)とした。
- マイグレーションは infra の `runMigrations(sql, migrations)` ランナーを再利用し、notifications は独立 version(1000+)で共有 `schema_migrations` 台帳上に共存。
- スケジュール: agents SDK の `this.schedule(cronExpr, callbackMethodName)` はクーロン既定で冪等。コールバックは Agent の `keyof this` メソッド名。タスク5.1/6.3 は `EvaluationCycleAgent` への最小配線(`onStart` でのスケジュール登録 + 委譲コールバックメソッド)が必須(設計の Modified Files と一致)。ドメインロジックは notifications モジュールの純関数に保ち boundary.test を満たす。金曜16:30 cron = `30 16 * * 5`。
- トリガ判断(裁定済み): `no_evidence_2w` は `latestEvidenceAgeDays !== null && >= 14` のみ成立(年齢ベース)。証跡0件(null)は成立させない(設計 L383/L401 の null=証跡なし意味、タスク6.2「証跡経過2週超」記述に準拠)。期限トリガは `<=30`/`<=14` で評価し、サイクル内重複抑止は dedup(2.3)が担う。
- 6.2 状態更新タイミング(裁定済み): `upsertLastStatus`(直近状態更新)は配信成否と独立に成立判定直後に実行、`recordSent`(送信履歴)のみ配信成功にゲート。設計シーケンス図 L177-187/L191・Req 3.3/6.4 と一致(再送は alert_sent_log の dedup で担保)。証跡経過は `daysUntilCycleEnd(evidenceDate, now)` の符号反転で age 算出(日付ユーティリティ非再実装)。
- 6.3 構成(裁定済み): 設計 §file-structure の `schedule/register.ts` は新設せず、配線は `EvaluationCycleAgent.onStart`(`runNotificationMigrations` + `scheduleWeeklyCheckin`)+ 薄い `fireWeeklyCheckin` コールバックで実装。発火は notifications ドメインの新オーケストレータ `runWeeklyCheckinCycle`(`determineAllStatuses` をメモ化し週次1回に集約 → checkin → alert)へ委譲。Agent 本体は色/判定名を持たず boundary.test 維持。DO ランタイム結合テストは workers project(`vitest.config.ts` で振り分け)。
