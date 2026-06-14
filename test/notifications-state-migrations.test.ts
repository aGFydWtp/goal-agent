// notifications 状態テーブルの追加マイグレーション検証(Req 3.1, 4.8 / Task 1.1)。
//
// 検証観点:
//   1. 空 DB から追加2表(last_goal_status / alert_sent_log)が生成される。
//   2. infra §11 マイグレーション(既定 MIGRATIONS)と同一バックエンド上で共存し、
//      §11 テーブルと追加2表の双方が生成される(独立 version・台帳共存)。
//   3. 再適用しても冪等(エラーなし・既存データ保持)。
//
// 実行環境: vitest "node" プロジェクト(node:sqlite が必要)。workers には載せない。

import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/persistence/migrator";
import {
  NOTIFICATION_MIGRATIONS,
  runNotificationMigrations,
} from "../src/notifications/state/migrations";
import { NodeSqliteBackend } from "./helpers/node-sqlite-adapter";

/** sqlite_master から指定テーブルの存在有無を返す。 */
function tableExists(backend: NodeSqliteBackend, name: string): boolean {
  const rows = backend
    .exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      name,
    )
    .toArray();
  return rows.length === 1;
}

describe("notifications state migrations", () => {
  it("空 DB から追加2表(last_goal_status / alert_sent_log)を生成する", () => {
    const backend = new NodeSqliteBackend();
    try {
      runNotificationMigrations(backend);

      expect(tableExists(backend, "last_goal_status")).toBe(true);
      expect(tableExists(backend, "alert_sent_log")).toBe(true);
    } finally {
      backend.close();
    }
  });

  it("追加 version は infra version 1 と衝突しない(>= 1000)", () => {
    // 共有台帳上で infra version 1 と共存できるよう、衝突しない高 version であること。
    for (const migration of NOTIFICATION_MIGRATIONS) {
      expect(migration.version).toBeGreaterThanOrEqual(1000);
    }
  });

  it("infra §11 マイグレーションと同一バックエンド上で共存する", () => {
    const backend = new NodeSqliteBackend();
    try {
      // infra の §11 8 テーブル(既定 MIGRATIONS)を適用。
      runMigrations(backend);
      // 本スペックの追加マイグレーションを同じバックエンドへ適用。
      runNotificationMigrations(backend);

      // §11 の代表テーブルが生成されている。
      expect(tableExists(backend, "evaluation_cycles")).toBe(true);
      expect(tableExists(backend, "goals")).toBe(true);
      expect(tableExists(backend, "evidence")).toBe(true);
      // 追加2表も生成されている。
      expect(tableExists(backend, "last_goal_status")).toBe(true);
      expect(tableExists(backend, "alert_sent_log")).toBe(true);
    } finally {
      backend.close();
    }
  });

  it("再適用しても冪等であり既存データを保持する", () => {
    const backend = new NodeSqliteBackend();
    try {
      runNotificationMigrations(backend);

      // 1 行投入して直近状態を保持。
      backend.exec(
        "INSERT INTO last_goal_status (user_id, cycle_id, goal_id, status, updated_at) VALUES (?, ?, ?, ?, ?)",
        "user-1",
        "cycle-1",
        "goal-1",
        "yellow",
        "2026-06-15T00:00:00.000Z",
      );

      // 再適用してもエラーなく、既存行は保持される。
      expect(() => runNotificationMigrations(backend)).not.toThrow();

      const rows = backend
        .exec(
          "SELECT status FROM last_goal_status WHERE user_id = ? AND cycle_id = ? AND goal_id = ?",
          "user-1",
          "cycle-1",
          "goal-1",
        )
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("yellow");
    } finally {
      backend.close();
    }
  });
});
