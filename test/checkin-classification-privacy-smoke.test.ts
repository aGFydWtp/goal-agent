// checkin-classification プライバシー・境界の E2E/スモークテスト(task 5.3 / Req 1.5, 3.6,
// 6.1, 6.2, 6.3, 6.4, 6.5, 6.6)。
//
// 検証:
//  - critical path: サイクル + 目標登録済みから `/checkin` → modal → 分類 → [保存] → 保存後メッセージ
//    まで通し、証跡・リンク・週次レビューが単一権威(同一 DO authority)に揃う。
//  - 全応答が ephemeral(本人限定)である。
//  - 自動分類が [保存] なしに確定しない(分類だけでは証跡が作られない)。
//  - 他ユーザーの pending へアクセスしない(別 userId は not_found に正規化)。
//
// 方針: DO 境界(agents/routing)を per-user fake stub へ、LLM を FIFO キューの fake へ差し替える。
// 実行環境: vitest "node" プロジェクト。

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClassificationResult } from "../src/checkin-classification/classification/schema";
import type { WeeklyReview } from "../src/checkin-classification/weekly-review/schema";
import type { DiscordEnv } from "../src/discord/env";
import type { Followup, HandlerResult, InteractionContext, SendResult } from "../src/discord/types";
import type { LlmClient, LlmResult } from "../src/llm/client";
import { runMigrations } from "../src/persistence/migrator";
import { createRepository, type Repository } from "../src/persistence/repository";
import type { GoalRow } from "../src/types";
import { NodeSqliteBackend } from "./helpers/node-sqlite-adapter";

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
    updateRow: async (e: string, id: string, patch: unknown) =>
      // biome-ignore lint/suspicious/noExplicitAny: テスト用ブリッジ
      repo.update(e as any, id, patch as any),
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
  getCycleAgent: async (_env: unknown, userId: string) => doFor(userId).stub,
  getGoalAgent: async (_env: unknown, userId: string) => doFor(userId).stub,
}));

const llmQueue: LlmResult<unknown>[] = [];
class FakeLlmClient implements LlmClient {
  async complete(): Promise<LlmResult<string>> {
    return { ok: true, value: "" };
  }
  async completeJson(): Promise<LlmResult<never>> {
    const next = llmQueue.shift();
    if (next === undefined) {
      return { ok: false, error: { kind: "invalid_output", message: "queue empty" } };
    }
    return next as LlmResult<never>;
  }
}
vi.mock("../src/llm/factory", () => ({
  createLlmClient: () => new FakeLlmClient(),
}));

const { registerCheckinClassification } = await import("../src/checkin-classification/register");
const { lookupHandler, resetDefaultRegistry } = await import("../src/discord/registry");
const { resetCommandDefinitions } = await import("../src/discord/commands/definitions");
const { CHECKIN_COMMAND_NAME } = await import("../src/checkin-classification/commands");
const { CHECKIN_INPUT_FIELD_ID, CHECKIN_MODAL_ID, parseCheckinSaveButtonId, buildCheckinSaveButtonId } =
  await import("../src/checkin-classification/custom-ids");

const env = {} as DiscordEnv;

const classificationResult: ClassificationResult = {
  items: [
    {
      text: "プライバシー境界のスモークを書いた",
      candidateGoals: [{ goalId: "goal-1", relevanceScore: 0.91, reason: "境界検証に直結" }],
      usefulness: "high",
      suggestedEvidenceTitle: "プライバシースモーク実装",
    },
  ],
};
const review: WeeklyReview = {
  summary: "今週はプライバシー境界の検証を整えた。",
  risks: [],
  next_actions: ["DM 文脈の確認"],
};

function seedCycleAndGoal(userId: string): void {
  const { repo } = doFor(userId);
  repo.insert("evaluation_cycles", {
    id: "cycle-1",
    user_id: userId,
    name: "2026 H1",
    start_date: "2026-01-01",
    end_date: "2026-06-30",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  const goal: GoalRow = {
    id: "goal-1",
    cycle_id: "cycle-1",
    user_id: userId,
    title: "境界とプライバシーを守る",
    description: "所有者スコープと ephemeral を徹底する",
    success_criteria: "全応答が本人限定であること",
    evaluation_points: null,
    status: "gray",
    created_at: "2026-01-02T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
  };
  repo.insert("goals", goal);
}

function baseCtx(
  kind: InteractionContext["kind"],
  name: string,
  userId: string,
  raw: unknown,
): InteractionContext {
  return {
    kind,
    name,
    userId,
    channelId: "chan-1",
    isDm: false,
    interactionId: "interaction-1",
    token: "tok",
    raw: raw as InteractionContext["raw"],
  };
}
function commandCtx(userId: string): InteractionContext {
  return baseCtx("command", CHECKIN_COMMAND_NAME, userId, { data: { name: CHECKIN_COMMAND_NAME } });
}
function modalCtx(userId: string, rawText: string): InteractionContext {
  return baseCtx("modal", CHECKIN_MODAL_ID, userId, {
    data: {
      custom_id: CHECKIN_MODAL_ID,
      components: [
        { type: 1, components: [{ type: 4, custom_id: CHECKIN_INPUT_FIELD_ID, value: rawText }] },
      ],
    },
  });
}
function buttonCtx(customId: string, userId: string): InteractionContext {
  return baseCtx("component", customId, userId, { data: { custom_id: customId } });
}

async function dispatch(ctx: InteractionContext): Promise<HandlerResult> {
  const handler = lookupHandler(ctx.kind, ctx.name);
  if (handler === null) throw new Error(`no handler for (${ctx.kind}, ${ctx.name})`);
  return handler.handle(ctx, env);
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

/** HandlerResult が本人限定(reply/deferred は ephemeral=true、modal は本人にしか表示されない)か。 */
function assertPersonalOnly(result: HandlerResult): void {
  if (result.mode === "reply" || result.mode === "deferred") {
    expect(result.ephemeral).toBe(true);
  }
  // modal は実行ユーザーにのみ提示されるため追加フラグ不要。
}

async function classifyPendingId(userId: string, rawText: string): Promise<string> {
  const modal = await dispatch(modalCtx(userId, rawText));
  if (modal.mode !== "deferred") throw new Error("deferred");
  const fu = makeFollowup();
  await modal.run(fu.followup);
  const rows = fu.edits[0].components as { components: { custom_id: string }[] }[];
  const saveId = rows[0].components
    .map((c) => c.custom_id)
    .find((id) => parseCheckinSaveButtonId(id) !== null);
  const pendingId = parseCheckinSaveButtonId(saveId ?? "");
  if (pendingId === null) throw new Error("pendingId");
  return pendingId;
}

beforeEach(() => {
  dos.clear();
  llmQueue.length = 0;
  resetDefaultRegistry();
  resetCommandDefinitions();
  registerCheckinClassification();
});

describe("task 5.3: critical path が単一権威に揃い、全応答が ephemeral", () => {
  it("/checkin → modal → 分類 → [保存] で証跡/リンク/週次レビューが単一 authority に揃う (6.1, 6.5)", async () => {
    seedCycleAndGoal("user-1");
    llmQueue.push({ ok: true, value: classificationResult });
    llmQueue.push({ ok: true, value: review });

    const command = await dispatch(commandCtx("user-1"));
    assertPersonalOnly(command);

    const pendingId = await classifyPendingId("user-1", "プライバシー境界のスモークを書いた");

    const save = await dispatch(buttonCtx(buildCheckinSaveButtonId(pendingId), "user-1"));
    assertPersonalOnly(save);
    if (save.mode !== "deferred") throw new Error("deferred");
    const saveFu = makeFollowup();
    await save.run(saveFu.followup);
    expect(saveFu.edits[0].content).toContain("保存しました");

    // 単一権威(user-1 の DO)に全レコードが揃う。
    const { repo } = doFor("user-1");
    expect(repo.listBy("checkins", {})).toHaveLength(1);
    expect(repo.listBy("evidence", {})).toHaveLength(1);
    expect(repo.listBy("evidence_goal_links", {})).toHaveLength(1);
    expect(repo.listBy("weekly_reviews", {})).toHaveLength(1);
    // 全レコードが所有者スコープ(user_id 一致)。
    for (const ev of repo.listBy("evidence", {})) {
      expect(ev.user_id).toBe("user-1");
    }
  });
});

describe("task 5.3: 保存前確認・所有者スコープ", () => {
  it("自動分類は [保存] なしに確定しない(分類だけでは証跡を作らない) (6.1)", async () => {
    seedCycleAndGoal("user-1");
    llmQueue.push({ ok: true, value: classificationResult });

    await classifyPendingId("user-1", "プライバシー境界のスモークを書いた");

    // pending は保持されるが、証跡・リンク・レビューは未作成。
    const { repo, ephemeral } = doFor("user-1");
    expect(ephemeral.size).toBe(1);
    expect(repo.listBy("evidence", {})).toHaveLength(0);
    expect(repo.listBy("weekly_reviews", {})).toHaveLength(0);
  });

  it("他ユーザーは他人の pending へアクセスできない(別 userId は not_found) (6.5)", async () => {
    seedCycleAndGoal("user-1");
    llmQueue.push({ ok: true, value: classificationResult });
    const pendingId = await classifyPendingId("user-1", "プライバシー境界のスモークを書いた");

    // user-2 が user-1 の pendingId を押す → user-2 の DO には pending が無く not_found。
    const save = await dispatch(buttonCtx(buildCheckinSaveButtonId(pendingId), "user-2"));
    assertPersonalOnly(save);
    if (save.mode !== "deferred") throw new Error("deferred");
    const saveFu = makeFollowup();
    await save.run(saveFu.followup);
    expect(saveFu.edits[0].content).toContain("操作できません");

    // user-1 の pending は残存、user-1/user-2 とも証跡未作成。
    expect(doFor("user-1").ephemeral.size).toBe(1);
    expect(doFor("user-1").repo.listBy("checkins", {})).toHaveLength(0);
    expect(doFor("user-2").repo.listBy("checkins", {})).toHaveLength(0);
  });
});
