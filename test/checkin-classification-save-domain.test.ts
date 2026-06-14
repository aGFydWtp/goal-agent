// checkin-classification の証跡化保存ドメインメソッド(task 2.3 / Req 4.1-4.6)。
//
// 完了条件: pending 分類を所有者スコープで確定し、checkins/evidence/evidence_goal_links を
// 整合的に保存すること。別人/不在 pending は not_found、途中失敗はロールバックして pending を残す。

import { describe, expect, it } from "vitest";
import type { ClassificationResult } from "../src/checkin-classification/classification/schema";
import {
  createPendingCheckinStore,
  saveClassifiedCheckin,
  storePendingClassification,
} from "../src/checkin-classification/domain/checkin-operations";
import type { CycleDataAuthority, DomainDeps } from "../src/goal-management/domain/cycle-operations";
import { runMigrations } from "../src/persistence/migrator";
import { createRepository } from "../src/persistence/repository";
import type { CheckinRow, EntityName, EntityRow, EvidenceGoalLinkRow, EvidenceRow } from "../src/types";
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
      return `id-${counter}`;
    },
    now: () => now,
  };
}

async function listSavedRows(authority: CycleDataAuthority): Promise<{
  checkins: CheckinRow[];
  evidence: EvidenceRow[];
  evidenceGoalLinks: EvidenceGoalLinkRow[];
}> {
  return {
    checkins: await authority.listRowsBy("checkins", {}),
    evidence: await authority.listRowsBy("evidence", {}),
    evidenceGoalLinks: await authority.listRowsBy("evidence_goal_links", {}),
  };
}

const classificationResult: ClassificationResult = {
  items: [
    {
      text: "分類保存ドメインを実装し、ロールバックテストを追加した",
      candidateGoals: [
        {
          goalId: "goal-1",
          relevanceScore: 0.92,
          reason: "チェックイン分類の保存処理に直結する",
        },
        {
          goalId: "goal-2",
          relevanceScore: 0.71,
          reason: "証跡を後続レビューへ渡す基盤になる",
        },
      ],
      usefulness: "high",
      suggestedEvidenceTitle: "分類保存ドメインの実装",
    },
    {
      text: "チームの雑談チャンネルを整理した",
      candidateGoals: [],
      usefulness: "low",
      suggestedEvidenceTitle: "雑談チャンネル整理",
    },
  ],
};

describe("saveClassifiedCheckin", () => {
  it("pending 分類を checkins/evidence/evidence_goal_links として所有者スコープで保存し、複数目標リンクを作る (4.1-4.5)", async () => {
    const { db, authority } = setupAuthority();
    try {
      const deps = makeDeps();
      const store = createPendingCheckinStore();
      const { pendingId } = storePendingClassification(store, deps, {
        userId: "user-1",
        cycleId: "cycle-1",
        rawText: "今週は分類保存ドメインを実装した。雑談チャンネルも整理した。",
        result: classificationResult,
      });

      const result = await saveClassifiedCheckin(authority, deps, store, {
        userId: "user-1",
        pendingId,
      });

      expect(result).toEqual({
        ok: true,
        checkinId: "id-2",
        evidenceIds: ["id-3", "id-6"],
        weekStartDate: "2026-06-08",
      });
      expect(store.classifications.has(pendingId)).toBe(false);

      const rows = await listSavedRows(authority);
      expect(rows.checkins).toEqual([
        {
          id: "id-2",
          cycle_id: "cycle-1",
          user_id: "user-1",
          raw_text: "今週は分類保存ドメインを実装した。雑談チャンネルも整理した。",
          week_start_date: "2026-06-08",
          created_at: "2026-06-14T12:00:00.000Z",
        },
      ]);
      expect(rows.evidence).toEqual([
        {
          id: "id-3",
          cycle_id: "cycle-1",
          user_id: "user-1",
          source_type: "manual_checkin",
          source_url: null,
          title: "分類保存ドメインの実装",
          body: "分類保存ドメインを実装し、ロールバックテストを追加した",
          evidence_date: "2026-06-08",
          usefulness: "high",
          created_at: "2026-06-14T12:00:00.000Z",
          updated_at: "2026-06-14T12:00:00.000Z",
        },
        {
          id: "id-6",
          cycle_id: "cycle-1",
          user_id: "user-1",
          source_type: "manual_checkin",
          source_url: null,
          title: "雑談チャンネル整理",
          body: "チームの雑談チャンネルを整理した",
          evidence_date: "2026-06-08",
          usefulness: "low",
          created_at: "2026-06-14T12:00:00.000Z",
          updated_at: "2026-06-14T12:00:00.000Z",
        },
      ]);
      expect(rows.evidenceGoalLinks).toEqual([
        {
          id: "id-4",
          evidence_id: "id-3",
          goal_id: "goal-1",
          relevance_score: 0.92,
          reason: "チェックイン分類の保存処理に直結する",
          created_at: "2026-06-14T12:00:00.000Z",
        },
        {
          id: "id-5",
          evidence_id: "id-3",
          goal_id: "goal-2",
          relevance_score: 0.71,
          reason: "証跡を後続レビューへ渡す基盤になる",
          created_at: "2026-06-14T12:00:00.000Z",
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("pending が不在なら not_found を返し、DB を変更しない (3.7, 4.6)", async () => {
    const { db, authority } = setupAuthority();
    try {
      const store = createPendingCheckinStore();

      const result = await saveClassifiedCheckin(authority, makeDeps(), store, {
        userId: "user-1",
        pendingId: "missing",
      });

      expect(result).toEqual({ ok: false, reason: "not_found" });
      expect(await listSavedRows(authority)).toEqual({
        checkins: [],
        evidence: [],
        evidenceGoalLinks: [],
      });
    } finally {
      db.close();
    }
  });

  it("別 userId の pending は not_found を返し、pending を削除しない (3.7, 4.6)", async () => {
    const { db, authority } = setupAuthority();
    try {
      const store = createPendingCheckinStore();
      const { pendingId } = storePendingClassification(store, makeDeps(), {
        userId: "user-1",
        cycleId: "cycle-1",
        rawText: "今週の入力",
        result: classificationResult,
      });

      const result = await saveClassifiedCheckin(authority, makeDeps(), store, {
        userId: "user-2",
        pendingId,
      });

      expect(result).toEqual({ ok: false, reason: "not_found" });
      expect(store.classifications.has(pendingId)).toBe(true);
      expect(await listSavedRows(authority)).toEqual({
        checkins: [],
        evidence: [],
        evidenceGoalLinks: [],
      });
    } finally {
      db.close();
    }
  });

  it("途中 insert 失敗時は作成済みレコードを削除し、pending を残す (4.6)", async () => {
    const { db, authority } = setupAuthority();
    try {
      const store = createPendingCheckinStore();
      const { pendingId } = storePendingClassification(store, makeDeps(), {
        userId: "user-1",
        cycleId: "cycle-1",
        rawText: "今週の入力",
        result: classificationResult,
      });
      let insertCount = 0;
      const failingAuthority: CycleDataAuthority = {
        ...authority,
        insertRow: async (entity, row) => {
          insertCount += 1;
          if (insertCount === 4) {
            throw new Error("injected insert failure");
          }
          await authority.insertRow(entity, row);
        },
      };

      const result = await saveClassifiedCheckin(failingAuthority, makeDeps(), store, {
        userId: "user-1",
        pendingId,
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected save failure");
      expect(result.reason).toBe("save_failed");
      expect(store.classifications.has(pendingId)).toBe(true);
      expect(await listSavedRows(authority)).toEqual({
        checkins: [],
        evidence: [],
        evidenceGoalLinks: [],
      });
    } finally {
      db.close();
    }
  });
});
