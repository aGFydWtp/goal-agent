// checkin-classification のチェックインドメイン操作(task 2.1 / Req 1.2, 3.3, 3.4, 3.7)。
//
// 完了条件: 実行ユーザーの最新サイクルを goal-management の対象サイクル決定規約に従って
// 判別できること。分類完了後の pending 分類を pendingId で揮発保持し、userId 所有者スコープで
// 取得・破棄でき、別 userId からは不存在として扱うこと。

import { describe, expect, it } from "vitest";
import {
  createPendingCheckinStore,
  discardPendingClassification,
  getPendingClassification,
  resolveCheckinActiveCycle,
  storePendingClassification,
} from "../src/checkin-classification/domain/checkin-operations";
import type { ClassificationResult } from "../src/checkin-classification/classification/schema";
import type { CycleDataAuthority, DomainDeps } from "../src/goal-management/domain/cycle-operations";
import { runMigrations } from "../src/persistence/migrator";
import { createRepository } from "../src/persistence/repository";
import type { EntityName, EntityRow, EvaluationCycleRow } from "../src/types";
import { NodeSqliteBackend } from "./helpers/node-sqlite-adapter";

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

function makeDeps(now = "2026-06-14T12:00:00.000Z"): DomainDeps {
  let counter = 0;
  return {
    newId: () => {
      counter += 1;
      return `pending-${counter}`;
    },
    now: () => now,
  };
}

async function seedCycle(
  authority: CycleDataAuthority,
  cycle: EvaluationCycleRow,
): Promise<EvaluationCycleRow> {
  await authority.insertRow("evaluation_cycles", cycle);
  return cycle;
}

const classificationResult: ClassificationResult = {
  items: [
    {
      text: "分類ドメイン操作を実装した",
      candidateGoals: [
        {
          goalId: "goal-1",
          relevanceScore: 0.9,
          reason: "実装タスクの完了に対応する",
        },
      ],
      usefulness: "high",
      suggestedEvidenceTitle: "分類ドメイン操作の実装",
    },
  ],
};

describe("resolveCheckinActiveCycle", () => {
  it("実行ユーザーのサイクルが無ければ no_cycle を返す (1.2)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority, {
        id: "cycle-other",
        user_id: "user-2",
        name: "他人のサイクル",
        start_date: "2026-01-01",
        end_date: "2026-06-30",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      });

      expect(await resolveCheckinActiveCycle(authority, "user-1")).toEqual({
        ok: false,
        reason: "no_cycle",
      });
    } finally {
      db.close();
    }
  });

  it("実行ユーザーが所有する created_at 最大の最新サイクルを返す (1.2)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority, {
        id: "cycle-old",
        user_id: "user-1",
        name: "古い",
        start_date: "2025-01-01",
        end_date: "2025-06-30",
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      });
      await seedCycle(authority, {
        id: "cycle-new",
        user_id: "user-1",
        name: "新しい",
        start_date: "2026-01-01",
        end_date: "2026-06-30",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      });

      const result = await resolveCheckinActiveCycle(authority, "user-1");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected active cycle");
      expect(result.cycle.id).toBe("cycle-new");
    } finally {
      db.close();
    }
  });
});

describe("pending classification store", () => {
  it("pendingId 採番で分類結果を userId に紐付けて保持・取得できる (3.3)", () => {
    const store = createPendingCheckinStore();
    const result = storePendingClassification(store, makeDeps(), {
      userId: "user-1",
      cycleId: "cycle-1",
      rawText: "今週やったこと",
      result: classificationResult,
    });

    expect(result.pendingId).toBe("pending-1");
    expect(result.pending).toEqual({
      pendingId: "pending-1",
      userId: "user-1",
      cycleId: "cycle-1",
      rawText: "今週やったこと",
      result: classificationResult,
      createdAt: "2026-06-14T12:00:00.000Z",
    });
    expect(getPendingClassification(store, "user-1", "pending-1")).toEqual(result.pending);
  });

  it("別 userId からの取得は不存在として扱い、破棄でも削除しない (3.7)", () => {
    const store = createPendingCheckinStore();
    const { pendingId } = storePendingClassification(store, makeDeps(), {
      userId: "user-1",
      cycleId: "cycle-1",
      rawText: "今週やったこと",
      result: classificationResult,
    });

    expect(getPendingClassification(store, "user-2", pendingId)).toBeNull();
    expect(discardPendingClassification(store, "user-2", pendingId)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(getPendingClassification(store, "user-1", pendingId)?.pendingId).toBe(pendingId);
  });

  it("所有者が破棄すると pending を削除し、以後は not_found になる (3.4, 3.7)", () => {
    const store = createPendingCheckinStore();
    const { pendingId } = storePendingClassification(store, makeDeps(), {
      userId: "user-1",
      cycleId: "cycle-1",
      rawText: "今週やったこと",
      result: classificationResult,
    });

    expect(discardPendingClassification(store, "user-1", pendingId)).toEqual({ ok: true });
    expect(getPendingClassification(store, "user-1", pendingId)).toBeNull();
    expect(discardPendingClassification(store, "user-1", pendingId)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});
