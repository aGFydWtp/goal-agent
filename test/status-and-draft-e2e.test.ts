// status-and-draft クリティカルパス E2E + notifications 再利用契約スモーク + LLM フォール
// バック(task 7.1 / Req 1.5, 1.6, 7.5, 8.5)。
//
// 完了条件(tasks.md 7.1 / design「E2E / Smoke Tests」):
// - サイクル + 目標 + 証跡蓄積済み状態で `/status` → `/goal status` → `/evidence list` →
//   `/draft goal` → 調整 → [保存] を通し、判定・閲覧・ドラフト保存が **単一権威** で成立する。
// - 単一/全目標判定メソッド(`determineGoalStatus`/`determineAllStatuses`)が Agent 取得経由で
//   外部(notifications 想定)から呼べ、`StatusVerdict` 形の判定結果を返す(Req 1.6, 8.5)。
// - LLM 失敗時にルール候補で判定が成立し、見立て欠落(`reasonMissing`)が識別できる(Req 1.5)。
// - drafts に保存行が確認できる(Req 7.5)。
//
// 方針: 1 つの SQLite 実体に支えられた `CycleDataAuthority` を **全ハンドラ越しに共有**(routing
// モックで注入)し、揮発 pending を **1 つの ephemeral KV(Map)で共有**(agents/routing モックで
// 注入)する。これにより `/draft` 生成 → 調整 → [保存] の別 interaction 間で pending が跨ぐ。
// LLM は schema 引数で分岐する FakeLlmClient(status は StatusVerdict、draft は DraftContent)。
// 実ドメイン(determine*/generateDraft/refineDraft/saveDraft/listEvidenceWithLinks)がハンドラを
// 通して end-to-end で走る。実行環境: vitest "node"(test/*.test.ts 自動収集)。

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ZodType } from "zod";

import type { DiscordEnv } from "../src/discord/env";
import type { Followup, InteractionContext, SendResult } from "../src/discord/types";
import type {
  CycleDataAuthority,
  DomainDeps,
} from "../src/goal-management/domain/cycle-operations";
import type { LlmClient, LlmCompletionRequest, LlmResult } from "../src/llm/client";
import { runMigrations } from "../src/persistence/migrator";
import { createRepository } from "../src/persistence/repository";
import { draftContentSchema, type DraftContent } from "../src/status-and-draft/draft/schema";
import type { StatusVerdict } from "../src/status-and-draft/status/schema";
import type {
  EntityName,
  EntityRow,
  EvaluationCycleRow,
  EvidenceGoalLinkRow,
  EvidenceRow,
  GoalRow,
} from "../src/types";
import { NodeSqliteBackend } from "./helpers/node-sqlite-adapter";

// ── 単一権威 + 単一 ephemeral KV(全ハンドラ・再利用契約で共有)──
// setupShared() が beforeEach で組み直し、各モックはこの共有実体を返す。

interface Shared {
  db: NodeSqliteBackend;
  authority: CycleDataAuthority;
  ephemeral: Map<string, string>;
}

let shared: Shared;

function setupShared(): Shared {
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
  return { db, authority, ephemeral: new Map() };
}

// ── モック: routing(単一 authority 注入)/ agents/routing(単一 ephemeral KV 注入)/
//    llm/factory(schema 分岐 FakeLlmClient 注入)──
// 全ハンドラは getUserCycleAuthority(env,userId) で同一 authority を、draft 系は
// getDraftEphemeralKv → getCycleAgent(env,userId,...) で同一 KV を引く。

vi.mock("../src/goal-management/routing", () => ({
  PRIMARY_CYCLE_KEY: "primary",
  getUserCycleAuthority: async (_env: DiscordEnv, _userId: string) => shared.authority,
}));

// ephemeral KV を備えた最小 DO スタブ(全ユーザーで共有 Map を使う。本 E2E は単一ユーザー)。
function ephemeralStub(): {
  putEphemeral: (key: string, value: string) => Promise<void>;
  getEphemeral: (key: string) => Promise<string | null>;
  deleteEphemeral: (key: string) => Promise<void>;
} {
  return {
    putEphemeral: async (key: string, value: string) => {
      shared.ephemeral.set(key, value);
    },
    getEphemeral: async (key: string) => shared.ephemeral.get(key) ?? null,
    deleteEphemeral: async (key: string) => {
      shared.ephemeral.delete(key);
    },
  };
}

vi.mock("../src/agents/routing", () => ({
  PRIMARY_CYCLE_KEY: "primary",
  getCycleAgent: async (..._args: unknown[]) => ephemeralStub(),
  getGoalAgent: async (..._args: unknown[]) => ephemeralStub(),
}));

// status 判定と draft 生成/調整の LLM 結果を各テストで差し替える。
// completeJson は schema 引数で分岐(status は StatusVerdict、draft は DraftContent)。
let nextStatus: LlmResult<StatusVerdict> = { ok: true, value: undefined as never };
let nextDraft: LlmResult<DraftContent> = {
  ok: false,
  error: { kind: "invalid_output", message: "unset" },
};

class FakeLlmClient implements LlmClient {
  public readonly jsonRequests: LlmCompletionRequest[] = [];

  async complete(): Promise<LlmResult<string>> {
    return { ok: true, value: "" };
  }

  async completeJson<T>(
    request: LlmCompletionRequest,
    schema: ZodType<T>,
  ): Promise<LlmResult<T>> {
    this.jsonRequests.push(request);
    if (schema === (draftContentSchema as unknown as ZodType<T>)) {
      return nextDraft as LlmResult<T>;
    }
    return nextStatus as LlmResult<T>;
  }
}

vi.mock("../src/llm/factory", () => ({
  createLlmClient: (_env: DiscordEnv) => new FakeLlmClient(),
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
const { draftCommandHandler } = await import("../src/status-and-draft/handlers/draft-command");
const { refineButtonHandler } = await import("../src/status-and-draft/handlers/refine-button");
const { saveDraftButtonHandler } = await import(
  "../src/status-and-draft/handlers/save-draft-button"
);
const { buildRefineButtonId, buildSaveDraftButtonId } = await import(
  "../src/status-and-draft/custom-ids"
);
const { pendingDraftKey } = await import("../src/status-and-draft/routing");
const { determineGoalStatus, determineAllStatuses } = await import(
  "../src/status-and-draft/domain/status-operations"
);
const { getGoalAgent, getCycleAgent } = await import("../src/agents/routing");

const env = {} as DiscordEnv;

// 判定で newId は使われない読み取り経路。determine* 直呼び用に決定的 deps を組む。
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

// ── §13.2 / §13.3 の LLM 出力(schema-valid)──
const statusVerdict: StatusVerdict = {
  status: "green",
  reason: "直近2週で AI 活用の成果証跡が複数あり順調に進んでいる",
  risks: ["証跡の更新頻度が落ちる懸念"],
  nextActions: ["来週も実績を記録する"],
  reasonMissing: false,
};

const generatedDraft: DraftContent = {
  facts: "AI 支援で機能を実装し、レビュー時間を短縮した。",
  interpretation: "目標に直結する成果が複数あり、活用が定着しつつある。",
  issues: "効果測定の定量化が不足している。",
  nextActions: "次週は短縮率の計測を行う。",
  speculativeNotes: ["定着度合いは推測を含む"],
};

const refinedDraft: DraftContent = {
  facts: "AI 支援で機能を実装し、レビューを効率化した(上司向け要約)。",
  interpretation: "評価観点に沿った成果を提示できる水準にある。",
  issues: "定量指標の提示が今後の課題。",
  nextActions: "短縮率を計測し次回報告に反映する。",
  speculativeNotes: [],
};

// ── シード(単一権威へ): サイクル + 2 目標 + 証跡 + 目標リンク ──
const USER = "user-1";
const CYCLE_ID = "cycle-1";
const GOAL_A = "goal-a";
const GOAL_B = "goal-b";

async function seedFullState(): Promise<void> {
  const cycle: EvaluationCycleRow = {
    id: CYCLE_ID,
    user_id: USER,
    name: "2026 H1",
    start_date: "2026-01-01",
    end_date: "2026-06-30",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  await shared.authority.insertRow("evaluation_cycles", cycle);

  const goalA: GoalRow = {
    id: GOAL_A,
    cycle_id: CYCLE_ID,
    user_id: USER,
    title: "AI 活用で開発効率を上げる",
    description: "開発プロセスに AI 支援を組み込み、レビューと実装速度を改善する",
    success_criteria: "週次で AI 活用の改善実績を 3 件以上記録する",
    evaluation_points: "レビュー時間の短縮\n期限: 2026-06-30",
    status: "gray",
    created_at: "2026-01-02T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
  };
  await shared.authority.insertRow("goals", goalA);

  const goalB: GoalRow = {
    ...goalA,
    id: GOAL_B,
    title: "チームのナレッジ共有を促進する",
    success_criteria: "月次で共有会を 1 回以上開催する",
  };
  await shared.authority.insertRow("goals", goalB);

  // GOAL_A に直近の証跡 2 件(usefulness high)を紐づける。
  const evidences: Array<EvidenceRow> = [
    {
      id: "ev-1",
      cycle_id: CYCLE_ID,
      user_id: USER,
      source_type: "manual_checkin",
      source_url: null,
      title: "実装記録",
      body: "AI 支援でレビュー導入を実施した",
      evidence_date: "2026-06-10",
      usefulness: "high",
      created_at: "2026-06-10T00:00:00.000Z",
      updated_at: "2026-06-10T00:00:00.000Z",
    },
    {
      id: "ev-2",
      cycle_id: CYCLE_ID,
      user_id: USER,
      source_type: "manual_checkin",
      source_url: null,
      title: "効率化記録",
      body: "AI 支援で実装速度を改善した",
      evidence_date: "2026-06-12",
      usefulness: "medium",
      created_at: "2026-06-12T00:00:00.000Z",
      updated_at: "2026-06-12T00:00:00.000Z",
    },
  ];
  for (const ev of evidences) {
    await shared.authority.insertRow("evidence", ev);
  }
  const links: Array<EvidenceGoalLinkRow> = [
    {
      id: "link-1",
      evidence_id: "ev-1",
      goal_id: GOAL_A,
      relevance_score: 0.9,
      reason: null,
      created_at: "2026-06-10T00:00:00.000Z",
    },
    {
      id: "link-2",
      evidence_id: "ev-2",
      goal_id: GOAL_A,
      relevance_score: 0.8,
      reason: null,
      created_at: "2026-06-12T00:00:00.000Z",
    },
  ];
  for (const link of links) {
    await shared.authority.insertRow("evidence_goal_links", link);
  }
}

// ── InteractionContext ビルダ ──
const SUBCOMMAND = 1;
const STRING = 3;

function statusCtx(): InteractionContext {
  return {
    kind: "command",
    name: "status",
    userId: USER,
    channelId: "chan-1",
    isDm: false,
    interactionId: "int-status",
    token: "tok-status",
    raw: { data: { name: "status" } } as unknown as InteractionContext["raw"],
  };
}

function goalStatusCtx(goalId: string): InteractionContext {
  return {
    kind: "command",
    name: "goal",
    userId: USER,
    channelId: "chan-1",
    isDm: false,
    interactionId: "int-goal-status",
    token: "tok-goal-status",
    raw: {
      data: {
        name: "goal",
        options: [
          {
            name: "status",
            type: SUBCOMMAND,
            options: [{ name: "goal", type: STRING, value: goalId }],
          },
        ],
      },
    } as unknown as InteractionContext["raw"],
  };
}

function evidenceListCtx(): InteractionContext {
  return {
    kind: "command",
    name: "evidence",
    userId: USER,
    channelId: "chan-1",
    isDm: false,
    interactionId: "int-ev-list",
    token: "tok-ev-list",
    raw: {
      data: {
        name: "evidence",
        options: [{ name: "list", type: SUBCOMMAND, options: [] }],
      },
    } as unknown as InteractionContext["raw"],
  };
}

function draftGoalCtx(goalId: string): InteractionContext {
  return {
    kind: "command",
    name: "draft",
    userId: USER,
    channelId: "chan-1",
    isDm: false,
    interactionId: "int-draft-goal",
    token: "tok-draft-goal",
    raw: {
      data: {
        name: "draft",
        options: [
          {
            name: "goal",
            type: SUBCOMMAND,
            options: [{ name: "goal", type: STRING, value: goalId }],
          },
        ],
      },
    } as unknown as InteractionContext["raw"],
  };
}

function buttonCtx(customId: string): InteractionContext {
  return {
    kind: "component",
    name: customId,
    userId: USER,
    channelId: "chan-1",
    isDm: false,
    interactionId: "int-button",
    token: "tok-button",
    raw: { data: { custom_id: customId } } as unknown as InteractionContext["raw"],
  };
}

function makeFollowup(): {
  followup: Followup;
  edits: Array<{ content: string; components: unknown }>;
} {
  const edits: Array<{ content: string; components: unknown }> = [];
  const ok: SendResult = { ok: true };
  const followup: Followup = {
    editOriginal: async (content: string, opts?: { components?: unknown }) => {
      edits.push({ content, components: opts?.components });
      return ok;
    },
    send: async () => ok,
  };
  return { followup, edits };
}

/** action row のボタン数を返す。 */
function buttonCount(components: unknown): number {
  if (!Array.isArray(components) || components.length === 0) return 0;
  const row = components[0] as { components?: unknown[] };
  return Array.isArray(row.components) ? row.components.length : 0;
}

/** ephemeral KV から pending を 1 件読み、draftPendingId を返す。 */
function pendingDraftIdFromKv(): string {
  const key = [...shared.ephemeral.keys()].find((k) => k.startsWith(pendingDraftKey("")));
  if (key === undefined) throw new Error("pending not persisted to shared KV");
  return JSON.parse(shared.ephemeral.get(key)!).draftPendingId as string;
}

beforeEach(() => {
  shared = setupShared();
  nextStatus = { ok: true, value: statusVerdict };
  nextDraft = { ok: true, value: generatedDraft };
});

describe("クリティカルパス E2E(単一権威 + 単一 KV)", () => {
  it("/status → /goal status → /evidence list → /draft goal → 調整 → [保存] が同一権威で成立し drafts に保存される (1.6, 7.5, 8.5)", async () => {
    await seedFullState();

    // ── 1) /status: deferred → §8.4 概況(目標名 + 状態 + 今週やるとよいこと)──
    const statusResult = await statusCommandHandler.handle(statusCtx(), env);
    expect(statusResult.mode).toBe("deferred");
    if (statusResult.mode !== "deferred") throw new Error("expected deferred");
    expect(statusResult.ephemeral).toBe(true);
    {
      const { followup, edits } = makeFollowup();
      await statusResult.run(followup);
      expect(edits).toHaveLength(1);
      const content = edits[0]!.content;
      expect(content).toContain("評価目標ステータス");
      expect(content).toContain("AI 活用で開発効率を上げる");
      expect(content).toContain("チームのナレッジ共有を促進する");
      expect(content).toContain("今週やるとよいこと");
    }

    // ── 2) /goal status: deferred → §8.5 詳細(状態/見立て/証跡/不足/次アクション)──
    const goalResult = await goalStatusCommandHandler.handle(goalStatusCtx(GOAL_A), env);
    expect(goalResult.mode).toBe("deferred");
    if (goalResult.mode !== "deferred") throw new Error("expected deferred");
    {
      const { followup, edits } = makeFollowup();
      await goalResult.run(followup);
      expect(edits).toHaveLength(1);
      const content = edits[0]!.content;
      expect(content).toContain("AI 活用で開発効率を上げる");
      expect(content).toContain("Agent の見立て:");
      expect(content).toContain(statusVerdict.reason);
      expect(content).toContain("保存済み証跡:");
      expect(content).toContain("AI 支援でレビュー導入を実施した");
      expect(content).toContain("不足:");
      expect(content).toContain("次アクション:");
    }

    // ── 3) /evidence list: 即時 ephemeral → §8.6(目標名 + usefulness)──
    const evResult = await evidenceListCommandHandler.handle(evidenceListCtx(), env);
    expect(evResult.mode).toBe("reply");
    if (evResult.mode !== "reply") throw new Error("expected reply");
    expect(evResult.ephemeral).toBe(true);
    expect(evResult.content).toContain("保存済み証跡");
    expect(evResult.content).toContain("AI 支援でレビュー導入を実施した");
    expect(evResult.content).toContain("AI 活用で開発効率を上げる");

    // ── 4) /draft goal: deferred → §8.7 ドラフト + 5 ボタン、pending を共有 KV へ ──
    const draftResult = await draftCommandHandler.handle(draftGoalCtx(GOAL_A), env);
    expect(draftResult.mode).toBe("deferred");
    if (draftResult.mode !== "deferred") throw new Error("expected deferred");
    {
      const { followup, edits } = makeFollowup();
      await draftResult.run(followup);
      expect(edits).toHaveLength(1);
      expect(edits[0]!.content).toContain("自己評価ドラフト");
      expect(edits[0]!.content).toContain(generatedDraft.facts);
      expect(buttonCount(edits[0]!.components)).toBe(5);
    }
    const draftPendingId = pendingDraftIdFromKv();

    // ── 5) 調整(上司向け manager): deferred → 再生成 §8.7 + 5 ボタン、pending を共有 KV で更新 ──
    nextDraft = { ok: true, value: refinedDraft };
    const refineResult = await refineButtonHandler.handle(
      buttonCtx(buildRefineButtonId("manager", draftPendingId)),
      env,
    );
    expect(refineResult.mode).toBe("deferred");
    if (refineResult.mode !== "deferred") throw new Error("expected deferred");
    {
      const { followup, edits } = makeFollowup();
      await refineResult.run(followup);
      expect(edits[0]!.content).toContain("自己評価ドラフト");
      expect(edits[0]!.content).toContain(refinedDraft.facts);
      expect(buttonCount(edits[0]!.components)).toBe(5);
    }
    // 共有 KV 上の pending が調整版へ更新され、種別が manager_summary になっている。
    {
      const key = [...shared.ephemeral.keys()].find((k) => k.startsWith(pendingDraftKey("")))!;
      const pending = JSON.parse(shared.ephemeral.get(key)!);
      expect(pending.content.facts).toBe(refinedDraft.facts);
      expect(pending.draftType).toBe("manager_summary");
    }

    // ── 6) [保存]: drafts へ保存し保存通知 ──
    const saveResult = await saveDraftButtonHandler.handle(
      buttonCtx(buildSaveDraftButtonId(draftPendingId)),
      env,
    );
    let savedContent: string;
    if (saveResult.mode === "reply") {
      savedContent = saveResult.content;
      expect(saveResult.ephemeral).toBe(true);
    } else if (saveResult.mode === "deferred") {
      const { followup, edits } = makeFollowup();
      await saveResult.run(followup);
      savedContent = edits[0]!.content;
    } else {
      throw new Error("expected reply or deferred");
    }
    expect(savedContent).toContain("保存");

    // ── drafts に保存行が確認できる(同一権威・所有者・調整版種別/本文)(Req 7.5)──
    const drafts = await shared.authority.listRowsBy("drafts", {});
    expect(drafts).toHaveLength(1);
    const row = drafts[0]!;
    expect(row.user_id).toBe(USER);
    expect(row.cycle_id).toBe(CYCLE_ID);
    expect(row.goal_id).toBe(GOAL_A);
    // 調整(上司向け)版が保存されている(Req 7.2: kind→type)。
    expect(row.type).toBe("manager_summary");
    expect(row.body).toContain(refinedDraft.facts);
  });
});

describe("notifications 再利用契約スモーク (Req 1.6, 8.5)", () => {
  it("getGoalAgent/getCycleAgent 取得後に determineGoalStatus / determineAllStatuses を外部から呼び StatusVerdict 形を返す", async () => {
    await seedFullState();
    nextStatus = { ok: true, value: statusVerdict };
    const llm = new FakeLlmClient();
    const deps = makeDeps();

    // notifications 想定の取得経路: Agent を取得(本テストではモックスタブ)してから、
    // 権威 + deps + llm を注入してドメイン判定メソッドを直接呼ぶ。
    const goalAgent = await getGoalAgent(env, USER, CYCLE_ID, GOAL_A);
    const cycleAgent = await getCycleAgent(env, USER, "primary");
    expect(goalAgent).toBeDefined();
    expect(cycleAgent).toBeDefined();

    const single = await determineGoalStatus(
      shared.authority,
      deps,
      llm,
      USER,
      CYCLE_ID,
      GOAL_A,
    );
    expect(single.ok).toBe(true);
    if (!single.ok) throw new Error("expected single status result");
    const singleVerdict: StatusVerdict = single.verdict;
    // StatusVerdict 形(status は列挙、reason/risks[]/nextActions[]/reasonMissing)を満たす。
    expect(["green", "yellow", "red", "gray"]).toContain(singleVerdict.status);
    expect(typeof singleVerdict.reason).toBe("string");
    expect(Array.isArray(singleVerdict.risks)).toBe(true);
    expect(Array.isArray(singleVerdict.nextActions)).toBe(true);
    expect(typeof singleVerdict.reasonMissing).toBe("boolean");
    expect(singleVerdict.reasonMissing).toBe(false);

    const all = await determineAllStatuses(shared.authority, deps, llm, USER);
    expect(all.ok).toBe(true);
    if (!all.ok) throw new Error("expected all-statuses result");
    expect(all.cycle.id).toBe(CYCLE_ID);
    expect(all.results).toHaveLength(2);
    const allVerdict: StatusVerdict = all.results[0]!.verdict;
    expect(["green", "yellow", "red", "gray"]).toContain(allVerdict.status);
    expect(typeof allVerdict.reasonMissing).toBe("boolean");
  });
});

describe("LLM 失敗フォールバック (Req 1.5)", () => {
  it("status 見立て取得が失敗してもルール候補で判定が成立し reasonMissing=true(見立て欠落を識別)", async () => {
    await seedFullState();
    // 直近2週内の high 証跡 2 件 → ルール候補 green。LLM 見立ては invalid_output で失敗。
    nextStatus = { ok: false, error: { kind: "invalid_output", message: "schema mismatch" } };
    const llm = new FakeLlmClient();

    const result = await determineGoalStatus(
      shared.authority,
      makeDeps(),
      llm,
      USER,
      CYCLE_ID,
      GOAL_A,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected status result");
    // ルール候補で status が成立する(判断材料あり → Gray ではなく green 候補)。
    expect(result.verdict.status).toBe("green");
    // 見立て欠落が呼び出し側から識別できる。
    expect(result.verdict.reasonMissing).toBe(true);
    expect(result.verdict.reason).toBe("");
    // LLM 見立ては要求されている(失敗してフォールバックした)。
    expect(llm.jsonRequests).toHaveLength(1);
  });

  it("証跡なし + LLM 失敗は判断材料不足として Gray + reasonMissing=true を返す (1.4, 1.5)", async () => {
    // サイクル + 目標のみ(証跡なし)。
    const cycle: EvaluationCycleRow = {
      id: CYCLE_ID,
      user_id: USER,
      name: "2026 H1",
      start_date: "2026-01-01",
      end_date: "2026-06-30",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    await shared.authority.insertRow("evaluation_cycles", cycle);
    const goal: GoalRow = {
      id: GOAL_A,
      cycle_id: CYCLE_ID,
      user_id: USER,
      title: "AI 活用で開発効率を上げる",
      description: "AI 支援を組み込む",
      success_criteria: "週次で改善実績を記録",
      evaluation_points: null,
      status: "gray",
      created_at: "2026-01-02T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
    };
    await shared.authority.insertRow("goals", goal);

    nextStatus = { ok: false, error: { kind: "provider_error", message: "down" } };
    const llm = new FakeLlmClient();

    const result = await determineGoalStatus(
      shared.authority,
      makeDeps(),
      llm,
      USER,
      CYCLE_ID,
      GOAL_A,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected status result");
    expect(result.verdict.status).toBe("gray");
    expect(result.verdict.reasonMissing).toBe(true);
  });
});
