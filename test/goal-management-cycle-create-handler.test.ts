// `/cycle create` ハンドラの検証(goal-management task 3.1 / Req 1.1, 1.3, 1.4, 1.6, 4.4)。
//
// 完了条件: 正常入力で createCycle 経由にサイクルが作成され、name と期間を含む
// ephemeral 確認応答(mode:"reply", ephemeral:true)が返る。不正期間
// (end_before_start / invalid_date)では createCycle が呼ばれず ephemeral エラー応答、
// 同名重複(authority が同名既存を返す)では ephemeral エラー応答。応答は全て ephemeral。
//
// 方針: DO を起動せず、in-memory な CycleDataAuthority を返すよう routing をモックして
// ハンドラ単体を検証する(実 DO 統合は task 5.1)。`vi.mock` で getUserCycleAuthority を
// 差し替える。実行環境: vitest projects の "node" プロジェクト。

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CYCLE_COMMAND_NAME,
  CYCLE_CREATE_SUBCOMMAND,
  CYCLE_OPT_END,
  CYCLE_OPT_NAME,
  CYCLE_OPT_START,
} from "../src/goal-management/commands";
import type {
  CycleDataAuthority,
} from "../src/goal-management/domain/cycle-operations";
import type { DiscordEnv } from "../src/discord/env";
import type { EntityName, EntityRow } from "../src/types";
import type { InteractionContext } from "../src/discord/types";

// routing をモックして DO 起動を避ける(in-memory authority を返す)。
const getUserCycleAuthorityMock = vi.fn<(env: DiscordEnv, userId: string) => Promise<CycleDataAuthority>>();
vi.mock("../src/goal-management/routing", () => ({
  PRIMARY_CYCLE_KEY: "primary",
  getUserCycleAuthority: (env: DiscordEnv, userId: string) =>
    getUserCycleAuthorityMock(env, userId),
}));

// モック設定後に SUT を import する。
const { cycleCreateHandler } = await import("../src/goal-management/handlers/cycle-create");

const env = {} as DiscordEnv;

/** insert を記録する in-memory CycleDataAuthority。既存行リストを差し込める。 */
function makeAuthority(existing: EntityRow<"evaluation_cycles">[] = []): {
  authority: CycleDataAuthority;
  inserted: { entity: EntityName; row: unknown }[];
} {
  const cycles: EntityRow<"evaluation_cycles">[] = [...existing];
  const inserted: { entity: EntityName; row: unknown }[] = [];
  const authority: CycleDataAuthority = {
    insertRow: async (entity, row) => {
      inserted.push({ entity, row });
      if (entity === "evaluation_cycles") {
        cycles.push(row as EntityRow<"evaluation_cycles">);
      }
    },
    getRowById: async () => null,
    listRowsBy: async <E extends EntityName>(entity: E, where: Partial<EntityRow<E>>) => {
      if (entity !== "evaluation_cycles") return [];
      return cycles.filter((c) =>
        Object.entries(where).every(([k, v]) => (c as Record<string, unknown>)[k] === v),
      ) as unknown as EntityRow<E>[];
    },
    removeRow: async () => {},
  };
  return { authority, inserted };
}

/** `/cycle create` の command interaction(type2)payload を組み立てる。 */
function cycleCreateCtx(
  name: string,
  start: string,
  end: string,
  userId = "user-1",
): InteractionContext {
  const raw = {
    id: "interaction-1",
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
    interactionId: "interaction-1",
    token: "tok-cycle",
    raw: raw as unknown as InteractionContext["raw"],
  };
}

beforeEach(() => {
  getUserCycleAuthorityMock.mockReset();
});

describe("cycleCreateHandler: /cycle create ハンドラ", () => {
  it("正常入力でサイクルを作成し name と期間を含む ephemeral 確認応答を返す (1.1, 1.3, 1.6, 4.4)", async () => {
    const { authority, inserted } = makeAuthority();
    getUserCycleAuthorityMock.mockResolvedValue(authority);

    const result = await cycleCreateHandler.handle(
      cycleCreateCtx("2026 上期", "2026-01-01", "2026-06-30"),
      env,
    );

    expect(result.mode).toBe("reply");
    if (result.mode !== "reply") throw new Error("expected reply");
    expect(result.ephemeral).toBe(true);
    expect(result.content).toContain("2026 上期");
    expect(result.content).toContain("2026-01-01");
    expect(result.content).toContain("2026-06-30");

    // createCycle 経由で evaluation_cycles が user_id 付きで insert された。
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.entity).toBe("evaluation_cycles");
    expect((inserted[0]?.row as EntityRow<"evaluation_cycles">).user_id).toBe("user-1");
    expect((inserted[0]?.row as EntityRow<"evaluation_cycles">).name).toBe("2026 上期");
  });

  it("終了が開始より前なら createCycle を呼ばず ephemeral エラー応答を返す (1.4, 4.4)", async () => {
    const result = await cycleCreateHandler.handle(
      cycleCreateCtx("逆転", "2026-06-30", "2026-01-01"),
      env,
    );

    expect(result.mode).toBe("reply");
    if (result.mode !== "reply") throw new Error("expected reply");
    expect(result.ephemeral).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
    // 検証 NG では authority 取得(=作成)に到達しない。
    expect(getUserCycleAuthorityMock).not.toHaveBeenCalled();
  });

  it("不正日付なら createCycle を呼ばず ephemeral エラー応答を返す (1.4, 4.4)", async () => {
    const result = await cycleCreateHandler.handle(
      cycleCreateCtx("不正", "not-a-date", "2026-06-30"),
      env,
    );

    expect(result.mode).toBe("reply");
    if (result.mode !== "reply") throw new Error("expected reply");
    expect(result.ephemeral).toBe(true);
    expect(getUserCycleAuthorityMock).not.toHaveBeenCalled();
  });

  it("同名重複なら ephemeral エラー応答を返し 2 件目を insert しない (1.4, 4.4)", async () => {
    const existing: EntityRow<"evaluation_cycles"> = {
      id: "cyc-existing",
      user_id: "user-1",
      name: "重複名",
      start_date: "2026-01-01",
      end_date: "2026-06-30",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    const { authority, inserted } = makeAuthority([existing]);
    getUserCycleAuthorityMock.mockResolvedValue(authority);

    const result = await cycleCreateHandler.handle(
      cycleCreateCtx("重複名", "2026-07-01", "2026-12-31"),
      env,
    );

    expect(result.mode).toBe("reply");
    if (result.mode !== "reply") throw new Error("expected reply");
    expect(result.ephemeral).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
    // 重複検出で 2 件目は insert されない。
    expect(inserted).toHaveLength(0);
  });
});
