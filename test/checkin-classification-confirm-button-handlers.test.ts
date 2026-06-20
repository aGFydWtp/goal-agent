// 保存/修正/破棄ボタンハンドラ(checkin-classification task 3.3 / Req 3.3, 3.4, 3.5, 3.6, 3.7,
// 4.*, 5.1, 5.2, 5.3, 5.5)。
//
// 完了条件: [保存] で証跡 + 週次レビューが作られ §14.2 メッセージが ephemeral 表示、レビュー失敗時も
// 証跡保持 + 失敗通知、[破棄] で確定されず通知、[修正] で編集 modal 提示、不在/別人 pending で操作不可。
//
// 方針: DO 境界(agents/routing)を fake stub(per-user real SQLite repo + 揮発 Map)へ差し替え、routing/
// domain は real。pending は事前に揮発 KV へ投入してボタン操作を検証する。実行環境: vitest "node"。

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClassificationResult } from "../src/checkin-classification/classification/schema";
import type { PendingCheckinClassification } from "../src/checkin-classification/domain/checkin-operations";
import type { WeeklyReview } from "../src/checkin-classification/weekly-review/schema";
import type { DiscordEnv } from "../src/discord/env";
import type { Followup, InteractionContext, SendResult } from "../src/discord/types";
import type { LlmClient, LlmCompletionRequest, LlmResult } from "../src/llm/client";
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
  PRIMARY_CYCLE_KEY: "primary",
  getCycleAgent: async (_env: unknown, userId: string) => doFor(userId).stub,
  getGoalAgent: async (_env: unknown, userId: string) => doFor(userId).stub,
}));

let nextReview: LlmResult<WeeklyReview> = {
  ok: false,
  error: { kind: "invalid_output", message: "unset" },
};
class FakeLlmClient implements LlmClient {
  async complete(): Promise<LlmResult<string>> {
    return { ok: true, value: "" };
  }
  async completeJson(_req: LlmCompletionRequest): Promise<LlmResult<WeeklyReview>> {
    return nextReview as LlmResult<never>;
  }
}
vi.mock("../src/llm/factory", () => ({
  createLlmClient: () => new FakeLlmClient(),
}));

const { saveButtonHandler } = await import("../src/checkin-classification/handlers/save-button");
const { discardButtonHandler } = await import(
  "../src/checkin-classification/handlers/discard-button"
);
const { editButtonHandler } = await import("../src/checkin-classification/handlers/edit-button");
const {
  buildCheckinSaveButtonId,
  buildCheckinEditButtonId,
  buildCheckinDiscardButtonId,
  CHECKIN_INPUT_FIELD_ID,
} = await import("../src/checkin-classification/custom-ids");

const env = {} as DiscordEnv;

const classificationResult: ClassificationResult = {
  items: [
    {
      text: "保存ハンドラを実装した",
      candidateGoals: [
        { goalId: "goal-1", relevanceScore: 0.9, reason: "実装に直結" },
        { goalId: "goal-2", relevanceScore: 0.6, reason: "基盤になる" },
      ],
      usefulness: "high",
      suggestedEvidenceTitle: "保存ハンドラ実装",
    },
    {
      text: "雑談を整理した",
      candidateGoals: [],
      usefulness: "low",
      suggestedEvidenceTitle: "雑談整理",
    },
  ],
};

const review: WeeklyReview = {
  summary: "今週は保存ハンドラの実装が進んだ。",
  risks: ["レビュー生成のばらつき"],
  next_actions: ["結合テストを追加する"],
};

function goalRow(id: string, userId: string): GoalRow {
  return {
    id,
    cycle_id: "cycle-1",
    user_id: userId,
    title: `目標 ${id}`,
    description: "説明",
    success_criteria: "条件",
    evaluation_points: null,
    status: "gray",
    created_at: "2026-01-02T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
  };
}

/** サイクル + 目標 2 件をシードし、pending 分類を揮発 KV へ投入する。 */
function seedPending(userId: string, pendingId: string): void {
  const { repo, ephemeral } = doFor(userId);
  repo.insert("evaluation_cycles", {
    id: "cycle-1",
    user_id: userId,
    name: "2026 H1",
    start_date: "2026-01-01",
    end_date: "2026-06-30",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  repo.insert("goals", goalRow("goal-1", userId));
  repo.insert("goals", goalRow("goal-2", userId));
  const pending: PendingCheckinClassification = {
    pendingId,
    userId,
    cycleId: "cycle-1",
    rawText: "今週は保存ハンドラを実装した。雑談も整理した。",
    result: classificationResult,
    createdAt: "2026-06-14T12:00:00.000Z",
  };
  ephemeral.set(`checkin:pending:${pendingId}`, JSON.stringify(pending));
}

function buttonCtx(customId: string, userId = "user-1"): InteractionContext {
  return {
    kind: "component",
    name: customId,
    userId,
    channelId: "chan-1",
    isDm: false,
    interactionId: "interaction-1",
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

beforeEach(() => {
  dos.clear();
  nextReview = { ok: false, error: { kind: "invalid_output", message: "unset" } };
});

describe("saveButtonHandler", () => {
  it("[保存] で証跡 + 複数リンク + 週次レビューを作り §14.2 メッセージを返す (4.1-4.5, 5.1-5.3)", async () => {
    seedPending("user-1", "pending-1");
    nextReview = { ok: true, value: review };

    const result = await saveButtonHandler.handle(
      buttonCtx(buildCheckinSaveButtonId("pending-1")),
      env,
    );
    expect(result.mode).toBe("deferred");
    if (result.mode !== "deferred") throw new Error("expected deferred");

    const { followup, edits } = makeFollowup();
    await result.run(followup);

    expect(edits).toHaveLength(1);
    expect(edits[0].content).toContain("保存しました");
    expect(edits[0].content).toContain(review.summary);

    const { repo, ephemeral } = doFor("user-1");
    expect(repo.listBy("checkins", {})).toHaveLength(1);
    expect(repo.listBy("evidence", {})).toHaveLength(2);
    // 1 つの証跡が 2 目標に関連 → 2 リンク。
    expect(repo.listBy("evidence_goal_links", {})).toHaveLength(2);
    expect(repo.listBy("weekly_reviews", {})).toHaveLength(1);
    // 全レコードに所有者識別子が付与されている。
    for (const checkin of repo.listBy("checkins", {})) {
      expect(checkin.user_id).toBe("user-1");
    }
    // 保存後に pending は破棄されている。
    expect(ephemeral.has("checkin:pending:pending-1")).toBe(false);
  });

  it("レビュー失敗時も証跡保存を保持し、レビュー失敗のみ通知する (5.5)", async () => {
    seedPending("user-1", "pending-1");
    nextReview = { ok: false, error: { kind: "provider_error", message: "down" } };

    const result = await saveButtonHandler.handle(
      buttonCtx(buildCheckinSaveButtonId("pending-1")),
      env,
    );
    if (result.mode !== "deferred") throw new Error("expected deferred");
    const { followup, edits } = makeFollowup();
    await result.run(followup);

    expect(edits[0].content).toContain("保存しました");
    expect(edits[0].content).toContain("レビュー");
    const { repo } = doFor("user-1");
    expect(repo.listBy("evidence", {})).toHaveLength(2);
    expect(repo.listBy("weekly_reviews", {})).toHaveLength(0);
  });

  it("不在 pending で操作不可を通知し、何も保存しない (3.7)", async () => {
    // pending 未投入。
    const result = await saveButtonHandler.handle(
      buttonCtx(buildCheckinSaveButtonId("missing")),
      env,
    );
    if (result.mode !== "deferred") throw new Error("expected deferred");
    const { followup, edits } = makeFollowup();
    await result.run(followup);

    expect(edits[0].content).toContain("操作できません");
    expect(doFor("user-1").repo.listBy("checkins", {})).toHaveLength(0);
  });

  it("別人 pending は not_found として保存しない (3.7)", async () => {
    seedPending("user-1", "pending-1");
    // user-2 が user-1 の pendingId を押しても、user-2 の DO には pending が無い。
    const result = await saveButtonHandler.handle(
      buttonCtx(buildCheckinSaveButtonId("pending-1"), "user-2"),
      env,
    );
    if (result.mode !== "deferred") throw new Error("expected deferred");
    const { followup, edits } = makeFollowup();
    await result.run(followup);

    expect(edits[0].content).toContain("操作できません");
    // user-1 の pending は残存(他人操作で消えない)、user-1 側も未保存。
    expect(doFor("user-1").ephemeral.has("checkin:pending:pending-1")).toBe(true);
    expect(doFor("user-1").repo.listBy("checkins", {})).toHaveLength(0);
  });
});

describe("discardButtonHandler", () => {
  it("[破棄] で pending を破棄し確定されない旨を通知する (3.4)", async () => {
    seedPending("user-1", "pending-1");
    const result = await discardButtonHandler.handle(
      buttonCtx(buildCheckinDiscardButtonId("pending-1")),
      env,
    );
    expect(result.mode).toBe("reply");
    if (result.mode !== "reply") throw new Error("expected reply");
    expect(result.ephemeral).toBe(true);
    expect(result.content).toContain("破棄");
    expect(doFor("user-1").ephemeral.has("checkin:pending:pending-1")).toBe(false);
    expect(doFor("user-1").repo.listBy("checkins", {})).toHaveLength(0);
  });

  it("不在 pending で操作不可を通知する (3.7)", async () => {
    const result = await discardButtonHandler.handle(
      buttonCtx(buildCheckinDiscardButtonId("missing")),
      env,
    );
    if (result.mode !== "reply") throw new Error("expected reply");
    expect(result.content).toContain("操作できません");
  });
});

describe("editButtonHandler", () => {
  it("[修正] で元の自由文を充填した編集 modal を提示する (3.5)", async () => {
    seedPending("user-1", "pending-1");
    const result = await editButtonHandler.handle(
      buttonCtx(buildCheckinEditButtonId("pending-1")),
      env,
    );
    expect(result.mode).toBe("modal");
    if (result.mode !== "modal") throw new Error("expected modal");
    const field = result.components[0].components[0];
    expect(field.custom_id).toBe(CHECKIN_INPUT_FIELD_ID);
    expect(field.value).toContain("保存ハンドラを実装した");
    // 旧 pending は破棄され、再送信で新規 pending が作られる。
    expect(doFor("user-1").ephemeral.has("checkin:pending:pending-1")).toBe(false);
  });

  it("不在 pending で操作不可を通知する (3.7)", async () => {
    const result = await editButtonHandler.handle(
      buttonCtx(buildCheckinEditButtonId("missing")),
      env,
    );
    expect(result.mode).toBe("reply");
    if (result.mode !== "reply") throw new Error("expected reply");
    expect(result.content).toContain("操作できません");
  });
});
