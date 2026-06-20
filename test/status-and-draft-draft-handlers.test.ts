// ドラフトコマンド・調整ボタン・保存ボタンハンドラ(status-and-draft task 6.2 /
// Req 5.3, 5.5, 5.6, 5.7, 5.8, 5.9, 6.5, 6.6, 6.7, 7.3, 7.4, 8.2)の結合テスト。
//
// 完了条件: 生成→調整→保存のボタン系列が custom_id の draftPendingId/kind を解釈してドメイン
// メソッドを呼び、各応答(§8.7 ドラフト + 5 ボタン再提示・保存通知・各種失敗案内)が返り、
// pending が揮発 KV を跨いで共有される。
//
// 方針: DO 境界(agents/routing)を fake stub(per-user real SQLite repo + 揮発 Map)へ
// 差し替え、routing/domain/custom-ids は real。LLM は llm/factory モックで差し替え、生成/調整
// の成否を切り替える。pending は生成ハンドラ自身が揮発 KV へ投入し、後続の調整/保存が引く。
// 実行環境: vitest "node"。

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DiscordEnv } from "../src/discord/env";
import type { Followup, InteractionContext, SendResult } from "../src/discord/types";
import type { LlmClient, LlmCompletionRequest, LlmResult } from "../src/llm/client";
import { runMigrations } from "../src/persistence/migrator";
import { createRepository, type Repository } from "../src/persistence/repository";
import type { DraftContent } from "../src/status-and-draft/draft/schema";
import type { EvaluationCycleRow, EvidenceGoalLinkRow, EvidenceRow, GoalRow } from "../src/types";
import { NodeSqliteBackend } from "./helpers/node-sqlite-adapter";

// ── per-user fake DO(real SQLite repo + 揮発 KV)──
interface FakeDo {
  repo: Repository;
  ephemeral: Map<string, string>;
  // biome-ignore lint/suspicious/noExplicitAny: RPC スタブ互換の最小サーフェス
  stub: any;
}
const dos = new Map<string, FakeDo>();

function doFor(userId: string): FakeDo {
  const existing = dos.get(userId);
  if (existing !== undefined) return existing;
  const db = new NodeSqliteBackend();
  runMigrations(db);
  const repo = createRepository(db);
  const ephemeral = new Map<string, string>();
  const stub = {
    // biome-ignore lint/suspicious/noExplicitAny: テスト用ブリッジ
    insertRow: async (e: string, row: unknown) => repo.insert(e as any, row as any),
    // biome-ignore lint/suspicious/noExplicitAny: テスト用ブリッジ
    getRowById: async (e: string, id: string) => repo.getById(e as any, id),
    // biome-ignore lint/suspicious/noExplicitAny: テスト用ブリッジ
    listRowsBy: async (e: string, where: unknown) => repo.listBy(e as any, where as any),
    // biome-ignore lint/suspicious/noExplicitAny: テスト用ブリッジ
    removeRow: async (e: string, id: string) => repo.remove(e as any, id),
    putEphemeral: async (key: string, value: string) => {
      ephemeral.set(key, value);
    },
    getEphemeral: async (key: string) => ephemeral.get(key) ?? null,
    deleteEphemeral: async (key: string) => {
      ephemeral.delete(key);
    },
  };
  const fake: FakeDo = { repo, ephemeral, stub };
  dos.set(userId, fake);
  return fake;
}

vi.mock("../src/agents/routing", () => ({
  PRIMARY_CYCLE_KEY: "primary",
  getCycleAgent: async (_env: unknown, userId: string) => doFor(userId).stub,
  getGoalAgent: async (_env: unknown, userId: string) => doFor(userId).stub,
}));

// LLM 生成/調整の結果は各テストで差し替える。
let nextDraft: LlmResult<DraftContent> = {
  ok: false,
  error: { kind: "invalid_output", message: "unset" },
};
class FakeLlmClient implements LlmClient {
  public jsonCalls = 0;
  async complete(): Promise<LlmResult<string>> {
    return { ok: true, value: "" };
  }
  async completeJson(_req: LlmCompletionRequest): Promise<LlmResult<DraftContent>> {
    this.jsonCalls += 1;
    return nextDraft as LlmResult<never>;
  }
}
vi.mock("../src/llm/factory", () => ({
  createLlmClient: () => new FakeLlmClient(),
}));

const { draftCommandHandler, draftGenerateContinuation } = await import(
  "../src/status-and-draft/handlers/draft-command"
);
const { refineButtonHandler, draftRefineContinuation } = await import(
  "../src/status-and-draft/handlers/refine-button"
);
const { saveDraftButtonHandler } = await import(
  "../src/status-and-draft/handlers/save-draft-button"
);
const { buildRefineButtonId, buildSaveDraftButtonId } = await import(
  "../src/status-and-draft/custom-ids"
);
const { DRAFT_COMMAND_NAME, DRAFT_GOAL_SUBCOMMAND, DRAFT_OPT_GOAL, DRAFT_ALL_SUBCOMMAND } =
  await import("../src/status-and-draft/commands");
const { pendingDraftKey } = await import("../src/status-and-draft/routing");

const env = {} as DiscordEnv;

const generated: DraftContent = {
  facts: "AI 支援で機能を実装し、レビュー時間を短縮した。",
  interpretation: "目標に直結する成果が複数あり、活用が定着しつつある。",
  issues: "効果測定の定量化が不足している。",
  nextActions: "次週は短縮率の計測を行う。",
  speculativeNotes: ["定着度合いは推測を含む"],
};
const refined: DraftContent = {
  facts: "AI 支援で機能を実装した。",
  interpretation: "成果が出ている。",
  issues: "測定不足。",
  nextActions: "計測する。",
  speculativeNotes: [],
};

// command の type 値(数値リテラル)。
const SUBCOMMAND = 1;
const STRING = 3;

function seedCycleGoalEvidence(userId: string, withEvidence: boolean): void {
  const { repo } = doFor(userId);
  const cycle: EvaluationCycleRow = {
    id: "cycle-1",
    user_id: userId,
    name: "2026 H1",
    start_date: "2026-01-01",
    end_date: "2026-06-30",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  repo.insert("evaluation_cycles", cycle);
  const goal: GoalRow = {
    id: "goal-1",
    cycle_id: "cycle-1",
    user_id: userId,
    title: "AI 活用で開発効率を上げる",
    description: "AI 支援を組み込む",
    success_criteria: "週次で改善実績を記録",
    evaluation_points: null,
    status: "gray",
    created_at: "2026-01-02T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
  };
  repo.insert("goals", goal);
  if (!withEvidence) return;
  const evidence: EvidenceRow = {
    id: "ev-1",
    cycle_id: "cycle-1",
    user_id: userId,
    source_type: "manual_checkin",
    source_url: null,
    title: "実装記録",
    body: "AI 支援で機能を実装した",
    evidence_date: "2026-06-10",
    usefulness: "high",
    created_at: "2026-06-10T00:00:00.000Z",
    updated_at: "2026-06-10T00:00:00.000Z",
  };
  repo.insert("evidence", evidence);
  const link: EvidenceGoalLinkRow = {
    id: "link-1",
    evidence_id: "ev-1",
    goal_id: "goal-1",
    relevance_score: 0.9,
    reason: null,
    created_at: "2026-06-10T00:00:00.000Z",
  };
  repo.insert("evidence_goal_links", link);
}

function draftGoalCtx(goalId: string | null, userId = "user-1"): InteractionContext {
  const subOptions =
    goalId === null ? [] : [{ name: DRAFT_OPT_GOAL, type: STRING, value: goalId }];
  return {
    kind: "command",
    name: DRAFT_COMMAND_NAME,
    userId,
    channelId: "chan-1",
    isDm: false,
    interactionId: "int-draft-goal",
    token: "tok-draft-goal",
    raw: {
      data: {
        name: DRAFT_COMMAND_NAME,
        options: [{ name: DRAFT_GOAL_SUBCOMMAND, type: SUBCOMMAND, options: subOptions }],
      },
    } as unknown as InteractionContext["raw"],
  };
}

function draftAllCtx(userId = "user-1"): InteractionContext {
  return {
    kind: "command",
    name: DRAFT_COMMAND_NAME,
    userId,
    channelId: "chan-1",
    isDm: false,
    interactionId: "int-draft-all",
    token: "tok-draft-all",
    raw: {
      data: {
        name: DRAFT_COMMAND_NAME,
        options: [{ name: DRAFT_ALL_SUBCOMMAND, type: SUBCOMMAND, options: [] }],
      },
    } as unknown as InteractionContext["raw"],
  };
}

function buttonCtx(customId: string, userId = "user-1"): InteractionContext {
  return {
    kind: "component",
    name: customId,
    userId,
    channelId: "chan-1",
    isDm: false,
    interactionId: "int-button",
    token: "tok-button",
    raw: { data: { custom_id: customId } } as unknown as InteractionContext["raw"],
  };
}

function makeFollowup(): {
  followup: Followup;
  edits: { content: string; components: unknown }[];
} {
  const edits: { content: string; components: unknown }[] = [];
  const ok: SendResult = { ok: true };
  const followup: Followup = {
    editOriginal: async (content, opts) => {
      edits.push({ content, components: opts?.components });
      return ok;
    },
    send: async () => ok,
  };
  return { followup, edits };
}

/** edits[0].components の最初の action row のボタン数を返す(無ければ 0)。 */
function buttonCount(components: unknown): number {
  if (!Array.isArray(components) || components.length === 0) return 0;
  const row = components[0] as { components?: unknown[] };
  return Array.isArray(row.components) ? row.components.length : 0;
}

beforeEach(() => {
  dos.clear();
  nextDraft = { ok: false, error: { kind: "invalid_output", message: "unset" } };
});

describe("draftCommandHandler: /draft goal", () => {
  it("証跡ありで deferred → §8.7 ドラフト + 5 ボタンを follow-up し pending を KV へ保存する (5.3, 5.5, 5.9)", async () => {
    seedCycleGoalEvidence("user-1", true);
    nextDraft = { ok: true, value: generated };

    const result = await draftCommandHandler.handle(draftGoalCtx("goal-1"), env);
    expect(result.mode).toBe("deferred-persistent");
    if (result.mode !== "deferred-persistent")
      throw new Error("expected deferred-persistent");
    expect(result.ephemeral).toBe(true);

    const { followup, edits } = makeFollowup();
    await draftGenerateContinuation(env, result.continuation.payload, followup);

    expect(edits).toHaveLength(1);
    expect(edits[0].content).toContain("自己評価ドラフト");
    expect(edits[0].content).toContain(generated.facts);
    // 4 調整 + 保存 = 5 ボタン。
    expect(buttonCount(edits[0].components)).toBe(5);
    // pending が揮発 KV へ 1 件保存されている。
    const { ephemeral } = doFor("user-1");
    const keys = [...ephemeral.keys()].filter((k) => k.startsWith(pendingDraftKey("")));
    expect(keys).toHaveLength(1);
  });

  it("goal オプション欠落で即時 ephemeral 案内する (5.3)", async () => {
    const result = await draftCommandHandler.handle(draftGoalCtx(null), env);
    expect(result.mode).toBe("reply");
    if (result.mode !== "reply") throw new Error("expected reply");
    expect(result.ephemeral).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
  });

  it("証跡不足で案内し pending を作らない (5.7)", async () => {
    seedCycleGoalEvidence("user-1", false);
    nextDraft = { ok: true, value: generated };

    const result = await draftCommandHandler.handle(draftGoalCtx("goal-1"), env);
    if (result.mode !== "deferred-persistent")
      throw new Error("expected deferred-persistent");
    const { followup, edits } = makeFollowup();
    await draftGenerateContinuation(env, result.continuation.payload, followup);

    expect(edits[0].content).toContain("証跡");
    expect(edits[0].components).toBeUndefined();
    const { ephemeral } = doFor("user-1");
    expect([...ephemeral.keys()].filter((k) => k.startsWith(pendingDraftKey("")))).toHaveLength(0);
  });

  it("生成失敗で再試行案内し pending を作らない (5.8)", async () => {
    seedCycleGoalEvidence("user-1", true);
    nextDraft = { ok: false, error: { kind: "provider_error", message: "down" } };

    const result = await draftCommandHandler.handle(draftGoalCtx("goal-1"), env);
    if (result.mode !== "deferred-persistent")
      throw new Error("expected deferred-persistent");
    const { followup, edits } = makeFollowup();
    await draftGenerateContinuation(env, result.continuation.payload, followup);

    expect(edits[0].content.length).toBeGreaterThan(0);
    expect(edits[0].components).toBeUndefined();
    const { ephemeral } = doFor("user-1");
    expect([...ephemeral.keys()].filter((k) => k.startsWith(pendingDraftKey("")))).toHaveLength(0);
  });

  it("非所有/不存在目標は見つからない案内に正規化する (5.6)", async () => {
    seedCycleGoalEvidence("user-1", true);
    nextDraft = { ok: true, value: generated };

    const result = await draftCommandHandler.handle(draftGoalCtx("goal-missing"), env);
    if (result.mode !== "deferred-persistent")
      throw new Error("expected deferred-persistent");
    const { followup, edits } = makeFollowup();
    await draftGenerateContinuation(env, result.continuation.payload, followup);

    expect(edits[0].content).toContain("見つかりません");
    expect(edits[0].content).not.toContain("自己評価ドラフト");
  });
});

describe("draftCommandHandler: /draft all", () => {
  it("証跡ありで deferred → §8.7 + ボタンを follow-up する(goalId null 経路) (5.3, 5.5)", async () => {
    seedCycleGoalEvidence("user-1", true);
    nextDraft = { ok: true, value: generated };

    const result = await draftCommandHandler.handle(draftAllCtx(), env);
    if (result.mode !== "deferred-persistent")
      throw new Error("expected deferred-persistent");
    const { followup, edits } = makeFollowup();
    await draftGenerateContinuation(env, result.continuation.payload, followup);

    expect(edits[0].content).toContain("自己評価ドラフト");
    expect(buttonCount(edits[0].components)).toBe(5);
  });
});

describe("refineButtonHandler", () => {
  /** 生成して draftPendingId を返す(KV へ pending を投入する)。 */
  async function generateAndGetId(userId = "user-1"): Promise<string> {
    seedCycleGoalEvidence(userId, true);
    nextDraft = { ok: true, value: generated };
    const result = await draftCommandHandler.handle(draftGoalCtx("goal-1", userId), env);
    if (result.mode !== "deferred-persistent")
      throw new Error("expected deferred-persistent");
    const { followup } = makeFollowup();
    await draftGenerateContinuation(env, result.continuation.payload, followup);
    const { ephemeral } = doFor(userId);
    const key = [...ephemeral.keys()].find((k) => k.startsWith(pendingDraftKey("")));
    if (key === undefined) throw new Error("pending not persisted");
    return JSON.parse(ephemeral.get(key)!).draftPendingId as string;
  }

  it("調整(上司向け)で deferred → 再生成し §8.7 + ボタンを再提示、pending を更新する (6.5)", async () => {
    const id = await generateAndGetId();
    nextDraft = { ok: true, value: refined };

    const result = await refineButtonHandler.handle(
      buttonCtx(buildRefineButtonId("manager", id)),
      env,
    );
    expect(result.mode).toBe("deferred-persistent");
    if (result.mode !== "deferred-persistent")
      throw new Error("expected deferred-persistent");
    expect(result.ephemeral).toBe(true);

    const { followup, edits } = makeFollowup();
    await draftRefineContinuation(env, result.continuation.payload, followup);

    expect(edits[0].content).toContain("自己評価ドラフト");
    expect(edits[0].content).toContain(refined.facts);
    expect(buttonCount(edits[0].components)).toBe(5);
    // pending の内容が調整版へ更新されている。
    const { ephemeral } = doFor("user-1");
    const key = [...ephemeral.keys()].find((k) => k.startsWith(pendingDraftKey("")))!;
    expect(JSON.parse(ephemeral.get(key)!).content.facts).toBe(refined.facts);
  });

  it("pending 不在で操作不可を案内する (6.6)", async () => {
    nextDraft = { ok: true, value: refined };
    const result = await refineButtonHandler.handle(
      buttonCtx(buildRefineButtonId("shorten", "missing")),
      env,
    );
    if (result.mode !== "deferred-persistent")
      throw new Error("expected deferred-persistent");
    const { followup, edits } = makeFollowup();
    await draftRefineContinuation(env, result.continuation.payload, followup);

    expect(edits[0].content.length).toBeGreaterThan(0);
    expect(edits[0].content).not.toContain("自己評価ドラフト");
  });

  it("別人 pending は操作不可に正規化する (6.6)", async () => {
    const id = await generateAndGetId("user-1");
    nextDraft = { ok: true, value: refined };
    // user-2 が user-1 の id を押下 → user-2 の DO に pending は無い。
    const result = await refineButtonHandler.handle(
      buttonCtx(buildRefineButtonId("manager", id), "user-2"),
      env,
    );
    if (result.mode !== "deferred-persistent")
      throw new Error("expected deferred-persistent");
    const { followup, edits } = makeFollowup();
    await draftRefineContinuation(env, result.continuation.payload, followup);

    expect(edits[0].content).not.toContain("自己評価ドラフト");
    // user-1 の pending は更新されず残存。
    const { ephemeral } = doFor("user-1");
    const key = [...ephemeral.keys()].find((k) => k.startsWith(pendingDraftKey("")))!;
    expect(JSON.parse(ephemeral.get(key)!).content.facts).toBe(generated.facts);
  });

  it("調整失敗で直前ドラフトを維持し失敗を案内する (6.7)", async () => {
    const id = await generateAndGetId();
    nextDraft = { ok: false, error: { kind: "provider_error", message: "down" } };

    const result = await refineButtonHandler.handle(
      buttonCtx(buildRefineButtonId("clarify", id)),
      env,
    );
    if (result.mode !== "deferred-persistent")
      throw new Error("expected deferred-persistent");
    const { followup, edits } = makeFollowup();
    await draftRefineContinuation(env, result.continuation.payload, followup);

    expect(edits[0].content.length).toBeGreaterThan(0);
    expect(edits[0].content).not.toContain(refined.facts);
    // pending は直前(generated)を維持。
    const { ephemeral } = doFor("user-1");
    const key = [...ephemeral.keys()].find((k) => k.startsWith(pendingDraftKey("")))!;
    expect(JSON.parse(ephemeral.get(key)!).content.facts).toBe(generated.facts);
  });

  it("不正 custom_id で即時 ephemeral 案内する", async () => {
    const result = await refineButtonHandler.handle(buttonCtx("draft:refine:bogus"), env);
    expect(result.mode).toBe("reply");
    if (result.mode !== "reply") throw new Error("expected reply");
    expect(result.ephemeral).toBe(true);
  });
});

describe("saveDraftButtonHandler", () => {
  async function generateAndGetId(userId = "user-1"): Promise<string> {
    seedCycleGoalEvidence(userId, true);
    nextDraft = { ok: true, value: generated };
    const result = await draftCommandHandler.handle(draftGoalCtx("goal-1", userId), env);
    if (result.mode !== "deferred-persistent")
      throw new Error("expected deferred-persistent");
    const { followup } = makeFollowup();
    await draftGenerateContinuation(env, result.continuation.payload, followup);
    const { ephemeral } = doFor(userId);
    const key = [...ephemeral.keys()].find((k) => k.startsWith(pendingDraftKey("")));
    if (key === undefined) throw new Error("pending not persisted");
    return JSON.parse(ephemeral.get(key)!).draftPendingId as string;
  }

  it("[保存] で drafts へ保存し保存通知を返す (7.3)", async () => {
    const id = await generateAndGetId();

    const result = await saveDraftButtonHandler.handle(
      buttonCtx(buildSaveDraftButtonId(id)),
      env,
    );
    // reply / deferred どちらでも保存通知が返ればよい。
    let content: string;
    if (result.mode === "reply") {
      content = result.content;
      expect(result.ephemeral).toBe(true);
    } else if (result.mode === "deferred") {
      const { followup, edits } = makeFollowup();
      await result.run(followup);
      content = edits[0].content;
    } else {
      throw new Error("expected reply or deferred");
    }
    expect(content).toContain("保存");
    expect(doFor("user-1").repo.listBy("drafts", {})).toHaveLength(1);
  });

  it("pending 不在で操作不可を案内し何も保存しない (7.4)", async () => {
    const result = await saveDraftButtonHandler.handle(
      buttonCtx(buildSaveDraftButtonId("missing")),
      env,
    );
    let content: string;
    if (result.mode === "reply") {
      content = result.content;
    } else if (result.mode === "deferred") {
      const { followup, edits } = makeFollowup();
      await result.run(followup);
      content = edits[0].content;
    } else {
      throw new Error("expected reply or deferred");
    }
    expect(content.length).toBeGreaterThan(0);
    expect(doFor("user-1").repo.listBy("drafts", {})).toHaveLength(0);
  });

  it("別人 pending は保存しない (7.4)", async () => {
    const id = await generateAndGetId("user-1");
    const result = await saveDraftButtonHandler.handle(
      buttonCtx(buildSaveDraftButtonId(id), "user-2"),
      env,
    );
    if (result.mode === "deferred") {
      const { followup } = makeFollowup();
      await result.run(followup);
    }
    expect(doFor("user-1").repo.listBy("drafts", {})).toHaveLength(0);
    expect(doFor("user-2").repo.listBy("drafts", {})).toHaveLength(0);
  });

  it("不正 custom_id で即時 ephemeral 案内する", async () => {
    const result = await saveDraftButtonHandler.handle(buttonCtx("draft:save"), env);
    expect(result.mode).toBe("reply");
    if (result.mode !== "reply") throw new Error("expected reply");
    expect(result.ephemeral).toBe(true);
  });
});

describe("生成→調整→保存の全系列(KV 共有)", () => {
  it("生成→調整→保存が同一 draftPendingId/kind を解釈してドメインを呼び、調整版が保存される (5.3-5.9, 6.5, 7.3)", async () => {
    seedCycleGoalEvidence("user-1", true);
    nextDraft = { ok: true, value: generated };

    // 生成
    const gen = await draftCommandHandler.handle(draftGoalCtx("goal-1"), env);
    if (gen.mode !== "deferred-persistent")
      throw new Error("expected deferred-persistent");
    await draftGenerateContinuation(env, gen.continuation.payload, makeFollowup().followup);
    const { ephemeral } = doFor("user-1");
    const key = [...ephemeral.keys()].find((k) => k.startsWith(pendingDraftKey("")))!;
    const id = JSON.parse(ephemeral.get(key)!).draftPendingId as string;

    // 調整(短くする)
    nextDraft = { ok: true, value: refined };
    const ref = await refineButtonHandler.handle(
      buttonCtx(buildRefineButtonId("shorten", id)),
      env,
    );
    if (ref.mode !== "deferred-persistent")
      throw new Error("expected deferred-persistent");
    await draftRefineContinuation(env, ref.continuation.payload, makeFollowup().followup);

    // 保存
    const sav = await saveDraftButtonHandler.handle(buttonCtx(buildSaveDraftButtonId(id)), env);
    if (sav.mode === "deferred") {
      await sav.run(makeFollowup().followup);
    }

    const drafts = doFor("user-1").repo.listBy("drafts", {});
    expect(drafts).toHaveLength(1);
    // 保存本文は調整版(refined)を反映している。
    expect(drafts[0].body).toContain(refined.facts);
    expect(drafts[0].user_id).toBe("user-1");
  });
});
