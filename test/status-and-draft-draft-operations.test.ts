// status-and-draft のドラフト生成・調整・保存ドメイン操作(task 5.3 / Req 5.1, 5.2, 5.4,
// 5.6, 5.7, 5.8, 6.1, 6.2, 6.3, 6.4, 6.6, 6.7, 7.1, 7.2, 7.4, 7.5, 8.1)。
//
// 完了条件: 生成→調整→保存の系列で、証跡不足/生成失敗/別人 pending が各々正しい結果を返し、
// 保存時に種別と所有者が付与され drafts に 1 行作られること。
//
// 設計の Service Interface(Agent メソッド)は理想形であり、確立した純粋関数パターンに従って
// (authority, deps, llm, store, ...) を注入する実シグネチャで検証する(Implementation Notes 1.1)。

import { describe, expect, it } from "vitest";
import {
  createPendingDraftStore,
  generateDraft,
  refineDraft,
  saveDraft,
} from "../src/status-and-draft/domain/draft-operations";
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
import type { DraftContent } from "../src/status-and-draft/draft/schema";
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

const NOW = "2026-06-14T12:00:00.000Z";

function makeDeps(now = NOW): DomainDeps {
  let counter = 0;
  return {
    newId: () => {
      counter += 1;
      return `id-${counter}`;
    },
    now: () => now,
  };
}

/** completeJson に対し、呼び出しごとに用意した結果を順番に返す決定的スタブ。 */
class FakeLlmClient implements LlmClient {
  public readonly jsonRequests: LlmCompletionRequest[] = [];
  private index = 0;

  constructor(private readonly results: LlmResult<DraftContent>[]) {}

  async complete(): Promise<LlmResult<string>> {
    return { ok: true, value: "" };
  }

  async completeJson(request: LlmCompletionRequest): Promise<LlmResult<DraftContent>> {
    this.jsonRequests.push(request);
    const result = this.results[this.index] ?? this.results[this.results.length - 1];
    this.index += 1;
    return result as LlmResult<DraftContent>;
  }
}

function draftContent(overrides: Partial<DraftContent> = {}): DraftContent {
  return {
    facts: "AI 支援で機能を実装した",
    interpretation: "目標の効率改善に直結した",
    issues: "計測データが不足している",
    nextActions: "来週は計測を記録する",
    speculativeNotes: ["レビュー時間は短縮した可能性がある"],
    ...overrides,
  };
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

describe("generateDraft", () => {
  it("目標対象で証跡を集約し揮発 pending を採番して保持する (5.1, 8.1)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      await seedGoal(authority);
      await seedEvidence(authority, { id: "ev-1" });
      await linkEvidence(authority, "link-1", "ev-1", "goal-1");
      const content = draftContent();
      const llm = new FakeLlmClient([{ ok: true, value: content }]);
      const store = createPendingDraftStore();

      const result = await generateDraft(authority, makeDeps(), llm, store, "user-1", {
        kind: "goal",
        goalId: "goal-1",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected generated draft");
      expect(result.content).toEqual(content);
      expect(store.drafts.size).toBe(1);
      const pending = store.drafts.get(result.draftPendingId);
      expect(pending).toBeDefined();
      expect(pending?.userId).toBe("user-1");
      expect(pending?.cycleId).toBe("cycle-1");
      expect(pending?.goalId).toBe("goal-1");
      expect(pending?.draftType).toBe("self_evaluation");
      expect(pending?.content).toEqual(content);
      // 目標名と証跡本文がプロンプトへ渡る公開契約。
      expect(llm.jsonRequests).toHaveLength(1);
      expect(llm.jsonRequests[0]?.prompt).toContain("AI 活用で開発効率を上げる");
      expect(llm.jsonRequests[0]?.prompt).toContain("AI 支援で機能を実装した");
    } finally {
      db.close();
    }
  });

  it("all 対象でサイクル全証跡を集約し goalId=null で保持する (5.2)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      await seedGoal(authority);
      await seedEvidence(authority, { id: "ev-1", body: "目標Aの実装" });
      await seedEvidence(authority, { id: "ev-2", body: "目標Bの調査", evidence_date: "2026-06-11" });
      const content = draftContent();
      const llm = new FakeLlmClient([{ ok: true, value: content }]);
      const store = createPendingDraftStore();

      const result = await generateDraft(authority, makeDeps(), llm, store, "user-1", {
        kind: "all",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected generated draft");
      const pending = store.drafts.get(result.draftPendingId);
      expect(pending?.goalId).toBeNull();
      expect(pending?.draftType).toBe("self_evaluation");
      // all は両方の証跡をプロンプトへ渡す。
      expect(llm.jsonRequests[0]?.prompt).toContain("目標Aの実装");
      expect(llm.jsonRequests[0]?.prompt).toContain("目標Bの調査");
    } finally {
      db.close();
    }
  });

  it("アクティブサイクルが無ければ not_found を返す (5.6, 8.1)", async () => {
    const { db, authority } = setupAuthority();
    try {
      const llm = new FakeLlmClient([{ ok: true, value: draftContent() }]);
      const store = createPendingDraftStore();

      expect(
        await generateDraft(authority, makeDeps(), llm, store, "user-1", { kind: "all" }),
      ).toEqual({ ok: false, reason: "not_found" });
      expect(store.drafts.size).toBe(0);
      expect(llm.jsonRequests).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("非所有/不存在目標は not_found に正規化し LLM を呼ばない (5.6, 8.1)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      await seedGoal(authority, { id: "goal-other", user_id: "user-2" });
      const llm = new FakeLlmClient([{ ok: true, value: draftContent() }]);
      const store = createPendingDraftStore();

      expect(
        await generateDraft(authority, makeDeps(), llm, store, "user-1", {
          kind: "goal",
          goalId: "goal-other",
        }),
      ).toEqual({ ok: false, reason: "not_found" });
      expect(
        await generateDraft(authority, makeDeps(), llm, store, "user-1", {
          kind: "goal",
          goalId: "missing",
        }),
      ).toEqual({ ok: false, reason: "not_found" });
      expect(store.drafts.size).toBe(0);
      expect(llm.jsonRequests).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("対象証跡が無ければ no_evidence を返し LLM を呼ばない (5.7)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      await seedGoal(authority);
      const llm = new FakeLlmClient([{ ok: true, value: draftContent() }]);
      const store = createPendingDraftStore();

      expect(
        await generateDraft(authority, makeDeps(), llm, store, "user-1", {
          kind: "goal",
          goalId: "goal-1",
        }),
      ).toEqual({ ok: false, reason: "no_evidence" });
      expect(
        await generateDraft(authority, makeDeps(), llm, store, "user-1", { kind: "all" }),
      ).toEqual({ ok: false, reason: "no_evidence" });
      expect(store.drafts.size).toBe(0);
      expect(llm.jsonRequests).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("LLM 生成失敗時は pending を作らず generation_failed を返す (5.8)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      await seedGoal(authority);
      await seedEvidence(authority, { id: "ev-1" });
      await linkEvidence(authority, "link-1", "ev-1", "goal-1");
      const llm = new FakeLlmClient([
        { ok: false, error: { kind: "invalid_output", message: "schema mismatch" } },
      ]);
      const store = createPendingDraftStore();

      expect(
        await generateDraft(authority, makeDeps(), llm, store, "user-1", {
          kind: "goal",
          goalId: "goal-1",
        }),
      ).toEqual({ ok: false, reason: "generation_failed" });
      expect(store.drafts.size).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("refineDraft", () => {
  async function setupWithPending(): Promise<{
    db: NodeSqliteBackend;
    authority: CycleDataAuthority;
    store: ReturnType<typeof createPendingDraftStore>;
    draftPendingId: string;
    initialContent: DraftContent;
  }> {
    const { db, authority } = setupAuthority();
    await seedCycle(authority);
    await seedGoal(authority);
    await seedEvidence(authority, { id: "ev-1" });
    await linkEvidence(authority, "link-1", "ev-1", "goal-1");
    const initialContent = draftContent();
    const store = createPendingDraftStore();
    const genLlm = new FakeLlmClient([{ ok: true, value: initialContent }]);
    const gen = await generateDraft(authority, makeDeps(), genLlm, store, "user-1", {
      kind: "goal",
      goalId: "goal-1",
    });
    if (!gen.ok) throw new Error("setup: expected generated draft");
    return { db, authority, store, draftPendingId: gen.draftPendingId, initialContent };
  }

  it("manager 調整は内容を更新し draftType を manager_summary にする (6.4, 6.5)", async () => {
    const { db, authority, store, draftPendingId } = await setupWithPending();
    try {
      const refined = draftContent({ facts: "(上司向け)成果を客観的に記述" });
      const llm = new FakeLlmClient([{ ok: true, value: refined }]);

      const result = await refineDraft(authority, makeDeps(), llm, store, "user-1", draftPendingId, "manager");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected refined draft");
      expect(result.content).toEqual(refined);
      const pending = store.drafts.get(draftPendingId);
      expect(pending?.content).toEqual(refined);
      expect(pending?.draftType).toBe("manager_summary");
    } finally {
      db.close();
    }
  });

  it("shorten 調整は draftType を short_summary にする (6.1)", async () => {
    const { db, authority, store, draftPendingId } = await setupWithPending();
    try {
      const refined = draftContent({ facts: "短縮版" });
      const llm = new FakeLlmClient([{ ok: true, value: refined }]);

      const result = await refineDraft(authority, makeDeps(), llm, store, "user-1", draftPendingId, "shorten");

      expect(result.ok).toBe(true);
      expect(store.drafts.get(draftPendingId)?.draftType).toBe("short_summary");
    } finally {
      db.close();
    }
  });

  it("別 userId / 不存在 pending の調整は not_found に正規化する (6.6, 8.1)", async () => {
    const { db, authority, store, draftPendingId } = await setupWithPending();
    try {
      const llm = new FakeLlmClient([{ ok: true, value: draftContent() }]);

      expect(
        await refineDraft(authority, makeDeps(), llm, store, "user-2", draftPendingId, "shorten"),
      ).toEqual({ ok: false, reason: "not_found" });
      expect(
        await refineDraft(authority, makeDeps(), llm, store, "user-1", "missing", "shorten"),
      ).toEqual({ ok: false, reason: "not_found" });
      // 別人操作では LLM を呼ばない。
      expect(llm.jsonRequests).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("調整の LLM 失敗時は直前 pending を保持し refine_failed を返す (6.7)", async () => {
    const { db, authority, store, draftPendingId, initialContent } = await setupWithPending();
    try {
      const llm = new FakeLlmClient([
        { ok: false, error: { kind: "provider_error", message: "down" } },
      ]);

      const result = await refineDraft(authority, makeDeps(), llm, store, "user-1", draftPendingId, "strengthen");

      expect(result).toEqual({ ok: false, reason: "refine_failed" });
      // 直前 pending は変更されない。
      const pending = store.drafts.get(draftPendingId);
      expect(pending?.content).toEqual(initialContent);
      expect(pending?.draftType).toBe("self_evaluation");
    } finally {
      db.close();
    }
  });
});

describe("saveDraft", () => {
  async function setupWithPending(target: { kind: "goal"; goalId: string } | { kind: "all" }): Promise<{
    db: NodeSqliteBackend;
    authority: CycleDataAuthority;
    store: ReturnType<typeof createPendingDraftStore>;
    deps: DomainDeps;
    draftPendingId: string;
    content: DraftContent;
  }> {
    const { db, authority } = setupAuthority();
    await seedCycle(authority);
    await seedGoal(authority);
    await seedEvidence(authority, { id: "ev-1" });
    await linkEvidence(authority, "link-1", "ev-1", "goal-1");
    const content = draftContent();
    const store = createPendingDraftStore();
    const deps = makeDeps();
    const genLlm = new FakeLlmClient([{ ok: true, value: content }]);
    const gen = await generateDraft(authority, deps, genLlm, store, "user-1", target);
    if (!gen.ok) throw new Error("setup: expected generated draft");
    return { db, authority, store, deps, draftPendingId: gen.draftPendingId, content };
  }

  it("所有者保存で種別・所有者・本文付きの drafts 行を 1 行作る (7.1, 7.2, 7.5, 8.1)", async () => {
    const { db, authority, store, deps, draftPendingId, content } = await setupWithPending({
      kind: "goal",
      goalId: "goal-1",
    });
    try {
      const result = await saveDraft(authority, deps, store, "user-1", draftPendingId);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected saved draft");
      expect(result.draft.user_id).toBe("user-1");
      expect(result.draft.cycle_id).toBe("cycle-1");
      expect(result.draft.goal_id).toBe("goal-1");
      expect(result.draft.type).toBe("self_evaluation");
      // 本文に §13.3 のセクションと推測注記が含まれる。
      expect(result.draft.body).toContain(content.facts);
      expect(result.draft.body).toContain(content.nextActions);
      expect(result.draft.body).toContain(content.speculativeNotes[0] as string);

      const rows = await authority.listRowsBy("drafts", { user_id: "user-1" });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(result.draft.id);
    } finally {
      db.close();
    }
  });

  it("all ドラフトの保存は goal_id を null にする (7.1)", async () => {
    const { db, authority, store, deps, draftPendingId } = await setupWithPending({ kind: "all" });
    try {
      const result = await saveDraft(authority, deps, store, "user-1", draftPendingId);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected saved draft");
      expect(result.draft.goal_id).toBeNull();
    } finally {
      db.close();
    }
  });

  it("別 userId / 不存在 pending の保存は not_found で行を作らない (7.4, 8.1)", async () => {
    const { db, authority, store, deps, draftPendingId } = await setupWithPending({
      kind: "goal",
      goalId: "goal-1",
    });
    try {
      expect(await saveDraft(authority, deps, store, "user-2", draftPendingId)).toEqual({
        ok: false,
        reason: "not_found",
      });
      expect(await saveDraft(authority, deps, store, "user-1", "missing")).toEqual({
        ok: false,
        reason: "not_found",
      });
      const rows = await authority.listRowsBy("drafts", {});
      expect(rows).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

describe("生成→調整→保存の系列 (結合)", () => {
  it("生成後に上司向け調整して保存すると manager_summary の drafts 行になる", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      await seedGoal(authority);
      await seedEvidence(authority, { id: "ev-1" });
      await linkEvidence(authority, "link-1", "ev-1", "goal-1");
      const deps = makeDeps();
      const store = createPendingDraftStore();

      const initial = draftContent();
      const refined = draftContent({ facts: "上司向けに調整した成果" });
      const llm = new FakeLlmClient([
        { ok: true, value: initial },
        { ok: true, value: refined },
      ]);

      const gen = await generateDraft(authority, deps, llm, store, "user-1", {
        kind: "goal",
        goalId: "goal-1",
      });
      expect(gen.ok).toBe(true);
      if (!gen.ok) throw new Error("expected generate");

      const refine = await refineDraft(
        authority,
        deps,
        llm,
        store,
        "user-1",
        gen.draftPendingId,
        "manager",
      );
      expect(refine.ok).toBe(true);

      const save = await saveDraft(authority, deps, store, "user-1", gen.draftPendingId);
      expect(save.ok).toBe(true);
      if (!save.ok) throw new Error("expected save");
      expect(save.draft.type).toBe("manager_summary");
      expect(save.draft.body).toContain("上司向けに調整した成果");

      const rows = await authority.listRowsBy("drafts", { user_id: "user-1" });
      expect(rows).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
