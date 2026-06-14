// 目標一覧/取得ドメインロジックの検証(goal-management task 2.3 / Req 5.1, 5.2, 5.3, 2.3)。
//
// 完了条件: 所有者スコープ内で同一サイクルの目標一覧(listGoals)と各目標定義(getGoal)が取得でき、
// 非所有データ(別 user_id)・別サイクル(cycle_id 不一致)・不存在は取得対象外(null/除外)になること。
// getGoalDefinition は GoalAgent の親委譲として getGoal と同一結果を返す。
//
// 実行環境: vitest projects の "node" プロジェクト(node:sqlite を使う実 SQLite で検証)。
// 参考: test/goal-management-add-goal.test.ts。

import { describe, expect, it } from "vitest";
import type { CycleDataAuthority } from "../src/goal-management/domain/cycle-operations";
import { getGoal, listGoals } from "../src/goal-management/domain/cycle-operations";
import { getGoalDefinition } from "../src/goal-management/domain/goal-operations";
import { runMigrations } from "../src/persistence/migrator";
import { createRepository } from "../src/persistence/repository";
import type { EntityName, EntityRow, GoalRow } from "../src/types";
import { NodeSqliteBackend } from "./helpers/node-sqlite-adapter";

/**
 * マイグレーション適用済みの実 SQLite を `CycleDataAuthority` に async ラップしたアダプタと、
 * DO 無しで検証するための後始末用 `db` を返す。
 */
function setupAuthority(): { db: NodeSqliteBackend; authority: CycleDataAuthority } {
  const db = new NodeSqliteBackend();
  runMigrations(db);
  const repo = createRepository(db);
  const authority: CycleDataAuthority = {
    insertRow: async (entity, row) => repo.insert(entity, row),
    getRowById: async <E extends EntityName>(entity: E, id: string) => repo.getById(entity, id),
    listRowsBy: async <E extends EntityName>(entity: E, where: Partial<EntityRow<E>>) =>
      repo.listBy(entity, where),
    removeRow: async (entity, id) => repo.remove(entity, id),
  };
  return { db, authority };
}

/** テスト用に直接 evaluation_cycles 行を作成する(前提条件構築)。 */
async function seedCycle(
  authority: CycleDataAuthority,
  id: string,
  userId: string,
): Promise<void> {
  await authority.insertRow("evaluation_cycles", {
    id,
    user_id: userId,
    name: `cycle-${id}`,
    start_date: "2026-01-01",
    end_date: "2026-06-30",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });
}

/** テスト用に直接 goals 行を作成する。 */
async function seedGoal(
  authority: CycleDataAuthority,
  overrides: Partial<GoalRow> & Pick<GoalRow, "id" | "cycle_id" | "user_id">,
): Promise<GoalRow> {
  const goal: GoalRow = {
    title: "目標",
    description: "本文",
    success_criteria: null,
    evaluation_points: null,
    status: "gray",
    created_at: "2026-02-01T00:00:00.000Z",
    updated_at: "2026-02-01T00:00:00.000Z",
    ...overrides,
  };
  await authority.insertRow("goals", goal);
  return goal;
}

describe("listGoals: サイクル配下の目標一覧(所有者スコープ)", () => {
  it("同一サイクル・同一ユーザーの目標を全件返す (5.1, 5.3)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority, "cyc-1", "user-1");
      await seedGoal(authority, { id: "g-1", cycle_id: "cyc-1", user_id: "user-1" });
      await seedGoal(authority, { id: "g-2", cycle_id: "cyc-1", user_id: "user-1" });

      const rows = await listGoals(authority, "user-1", "cyc-1");
      expect(rows.map((r) => r.id).sort()).toEqual(["g-1", "g-2"]);
    } finally {
      db.close();
    }
  });

  it("別ユーザーの目標は含まれない(所有者スコープ) (4.1, 5.1)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority, "cyc-1", "user-1");
      await seedGoal(authority, { id: "g-1", cycle_id: "cyc-1", user_id: "user-1" });
      // 別ユーザーが同じ cycle_id を参照していても露出しない。
      await seedGoal(authority, { id: "g-other", cycle_id: "cyc-1", user_id: "user-2" });

      const rows = await listGoals(authority, "user-1", "cyc-1");
      expect(rows.map((r) => r.id)).toEqual(["g-1"]);
    } finally {
      db.close();
    }
  });

  it("別サイクルの目標は含まれない(サイクルスコープ) (5.1)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority, "cyc-1", "user-1");
      await seedCycle(authority, "cyc-2", "user-1");
      await seedGoal(authority, { id: "g-1", cycle_id: "cyc-1", user_id: "user-1" });
      await seedGoal(authority, { id: "g-2", cycle_id: "cyc-2", user_id: "user-1" });

      const rows = await listGoals(authority, "user-1", "cyc-1");
      expect(rows.map((r) => r.id)).toEqual(["g-1"]);
    } finally {
      db.close();
    }
  });

  it("該当目標が無ければ空配列を返す (5.1)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority, "cyc-1", "user-1");
      const rows = await listGoals(authority, "user-1", "cyc-1");
      expect(rows).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("getGoal: 特定目標の定義取得(所有者スコープ)", () => {
  it("所有かつ同一サイクルの目標定義を返す (5.2, 5.3)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority, "cyc-1", "user-1");
      const goal = await seedGoal(authority, {
        id: "g-1",
        cycle_id: "cyc-1",
        user_id: "user-1",
        title: "目標 A",
        success_criteria: "a\nb",
        evaluation_points: "観点1\n観点2",
      });

      const fetched = await getGoal(authority, "user-1", "cyc-1", "g-1");
      expect(fetched).toEqual(goal);
    } finally {
      db.close();
    }
  });

  it("非所有(別 user_id)の目標は null を返す(露出しない) (4.2, 5.3)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority, "cyc-1", "user-2");
      await seedGoal(authority, { id: "g-other", cycle_id: "cyc-1", user_id: "user-2" });

      expect(await getGoal(authority, "user-1", "cyc-1", "g-other")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("別サイクル(cycle_id 不一致)の目標は null を返す (5.2, 2.3)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority, "cyc-1", "user-1");
      await seedCycle(authority, "cyc-2", "user-1");
      await seedGoal(authority, { id: "g-1", cycle_id: "cyc-2", user_id: "user-1" });

      // 所有者は一致するが対象サイクルが異なる目標は露出しない。
      expect(await getGoal(authority, "user-1", "cyc-1", "g-1")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("不存在の goalId は null を返す (5.2)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority, "cyc-1", "user-1");
      expect(await getGoal(authority, "user-1", "cyc-1", "missing")).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("getGoalDefinition: GoalAgent 親委譲 (2.3, 5.2, 5.3)", () => {
  it("所有かつ同一サイクルなら getGoal と同一の行を返す", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority, "cyc-1", "user-1");
      const goal = await seedGoal(authority, { id: "g-1", cycle_id: "cyc-1", user_id: "user-1" });

      const viaDelegate = await getGoalDefinition(authority, "user-1", "cyc-1", "g-1");
      const viaDirect = await getGoal(authority, "user-1", "cyc-1", "g-1");
      expect(viaDelegate).toEqual(goal);
      expect(viaDelegate).toEqual(viaDirect);
    } finally {
      db.close();
    }
  });

  it("非所有の目標は null を返す(委譲先の所有者スコープを継承)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority, "cyc-1", "user-2");
      await seedGoal(authority, { id: "g-other", cycle_id: "cyc-1", user_id: "user-2" });

      expect(await getGoalDefinition(authority, "user-1", "cyc-1", "g-other")).toBeNull();
    } finally {
      db.close();
    }
  });
});
