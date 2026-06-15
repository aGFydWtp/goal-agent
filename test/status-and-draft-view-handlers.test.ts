// 閲覧コマンドハンドラ(status-and-draft task 6.1 / Req 2.1-2.6, 3.1, 3.3-3.6, 4.1, 4.3, 4.4, 8.2)
// の結合テスト。
//
// 完了条件: 3 コマンドが署名済み interaction から各 §8 応答を返し、deferred 経路で type5 即返後に
// follow-up される。
//
// 方針: DO を立てず、本物の SQLite(node:sqlite + repository)を裏に持つ in-memory な
// CycleDataAuthority を `routing` モックで注入し、LLM は `llm/factory` モックで FakeLlmClient を
// 注入する。これにより実ドメインロジック(determineAllStatuses / determineGoalStatus /
// listEvidenceWithLinks)がハンドラ越しに end-to-end で走る。deferred ハンドラは
// `result.run(fakeFollowup)` を呼んで editOriginal に渡る §8 形状を検証する。
//
// 実行環境: vitest projects の "node" プロジェクト(test/*.test.ts は自動収集)。

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DiscordEnv } from "../src/discord/env";
import type { Followup, InteractionContext, SendResult } from "../src/discord/types";
import type {
  CycleDataAuthority,
  DomainDeps,
} from "../src/goal-management/domain/cycle-operations";
import type { LlmClient, LlmCompletionRequest, LlmResult } from "../src/llm/client";
import { runMigrations } from "../src/persistence/migrator";
import { createRepository } from "../src/persistence/repository";
import type { StatusVerdict } from "../src/status-and-draft/status/schema";
import {
  EVIDENCE_LIST_SUBCOMMAND,
  GOAL_STATUS_OPT_GOAL,
  GOAL_STATUS_SUBCOMMAND,
  STATUS_COMMAND_NAME,
} from "../src/status-and-draft/commands";
import type {
  EntityName,
  EntityRow,
  EvaluationCycleRow,
  EvidenceGoalLinkRow,
  EvidenceRow,
  GoalRow,
} from "../src/types";
import { NodeSqliteBackend } from "./helpers/node-sqlite-adapter";

// ── モック: routing(authority 注入)と llm/factory(LLM 注入)──
// SUT は handler 内部で getUserCycleAuthority(env,userId) / createLlmClient(env) を呼ぶため、
// モックで in-memory authority と FakeLlmClient を返し、DO/Workers AI を起動しない。

const getUserCycleAuthorityMock =
  vi.fn<(env: DiscordEnv, userId: string) => Promise<CycleDataAuthority>>();
vi.mock("../src/goal-management/routing", () => ({
  PRIMARY_CYCLE_KEY: "primary",
  getUserCycleAuthority: (env: DiscordEnv, userId: string) =>
    getUserCycleAuthorityMock(env, userId),
}));

const createLlmClientMock = vi.fn<(env: DiscordEnv) => LlmClient>();
vi.mock("../src/llm/factory", () => ({
  createLlmClient: (env: DiscordEnv) => createLlmClientMock(env),
}));

// モック設定後に SUT を import する。
const { statusCommandHandler } = await import(
  "../src/status-and-draft/handlers/status-command"
);
const { goalStatusCommandHandler } = await import(
  "../src/status-and-draft/handlers/goal-status-command"
);
const { evidenceListCommandHandler } = await import(
  "../src/status-and-draft/handlers/evidence-list-command"
);

const env = {} as DiscordEnv;

// ── テスト用ヘルパ ──

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

const adoptedVerdict: StatusVerdict = {
  status: "green",
  reason: "直近2週で成果証跡が複数あり順調",
  risks: ["証跡の更新頻度が落ちる懸念"],
  nextActions: ["来週も実績を記録する"],
  reasonMissing: false,
};

/** editOriginal に渡された (content, opts) を記録する Followup スパイ。 */
function makeFollowup(): {
  followup: Followup;
  editCalls: Array<{ content: string }>;
} {
  const editCalls: Array<{ content: string }> = [];
  const ok: SendResult = { ok: true };
  const followup: Followup = {
    editOriginal: async (content: string) => {
      editCalls.push({ content });
      return ok;
    },
    send: async () => ok,
  };
  return { followup, editCalls };
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

// command の type 値(数値リテラル)。
const SUBCOMMAND = 1;
const STRING = 3;

/** `/status`(オプションなし)の command InteractionContext。 */
function statusCtx(userId = "user-1"): InteractionContext {
  return {
    kind: "command",
    name: STATUS_COMMAND_NAME,
    userId,
    channelId: "chan-1",
    isDm: false,
    interactionId: "int-status",
    token: "tok-status",
    raw: { data: { name: STATUS_COMMAND_NAME } } as unknown as InteractionContext["raw"],
  };
}

/** `/goal status`(goal オプション)の command InteractionContext。goalId 未指定なら null。 */
function goalStatusCtx(goalId: string | null, userId = "user-1"): InteractionContext {
  const subOptions =
    goalId === null
      ? []
      : [{ name: GOAL_STATUS_OPT_GOAL, type: STRING, value: goalId }];
  return {
    kind: "command",
    name: "goal",
    userId,
    channelId: "chan-1",
    isDm: false,
    interactionId: "int-goal-status",
    token: "tok-goal-status",
    raw: {
      data: {
        name: "goal",
        options: [
          { name: GOAL_STATUS_SUBCOMMAND, type: SUBCOMMAND, options: subOptions },
        ],
      },
    } as unknown as InteractionContext["raw"],
  };
}

/** `/evidence list`(オプションなし)の command InteractionContext。 */
function evidenceListCtx(userId = "user-1"): InteractionContext {
  return {
    kind: "command",
    name: "evidence",
    userId,
    channelId: "chan-1",
    isDm: false,
    interactionId: "int-ev-list",
    token: "tok-ev-list",
    raw: {
      data: {
        name: "evidence",
        options: [{ name: EVIDENCE_LIST_SUBCOMMAND, type: SUBCOMMAND, options: [] }],
      },
    } as unknown as InteractionContext["raw"],
  };
}

beforeEach(() => {
  getUserCycleAuthorityMock.mockReset();
  createLlmClientMock.mockReset();
});

describe("statusCommandHandler: /status", () => {
  it("アクティブサイクル無しで案内を ephemeral 即時応答する (2.4, 2.6)", async () => {
    const { db, authority } = setupAuthority();
    try {
      // 別ユーザーのサイクルのみ → user-1 はサイクル無し。
      await seedCycle(authority, { id: "cycle-other", user_id: "user-2" });
      getUserCycleAuthorityMock.mockResolvedValue(authority);
      createLlmClientMock.mockReturnValue(
        new FakeLlmClient({ ok: true, value: adoptedVerdict }),
      );

      const result = await statusCommandHandler.handle(statusCtx("user-1"), env);

      expect(result.mode).toBe("reply");
      if (result.mode !== "reply") throw new Error("expected reply");
      expect(result.ephemeral).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("目標未登録で案内を ephemeral 即時応答する (2.5, 2.6)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      getUserCycleAuthorityMock.mockResolvedValue(authority);
      createLlmClientMock.mockReturnValue(
        new FakeLlmClient({ ok: true, value: adoptedVerdict }),
      );

      const result = await statusCommandHandler.handle(statusCtx("user-1"), env);

      expect(result.mode).toBe("reply");
      if (result.mode !== "reply") throw new Error("expected reply");
      expect(result.ephemeral).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("目標ありで deferred(type5)→ §8.4 を follow-up する (2.1, 2.2, 2.3, 2.6)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      await seedGoal(authority, { id: "goal-1", title: "目標A" });
      await seedGoal(authority, { id: "goal-2", title: "目標B" });
      getUserCycleAuthorityMock.mockResolvedValue(authority);
      createLlmClientMock.mockReturnValue(
        new FakeLlmClient({ ok: true, value: adoptedVerdict }),
      );

      const result = await statusCommandHandler.handle(statusCtx("user-1"), env);

      expect(result.mode).toBe("deferred");
      if (result.mode !== "deferred") throw new Error("expected deferred");
      expect(result.ephemeral).toBe(true);

      const { followup, editCalls } = makeFollowup();
      await result.run(followup);

      expect(editCalls).toHaveLength(1);
      const content = editCalls[0]!.content;
      // §8.4 のラベルと目標名・今週やるとよいことが含まれる。
      expect(content).toContain("評価目標ステータス");
      expect(content).toContain("目標A");
      expect(content).toContain("目標B");
      expect(content).toContain("今週やるとよいこと");
    } finally {
      db.close();
    }
  });
});

describe("goalStatusCommandHandler: /goal status", () => {
  it("goalId 未指定で案内を ephemeral 即時応答する (3.6)", async () => {
    getUserCycleAuthorityMock.mockResolvedValue(setupAuthority().authority);
    createLlmClientMock.mockReturnValue(new FakeLlmClient({ ok: true, value: adoptedVerdict }));

    const result = await goalStatusCommandHandler.handle(goalStatusCtx(null, "user-1"), env);

    expect(result.mode).toBe("reply");
    if (result.mode !== "reply") throw new Error("expected reply");
    expect(result.ephemeral).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
  });

  it("非所有/不存在目標は deferred → 見つからない follow-up に正規化する (3.4)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      await seedGoal(authority, { id: "goal-other", user_id: "user-2" });
      getUserCycleAuthorityMock.mockResolvedValue(authority);
      createLlmClientMock.mockReturnValue(
        new FakeLlmClient({ ok: true, value: adoptedVerdict }),
      );

      const result = await goalStatusCommandHandler.handle(
        goalStatusCtx("goal-other", "user-1"),
        env,
      );

      expect(result.mode).toBe("deferred");
      if (result.mode !== "deferred") throw new Error("expected deferred");

      const { followup, editCalls } = makeFollowup();
      await result.run(followup);

      expect(editCalls).toHaveLength(1);
      expect(editCalls[0]!.content).toContain("見つかりません");
      // §8.5 の状態行は含まない(データを露出しない)。
      expect(editCalls[0]!.content).not.toContain("状態:");
    } finally {
      db.close();
    }
  });

  it("所有目標で deferred → §8.5(証跡/不足/次アクション)を follow-up する (3.1, 3.3, 3.5, 3.6)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      await seedGoal(authority, { id: "goal-1", title: "目標X" });
      await seedEvidence(authority, {
        id: "ev-1",
        evidence_date: "2026-06-12",
        body: "AI レビュー導入を実施",
        usefulness: "high",
      });
      await linkEvidence(authority, "link-1", "ev-1", "goal-1");
      getUserCycleAuthorityMock.mockResolvedValue(authority);
      createLlmClientMock.mockReturnValue(
        new FakeLlmClient({ ok: true, value: adoptedVerdict }),
      );

      const result = await goalStatusCommandHandler.handle(
        goalStatusCtx("goal-1", "user-1"),
        env,
      );

      expect(result.mode).toBe("deferred");
      if (result.mode !== "deferred") throw new Error("expected deferred");
      expect(result.ephemeral).toBe(true);

      const { followup, editCalls } = makeFollowup();
      await result.run(followup);

      expect(editCalls).toHaveLength(1);
      const content = editCalls[0]!.content;
      expect(content).toContain("目標X");
      expect(content).toContain("Agent の見立て:");
      expect(content).toContain("保存済み証跡:");
      expect(content).toContain("AI レビュー導入を実施");
      expect(content).toContain("不足:");
      expect(content).toContain("次アクション:");
    } finally {
      db.close();
    }
  });
});

describe("evidenceListCommandHandler: /evidence list", () => {
  it("証跡無しで未保存案内を ephemeral 即時応答する (4.3, 4.4)", async () => {
    const { db, authority } = setupAuthority();
    try {
      getUserCycleAuthorityMock.mockResolvedValue(authority);

      const result = await evidenceListCommandHandler.handle(evidenceListCtx("user-1"), env);

      expect(result.mode).toBe("reply");
      if (result.mode !== "reply") throw new Error("expected reply");
      expect(result.ephemeral).toBe(true);
      expect(result.content).toContain("保存済み証跡");
      expect(result.content).toContain("未保存");
    } finally {
      db.close();
    }
  });

  it("証跡ありで §8.6(目標名付き)を ephemeral 即時応答する (4.1, 4.4)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      await seedGoal(authority, { id: "goal-1", title: "目標Z" });
      await seedEvidence(authority, {
        id: "ev-1",
        evidence_date: "2026-06-12",
        body: "AI レビュー導入を実施",
        usefulness: "high",
      });
      await linkEvidence(authority, "link-1", "ev-1", "goal-1");
      getUserCycleAuthorityMock.mockResolvedValue(authority);

      const result = await evidenceListCommandHandler.handle(evidenceListCtx("user-1"), env);

      expect(result.mode).toBe("reply");
      if (result.mode !== "reply") throw new Error("expected reply");
      expect(result.ephemeral).toBe(true);
      expect(result.content).toContain("保存済み証跡");
      expect(result.content).toContain("AI レビュー導入を実施");
      expect(result.content).toContain("目標Z");
    } finally {
      db.close();
    }
  });

  it("実行ユーザーの userId で authority を解決する (4.4)", async () => {
    const { db, authority } = setupAuthority();
    try {
      getUserCycleAuthorityMock.mockResolvedValue(authority);

      await evidenceListCommandHandler.handle(evidenceListCtx("user-9"), env);

      expect(getUserCycleAuthorityMock).toHaveBeenCalledWith(env, "user-9");
    } finally {
      db.close();
    }
  });
});
