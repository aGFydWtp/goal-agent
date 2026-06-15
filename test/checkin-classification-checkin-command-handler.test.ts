// `/checkin` コマンドハンドラ(checkin-classification task 3.1 / Req 1.1, 1.2, 1.5)のユニットテスト。
//
// 完了条件: 対象サイクル有りで促し文 + [入力する] ボタンを ephemeral 即時応答、無しで
// サイクル未作成案内のみを ephemeral で返し分類フローを開始しない(ボタンを出さない)。
//
// 方針: DO を起動せず、in-memory な CycleDataAuthority を返すよう routing をモックして
// ハンドラ単体を検証する。`vi.mock` で getUserCycleAuthority を差し替える。実行環境:
// vitest projects の "node" プロジェクト。

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CycleDataAuthority } from "../src/goal-management/domain/cycle-operations";
import type { DiscordEnv } from "../src/discord/env";
import type { EntityName, EntityRow } from "../src/types";
import type { InteractionContext } from "../src/discord/types";
import { CHECKIN_COMMAND_NAME } from "../src/checkin-classification/commands";
import { CHECKIN_INPUT_BUTTON_ID } from "../src/checkin-classification/custom-ids";
import { formatCheckinPromptMessage } from "../src/checkin-classification/messages";

// routing をモックして DO 起動を避ける(in-memory authority を返す)。
const getUserCycleAuthorityMock =
  vi.fn<(env: DiscordEnv, userId: string) => Promise<CycleDataAuthority>>();
vi.mock("../src/goal-management/routing", () => ({
  PRIMARY_CYCLE_KEY: "primary",
  getUserCycleAuthority: (env: DiscordEnv, userId: string) =>
    getUserCycleAuthorityMock(env, userId),
}));

// モック設定後に SUT を import する。
const { checkinCommandHandler } = await import(
  "../src/checkin-classification/handlers/checkin-command"
);

const env = {} as DiscordEnv;

/** listRowsBy("evaluation_cycles", ...) のみを応答する最小 CycleDataAuthority。 */
function makeAuthority(cycles: EntityRow<"evaluation_cycles">[] = []): CycleDataAuthority {
  return {
    insertRow: async () => {},
    getRowById: async () => null,
    listRowsBy: async <E extends EntityName>(entity: E, where: Partial<EntityRow<E>>) => {
      if (entity !== "evaluation_cycles") return [];
      return cycles.filter((c) =>
        Object.entries(where).every(([k, v]) => (c as Record<string, unknown>)[k] === v),
      ) as unknown as EntityRow<E>[];
    },
    removeRow: async () => {},
  };
}

/** 指定ユーザー所有のサイクル行を組み立てる。 */
function makeCycle(userId: string): EntityRow<"evaluation_cycles"> {
  return {
    id: "cyc-1",
    user_id: userId,
    name: "2026 上期",
    start_date: "2026-01-01",
    end_date: "2026-06-30",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

/** `/checkin` の command interaction(type2)の最小 InteractionContext を組み立てる。 */
function checkinCtx(userId = "user-1"): InteractionContext {
  return {
    kind: "command",
    name: CHECKIN_COMMAND_NAME,
    userId,
    channelId: "chan-1",
    isDm: false,
    interactionId: "interaction-1",
    token: "tok-checkin",
    raw: { data: { name: CHECKIN_COMMAND_NAME } } as unknown as InteractionContext["raw"],
  };
}

beforeEach(() => {
  getUserCycleAuthorityMock.mockReset();
});

describe("checkinCommandHandler: /checkin コマンドハンドラ", () => {
  it("対象サイクル有りで促し文 + [入力する] ボタンを ephemeral 即時応答する (1.1, 1.5)", async () => {
    getUserCycleAuthorityMock.mockResolvedValue(makeAuthority([makeCycle("user-1")]));

    const result = await checkinCommandHandler.handle(checkinCtx("user-1"), env);

    expect(result.mode).toBe("reply");
    if (result.mode !== "reply") throw new Error("expected reply");
    expect(result.ephemeral).toBe(true);
    expect(result.content).toBe(formatCheckinPromptMessage());

    // [入力する] ボタンを 1 つ持つ action row が 1 つ。
    expect(result.components).toBeDefined();
    const components = result.components ?? [];
    expect(components).toHaveLength(1);
    expect(components[0].type).toBe(1);
    expect(components[0].components).toHaveLength(1);

    const button = components[0].components[0];
    expect(button.type).toBe(2);
    expect(button.custom_id).toBe(CHECKIN_INPUT_BUTTON_ID);
    expect(button.label.length).toBeGreaterThan(0);
    expect([1, 2, 3, 4]).toContain(button.style);
  });

  it("対象サイクル無しで案内のみを ephemeral 応答し、ボタンを出さない (1.2, 1.5)", async () => {
    getUserCycleAuthorityMock.mockResolvedValue(makeAuthority([]));

    const result = await checkinCommandHandler.handle(checkinCtx("user-1"), env);

    expect(result.mode).toBe("reply");
    if (result.mode !== "reply") throw new Error("expected reply");
    expect(result.ephemeral).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);
    // 分類フローを開始しない: ボタン(=次の入力導線)を提示しない。
    expect(result.components === undefined || result.components.length === 0).toBe(true);
    // 促し文とは別の案内であること。
    expect(result.content).not.toBe(formatCheckinPromptMessage());
  });

  it("実行ユーザーの userId で authority を解決する (1.2)", async () => {
    getUserCycleAuthorityMock.mockResolvedValue(makeAuthority([makeCycle("user-9")]));

    await checkinCommandHandler.handle(checkinCtx("user-9"), env);

    expect(getUserCycleAuthorityMock).toHaveBeenCalledWith(env, "user-9");
  });
});
