// notifications Alert State Store の結合テスト(task 1.2 / design「Alert State Store + Migrations」)。
//
// 検証対象(完了条件):
// - 直近判定状態: upsert→get の往復一致 / 二度目の upsert で最新勝ち上書き / 未保持目標は Map から不在。
// - 送信履歴: recordSent 前は isAlreadySent=false、後は true。
//   判定キー (user_id, cycle_id, goal_id, trigger_kind) でスコープされ、トリガ種別違い・
//   ユーザー違い・サイクル違いは互いに隔離される(Req 3.5 所有者スコープ / Req 4.8 重複抑止)。
//
// 実行環境: vitest "node" プロジェクト。`node:sqlite` の実 SQLite に対し
// `runNotificationMigrations` でスキーマを用意し、決定的 deps を注入する。

import { beforeEach, describe, expect, it } from "vitest";
import { createAlertStateStore } from "../src/notifications/state/alert-state";
import { runNotificationMigrations } from "../src/notifications/state/migrations";
import { NodeSqliteBackend } from "./helpers/node-sqlite-adapter";

/** 決定的 deps を生成する(id は連番、now は固定基点からの単調増加 ISO8601)。 */
function deterministicDeps() {
  let idSeq = 0;
  let clockSeq = 0;
  return {
    newId: () => `id-${++idSeq}`,
    now: () => new Date(Date.UTC(2026, 0, 1) + clockSeq++ * 1000).toISOString(),
  };
}

describe("createAlertStateStore", () => {
  let backend: NodeSqliteBackend;

  beforeEach(() => {
    backend = new NodeSqliteBackend();
    runNotificationMigrations(backend);
  });

  describe("直近判定状態 (last_goal_status)", () => {
    it("upsert→get が往復一致する", () => {
      const store = createAlertStateStore(backend, deterministicDeps());
      store.upsertLastStatus("user-1", "cycle-1", "goal-1", "green");

      const statuses = store.getLastStatuses("user-1", "cycle-1");
      expect(statuses.get("goal-1")).toBe("green");
    });

    it("二度目の upsert は最新の status で上書きする(最新勝ち)", () => {
      const store = createAlertStateStore(backend, deterministicDeps());
      store.upsertLastStatus("user-1", "cycle-1", "goal-1", "green");
      store.upsertLastStatus("user-1", "cycle-1", "goal-1", "yellow");

      const statuses = store.getLastStatuses("user-1", "cycle-1");
      expect(statuses.get("goal-1")).toBe("yellow");
      expect(statuses.size).toBe(1);
    });

    it("一度も upsert されていない目標は Map に不在", () => {
      const store = createAlertStateStore(backend, deterministicDeps());
      store.upsertLastStatus("user-1", "cycle-1", "goal-1", "green");

      const statuses = store.getLastStatuses("user-1", "cycle-1");
      expect(statuses.has("goal-2")).toBe(false);
      expect(statuses.get("goal-2")).toBeUndefined();
    });

    it("複数目標を所有ユーザー・サイクルでスコープして返す", () => {
      const store = createAlertStateStore(backend, deterministicDeps());
      store.upsertLastStatus("user-1", "cycle-1", "goal-1", "green");
      store.upsertLastStatus("user-1", "cycle-1", "goal-2", "red");
      // 別ユーザー / 別サイクルの行は混入しない。
      store.upsertLastStatus("user-2", "cycle-1", "goal-3", "yellow");
      store.upsertLastStatus("user-1", "cycle-2", "goal-4", "gray");

      const statuses = store.getLastStatuses("user-1", "cycle-1");
      expect(statuses.size).toBe(2);
      expect(statuses.get("goal-1")).toBe("green");
      expect(statuses.get("goal-2")).toBe("red");
      expect(statuses.has("goal-3")).toBe(false);
      expect(statuses.has("goal-4")).toBe(false);
    });
  });

  describe("送信履歴 (alert_sent_log)", () => {
    it("recordSent 前は false、記録後は true", () => {
      const store = createAlertStateStore(backend, deterministicDeps());
      expect(store.isAlreadySent("user-1", "cycle-1", "goal-1", "green_to_yellow")).toBe(false);

      store.recordSent("user-1", "cycle-1", "goal-1", "green_to_yellow");
      expect(store.isAlreadySent("user-1", "cycle-1", "goal-1", "green_to_yellow")).toBe(true);
    });

    it("トリガ種別が異なれば送信済みにならない", () => {
      const store = createAlertStateStore(backend, deterministicDeps());
      store.recordSent("user-1", "cycle-1", "goal-1", "green_to_yellow");

      expect(store.isAlreadySent("user-1", "cycle-1", "goal-1", "yellow_to_red")).toBe(false);
      expect(store.isAlreadySent("user-1", "cycle-1", "goal-1", "green_to_yellow")).toBe(true);
    });

    it("ユーザーが異なれば送信済みにならない(所有者スコープ)", () => {
      const store = createAlertStateStore(backend, deterministicDeps());
      store.recordSent("user-1", "cycle-1", "goal-1", "green_to_yellow");

      expect(store.isAlreadySent("user-2", "cycle-1", "goal-1", "green_to_yellow")).toBe(false);
    });

    it("サイクルが異なれば送信済みにならない", () => {
      const store = createAlertStateStore(backend, deterministicDeps());
      store.recordSent("user-1", "cycle-1", "goal-1", "green_to_yellow");

      expect(store.isAlreadySent("user-1", "cycle-2", "goal-1", "green_to_yellow")).toBe(false);
    });

    it("目標が異なれば送信済みにならない", () => {
      const store = createAlertStateStore(backend, deterministicDeps());
      store.recordSent("user-1", "cycle-1", "goal-1", "green_to_yellow");

      expect(store.isAlreadySent("user-1", "cycle-1", "goal-2", "green_to_yellow")).toBe(false);
    });
  });
});
