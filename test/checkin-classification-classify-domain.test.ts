// checkin-classification の分類実行ドメインメソッド(task 2.2 / Req 2.1, 2.2, 2.3, 2.6)。
//
// 完了条件: 目標 + 達成条件を分類コンテキストとして LLM に渡し、構造化結果をドメイン検証した上で
// pending に保持すること。invalid_output / 非実在 goalId / 目標なしでは分類失敗を返し、証跡系の
// 永続化を行わないこと。

import { describe, expect, it } from "vitest";
import {
  classifyCheckin,
  createPendingCheckinStore,
} from "../src/checkin-classification/domain/checkin-operations";
import type { ClassificationResult } from "../src/checkin-classification/classification/schema";
import type { LlmClient, LlmCompletionRequest, LlmResult } from "../src/llm/client";
import type { CycleDataAuthority, DomainDeps } from "../src/goal-management/domain/cycle-operations";
import { runMigrations } from "../src/persistence/migrator";
import { createRepository } from "../src/persistence/repository";
import type { EntityName, EntityRow, EvaluationCycleRow, GoalRow } from "../src/types";
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

class FakeLlmClient implements LlmClient {
  public readonly jsonRequests: LlmCompletionRequest[] = [];

  constructor(private readonly jsonResult: LlmResult<ClassificationResult>) {}

  async complete(): Promise<LlmResult<string>> {
    return { ok: true, value: "" };
  }

  async completeJson(request: LlmCompletionRequest): Promise<LlmResult<ClassificationResult>> {
    this.jsonRequests.push(request);
    return this.jsonResult;
  }
}

async function seedCycle(authority: CycleDataAuthority): Promise<EvaluationCycleRow> {
  const cycle: EvaluationCycleRow = {
    id: "cycle-1",
    user_id: "user-1",
    name: "2026 H1",
    start_date: "2026-01-01",
    end_date: "2026-06-30",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  await authority.insertRow("evaluation_cycles", cycle);
  return cycle;
}

async function seedGoal(authority: CycleDataAuthority, goal: GoalRow): Promise<GoalRow> {
  await authority.insertRow("goals", goal);
  return goal;
}

async function listEvidenceTables(authority: CycleDataAuthority) {
  return {
    checkins: await authority.listRowsBy("checkins", {}),
    evidence: await authority.listRowsBy("evidence", {}),
    evidenceGoalLinks: await authority.listRowsBy("evidence_goal_links", {}),
    weeklyReviews: await authority.listRowsBy("weekly_reviews", {}),
  };
}

const validClassification: ClassificationResult = {
  items: [
    {
      text: "分類実行ドメインメソッドを実装し、テストを追加した",
      candidateGoals: [
        {
          goalId: "goal-1",
          relevanceScore: 0.94,
          reason: "チェックイン分類フローの実装完了に直結する",
        },
      ],
      usefulness: "high",
      suggestedEvidenceTitle: "分類実行ドメインメソッドの実装",
    },
    {
      text: "チームの雑談チャンネルを整理した",
      candidateGoals: [],
      usefulness: "low",
      suggestedEvidenceTitle: "雑談チャンネル整理",
    },
  ],
};

describe("classifyCheckin", () => {
  it("目標 + 達成条件と rawText をプロンプトへ渡し、検証済み分類結果を pending に保持する (2.1, 2.2, 2.3)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      await seedGoal(authority, {
        id: "goal-1",
        cycle_id: "cycle-1",
        user_id: "user-1",
        title: "AI 活用で開発効率を上げる",
        description: "開発プロセスに AI 支援を組み込み、レビューと実装速度を改善する",
        success_criteria: "週次で AI 活用の改善実績を 3 件以上記録する",
        evaluation_points: null,
        status: "gray",
        created_at: "2026-01-02T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
      });
      const llm = new FakeLlmClient({ ok: true, value: validClassification });
      const store = createPendingCheckinStore();

      const result = await classifyCheckin(authority, makeDeps(), llm, store, {
        userId: "user-1",
        cycleId: "cycle-1",
        rawText: "今週は分類実行ドメインメソッドを実装し、テストも追加した。",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected classification success");
      expect(result.pendingId).toBe("id-1");
      expect(result.result).toEqual(validClassification);
      expect(result.unclassifiedItems).toEqual([validClassification.items[1]]);
      expect(store.classifications.get("id-1")).toMatchObject({
        userId: "user-1",
        cycleId: "cycle-1",
        rawText: "今週は分類実行ドメインメソッドを実装し、テストも追加した。",
        result: validClassification,
      });

      expect(llm.jsonRequests).toHaveLength(1);
      const request = llm.jsonRequests[0];
      expect(request?.system).toContain("週次チェックインを分類");
      expect(request?.prompt).toContain("AI 活用で開発効率を上げる");
      expect(request?.prompt).toContain("開発プロセスに AI 支援を組み込み");
      expect(request?.prompt).toContain("週次で AI 活用の改善実績を 3 件以上記録する");
      expect(request?.prompt).toContain("今週は分類実行ドメインメソッドを実装し、テストも追加した。");
      expect(await listEvidenceTables(authority)).toEqual({
        checkins: [],
        evidence: [],
        evidenceGoalLinks: [],
        weeklyReviews: [],
      });
    } finally {
      db.close();
    }
  });

  it("LLM の invalid_output は分類失敗として返し、pending と証跡を作らない (2.6)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      await seedGoal(authority, {
        id: "goal-1",
        cycle_id: "cycle-1",
        user_id: "user-1",
        title: "AI 活用",
        description: "AI を業務へ適用する",
        success_criteria: "改善実績を記録する",
        evaluation_points: null,
        status: "gray",
        created_at: "2026-01-02T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
      });
      const llm = new FakeLlmClient({
        ok: false,
        error: { kind: "invalid_output", message: "schema mismatch" },
      });
      const store = createPendingCheckinStore();

      const result = await classifyCheckin(authority, makeDeps(), llm, store, {
        userId: "user-1",
        cycleId: "cycle-1",
        rawText: "今週の入力",
      });

      expect(result).toEqual({
        ok: false,
        reason: "classification_failed",
        errorKind: "invalid_output",
      });
      expect(store.classifications.size).toBe(0);
      expect(await listEvidenceTables(authority)).toEqual({
        checkins: [],
        evidence: [],
        evidenceGoalLinks: [],
        weeklyReviews: [],
      });
    } finally {
      db.close();
    }
  });

  it("検証で非実在 goalId が見つかると分類失敗として返し、pending と証跡を作らない (2.6)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      await seedGoal(authority, {
        id: "goal-1",
        cycle_id: "cycle-1",
        user_id: "user-1",
        title: "AI 活用",
        description: "AI を業務へ適用する",
        success_criteria: "改善実績を記録する",
        evaluation_points: null,
        status: "gray",
        created_at: "2026-01-02T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
      });
      const llm = new FakeLlmClient({
        ok: true,
        value: {
          items: [
            {
              text: "存在しない目標に紐づく分類",
              candidateGoals: [
                {
                  goalId: "goal-missing",
                  relevanceScore: 0.8,
                  reason: "LLM が存在しない ID を返した",
                },
              ],
              usefulness: "medium",
              suggestedEvidenceTitle: "不正な分類",
            },
          ],
        },
      });
      const store = createPendingCheckinStore();

      const result = await classifyCheckin(authority, makeDeps(), llm, store, {
        userId: "user-1",
        cycleId: "cycle-1",
        rawText: "今週の入力",
      });

      expect(result).toEqual({
        ok: false,
        reason: "classification_failed",
        verificationReason: "invalid_goal_id",
        goalIds: ["goal-missing"],
      });
      expect(store.classifications.size).toBe(0);
      expect(await listEvidenceTables(authority)).toEqual({
        checkins: [],
        evidence: [],
        evidenceGoalLinks: [],
        weeklyReviews: [],
      });
    } finally {
      db.close();
    }
  });

  it("分類対象の目標が無ければ no_goals を返し、LLM を呼ばず pending と証跡を作らない (2.1, 2.6)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      const llm = new FakeLlmClient({ ok: true, value: validClassification });
      const store = createPendingCheckinStore();

      const result = await classifyCheckin(authority, makeDeps(), llm, store, {
        userId: "user-1",
        cycleId: "cycle-1",
        rawText: "今週の入力",
      });

      expect(result).toEqual({ ok: false, reason: "no_goals" });
      expect(llm.jsonRequests).toHaveLength(0);
      expect(store.classifications.size).toBe(0);
      expect(await listEvidenceTables(authority)).toEqual({
        checkins: [],
        evidence: [],
        evidenceGoalLinks: [],
        weeklyReviews: [],
      });
    } finally {
      db.close();
    }
  });
});
