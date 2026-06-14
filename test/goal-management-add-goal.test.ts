// 目標登録ドメインロジックの検証(goal-management task 2.2 / Req 2.2, 2.4, 2.6, 2.8, 4.3, 5.3, 5.4)。
//
// 完了条件: 対象サイクル(実行ユーザー所有の最新サイクル)存在時に `goals` 行が status='gray'・
// 複数行の達成条件/評価観点付きで insert され(getById で round-trip 確認)、対象サイクル不存在時に
// `{ok:false, reason:"no_cycle"}` を返すこと。dueDate 指定時は evaluation_points 末尾へ畳み込む。
// resolveActiveCycle は created_at 最大の所有サイクルを返し、別ユーザーのサイクルは対象にしない。
//
// 実行環境: vitest projects の "node" プロジェクト(node:sqlite を使う実 SQLite で検証)。
// 参考: test/goal-management-cycle-operations.test.ts。

import { describe, expect, it } from "vitest";
import {
  addGoal,
  type CycleDataAuthority,
  type DomainDeps,
  type GoalInput,
  resolveActiveCycle,
} from "../src/goal-management/domain/cycle-operations";
import { runMigrations } from "../src/persistence/migrator";
import { createRepository } from "../src/persistence/repository";
import type { EntityName, EntityRow, EvaluationCycleRow } from "../src/types";
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

/** 決定的な deps(連番 ID + 固定 timestamp)を生成する。 */
function makeDeps(prefix = "id", now = "2026-06-14T00:00:00.000Z"): DomainDeps {
  let counter = 0;
  return {
    newId: () => {
      counter += 1;
      return `${prefix}-${counter}`;
    },
    now: () => now,
  };
}

/** テスト用に直接 evaluation_cycles 行を作成する(addGoal の前提条件構築)。 */
async function seedCycle(
  authority: CycleDataAuthority,
  cycle: EvaluationCycleRow,
): Promise<EvaluationCycleRow> {
  await authority.insertRow("evaluation_cycles", cycle);
  return cycle;
}

const baseGoalInput: GoalInput = {
  title: "目標 A",
  description: "目標本文",
  successCriteria: "a\nb\nc",
  evaluationPoints: "観点1\n観点2",
  dueDate: null,
};

describe("resolveActiveCycle: 対象サイクル決定規約", () => {
  it("サイクルが無ければ null を返す", async () => {
    const { db, authority } = setupAuthority();
    try {
      expect(await resolveActiveCycle(authority, "user-1")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("複数サイクルがあるとき created_at 最大(最新)の行を返す", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority, {
        id: "cyc-old",
        user_id: "user-1",
        name: "古い",
        start_date: "2025-01-01",
        end_date: "2025-06-30",
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      });
      await seedCycle(authority, {
        id: "cyc-new",
        user_id: "user-1",
        name: "新しい",
        start_date: "2026-01-01",
        end_date: "2026-06-30",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      });

      const active = await resolveActiveCycle(authority, "user-1");
      expect(active?.id).toBe("cyc-new");
    } finally {
      db.close();
    }
  });

  it("別ユーザーのサイクルは対象にならない(所有者スコープ)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority, {
        id: "cyc-other",
        user_id: "user-2",
        name: "他人の",
        start_date: "2026-01-01",
        end_date: "2026-06-30",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      });

      expect(await resolveActiveCycle(authority, "user-1")).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("addGoal: 目標登録ドメインロジック", () => {
  it("対象サイクルが無ければ no_cycle を返し goals を insert しない (2.6)", async () => {
    const { db, authority } = setupAuthority();
    try {
      const result = await addGoal(authority, makeDeps(), "user-1", baseGoalInput);
      expect(result).toEqual({ ok: false, reason: "no_cycle" });

      const rows = await authority.listRowsBy("goals", { user_id: "user-1" });
      expect(rows).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("対象サイクル存在時に status='gray'・複数行・cycle_id/user_id 付きで insert する (2.2, 2.4, 2.8, 4.3, 5.3)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority, {
        id: "cyc-1",
        user_id: "user-1",
        name: "2026 上期",
        start_date: "2026-01-01",
        end_date: "2026-06-30",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      });

      const deps = makeDeps("goal");
      const result = await addGoal(authority, deps, "user-1", baseGoalInput);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.goal).toEqual({
        id: "goal-1",
        cycle_id: "cyc-1",
        user_id: "user-1",
        title: "目標 A",
        description: "目標本文",
        success_criteria: "a\nb\nc",
        evaluation_points: "観点1\n観点2",
        status: "gray",
        created_at: "2026-06-14T00:00:00.000Z",
        updated_at: "2026-06-14T00:00:00.000Z",
      });

      // 永続化を round-trip で確認する(複数行が保持される)。
      const fetched = await authority.getRowById("goals", "goal-1");
      expect(fetched).toEqual(result.goal);
      expect(fetched?.status).toBe("gray");
      expect(fetched?.success_criteria).toBe("a\nb\nc");
    } finally {
      db.close();
    }
  });

  it("dueDate 指定時に evaluation_points 末尾へ畳み込む(評価観点あり) (2.4)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority, {
        id: "cyc-1",
        user_id: "user-1",
        name: "サイクル",
        start_date: "2026-01-01",
        end_date: "2026-06-30",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      });

      const result = await addGoal(authority, makeDeps("goal"), "user-1", {
        ...baseGoalInput,
        evaluationPoints: "観点1\n観点2",
        dueDate: "2026-06-30",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.goal.evaluation_points).toBe("観点1\n観点2\n期限: 2026-06-30");
    } finally {
      db.close();
    }
  });

  it("dueDate 指定かつ評価観点が空のとき期限行のみを保持する (2.4)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority, {
        id: "cyc-1",
        user_id: "user-1",
        name: "サイクル",
        start_date: "2026-01-01",
        end_date: "2026-06-30",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      });

      const result = await addGoal(authority, makeDeps("goal"), "user-1", {
        ...baseGoalInput,
        evaluationPoints: null,
        dueDate: "2026-06-30",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.goal.evaluation_points).toBe("期限: 2026-06-30");
    } finally {
      db.close();
    }
  });

  it("dueDate 無しのときは evaluation_points をそのまま保持し null も保持する (2.4)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority, {
        id: "cyc-1",
        user_id: "user-1",
        name: "サイクル",
        start_date: "2026-01-01",
        end_date: "2026-06-30",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      });

      const withPoints = await addGoal(authority, makeDeps("g1"), "user-1", {
        ...baseGoalInput,
        evaluationPoints: "観点のみ",
        dueDate: null,
      });
      if (!withPoints.ok) throw new Error("expected ok");
      expect(withPoints.goal.evaluation_points).toBe("観点のみ");

      const withoutPoints = await addGoal(authority, makeDeps("g2"), "user-1", {
        ...baseGoalInput,
        evaluationPoints: null,
        dueDate: null,
      });
      if (!withoutPoints.ok) throw new Error("expected ok");
      expect(withoutPoints.goal.evaluation_points).toBeNull();
    } finally {
      db.close();
    }
  });

  it("最新サイクル(created_at 最大)に紐づけて insert する (2.2)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority, {
        id: "cyc-old",
        user_id: "user-1",
        name: "古い",
        start_date: "2025-01-01",
        end_date: "2025-06-30",
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      });
      await seedCycle(authority, {
        id: "cyc-new",
        user_id: "user-1",
        name: "新しい",
        start_date: "2026-01-01",
        end_date: "2026-06-30",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      });

      const result = await addGoal(authority, makeDeps("goal"), "user-1", baseGoalInput);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.goal.cycle_id).toBe("cyc-new");
    } finally {
      db.close();
    }
  });
});
