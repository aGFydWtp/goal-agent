// goal modal submit ハンドラの検証(goal-management task 3.3 / Req 2.2, 2.3, 2.5, 2.6, 2.7, 4.4)。
//
// 完了条件:
// - 正常 submit で目標が status='gray' で保存され、GoalAgent 経由で目標が読める(確立)、
//   ephemeral 確認応答に目標名を含む(2.2, 2.3, 2.7)。
// - 必須欠落(title 空 / description 空)で不足項目を示す ephemeral 応答、goals 0 件(2.5, 4.4)。
// - 対象サイクル無しで「先にサイクル作成」ephemeral 応答、goals 0 件(2.6, 4.4)。
// - dueDate 指定時に evaluation_points 末尾へ畳み込む(addGoal 挙動。1 ケースで確認)。
// - 応答は全て ephemeral(4.4)。
//
// 方針: DO を起動せず、`getUserCycleAuthority` と `getUserGoalAgent` を同一の in-memory authority
// (実 SQLite を async ラップ)へ差し替える。GoalAgent も同じストアを指すことで親委譲(read-through)を
// 再現する。実行環境: vitest projects の "node" プロジェクト。

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DiscordEnv } from "../src/discord/env";
import type { InteractionContext } from "../src/discord/types";
import {
  GOAL_FIELD_DESCRIPTION,
  GOAL_FIELD_DUE_DATE,
  GOAL_FIELD_EVALUATION_POINTS,
  GOAL_FIELD_SUCCESS_CRITERIA,
  GOAL_FIELD_TITLE,
  GOAL_MODAL_ID,
} from "../src/goal-management/commands";
import type { CycleDataAuthority } from "../src/goal-management/domain/cycle-operations";
import { runMigrations } from "../src/persistence/migrator";
import { createRepository } from "../src/persistence/repository";
import type { EntityName, EntityRow, EvaluationCycleRow } from "../src/types";
import { NodeSqliteBackend } from "./helpers/node-sqlite-adapter";

// 同一 authority を cycle/goal の両ルーティングから返す(GoalAgent も同じストアを指す)。
const getUserCycleAuthorityMock =
  vi.fn<(env: DiscordEnv, userId: string) => Promise<CycleDataAuthority>>();
const getUserGoalAgentMock =
  vi.fn<(env: DiscordEnv, userId: string, goalId: string) => Promise<CycleDataAuthority>>();
vi.mock("../src/goal-management/routing", () => ({
  PRIMARY_CYCLE_KEY: "primary",
  getUserCycleAuthority: (env: DiscordEnv, userId: string) =>
    getUserCycleAuthorityMock(env, userId),
  getUserGoalAgent: (env: DiscordEnv, userId: string, goalId: string) =>
    getUserGoalAgentMock(env, userId, goalId),
}));

// モック設定後に SUT を import する。
const { goalModalSubmitHandler } = await import(
  "../src/goal-management/handlers/goal-modal-submit"
);

const env = {} as DiscordEnv;

/** マイグレーション適用済みの実 SQLite を CycleDataAuthority に async ラップして返す。 */
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

/** テスト用に直接 evaluation_cycles 行を作成する(対象サイクルの前提条件)。 */
async function seedCycle(authority: CycleDataAuthority): Promise<EvaluationCycleRow> {
  const cycle: EvaluationCycleRow = {
    id: "cyc-1",
    user_id: "user-1",
    name: "2026 上期",
    start_date: "2026-01-01",
    end_date: "2026-06-30",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  await authority.insertRow("evaluation_cycles", cycle);
  return cycle;
}

interface ModalFieldValues {
  title?: string;
  description?: string;
  successCriteria?: string;
  evaluationPoints?: string;
  dueDate?: string;
}

/** goal modal submit interaction(type5)payload を組み立てる。 */
function modalSubmitCtx(fields: ModalFieldValues, userId = "user-1"): InteractionContext {
  const input = (customId: string, value: string) => ({
    type: 1,
    components: [{ type: 4, custom_id: customId, value }],
  });
  const raw = {
    id: "interaction-1",
    application_id: "app-1",
    type: 5,
    token: "tok-modal",
    version: 1,
    guild_id: "guild-1",
    channel_id: "chan-1",
    member: { user: { id: userId } },
    data: {
      custom_id: GOAL_MODAL_ID,
      components: [
        input(GOAL_FIELD_TITLE, fields.title ?? ""),
        input(GOAL_FIELD_DESCRIPTION, fields.description ?? ""),
        input(GOAL_FIELD_SUCCESS_CRITERIA, fields.successCriteria ?? ""),
        input(GOAL_FIELD_EVALUATION_POINTS, fields.evaluationPoints ?? ""),
        input(GOAL_FIELD_DUE_DATE, fields.dueDate ?? ""),
      ],
    },
  };
  return {
    kind: "modal",
    name: GOAL_MODAL_ID,
    userId,
    channelId: "chan-1",
    isDm: false,
    interactionId: "interaction-1",
    token: "tok-modal",
    raw: raw as unknown as InteractionContext["raw"],
  };
}

beforeEach(() => {
  getUserCycleAuthorityMock.mockReset();
  getUserGoalAgentMock.mockReset();
});

describe("goalModalSubmitHandler: goal modal submit ハンドラ", () => {
  it("正常 submit で目標を保存し GoalAgent 経由で読め、目標名を含む ephemeral 確認応答を返す (2.2, 2.3, 2.7, 4.4)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      getUserCycleAuthorityMock.mockResolvedValue(authority);

      // GoalAgent 側は同じストアを指すが、委譲読み取り(getRowById)を spy で観測できる
      // ラッパを返す。これにより「GoalAgent 経由の確立読み取り」がテストで保護され、
      // ハンドラの委譲読み取り行を削除するとこのテストが落ちる(ミューテーション耐性)。
      const goalGetRowById = vi.fn(authority.getRowById);
      const goalAuthority: CycleDataAuthority = { ...authority, getRowById: goalGetRowById };
      getUserGoalAgentMock.mockResolvedValue(goalAuthority);

      const result = await goalModalSubmitHandler.handle(
        modalSubmitCtx({
          title: "目標 A",
          description: "目標本文",
          successCriteria: "条件1\n条件2",
          evaluationPoints: "観点1\n観点2",
        }),
        env,
      );

      expect(result.mode).toBe("reply");
      if (result.mode !== "reply") throw new Error("expected reply");
      expect(result.ephemeral).toBe(true);
      expect(result.content).toContain("目標 A");

      // goals に status='gray' で 1 件保存された。
      const rows = await authority.listRowsBy("goals", { user_id: "user-1" });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("gray");
      expect(rows[0]?.title).toBe("目標 A");
      expect(rows[0]?.cycle_id).toBe("cyc-1");
      expect(rows[0]?.success_criteria).toBe("条件1\n条件2");

      const savedId = rows[0]?.id;
      // GoalAgent ルーティングが保存された目標 ID で確立に用いられた(2.3)。
      expect(getUserGoalAgentMock).toHaveBeenCalledWith(env, "user-1", savedId);
      // GoalAgent が返す authority の委譲読み取りが保存済み goal.id を引数に実際に呼ばれた
      // (Req 2.3 の確立確認。委譲読み取り行を削除するとこの期待が落ちる)。
      expect(goalGetRowById).toHaveBeenCalledWith("goals", savedId);
      // 委譲読み取りの戻り値が保存済み goal と一致する(GoalAgent 経由で実在が読める)。
      const readBack = await goalGetRowById.mock.results[0]?.value;
      expect(readBack).toEqual(rows[0]);
    } finally {
      db.close();
    }
  });

  it("title が空なら不足項目を示す ephemeral 応答を返し goals を保存しない (2.5, 4.4)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      getUserCycleAuthorityMock.mockResolvedValue(authority);
      getUserGoalAgentMock.mockResolvedValue(authority);

      const result = await goalModalSubmitHandler.handle(
        modalSubmitCtx({ title: "", description: "本文あり" }),
        env,
      );

      expect(result.mode).toBe("reply");
      if (result.mode !== "reply") throw new Error("expected reply");
      expect(result.ephemeral).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);

      const rows = await authority.listRowsBy("goals", { user_id: "user-1" });
      expect(rows).toHaveLength(0);
      // 保存に到達しないため authority も GoalAgent 確立も呼ばれない。
      expect(getUserGoalAgentMock).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("description が空なら不足項目を示す ephemeral 応答を返し goals を保存しない (2.5, 4.4)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      getUserCycleAuthorityMock.mockResolvedValue(authority);
      getUserGoalAgentMock.mockResolvedValue(authority);

      const result = await goalModalSubmitHandler.handle(
        modalSubmitCtx({ title: "目標あり", description: "" }),
        env,
      );

      expect(result.mode).toBe("reply");
      if (result.mode !== "reply") throw new Error("expected reply");
      expect(result.ephemeral).toBe(true);

      const rows = await authority.listRowsBy("goals", { user_id: "user-1" });
      expect(rows).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("対象サイクルが無ければ先にサイクル作成が必要な旨の ephemeral 応答を返し goals を保存しない (2.6, 4.4)", async () => {
    const { db, authority } = setupAuthority();
    try {
      // サイクルを seed しない。
      getUserCycleAuthorityMock.mockResolvedValue(authority);
      getUserGoalAgentMock.mockResolvedValue(authority);

      const result = await goalModalSubmitHandler.handle(
        modalSubmitCtx({ title: "目標 A", description: "本文" }),
        env,
      );

      expect(result.mode).toBe("reply");
      if (result.mode !== "reply") throw new Error("expected reply");
      expect(result.ephemeral).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);

      const rows = await authority.listRowsBy("goals", { user_id: "user-1" });
      expect(rows).toHaveLength(0);
      // 保存失敗のため GoalAgent 確立に到達しない。
      expect(getUserGoalAgentMock).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("dueDate を入れると evaluation_points 末尾へ畳み込まれる (2.2)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await seedCycle(authority);
      getUserCycleAuthorityMock.mockResolvedValue(authority);
      getUserGoalAgentMock.mockResolvedValue(authority);

      const result = await goalModalSubmitHandler.handle(
        modalSubmitCtx({
          title: "目標 A",
          description: "本文",
          evaluationPoints: "観点1",
          dueDate: "2026-06-30",
        }),
        env,
      );

      expect(result.mode).toBe("reply");
      if (result.mode !== "reply") throw new Error("expected reply");

      const rows = await authority.listRowsBy("goals", { user_id: "user-1" });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.evaluation_points).toBe("観点1\n期限: 2026-06-30");
    } finally {
      db.close();
    }
  });
});
