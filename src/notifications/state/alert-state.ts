// notifications 所有の Alert State Store(Req 3.1, 3.3, 3.5, 4.8, 6.4 / design「Alert State Store + Migrations」)。
//
// 責務: notifications が所有する派生状態 2 表(`last_goal_status` / `alert_sent_log`)に対する
// 低レベル read/update を提供する。
//   - 直近判定状態: 目標ごとの直近 GoalStatus を所有ユーザー×サイクル単位で取得 / upsert する(Req 3.1)。
//   - 送信履歴: アラートの送信済み判定(目標×トリガ種別×サイクル)と記録を提供する(Req 4.8)。
//
// 設計上の制約:
// - これら 2 表は notifications 所有であり、infra の `EntityName`/`EntityRow`/`Repository`
//   (§11 既存 8 表のみを知る)には存在しない。`Repository.assertTable` はこれらを拒否するため、
//   本ストアは infra の型付きリポジトリを介さず、共有 SQL 実行抽象 `SqlLike`
//   (`SqlStorage.exec(query, ...bindings)` 形 / migrator.ts)へ直接アクセスする。
//   構築様式は `createRepository(sql)` を踏襲し、`createAlertStateStore(sql, deps)` を公開する。
// - 同期 API: design の Service Interface は素の値(Map/boolean/void)を返す。EvaluationCycleAgent DO 内の
//   `this.ctx.storage.sql` は同期 `SqlLike` のため、Promise を介さず同期で実装する。
// - 全 SQL は値を `?` プレースホルダ + bindings としてバインドし、値を文字列連結しない
//   (SQL インジェクション耐性 / repository.ts と同方針)。
// - 所有者スコープ(Req 3.5): すべての問い合わせは `user_id` で絞り込む。比較元は本スペック所有の
//   2 表のみであり、status-and-draft の非永続判定には依存しない(本スペック保持状態が唯一の比較元)。
// - 値域(GoalStatus / AlertTriggerKind 列挙)は TS 層で保証する(DDL は plain TEXT / migrations.ts と同方針)。

import type { SqlLike } from "../../persistence/migrator";
import type { GoalStatus } from "../../types";

/**
 * アラートのトリガ種別(notifications 所有の列挙)。
 * 送信履歴の重複抑止判定キーの一部であり、alert/ 層(task 2.x)は本モジュールから import する
 * (依存方向: state → alert)。
 */
export type AlertTriggerKind =
  | "green_to_yellow"
  | "yellow_to_red"
  | "no_evidence_2w"
  | "cycle_end_30d"
  | "cycle_end_14d";

/** design.md Service Interface: 直近判定状態と送信履歴の低レベル read/update。 */
export interface AlertStateStore {
  /** 所有ユーザー×サイクルの直近判定状態を `goalId -> GoalStatus` の Map で返す。未保持目標は不在。 */
  getLastStatuses(userId: string, cycleId: string): Map<string, GoalStatus>;
  /** 直近判定状態を upsert する(PK 衝突時は最新値で上書き)。 */
  upsertLastStatus(userId: string, cycleId: string, goalId: string, status: GoalStatus): void;
  /** (user, cycle, goal, kind) のアラートが既に送信済みかを判定する。 */
  isAlreadySent(userId: string, cycleId: string, goalId: string, kind: AlertTriggerKind): boolean;
  /** (user, cycle, goal, kind) のアラート送信を履歴に記録する。 */
  recordSent(userId: string, cycleId: string, goalId: string, kind: AlertTriggerKind): void;
}

/**
 * ID / タイムスタンプ生成の注入点(テスト決定性のため)。
 * `DomainDeps`(cycle-operations.ts)と同形。本番既定は `defaultAlertStateDeps()`。
 */
export interface AlertStateDeps {
  newId(): string;
  now(): string;
}

/** 本番既定の deps(`crypto.randomUUID` / ISO8601 現在時刻)。 */
export function defaultAlertStateDeps(): AlertStateDeps {
  return {
    newId: () => crypto.randomUUID(),
    now: () => new Date().toISOString(),
  };
}

/**
 * 共有 SQL 実行インターフェイス(`SqlLike` = `SqlStorage.exec` 形)から
 * notifications 所有の Alert State Store を生成するファクトリ。
 *
 * @param sql 対象 DO の `this.ctx.storage.sql`(本番)またはテスト用 SQL バックエンド。
 * @param deps ID / 時刻生成の注入点(既定: `defaultAlertStateDeps()`)。テストは決定的値を注入する。
 */
export function createAlertStateStore(
  sql: SqlLike,
  deps: AlertStateDeps = defaultAlertStateDeps(),
): AlertStateStore {
  return {
    getLastStatuses(userId: string, cycleId: string): Map<string, GoalStatus> {
      // 所有者スコープ(Req 3.5): user_id で絞り込み、比較元は本表のみ。
      const rows = sql
        .exec(
          "SELECT goal_id, status FROM last_goal_status WHERE user_id = ? AND cycle_id = ?",
          userId,
          cycleId,
        )
        .toArray();
      const result = new Map<string, GoalStatus>();
      for (const row of rows) {
        result.set(row.goal_id as string, row.status as GoalStatus);
      }
      return result;
    },

    upsertLastStatus(userId: string, cycleId: string, goalId: string, status: GoalStatus): void {
      // PK (user_id, cycle_id, goal_id) 衝突時は最新の status / updated_at で上書き(最新勝ち)。
      const updatedAt = deps.now();
      sql.exec(
        `INSERT INTO last_goal_status (user_id, cycle_id, goal_id, status, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, cycle_id, goal_id)
         DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
        userId,
        cycleId,
        goalId,
        status,
        updatedAt,
      );
    },

    isAlreadySent(
      userId: string,
      cycleId: string,
      goalId: string,
      kind: AlertTriggerKind,
    ): boolean {
      // 判定キー (user_id, cycle_id, goal_id, trigger_kind) の全一致で送信済みとみなす(Req 4.8)。
      const rows = sql
        .exec(
          `SELECT 1 FROM alert_sent_log
           WHERE user_id = ? AND cycle_id = ? AND goal_id = ? AND trigger_kind = ?
           LIMIT 1`,
          userId,
          cycleId,
          goalId,
          kind,
        )
        .toArray();
      return rows.length > 0;
    },

    recordSent(userId: string, cycleId: string, goalId: string, kind: AlertTriggerKind): void {
      // id / sent_at は deps から供給し、テスト決定性を確保する。
      sql.exec(
        `INSERT INTO alert_sent_log (id, user_id, cycle_id, goal_id, trigger_kind, sent_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        deps.newId(),
        userId,
        cycleId,
        goalId,
        kind,
        deps.now(),
      );
    },
  };
}
