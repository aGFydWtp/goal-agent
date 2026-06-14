// status-and-draft の証跡閲覧ドメイン操作(task 5.2 / Req 4.1, 4.2, 4.4, 8.1)。
//
// 完了条件: 所有証跡が紐づく目標名付きで返り、非所有を含まず、証跡無しで空が返ること。
//
// 設計の Service Interface(EvidenceViewOperations)は理想形であり、確立した純粋関数パターンに
// 従って (authority, userId) を注入する実シグネチャで検証する(Implementation Notes 1.1)。

import { describe, expect, it } from "vitest";
import type { CycleDataAuthority } from "../src/goal-management/domain/cycle-operations";
import { runMigrations } from "../src/persistence/migrator";
import { createRepository } from "../src/persistence/repository";
import { listEvidenceWithLinks } from "../src/status-and-draft/domain/evidence-view";
import type {
  EntityName,
  EntityRow,
  EvaluationCycleRow,
  EvidenceGoalLinkRow,
  EvidenceRow,
  GoalRow,
} from "../src/types";
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

async function seedCycle(
  authority: CycleDataAuthority,
  overrides: Partial<EvaluationCycleRow> = {},
): Promise<EvaluationCycleRow> {
  const cycle: EvaluationCycleRow = {
    id: "cycle-1",
    user_id: "user-1",
    name: "2026 H1",
    start_date: "2026-01-01",
    end_date: "2026-06-30",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
  await authority.insertRow("evaluation_cycles", cycle);
  return cycle;
}

async function seedGoal(
  authority: CycleDataAuthority,
  overrides: Partial<GoalRow> = {},
): Promise<GoalRow> {
  const goal: GoalRow = {
    id: "goal-1",
    cycle_id: "cycle-1",
    user_id: "user-1",
    title: "AI 活用で開発効率を上げる",
    description: "開発プロセスに AI 支援を組み込む",
    success_criteria: "週次で改善実績を 3 件以上記録する",
    evaluation_points: "レビュー時間の短縮",
    status: "gray",
    created_at: "2026-01-02T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
  await authority.insertRow("goals", goal);
  return goal;
}

async function seedEvidence(
  authority: CycleDataAuthority,
  overrides: Partial<EvidenceRow> & { id: string },
): Promise<EvidenceRow> {
  const evidence: EvidenceRow = {
    cycle_id: "cycle-1",
    user_id: "user-1",
    source_type: "manual_checkin",
    source_url: null,
    title: "実装記録",
    body: "AI 支援で機能を実装した",
    evidence_date: "2026-06-10",
    usefulness: "high",
    created_at: "2026-06-10T00:00:00.000Z",
    updated_at: "2026-06-10T00:00:00.000Z",
    ...overrides,
  };
  await authority.insertRow("evidence", evidence);
  return evidence;
}

async function linkEvidence(
  authority: CycleDataAuthority,
  id: string,
  evidenceId: string,
  goalId: string,
): Promise<void> {
  const link: EvidenceGoalLinkRow = {
    id,
    evidence_id: evidenceId,
    goal_id: goalId,
    relevance_score: 0.9,
    reason: null,
    created_at: "2026-06-10T00:00:00.000Z",
  };
  await authority.insertRow("evidence_goal_links", link);
}

describe("listEvidenceWithLinks", () => {
  it("所有証跡を、紐づく目標名を解決して返す (4.1, 4.2)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      await seedGoal(authority, { id: "goal-1", title: "目標A" });
      await seedGoal(authority, { id: "goal-2", title: "目標B" });
      await seedEvidence(authority, { id: "ev-1", evidence_date: "2026-06-10" });
      await seedEvidence(authority, { id: "ev-2", evidence_date: "2026-06-12" });
      // ev-1 は goal-1 と goal-2 の両方に紐づく。
      await linkEvidence(authority, "link-1", "ev-1", "goal-1");
      await linkEvidence(authority, "link-2", "ev-1", "goal-2");
      // ev-2 は goal-2 のみ。
      await linkEvidence(authority, "link-3", "ev-2", "goal-2");

      const result = await listEvidenceWithLinks(authority, "user-1");

      expect(result).toHaveLength(2);
      const byId = new Map(result.map((r) => [r.evidence.id, r]));
      expect(byId.get("ev-1")?.linkedGoalTitles.sort()).toEqual(["目標A", "目標B"]);
      expect(byId.get("ev-2")?.linkedGoalTitles).toEqual(["目標B"]);
      // 証跡行そのものが内容付きで返る。
      expect(byId.get("ev-1")?.evidence.body).toBe("AI 支援で機能を実装した");
      expect(byId.get("ev-1")?.evidence.evidence_date).toBe("2026-06-10");
    } finally {
      db.close();
    }
  });

  it("他ユーザーの証跡を含めない (4.4, 8.1)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      await seedGoal(authority);
      await seedEvidence(authority, { id: "ev-mine", user_id: "user-1" });
      await seedEvidence(authority, { id: "ev-other", user_id: "user-2" });
      await linkEvidence(authority, "link-1", "ev-mine", "goal-1");
      await linkEvidence(authority, "link-2", "ev-other", "goal-1");

      const result = await listEvidenceWithLinks(authority, "user-1");

      expect(result).toHaveLength(1);
      expect(result[0]?.evidence.id).toBe("ev-mine");
    } finally {
      db.close();
    }
  });

  it("証跡無しは空配列を返す (4.3 案内はメッセージ層)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      await seedGoal(authority);
      // 別ユーザーの証跡だけ存在。
      await seedEvidence(authority, { id: "ev-other", user_id: "user-2" });

      const result = await listEvidenceWithLinks(authority, "user-1");

      expect(result).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("リンクが無い証跡は linkedGoalTitles を空にする (4.2)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      await seedGoal(authority);
      await seedEvidence(authority, { id: "ev-1" });
      // リンクを作らない。

      const result = await listEvidenceWithLinks(authority, "user-1");

      expect(result).toHaveLength(1);
      expect(result[0]?.linkedGoalTitles).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("非所有の目標へのリンクはその目標名を露出しない (4.4, 8.1)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      // 自分の目標と、他ユーザーの目標(防御的に名前を漏らさない)。
      await seedGoal(authority, { id: "goal-mine", title: "自分の目標" });
      await seedGoal(authority, { id: "goal-foreign", user_id: "user-2", title: "他人の目標" });
      await seedEvidence(authority, { id: "ev-1", user_id: "user-1" });
      await linkEvidence(authority, "link-1", "ev-1", "goal-mine");
      await linkEvidence(authority, "link-2", "ev-1", "goal-foreign");

      const result = await listEvidenceWithLinks(authority, "user-1");

      expect(result).toHaveLength(1);
      expect(result[0]?.linkedGoalTitles).toEqual(["自分の目標"]);
    } finally {
      db.close();
    }
  });

  it("複数証跡を evidence_date 昇順で安定して返す (4.1)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      await seedGoal(authority);
      await seedEvidence(authority, { id: "ev-late", evidence_date: "2026-06-20" });
      await seedEvidence(authority, { id: "ev-early", evidence_date: "2026-06-01" });
      await seedEvidence(authority, { id: "ev-mid", evidence_date: "2026-06-10" });

      const result = await listEvidenceWithLinks(authority, "user-1");

      expect(result.map((r) => r.evidence.id)).toEqual(["ev-early", "ev-mid", "ev-late"]);
    } finally {
      db.close();
    }
  });
});
