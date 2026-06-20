// checkin modal submit ハンドラ(checkin-classification task 3.2 / Req 1.3, 1.4, 2.6, 2.7, 3.1, 3.2)。
//
// 完了条件: 入力ありで deferred(type5)を即返し、follow-up に確認メッセージ + 保存/修正/破棄の
// 3 ボタンが届く。空入力で ephemeral 通知。分類失敗で再試行案内が届き、証跡が作られない。
//
// 方針: DO を起動せず、DO 境界(agents/routing の getCycleAgent)を fake stub(per-user の real
// SQLite repo + 揮発 Map)へ差し替える。routing ブリッジ・domain は real 実体を使い、handler→domain→
// 揮発 KV の結合を検証する。llm factory も fake へ差し替える。実行環境: vitest "node" プロジェクト。

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClassificationResult } from "../src/checkin-classification/classification/schema";
import type { DiscordEnv } from "../src/discord/env";
import type { Followup, InteractionContext, SendResult } from "../src/discord/types";
import type { LlmClient, LlmCompletionRequest, LlmResult } from "../src/llm/client";
import { runMigrations } from "../src/persistence/migrator";
import { createRepository, type Repository } from "../src/persistence/repository";
import type { GoalRow } from "../src/types";
import { NodeSqliteBackend } from "./helpers/node-sqlite-adapter";

// ---- per-user の fake DO(real SQLite repo + 揮発 Map)レジストリ -----------------
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
    insertRow: async (entity: string, row: unknown) =>
      // biome-ignore lint/suspicious/noExplicitAny: テスト用ブリッジ
      repo.insert(entity as any, row as any),
    getRowById: async (entity: string, id: string) =>
      // biome-ignore lint/suspicious/noExplicitAny: テスト用ブリッジ
      repo.getById(entity as any, id),
    listRowsBy: async (entity: string, where: unknown) =>
      // biome-ignore lint/suspicious/noExplicitAny: テスト用ブリッジ
      repo.listBy(entity as any, where as any),
    updateRow: async (entity: string, id: string, patch: unknown) =>
      // biome-ignore lint/suspicious/noExplicitAny: テスト用ブリッジ
      repo.update(entity as any, id, patch as any),
    // biome-ignore lint/suspicious/noExplicitAny: テスト用ブリッジ
    removeRow: async (entity: string, id: string) => repo.remove(entity as any, id),
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

// fake LLM を差し替えるための可変ホルダ。
let nextClassification: LlmResult<ClassificationResult> = {
  ok: false,
  error: { kind: "invalid_output", message: "unset" },
};
class FakeLlmClient implements LlmClient {
  async complete(): Promise<LlmResult<string>> {
    return { ok: true, value: "" };
  }
  async completeJson(_req: LlmCompletionRequest): Promise<LlmResult<ClassificationResult>> {
    return nextClassification as LlmResult<never>;
  }
}
vi.mock("../src/llm/factory", () => ({
  createLlmClient: () => new FakeLlmClient(),
}));

const { checkinModalSubmitHandler } = await import(
  "../src/checkin-classification/handlers/checkin-modal-submit"
);
const {
  CHECKIN_INPUT_FIELD_ID,
  parseCheckinSaveButtonId,
  parseCheckinEditButtonId,
  parseCheckinDiscardButtonId,
} = await import("../src/checkin-classification/custom-ids");

const env = {} as DiscordEnv;

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
    title: "AI 活用で開発効率を上げる",
    description: "開発に AI 支援を組み込む",
    success_criteria: "週次で改善実績を記録する",
    evaluation_points: null,
    status: "gray",
    created_at: "2026-01-02T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
  };
  repo.insert("goals", goal);
}

const validClassification: ClassificationResult = {
  items: [
    {
      text: "分類ハンドラを実装した",
      candidateGoals: [{ goalId: "goal-1", relevanceScore: 0.9, reason: "実装完了に直結" }],
      usefulness: "high",
      suggestedEvidenceTitle: "分類ハンドラ実装",
    },
    {
      text: "雑談チャンネルを整理した",
      candidateGoals: [],
      usefulness: "low",
      suggestedEvidenceTitle: "雑談整理",
    },
  ],
};

/** modal submit interaction の最小 InteractionContext を組み立てる(入力フィールド付き)。 */
function modalCtx(rawText: string, userId = "user-1"): InteractionContext {
  return {
    kind: "modal",
    name: "checkin:modal",
    userId,
    channelId: "chan-1",
    isDm: false,
    interactionId: "interaction-1",
    token: "tok-modal",
    raw: {
      data: {
        custom_id: "checkin:modal",
        components: [
          { type: 1, components: [{ type: 4, custom_id: CHECKIN_INPUT_FIELD_ID, value: rawText }] },
        ],
      },
    } as unknown as InteractionContext["raw"],
  };
}

/** editOriginal/send の呼び出しを記録する fake Followup。 */
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
  nextClassification = { ok: false, error: { kind: "invalid_output", message: "unset" } };
});

describe("checkinModalSubmitHandler: 空入力ガード", () => {
  it("空入力で deferred せず ephemeral 通知を返す (1.4)", async () => {
    const result = await checkinModalSubmitHandler.handle(modalCtx("   "), env);
    expect(result.mode).toBe("reply");
    if (result.mode !== "reply") throw new Error("expected reply");
    expect(result.ephemeral).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
  });
});

describe("checkinModalSubmitHandler: 分類成功", () => {
  it("入力ありで deferred を返し、follow-up に確認メッセージ + 3 ボタンを送る (2.7, 3.1, 3.2)", async () => {
    seedCycleAndGoal("user-1");
    nextClassification = { ok: true, value: validClassification };

    const result = await checkinModalSubmitHandler.handle(modalCtx("今週やったこと"), env);
    expect(result.mode).toBe("deferred");
    if (result.mode !== "deferred") throw new Error("expected deferred");
    expect(result.ephemeral).toBe(true);

    const { followup, edits } = makeFollowup();
    await result.run(followup);

    expect(edits).toHaveLength(1);
    const edit = edits[0];
    expect(edit.content).toContain("保存しますか");
    // 3 ボタン(保存/修正/破棄)が pendingId 埋め込みで届く。
    const rows = edit.components as { components: { custom_id: string }[] }[];
    expect(rows).toHaveLength(1);
    const ids = rows[0].components.map((c) => c.custom_id);
    expect(ids).toHaveLength(3);
    const saveId = ids.find((id) => parseCheckinSaveButtonId(id) !== null);
    const editId = ids.find((id) => parseCheckinEditButtonId(id) !== null);
    const discardId = ids.find((id) => parseCheckinDiscardButtonId(id) !== null);
    expect(saveId).toBeDefined();
    expect(editId).toBeDefined();
    expect(discardId).toBeDefined();
    // 3 ボタンは同一 pendingId を指す。
    const pendingId = parseCheckinSaveButtonId(saveId ?? "");
    expect(pendingId).not.toBeNull();
    expect(parseCheckinEditButtonId(editId ?? "")).toBe(pendingId);
    expect(parseCheckinDiscardButtonId(discardId ?? "")).toBe(pendingId);

    // pending 分類が揮発 KV に保持されている。
    expect(doFor("user-1").ephemeral.get(`checkin:pending:${pendingId}`)).toBeDefined();

    // 証跡は作られていない(保存前確認のみ / Req 2.6 補完)。
    expect(doFor("user-1").repo.listBy("evidence", {})).toHaveLength(0);
  });
});

describe("checkinModalSubmitHandler: 分類失敗", () => {
  it("invalid_output で再試行案内を follow-up し、証跡を作らない (2.6)", async () => {
    seedCycleAndGoal("user-1");
    nextClassification = { ok: false, error: { kind: "invalid_output", message: "bad json" } };

    const result = await checkinModalSubmitHandler.handle(modalCtx("今週やったこと"), env);
    if (result.mode !== "deferred") throw new Error("expected deferred");

    const { followup, edits } = makeFollowup();
    await result.run(followup);

    expect(edits).toHaveLength(1);
    expect(edits[0].content).toContain("分類に失敗");
    expect(edits[0].components).toBeUndefined();

    expect(doFor("user-1").ephemeral.size).toBe(0);
    expect(doFor("user-1").repo.listBy("evidence", {})).toHaveLength(0);
  });

  it("対象サイクル無しで案内を follow-up し分類しない", async () => {
    // サイクル未シードのまま実行。
    nextClassification = { ok: true, value: validClassification };
    const result = await checkinModalSubmitHandler.handle(modalCtx("今週やったこと"), env);
    if (result.mode !== "deferred") throw new Error("expected deferred");

    const { followup, edits } = makeFollowup();
    await result.run(followup);

    expect(edits).toHaveLength(1);
    expect(edits[0].content).toContain("サイクル");
    expect(doFor("user-1").ephemeral.size).toBe(0);
  });
});
