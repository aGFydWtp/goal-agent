// checkin-classification の週次レビュー生成ドメインメソッド(task 2.4 / Req 5.1, 5.2, 5.5)。
//
// 完了条件: 保存済み checkins/evidence/links/goals をもとに週次レビュープロンプトを組み立て、
// weekly_reviews に永続化すること。LLM 失敗時は週次レビューだけ失敗し、既存の証跡を保持する。

import { describe, expect, it } from "vitest";
import { generateWeeklyReview } from "../src/checkin-classification/domain/checkin-operations";
import type { WeeklyReview } from "../src/checkin-classification/weekly-review/schema";
import type { CycleDataAuthority, DomainDeps } from "../src/goal-management/domain/cycle-operations";
import type { LlmClient, LlmCompletionRequest, LlmResult } from "../src/llm/client";
import { runMigrations } from "../src/persistence/migrator";
import { createRepository } from "../src/persistence/repository";
import type {
  CheckinRow,
  EntityName,
  EntityRow,
  EvaluationCycleRow,
  EvidenceGoalLinkRow,
  EvidenceRow,
  GoalRow,
  WeeklyReviewRow,
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

function makeDeps(now = "2026-06-14T12:00:00.000Z"): DomainDeps {
  let counter = 0;
  return {
    newId: () => {
      counter += 1;
      return `review-${counter}`;
    },
    now: () => now,
  };
}

class FakeWeeklyReviewLlmClient implements LlmClient {
  public readonly jsonRequests: LlmCompletionRequest[] = [];

  constructor(private readonly jsonResult: LlmResult<WeeklyReview>) {}

  async complete(): Promise<LlmResult<string>> {
    return { ok: true, value: "" };
  }

  async completeJson<T>(request: LlmCompletionRequest): Promise<LlmResult<T>> {
    this.jsonRequests.push(request);
    return this.jsonResult as LlmResult<T>;
  }
}

async function seedSavedWeeklyInputs(authority: CycleDataAuthority): Promise<{
  cycle: EvaluationCycleRow;
  goal: GoalRow;
  checkin: CheckinRow;
  evidence: EvidenceRow;
  link: EvidenceGoalLinkRow;
}> {
  const cycle: EvaluationCycleRow = {
    id: "cycle-1",
    user_id: "user-1",
    name: "2026 H1",
    start_date: "2026-01-01",
    end_date: "2026-06-30",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  const goal: GoalRow = {
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
  };
  const checkin: CheckinRow = {
    id: "checkin-1",
    cycle_id: "cycle-1",
    user_id: "user-1",
    raw_text: "今週は週次レビュー生成の保存処理を実装した。",
    week_start_date: "2026-06-08",
    created_at: "2026-06-14T11:00:00.000Z",
  };
  const evidence: EvidenceRow = {
    id: "evidence-1",
    cycle_id: "cycle-1",
    user_id: "user-1",
    source_type: "manual_checkin",
    source_url: null,
    title: "週次レビュー生成の実装",
    body: "保存済み証跡から週次レビュープロンプトを作った",
    evidence_date: "2026-06-08",
    usefulness: "high",
    created_at: "2026-06-14T11:01:00.000Z",
    updated_at: "2026-06-14T11:01:00.000Z",
  };
  const link: EvidenceGoalLinkRow = {
    id: "link-1",
    evidence_id: "evidence-1",
    goal_id: "goal-1",
    relevance_score: 0.91,
    reason: "AI 活用による開発効率改善の証跡になる",
    created_at: "2026-06-14T11:02:00.000Z",
  };

  await authority.insertRow("evaluation_cycles", cycle);
  await authority.insertRow("goals", goal);
  await authority.insertRow("checkins", checkin);
  await authority.insertRow("evidence", evidence);
  await authority.insertRow("evidence_goal_links", link);
  return { cycle, goal, checkin, evidence, link };
}

async function listPersistence(authority: CycleDataAuthority): Promise<{
  checkins: CheckinRow[];
  evidence: EvidenceRow[];
  evidenceGoalLinks: EvidenceGoalLinkRow[];
  weeklyReviews: WeeklyReviewRow[];
}> {
  return {
    checkins: await authority.listRowsBy("checkins", {}),
    evidence: await authority.listRowsBy("evidence", {}),
    evidenceGoalLinks: await authority.listRowsBy("evidence_goal_links", {}),
    weeklyReviews: await authority.listRowsBy("weekly_reviews", {}),
  };
}

describe("generateWeeklyReview", () => {
  it("保存済み内容と紐づく目標をプロンプトへ渡し、週次レビューを weekly_reviews に保存する (5.1, 5.2)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedSavedWeeklyInputs(authority);
      const review: WeeklyReview = {
        summary: "週次レビュー生成の保存処理を実装し、証跡と目標リンクを確認できた。",
        risks: ["レビュー失敗時の通知経路は後続ハンドラ実装で接続が必要"],
        next_actions: ["保存ボタンハンドラから週次レビュー生成を呼び出す"],
      };
      const llm = new FakeWeeklyReviewLlmClient({ ok: true, value: review });

      const result = await generateWeeklyReview(authority, makeDeps(), llm, {
        userId: "user-1",
        cycleId: "cycle-1",
        weekStartDate: "2026-06-08",
      });

      expect(result).toEqual({
        ok: true,
        reviewId: "review-1",
        review,
      });
      expect(llm.jsonRequests).toHaveLength(1);
      const request = llm.jsonRequests[0];
      expect(request?.system).toContain("週次レビュー");
      expect(request?.prompt).toContain("2026-06-08");
      expect(request?.prompt).toContain("AI 活用で開発効率を上げる");
      expect(request?.prompt).toContain("週次で AI 活用の改善実績を 3 件以上記録する");
      expect(request?.prompt).toContain("今週は週次レビュー生成の保存処理を実装した。");
      expect(request?.prompt).toContain("保存済み証跡から週次レビュープロンプトを作った");
      expect(request?.prompt).toContain("goalId: goal-1");
      expect(request?.prompt).toContain("relevanceScore: 0.91");
      expect(request?.prompt).toContain("AI 活用による開発効率改善の証跡になる");

      const rows = await listPersistence(authority);
      expect(rows.weeklyReviews).toEqual([
        {
          id: "review-1",
          cycle_id: "cycle-1",
          user_id: "user-1",
          week_start_date: "2026-06-08",
          summary: review.summary,
          risks: JSON.stringify(review.risks),
          next_actions: JSON.stringify(review.next_actions),
          created_at: "2026-06-14T12:00:00.000Z",
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("LLM invalid_output はレビュー失敗として返し、週次レビューを作らず既存の証跡を保持する (5.5)", async () => {
    const { db, authority } = setupAuthority();
    try {
      const seeded = await seedSavedWeeklyInputs(authority);
      const llm = new FakeWeeklyReviewLlmClient({
        ok: false,
        error: { kind: "invalid_output", message: "schema mismatch" },
      });

      const result = await generateWeeklyReview(authority, makeDeps(), llm, {
        userId: "user-1",
        cycleId: "cycle-1",
        weekStartDate: "2026-06-08",
      });

      expect(result).toEqual({
        ok: false,
        reason: "review_failed",
        errorKind: "invalid_output",
      });
      expect(await listPersistence(authority)).toEqual({
        checkins: [seeded.checkin],
        evidence: [seeded.evidence],
        evidenceGoalLinks: [seeded.link],
        weeklyReviews: [],
      });
    } finally {
      db.close();
    }
  });

  it("weekly_reviews insert 失敗時もレビュー失敗として返し、既存の証跡を保持する (5.2, 5.5)", async () => {
    const { db, authority } = setupAuthority();
    try {
      const seeded = await seedSavedWeeklyInputs(authority);
      const llm = new FakeWeeklyReviewLlmClient({
        ok: true,
        value: {
          summary: "週次レビュー生成までは成功した。",
          risks: [],
          next_actions: [],
        },
      });
      const failingAuthority: CycleDataAuthority = {
        ...authority,
        insertRow: async (entity, row) => {
          if (entity === "weekly_reviews") {
            throw new Error("injected weekly review insert failure");
          }
          await authority.insertRow(entity, row);
        },
      };

      const result = await generateWeeklyReview(failingAuthority, makeDeps(), llm, {
        userId: "user-1",
        cycleId: "cycle-1",
        weekStartDate: "2026-06-08",
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected review failure");
      expect(result.reason).toBe("review_failed");
      expect(await listPersistence(authority)).toEqual({
        checkins: [seeded.checkin],
        evidence: [seeded.evidence],
        evidenceGoalLinks: [seeded.link],
        weeklyReviews: [],
      });
    } finally {
      db.close();
    }
  });
});
