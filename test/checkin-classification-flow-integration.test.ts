// checkin-classification 結合テスト(task 5.1 分類フロー / 5.2 保存・週次レビュー・破棄・修正)。
//
// `/checkin` → [入力する] → modal → 分類(deferred)→ 確認 → [保存]/[破棄]/[修正] の経路を、
// registerCheckinClassification() で登録したハンドラを lookupHandler 経由で解決・実行して結合検証する
// (登録 → ディスパッチ解決 → ハンドラ → ドメイン → 揮発 KV / 単一権威の全経路)。
//
// 方針: DO 境界(agents/routing)を fake stub(per-user real SQLite repo + 揮発 Map)へ、LLM を FIFO
// キューの fake へ差し替える(モック LLM/ゲートウェイ)。実行環境: vitest "node" プロジェクト。

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

// FIFO の LLM 結果キュー(分類 → 週次レビューの順で消費)。
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
const {
  CHECKIN_INPUT_BUTTON_ID,
  CHECKIN_INPUT_FIELD_ID,
  CHECKIN_MODAL_ID,
  parseCheckinSaveButtonId,
  buildCheckinSaveButtonId,
  buildCheckinEditButtonId,
  buildCheckinDiscardButtonId,
} = await import("../src/checkin-classification/custom-ids");

const env = {} as DiscordEnv;

const classificationResult: ClassificationResult = {
  items: [
    {
      text: "結合テストを実装した",
      candidateGoals: [{ goalId: "goal-1", relevanceScore: 0.88, reason: "テスト実装に直結" }],
      usefulness: "high",
      suggestedEvidenceTitle: "結合テスト実装",
    },
    {
      text: "ドキュメントの誤字を直した",
      candidateGoals: [],
      usefulness: "low",
      suggestedEvidenceTitle: "誤字修正",
    },
  ],
};

const review: WeeklyReview = {
  summary: "今週は結合テストの整備が進んだ。",
  risks: ["LLM 出力のばらつき"],
  next_actions: ["E2E スモークを追加する"],
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
    title: "テスト整備で品質を上げる",
    description: "結合/E2E テストを整備する",
    success_criteria: "主要フローのテストを揃える",
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
function inputButtonCtx(userId: string): InteractionContext {
  return baseCtx("component", CHECKIN_INPUT_BUTTON_ID, userId, {
    data: { custom_id: CHECKIN_INPUT_BUTTON_ID },
  });
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

/** 登録済みハンドラを lookupHandler で解決して実行する(ディスパッチ解決も同時に検証)。 */
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

/** modal submit を実行し、確認 follow-up から pendingId を取り出す。 */
async function classifyAndGetPendingId(userId: string, rawText: string): Promise<string> {
  const result = await dispatch(modalCtx(userId, rawText));
  if (result.mode !== "deferred") throw new Error("expected deferred");
  const { followup, edits } = makeFollowup();
  await result.run(followup);
  const rows = edits[0].components as { components: { custom_id: string }[] }[];
  const saveId = rows[0].components
    .map((c) => c.custom_id)
    .find((id) => parseCheckinSaveButtonId(id) !== null);
  const pendingId = parseCheckinSaveButtonId(saveId ?? "");
  if (pendingId === null) throw new Error("pendingId not found");
  return pendingId;
}

beforeEach(() => {
  dos.clear();
  llmQueue.length = 0;
  resetDefaultRegistry();
  resetCommandDefinitions();
  registerCheckinClassification();
});

describe("task 5.1: 分類フロー結合", () => {
  it("/checkin → [入力する] → modal → 分類 で確認メッセージ + 3 ボタン + 未分類保持 (1.2, 1.3, 2.5, 3.1, 3.2)", async () => {
    seedCycleAndGoal("user-1");
    llmQueue.push({ ok: true, value: classificationResult });

    // /checkin: 促し + [入力する] ボタン。
    const command = await dispatch(commandCtx("user-1"));
    expect(command.mode).toBe("reply");
    if (command.mode !== "reply") throw new Error("reply");
    expect(command.ephemeral).toBe(true);
    expect(command.components?.[0].components[0].custom_id).toBe(CHECKIN_INPUT_BUTTON_ID);

    // [入力する]: modal を開く。
    const input = await dispatch(inputButtonCtx("user-1"));
    expect(input.mode).toBe("modal");

    // modal submit: deferred → 確認メッセージ + 3 ボタン。
    const modal = await dispatch(modalCtx("user-1", "結合テストを実装した。誤字も直した。"));
    expect(modal.mode).toBe("deferred");
    if (modal.mode !== "deferred") throw new Error("deferred");
    const { followup, edits } = makeFollowup();
    await modal.run(followup);

    expect(edits).toHaveLength(1);
    expect(edits[0].content).toContain("保存しますか");
    // 未分類項目が確認メッセージに保持される(Req 2.5)。
    expect(edits[0].content).toContain("未分類");
    expect(edits[0].content).toContain("誤字");
    const rows = edits[0].components as { components: { custom_id: string }[] }[];
    expect(rows[0].components).toHaveLength(3);
    // 証跡は未作成(保存前確認)。
    expect(doFor("user-1").repo.listBy("evidence", {})).toHaveLength(0);
  });

  it("サイクル無しで /checkin は案内のみ・ボタンを出さない (1.2)", async () => {
    const command = await dispatch(commandCtx("user-1"));
    if (command.mode !== "reply") throw new Error("reply");
    expect(command.components === undefined || command.components.length === 0).toBe(true);
  });

  it("空入力 modal は ephemeral 通知で分類しない (1.4)", async () => {
    seedCycleAndGoal("user-1");
    const result = await dispatch(modalCtx("user-1", "   "));
    expect(result.mode).toBe("reply");
  });
});

describe("task 5.2: 保存・週次レビュー・破棄/修正 結合", () => {
  it("[保存] で checkins/evidence/links + weekly_review を単一権威に作り §14.2 を返す (4.*, 5.1-5.3)", async () => {
    seedCycleAndGoal("user-1");
    llmQueue.push({ ok: true, value: classificationResult });
    llmQueue.push({ ok: true, value: review });

    const pendingId = await classifyAndGetPendingId("user-1", "結合テストを実装した。誤字も直した。");

    const save = await dispatch(buttonCtx(buildCheckinSaveButtonId(pendingId), "user-1"));
    if (save.mode !== "deferred") throw new Error("deferred");
    const { followup, edits } = makeFollowup();
    await save.run(followup);

    expect(edits[0].content).toContain("保存しました");
    expect(edits[0].content).toContain(review.summary);
    const { repo, ephemeral } = doFor("user-1");
    expect(repo.listBy("checkins", {})).toHaveLength(1);
    expect(repo.listBy("evidence", {})).toHaveLength(2);
    expect(repo.listBy("evidence_goal_links", {})).toHaveLength(1);
    expect(repo.listBy("weekly_reviews", {})).toHaveLength(1);
    expect(ephemeral.size).toBe(0); // pending 破棄済み。
  });

  it("[破棄] で確定されず通知し、証跡を作らない (3.4)", async () => {
    seedCycleAndGoal("user-1");
    llmQueue.push({ ok: true, value: classificationResult });
    const pendingId = await classifyAndGetPendingId("user-1", "結合テストを実装した。誤字も直した。");

    const discard = await dispatch(buttonCtx(buildCheckinDiscardButtonId(pendingId), "user-1"));
    if (discard.mode !== "reply") throw new Error("reply");
    expect(discard.content).toContain("破棄");
    expect(doFor("user-1").repo.listBy("evidence", {})).toHaveLength(0);
    expect(doFor("user-1").ephemeral.size).toBe(0);
  });

  it("[修正] で編集 modal を提示する (3.5)", async () => {
    seedCycleAndGoal("user-1");
    llmQueue.push({ ok: true, value: classificationResult });
    const pendingId = await classifyAndGetPendingId("user-1", "結合テストを実装した。誤字も直した。");

    const edit = await dispatch(buttonCtx(buildCheckinEditButtonId(pendingId), "user-1"));
    expect(edit.mode).toBe("modal");
    if (edit.mode !== "modal") throw new Error("modal");
    expect(edit.components[0].components[0].value).toContain("結合テストを実装した");
  });

  it("レビュー生成失敗でも証跡保存を保持し失敗のみ通知する (5.5)", async () => {
    seedCycleAndGoal("user-1");
    llmQueue.push({ ok: true, value: classificationResult });
    llmQueue.push({ ok: false, error: { kind: "provider_error", message: "down" } });
    const pendingId = await classifyAndGetPendingId("user-1", "結合テストを実装した。誤字も直した。");

    const save = await dispatch(buttonCtx(buildCheckinSaveButtonId(pendingId), "user-1"));
    if (save.mode !== "deferred") throw new Error("deferred");
    const { followup, edits } = makeFollowup();
    await save.run(followup);

    expect(edits[0].content).toContain("保存しました");
    expect(doFor("user-1").repo.listBy("evidence", {})).toHaveLength(2);
    expect(doFor("user-1").repo.listBy("weekly_reviews", {})).toHaveLength(0);
  });
});
