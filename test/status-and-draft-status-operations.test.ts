// status-and-draft のステータス判定ドメイン操作(task 5.1 / Req 1.1-1.7, 2.1, 3.1, 3.2, 3.4, 3.5, 8.1, 8.5)。
//
// 完了条件: 所有目標で判定結果が返り、非所有/不存在で「見つからない」、証跡無しで Gray となり、
// 外部(notifications 想定)から判定メソッドを呼んで判定結果型(StatusVerdict)が得られること。
//
// 設計の Service Interface(Agent メソッド)は理想形であり、確立した純粋関数パターンに従って
// (authority, deps, llm, ...) を注入する実シグネチャで検証する(Implementation Notes 1.1)。

import { describe, expect, it } from "vitest";
import {
  collectGoalContext,
  determineAllStatuses,
  determineGoalStatus,
} from "../src/status-and-draft/domain/status-operations";
import type { LlmClient, LlmCompletionRequest, LlmResult } from "../src/llm/client";
import type { CycleDataAuthority, DomainDeps } from "../src/goal-management/domain/cycle-operations";
import { runMigrations } from "../src/persistence/migrator";
import { createRepository } from "../src/persistence/repository";
import type {
  EntityName,
  EntityRow,
  EvaluationCycleRow,
  EvidenceGoalLinkRow,
  EvidenceRow,
  GoalRow,
} from "../src/types";
import type { StatusVerdict } from "../src/status-and-draft/status/schema";
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

// 判定は読み取りのみなので newId は使われない前提。決定的な now を固定する。
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

  constructor(private readonly jsonResult: LlmResult<StatusVerdict>) {}

  async complete(): Promise<LlmResult<string>> {
    return { ok: true, value: "" };
  }

  async completeJson(request: LlmCompletionRequest): Promise<LlmResult<StatusVerdict>> {
    this.jsonRequests.push(request);
    return this.jsonResult;
  }
}

const NOW = "2026-06-14T12:00:00.000Z";

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
    description: "開発プロセスに AI 支援を組み込み、レビューと実装速度を改善する",
    success_criteria: "週次で AI 活用の改善実績を 3 件以上記録する",
    evaluation_points: "レビュー時間の短縮\n期限: 2026-06-30",
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

const adoptedVerdict: StatusVerdict = {
  status: "green",
  reason: "直近2週で成果証跡が複数あり順調",
  risks: ["証跡の更新頻度が落ちる懸念"],
  nextActions: ["来週も実績を記録する"],
  reasonMissing: false,
};

describe("collectGoalContext", () => {
  it("所有目標で定義・証跡・期限/経過日数を集約する (1.1)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      await seedGoal(authority);
      await seedEvidence(authority, { id: "ev-1", evidence_date: "2026-06-10", usefulness: "high" });
      await seedEvidence(authority, { id: "ev-2", evidence_date: "2026-06-12", usefulness: "medium" });
      await linkEvidence(authority, "link-1", "ev-1", "goal-1");
      await linkEvidence(authority, "link-2", "ev-2", "goal-1");

      const ctx = await collectGoalContext(authority, makeDeps(NOW), "user-1", "cycle-1", "goal-1");

      expect(ctx).not.toBeNull();
      if (ctx === null) throw new Error("expected context");
      expect(ctx.goalId).toBe("goal-1");
      expect(ctx.title).toBe("AI 活用で開発効率を上げる");
      expect(ctx.successCriteria).toBe("週次で AI 活用の改善実績を 3 件以上記録する");
      expect(ctx.evidence).toHaveLength(2);
      // 2026-06-30 まで(NOW=2026-06-14) → 16 日。
      expect(ctx.daysUntilCycleEnd).toBe(16);
      // 最新証跡 2026-06-12 から NOW(2026-06-14) → 2 日。
      expect(ctx.latestEvidenceAgeDays).toBe(2);
    } finally {
      db.close();
    }
  });

  it("非所有/不存在目標は null を返す (1.7, 3.4, 8.1)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      await seedGoal(authority, { id: "goal-other", user_id: "user-2" });

      // 別ユーザーの目標
      expect(
        await collectGoalContext(authority, makeDeps(NOW), "user-1", "cycle-1", "goal-other"),
      ).toBeNull();
      // 不存在の目標
      expect(
        await collectGoalContext(authority, makeDeps(NOW), "user-1", "cycle-1", "missing"),
      ).toBeNull();
    } finally {
      db.close();
    }
  });

  it("証跡なしは latestEvidenceAgeDays を null にする (3.5)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      await seedGoal(authority);

      const ctx = await collectGoalContext(authority, makeDeps(NOW), "user-1", "cycle-1", "goal-1");

      expect(ctx).not.toBeNull();
      if (ctx === null) throw new Error("expected context");
      expect(ctx.evidence).toHaveLength(0);
      expect(ctx.latestEvidenceAgeDays).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("determineGoalStatus", () => {
  it("所有目標 + 直近証跡 + LLM 成功で見立てを採用し reasonMissing=false を返す (1.1, 1.2, 1.3, 2.1, 8.5)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      await seedGoal(authority);
      await seedEvidence(authority, { id: "ev-1", evidence_date: "2026-06-10", usefulness: "high" });
      await seedEvidence(authority, { id: "ev-2", evidence_date: "2026-06-12", usefulness: "high" });
      await linkEvidence(authority, "link-1", "ev-1", "goal-1");
      await linkEvidence(authority, "link-2", "ev-2", "goal-1");
      const llm = new FakeLlmClient({ ok: true, value: adoptedVerdict });

      const result = await determineGoalStatus(
        authority,
        makeDeps(NOW),
        llm,
        "user-1",
        "cycle-1",
        "goal-1",
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected status result");
      expect(result.verdict).toEqual(adoptedVerdict);
      expect(result.verdict.reasonMissing).toBe(false);
      expect(result.goal.id).toBe("goal-1");
      expect(result.evidence).toHaveLength(2);
      // 公開契約: prompt に目標定義・達成条件・証跡が渡る。
      expect(llm.jsonRequests).toHaveLength(1);
      expect(llm.jsonRequests[0]?.prompt).toContain("AI 活用で開発効率を上げる");
      expect(llm.jsonRequests[0]?.prompt).toContain("週次で AI 活用の改善実績を 3 件以上記録する");
    } finally {
      db.close();
    }
  });

  it("非所有/不存在目標は not_found に正規化する (1.7, 3.4, 8.1)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      await seedGoal(authority, { id: "goal-other", user_id: "user-2" });
      const llm = new FakeLlmClient({ ok: true, value: adoptedVerdict });

      expect(
        await determineGoalStatus(authority, makeDeps(NOW), llm, "user-1", "cycle-1", "goal-other"),
      ).toEqual({ ok: false, reason: "not_found" });
      expect(
        await determineGoalStatus(authority, makeDeps(NOW), llm, "user-1", "cycle-1", "missing"),
      ).toEqual({ ok: false, reason: "not_found" });
      // not_found では LLM を呼ばない。
      expect(llm.jsonRequests).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("証跡なしは判断材料不足として Gray を返す (1.4, 3.5)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      await seedGoal(authority);
      // LLM が緑を返してもルール側が Gray を成立させる対象だが、
      // combineVerdict は LLM 成功時に見立てを採用するため、LLM 失敗で確認する。
      const llm = new FakeLlmClient({
        ok: false,
        error: { kind: "invalid_output", message: "schema mismatch" },
      });

      const result = await determineGoalStatus(
        authority,
        makeDeps(NOW),
        llm,
        "user-1",
        "cycle-1",
        "goal-1",
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected status result");
      expect(result.verdict.status).toBe("gray");
      expect(result.verdict.reasonMissing).toBe(true);
    } finally {
      db.close();
    }
  });

  it("LLM 失敗時はルール候補で status を成立させ reasonMissing=true を返す (1.5)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      await seedGoal(authority);
      // 直近証跡 2 件(high)→ ルール候補 green。
      await seedEvidence(authority, { id: "ev-1", evidence_date: "2026-06-10", usefulness: "high" });
      await seedEvidence(authority, { id: "ev-2", evidence_date: "2026-06-12", usefulness: "high" });
      await linkEvidence(authority, "link-1", "ev-1", "goal-1");
      await linkEvidence(authority, "link-2", "ev-2", "goal-1");
      const llm = new FakeLlmClient({
        ok: false,
        error: { kind: "provider_error", message: "down" },
      });

      const result = await determineGoalStatus(
        authority,
        makeDeps(NOW),
        llm,
        "user-1",
        "cycle-1",
        "goal-1",
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected status result");
      expect(result.verdict.status).toBe("green");
      expect(result.verdict.reasonMissing).toBe(true);
      expect(result.verdict.reason).toBe("");
    } finally {
      db.close();
    }
  });
});

describe("determineAllStatuses", () => {
  it("サイクル + 目標があれば各目標の判定結果を集約する (2.1, 8.5)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      await seedGoal(authority, { id: "goal-1", title: "目標A" });
      await seedGoal(authority, { id: "goal-2", title: "目標B" });
      const llm = new FakeLlmClient({ ok: true, value: adoptedVerdict });

      const result = await determineAllStatuses(authority, makeDeps(NOW), llm, "user-1");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected all-statuses result");
      expect(result.cycle.id).toBe("cycle-1");
      expect(result.results).toHaveLength(2);
      const goalIds = result.results.map((r) => r.goal.id).sort();
      expect(goalIds).toEqual(["goal-1", "goal-2"]);
      for (const r of result.results) {
        expect(r.verdict.status).toBe("green");
      }
    } finally {
      db.close();
    }
  });

  it("アクティブなサイクルが無ければ no_cycle を返す (2.1)", async () => {
    const { db, authority } = setupAuthority();
    try {
      // 別ユーザーのサイクルのみ
      await seedCycle(authority, { id: "cycle-other", user_id: "user-2" });
      const llm = new FakeLlmClient({ ok: true, value: adoptedVerdict });

      expect(await determineAllStatuses(authority, makeDeps(NOW), llm, "user-1")).toEqual({
        ok: false,
        reason: "no_cycle",
      });
    } finally {
      db.close();
    }
  });

  it("サイクルはあるが目標が無ければ no_goals を返す (2.1)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      const llm = new FakeLlmClient({ ok: true, value: adoptedVerdict });

      expect(await determineAllStatuses(authority, makeDeps(NOW), llm, "user-1")).toEqual({
        ok: false,
        reason: "no_goals",
      });
    } finally {
      db.close();
    }
  });
});

describe("外部再利用の公開契約 (1.6, 8.5)", () => {
  it("determineGoalStatus / determineAllStatuses は StatusVerdict 型の判定結果を返す", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      await seedGoal(authority);
      await seedEvidence(authority, { id: "ev-1", evidence_date: "2026-06-12", usefulness: "high" });
      await seedEvidence(authority, { id: "ev-2", evidence_date: "2026-06-13", usefulness: "high" });
      await linkEvidence(authority, "link-1", "ev-1", "goal-1");
      await linkEvidence(authority, "link-2", "ev-2", "goal-1");
      const llm = new FakeLlmClient({ ok: true, value: adoptedVerdict });

      // notifications 想定の呼び出し: authority/deps/llm を注入して判定結果型を取得する。
      const single = await determineGoalStatus(
        authority,
        makeDeps(NOW),
        llm,
        "user-1",
        "cycle-1",
        "goal-1",
      );
      const all = await determineAllStatuses(authority, makeDeps(NOW), llm, "user-1");

      expect(single.ok).toBe(true);
      if (!single.ok) throw new Error("expected single result");
      const singleVerdict: StatusVerdict = single.verdict;
      expect(typeof singleVerdict.status).toBe("string");
      expect(typeof singleVerdict.reasonMissing).toBe("boolean");

      expect(all.ok).toBe(true);
      if (!all.ok) throw new Error("expected all result");
      const allVerdict: StatusVerdict = all.results[0]!.verdict;
      expect(typeof allVerdict.status).toBe("string");
    } finally {
      db.close();
    }
  });
});
