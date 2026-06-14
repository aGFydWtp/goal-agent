// notifications 重複抑止フィルタの結合テスト(task 2.3 / Req 4.8 / design「Alert Triggers + Dedup」)。
//
// 検証対象(完了条件):
// - 送信済みトリガ ((goal, kind) が recordSent 済み) は除外され、未送信トリガは通過する。
// - 混在リストでは送信済みのみが除外され、入力順が保たれる。
// - 期限トリガの冪等性: cycle_end_30d を送信済みにし、30d(除外)/14d(通過)混在から 14d のみ残る。
//   同一フィルタを二度適用しても結果は同一(dedup は履歴を変更しないため冪等)。
// - スコープ: 別サイクル / 別ユーザーの送信履歴は本サイクル・本ユーザーの送信済み判定に影響しない。
//
// 実行環境: vitest "node" プロジェクト。`node:sqlite` の実 SQLite に対し
// `runNotificationMigrations` でスキーマを用意し、`recordSent` で送信履歴を播種する(実 store / 現実主義)。

import { beforeEach, describe, expect, it } from "vitest";
import { filterUnsentTriggers } from "../src/notifications/alert/dedup";
import type { FiredTrigger } from "../src/notifications/alert/triggers";
import {
  type AlertStateStore,
  type AlertTriggerKind,
  createAlertStateStore,
} from "../src/notifications/state/alert-state";
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

/** テスト用の FiredTrigger を最小構成で組み立てる(reasons は非空ダミー)。 */
function firedTrigger(goalId: string, kind: AlertTriggerKind): FiredTrigger {
  return {
    goalId,
    goalTitle: `${goalId} のタイトル`,
    kind,
    newStatus: "yellow",
    reasons: [`理由: ${kind}`],
  };
}

describe("filterUnsentTriggers", () => {
  let backend: NodeSqliteBackend;
  let store: AlertStateStore;

  beforeEach(() => {
    backend = new NodeSqliteBackend();
    runNotificationMigrations(backend);
    store = createAlertStateStore(backend, deterministicDeps());
  });

  it("送信済み (goal, kind) を除外し、未送信トリガを通過させる", () => {
    store.recordSent("user-1", "cycle-1", "goal-1", "green_to_yellow");

    const fired = [
      firedTrigger("goal-1", "green_to_yellow"), // 送信済み → 除外
      firedTrigger("goal-2", "green_to_yellow"), // 未送信 → 通過
    ];

    const result = filterUnsentTriggers(store, "user-1", "cycle-1", fired);

    expect(result).toHaveLength(1);
    expect(result[0]?.goalId).toBe("goal-2");
  });

  it("混在リストで送信済みのみ除外し、入力順を保つ", () => {
    store.recordSent("user-1", "cycle-1", "goal-b", "yellow_to_red");
    store.recordSent("user-1", "cycle-1", "goal-d", "no_evidence_2w");

    const fired = [
      firedTrigger("goal-a", "green_to_yellow"), // 通過
      firedTrigger("goal-b", "yellow_to_red"), // 除外
      firedTrigger("goal-c", "green_to_yellow"), // 通過
      firedTrigger("goal-d", "no_evidence_2w"), // 除外
      firedTrigger("goal-e", "yellow_to_red"), // 通過
    ];

    const result = filterUnsentTriggers(store, "user-1", "cycle-1", fired);

    expect(result.map((t) => t.goalId)).toEqual(["goal-a", "goal-c", "goal-e"]);
  });

  it("同一目標で kind 違いは独立に判定される(送信済み kind のみ除外)", () => {
    store.recordSent("user-1", "cycle-1", "goal-1", "cycle_end_30d");

    const fired = [
      firedTrigger("goal-1", "cycle_end_30d"), // 送信済み → 除外
      firedTrigger("goal-1", "cycle_end_14d"), // 未送信 → 通過
    ];

    const result = filterUnsentTriggers(store, "user-1", "cycle-1", fired);

    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe("cycle_end_14d");
  });

  it("期限トリガの週跨ぎ冪等性: 既送信 30d を落とし、新たに跨いだ 14d を通す(再適用しても同一)", () => {
    // 前週に cycle_end_30d を送信済み。今週 30d/14d 双方が fired したと仮定。
    store.recordSent("user-1", "cycle-1", "goal-1", "cycle_end_30d");

    const fired = [
      firedTrigger("goal-1", "cycle_end_30d"), // 既送信 → 除外
      firedTrigger("goal-1", "cycle_end_14d"), // 今週新規 → 通過
    ];

    const first = filterUnsentTriggers(store, "user-1", "cycle-1", fired);
    expect(first.map((t) => t.kind)).toEqual(["cycle_end_14d"]);

    // dedup は履歴を変更しないため、二度適用しても結果は同一(冪等・重複なし)。
    const second = filterUnsentTriggers(store, "user-1", "cycle-1", fired);
    expect(second.map((t) => t.kind)).toEqual(["cycle_end_14d"]);
  });

  it("別サイクルの送信履歴は本サイクルの送信済み判定に影響しない", () => {
    // 別サイクルで送信済みでも、本サイクルでは未送信として通過する。
    store.recordSent("user-1", "cycle-OTHER", "goal-1", "green_to_yellow");

    const fired = [firedTrigger("goal-1", "green_to_yellow")];
    const result = filterUnsentTriggers(store, "user-1", "cycle-1", fired);

    expect(result).toHaveLength(1);
    expect(result[0]?.goalId).toBe("goal-1");
  });

  it("別ユーザーの送信履歴は本ユーザーの送信済み判定に影響しない", () => {
    store.recordSent("user-OTHER", "cycle-1", "goal-1", "green_to_yellow");

    const fired = [firedTrigger("goal-1", "green_to_yellow")];
    const result = filterUnsentTriggers(store, "user-1", "cycle-1", fired);

    expect(result).toHaveLength(1);
    expect(result[0]?.goalId).toBe("goal-1");
  });

  it("空入力は空配列を返す", () => {
    const result = filterUnsentTriggers(store, "user-1", "cycle-1", []);
    expect(result).toEqual([]);
  });
});
