// サイクル/目標登録の統合テスト(goal-management task 5.1 / Req 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.7, 5.1, 5.3)。
//
// このテストは個別ハンドラ単体ではなく、`/cycle create` → `/goal add`(modal 提示)→
// goal modal submit → 目標一覧取得 の一連フローが、単一の EvaluationCycleAgent データ権威
// (ユーザー単位ホーム)上で連結して機能することを検証する統合テストである。
//
// 方針: DO を起動せず、`getUserCycleAuthority` と `getUserGoalAgent` を「同一の」実 SQLite
// 権威(`createRepository(NodeSqliteBackend)` を async ラップしたアダプタ)へ差し替える。
// これにより、cycle-create ハンドラの書き込みが goal-modal-submit ハンドラと listGoals から
// 同じ単一権威として観測でき、「単一権威に揃う」整合(Req 5.3)をハンドラ層を通して保証する。
// GoalAgent も同一権威を指すことで親委譲(read-through)= 確立(Req 2.3)を再現する。
//
// ユニットテスト(cycle-create / goal-modal-submit ハンドラ)との差: 各ハンドラを「同じ」
// 永続化の上で順に実行し、ハンドラ間でデータが連結すること・複数目標が単一サイクルへ揃う
// ことを end-to-end で検証する。実行環境: vitest projects の "node" プロジェクト。

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DiscordEnv } from "../src/discord/env";
import type { HandlerResult, InteractionContext } from "../src/discord/types";
import {
  CYCLE_COMMAND_NAME,
  CYCLE_CREATE_SUBCOMMAND,
  CYCLE_OPT_END,
  CYCLE_OPT_NAME,
  CYCLE_OPT_START,
  GOAL_FIELD_DESCRIPTION,
  GOAL_FIELD_DUE_DATE,
  GOAL_FIELD_EVALUATION_POINTS,
  GOAL_FIELD_SUCCESS_CRITERIA,
  GOAL_FIELD_TITLE,
  GOAL_MODAL_ID,
} from "../src/goal-management/commands";
import {
  type CycleDataAuthority,
  listGoals,
} from "../src/goal-management/domain/cycle-operations";
import { runMigrations } from "../src/persistence/migrator";
import { createRepository } from "../src/persistence/repository";
import type { EntityName, EntityRow } from "../src/types";
import { NodeSqliteBackend } from "./helpers/node-sqlite-adapter";

// cycle/goal の両ルーティングを「同一の」権威へ向ける。これが統合テストの肝:
// 別々のハンドラが単一の EvaluationCycleAgent データ権威を共有することを再現する。
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

// モック設定後に SUT(ハンドラ群)を import する。
const { cycleCreateHandler } = await import("../src/goal-management/handlers/cycle-create");
const { goalAddHandler } = await import("../src/goal-management/handlers/goal-add");
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

/** `/cycle create` の command interaction(type2)payload を組み立てる。 */
function cycleCreateCtx(
  name: string,
  start: string,
  end: string,
  userId = "user-1",
): InteractionContext {
  const raw = {
    id: "interaction-cyc",
    application_id: "app-1",
    type: 2,
    token: "tok-cycle",
    version: 1,
    guild_id: "guild-1",
    channel_id: "chan-1",
    member: { user: { id: userId } },
    data: {
      id: "cmd-id",
      name: CYCLE_COMMAND_NAME,
      type: 1,
      options: [
        {
          name: CYCLE_CREATE_SUBCOMMAND,
          type: 1,
          options: [
            { name: CYCLE_OPT_NAME, type: 3, value: name },
            { name: CYCLE_OPT_START, type: 3, value: start },
            { name: CYCLE_OPT_END, type: 3, value: end },
          ],
        },
      ],
    },
  };
  return {
    kind: "command",
    name: CYCLE_COMMAND_NAME,
    userId,
    channelId: "chan-1",
    isDm: false,
    interactionId: "interaction-cyc",
    token: "tok-cycle",
    raw: raw as unknown as InteractionContext["raw"],
  };
}

/** `/goal add` の最小 command interaction(modal 提示はオプションに依存しない)。 */
function goalAddCtx(userId = "user-1"): InteractionContext {
  return {
    kind: "command",
    name: "goal",
    userId,
    channelId: "chan-1",
    isDm: false,
    interactionId: "interaction-goaladd",
    token: "tok-goal-add",
    raw: {} as InteractionContext["raw"],
  };
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
    id: "interaction-modal",
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
    interactionId: "interaction-modal",
    token: "tok-modal",
    raw: raw as unknown as InteractionContext["raw"],
  };
}

/** reply 応答を narrow して返す(ephemeral 確認のアサート用)。 */
function asReply(result: HandlerResult): Extract<HandlerResult, { mode: "reply" }> {
  if (result.mode !== "reply") {
    throw new Error(`expected reply, got ${result.mode}`);
  }
  return result;
}

beforeEach(() => {
  getUserCycleAuthorityMock.mockReset();
  getUserGoalAgentMock.mockReset();
});

describe("cycle/goal 登録の統合フロー(単一権威での連結)", () => {
  it("/cycle create → /goal add → modal submit が単一権威上で連結し、目標が対象サイクルへ保存される (1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.7)", async () => {
    const { db, authority } = setupAuthority();
    try {
      // 同一権威を cycle/goal 両ルーティングから返す(= 単一 EvaluationCycleAgent データホーム)。
      getUserCycleAuthorityMock.mockResolvedValue(authority);

      // GoalAgent 側は同一権威を指すが、委譲読み取り(getRowById)を spy で観測する。
      // これにより「GoalAgent 経由の確立読み取り」(Req 2.3)が統合フローで保護される。
      const goalGetRowById = vi.fn(authority.getRowById);
      const goalAuthority: CycleDataAuthority = { ...authority, getRowById: goalGetRowById };
      getUserGoalAgentMock.mockResolvedValue(goalAuthority);

      // 1) /cycle create: サイクルが user_id 付きで永続化され ephemeral 確認応答が返る(1.1, 1.3)。
      const cycleResult = asReply(
        await cycleCreateHandler.handle(
          cycleCreateCtx("2026 上期", "2026-01-01", "2026-06-30"),
          env,
        ),
      );
      expect(cycleResult.ephemeral).toBe(true);
      expect(cycleResult.content).toContain("2026 上期");
      expect(cycleResult.content).toContain("2026-01-01");
      expect(cycleResult.content).toContain("2026-06-30");

      // EvaluationCycleAgent(=単一権威)にサイクルが確立・永続化された(1.1, 1.2)。
      const cycles = await authority.listRowsBy("evaluation_cycles", { user_id: "user-1" });
      expect(cycles).toHaveLength(1);
      const cycle = cycles[0];
      if (cycle === undefined) throw new Error("cycle not persisted");
      expect(cycle.name).toBe("2026 上期");
      // cycle ルーティングが実行ユーザーのデータホーム解決に用いられた(1.2)。
      expect(getUserCycleAuthorityMock).toHaveBeenCalledWith(env, "user-1");

      // 2) /goal add: 目標入力 modal を提示する(2.1)。submit には影響しない純粋な提示。
      const addResult = await goalAddHandler.handle(goalAddCtx(), env);
      expect(addResult.mode).toBe("modal");
      if (addResult.mode !== "modal") throw new Error("expected modal");
      expect(addResult.customId).toBe(GOAL_MODAL_ID);

      // 3) goal modal submit: 同一権威上で対象サイクル(=resolveActiveCycle で解決される最新)へ
      //    目標が status='gray' で保存され、GoalAgent が確立され、目標名を含む確認応答が返る。
      const submitResult = asReply(
        await goalModalSubmitHandler.handle(
          modalSubmitCtx({
            title: "目標 A",
            description: "目標本文",
            successCriteria: "条件1\n条件2",
            evaluationPoints: "観点1\n観点2",
          }),
          env,
        ),
      );
      expect(submitResult.ephemeral).toBe(true);
      expect(submitResult.content).toContain("目標 A");

      // 目標が「直前に作成したサイクル」へ status='gray' で保存された(2.2, 2.8 相当)。
      const goals = await authority.listRowsBy("goals", { user_id: "user-1" });
      expect(goals).toHaveLength(1);
      const goal = goals[0];
      if (goal === undefined) throw new Error("goal not persisted");
      expect(goal.title).toBe("目標 A");
      expect(goal.status).toBe("gray");
      expect(goal.success_criteria).toBe("条件1\n条件2");
      // 単一権威の連結証明: cycle-create が書いたサイクル id を goal が参照する(2.2, 5.3)。
      expect(goal.cycle_id).toBe(cycle.id);

      // GoalAgent が保存済み目標 id で確立され、親委譲読み取りが当該 id で実行された(2.3)。
      expect(getUserGoalAgentMock).toHaveBeenCalledWith(env, "user-1", goal.id);
      expect(goalGetRowById).toHaveBeenCalledWith("goals", goal.id);
      const readBack = await goalGetRowById.mock.results[0]?.value;
      expect(readBack).toEqual(goal);
    } finally {
      db.close();
    }
  });

  it("/cycle create → 複数 /goal add(submit)→ listGoals で登録目標が単一権威に揃う (2.2, 5.1, 5.3)", async () => {
    const { db, authority } = setupAuthority();
    try {
      getUserCycleAuthorityMock.mockResolvedValue(authority);
      getUserGoalAgentMock.mockResolvedValue(authority);

      // 1) サイクル作成。
      await cycleCreateHandler.handle(
        cycleCreateCtx("2026 上期", "2026-01-01", "2026-06-30"),
        env,
      );
      const cycles = await authority.listRowsBy("evaluation_cycles", { user_id: "user-1" });
      const cycle = cycles[0];
      if (cycle === undefined) throw new Error("cycle not persisted");

      // 2) 複数目標を順に submit(同一権威・同一対象サイクルへ集約される)。
      await goalModalSubmitHandler.handle(
        modalSubmitCtx({ title: "目標 1", description: "本文1" }),
        env,
      );
      await goalModalSubmitHandler.handle(
        modalSubmitCtx({ title: "目標 2", description: "本文2", successCriteria: "達成2" }),
        env,
      );
      await goalModalSubmitHandler.handle(
        modalSubmitCtx({ title: "目標 3", description: "本文3", dueDate: "2026-06-30" }),
        env,
      );

      // 3) 目標一覧取得(listGoals)で 3 件すべてが単一権威・単一サイクルに揃う(5.1, 5.3)。
      const listed = await listGoals(authority, "user-1", cycle.id);
      expect(listed).toHaveLength(3);
      const titles = listed.map((g) => g.title).sort();
      expect(titles).toEqual(["目標 1", "目標 2", "目標 3"]);
      // 全目標が同一対象サイクルに属し、初期ステータス gray を持つ。
      for (const g of listed) {
        expect(g.cycle_id).toBe(cycle.id);
        expect(g.status).toBe("gray");
      }
      // dueDate を入れた目標は evaluation_points 末尾へ畳み込まれている(永続化の連結確認)。
      const goal3 = listed.find((g) => g.title === "目標 3");
      expect(goal3?.evaluation_points).toBe("期限: 2026-06-30");

      // 単一権威の総数一致: 権威直読みの件数と listGoals の件数が一致する(5.3)。
      const allGoals = await authority.listRowsBy("goals", { user_id: "user-1" });
      expect(allGoals).toHaveLength(3);
    } finally {
      db.close();
    }
  });
});
