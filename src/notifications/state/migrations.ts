// notifications 所有の追加マイグレーション(Req 3.1, 4.8 / design「Alert State Store + Migrations」)。
//
// このモジュールは「notifications が所有する派生状態テーブル」の DDL と、その冪等適用を宣言する。
// infra-foundation の §11 既存 8 テーブルは一切変更しない。追加テーブルは独立 version と
// `CREATE TABLE IF NOT EXISTS` により、infra の共有マイグレーションランナー(migrator.ts)と
// 同一の `schema_migrations` 台帳上で共存し、冪等に適用される(design「Idempotency & recovery」)。
//
// 設計方針:
// - 適用ロジック(台帳確認・未適用分の適用・version 記録)は infra の `runMigrations` を再利用する。
//   本モジュールはランナーを再実装せず、適用対象の Migration 配列のみを宣言する(関心の分離)。
// - version は infra が所有する範囲(現状 version 1 = §11 全 8 テーブル)と衝突しないよう、
//   notifications 専用に予約した高 version(1000 起点)を用いる。これにより両スペックが
//   単一台帳を共有しても version 衝突なく共存できる。
// - 値域(列挙値: GoalStatus / AlertTriggerKind)は SQLite CHECK ではなく TypeScript 層で
//   保証する(infra schema.ts と同方針)。よって DDL は plain TEXT NOT NULL とする。

import type { Migration } from "../../persistence/migrations";
import { runMigrations } from "../../persistence/migrator";

/**
 * notifications マイグレーションの version 起点。
 * infra-foundation の version 範囲(§11 = version 1)から十分離した予約 version。
 * notifications が将来テーブルを追加する場合も、この起点以降の連番を用いることで
 * infra と単一の `schema_migrations` 台帳を衝突なく共有できる。
 */
const NOTIFICATION_MIGRATION_BASE_VERSION = 1000;

/**
 * 直近判定状態テーブル(`last_goal_status`)。
 * 主キー (user_id, cycle_id, goal_id)。目標ごとの直近判定状態(GoalStatus 列挙)を
 * 所有ユーザー・サイクルと対応づけて保持する(Req 3.1)。値域は TS 層で保証する。
 */
const LAST_GOAL_STATUS_DDL = `CREATE TABLE IF NOT EXISTS last_goal_status (
  user_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, cycle_id, goal_id)
)`;

/**
 * アラート送信履歴テーブル(`alert_sent_log`)。
 * 主キー id。(user_id, cycle_id, goal_id, trigger_kind) を重複抑止の判定キーとする(Req 4.8)。
 * trigger_kind は AlertTriggerKind 列挙(notifications 所有)。値域は TS 層で保証する。
 */
const ALERT_SENT_LOG_DDL = `CREATE TABLE IF NOT EXISTS alert_sent_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  sent_at TEXT NOT NULL
)`;

/**
 * notifications が所有する追加マイグレーションの順序付き配列。
 * version 1000 = 追加2表(last_goal_status / alert_sent_log)の作成。
 * 各 DDL は `IF NOT EXISTS` により再実行安全であり、台帳により全体が冪等。
 */
export const NOTIFICATION_MIGRATIONS: readonly Migration[] = [
  {
    version: NOTIFICATION_MIGRATION_BASE_VERSION,
    statements: [LAST_GOAL_STATUS_DDL, ALERT_SENT_LOG_DDL],
  },
];

/**
 * notifications の追加テーブルを冪等適用する。
 * infra の共有ランナー(`runMigrations`)に `NOTIFICATION_MIGRATIONS` を渡すことで、
 * 既存の §11 マイグレーションと同一台帳上で未適用分のみを昇順適用する。
 *
 * @param sql 対象 DO の `this.ctx.storage.sql`(本番)またはテスト用 SQL バックエンド。
 */
export function runNotificationMigrations(sql: Parameters<typeof runMigrations>[0]): void {
  runMigrations(sql, NOTIFICATION_MIGRATIONS);
}
