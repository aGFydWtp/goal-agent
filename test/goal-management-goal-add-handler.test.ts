// `/goal add` ハンドラ(goal-management task 3.2 / Req 2.1)のユニットテスト。
//
// ハンドラは modal を開く HandlerResult を返す薄層に徹する(DO / domain 非依存)。
// したがって本テストは DO を立てず、最小の InteractionContext を構築して返却 payload を
// 構造検証する。custom_id は commands.ts の定数と一致すること、5 フィールドの style /
// required が確定仕様どおりであることを固定する。

import { describe, expect, it } from "vitest";

import type { APIInteraction } from "discord-api-types/v10";

import type { DiscordEnv } from "../src/discord/env";
import type { HandlerResult, InteractionContext } from "../src/discord/types";
import {
  GOAL_FIELD_DESCRIPTION,
  GOAL_FIELD_DUE_DATE,
  GOAL_FIELD_EVALUATION_POINTS,
  GOAL_FIELD_SUCCESS_CRITERIA,
  GOAL_FIELD_TITLE,
  GOAL_MODAL_ID,
} from "../src/goal-management/commands";
import { goalAddHandler } from "../src/goal-management/handlers/goal-add";

/** `/goal add` の最小 InteractionContext を構築する(modal 提示はオプションに依存しない)。 */
function makeContext(): InteractionContext {
  return {
    kind: "command",
    name: "goal",
    userId: "user-1",
    channelId: "channel-1",
    isDm: false,
    interactionId: "interaction-1",
    token: "token-1",
    raw: {} as APIInteraction,
  };
}

/** ハンドラは env を参照しないため空オブジェクトをキャストで渡す。 */
const env = {} as DiscordEnv;

describe("goalAddHandler", () => {
  it("modal を開く HandlerResult を返す", async () => {
    const result = await goalAddHandler.handle(makeContext(), env);
    expect(result.mode).toBe("modal");
  });

  it("custom_id が GOAL_MODAL_ID と一致し、日本語タイトルを持つ", async () => {
    const result = (await goalAddHandler.handle(makeContext(), env)) as Extract<
      HandlerResult,
      { mode: "modal" }
    >;
    expect(result.customId).toBe(GOAL_MODAL_ID);
    expect(result.title.length).toBeGreaterThan(0);
  });

  it("5 つの action row を持ち、各 row が 1 つの text input を内包する", async () => {
    const result = (await goalAddHandler.handle(makeContext(), env)) as Extract<
      HandlerResult,
      { mode: "modal" }
    >;
    expect(result.components).toHaveLength(5);
    for (const row of result.components) {
      expect(row.type).toBe(1);
      expect(row.components).toHaveLength(1);
      expect(row.components[0].type).toBe(4);
    }
  });

  it("各フィールドの custom_id / style / required が確定仕様どおり", async () => {
    const result = (await goalAddHandler.handle(makeContext(), env)) as Extract<
      HandlerResult,
      { mode: "modal" }
    >;
    const fields = result.components.map((row) => row.components[0]);

    expect(fields[0].custom_id).toBe(GOAL_FIELD_TITLE);
    expect(fields[0].style).toBe(1);
    expect(fields[0].required).toBe(true);

    expect(fields[1].custom_id).toBe(GOAL_FIELD_DESCRIPTION);
    expect(fields[1].style).toBe(2);
    expect(fields[1].required).toBe(true);

    expect(fields[2].custom_id).toBe(GOAL_FIELD_SUCCESS_CRITERIA);
    expect(fields[2].style).toBe(2);
    expect(fields[2].required).toBe(false);

    expect(fields[3].custom_id).toBe(GOAL_FIELD_EVALUATION_POINTS);
    expect(fields[3].style).toBe(2);
    expect(fields[3].required).toBe(false);

    expect(fields[4].custom_id).toBe(GOAL_FIELD_DUE_DATE);
    expect(fields[4].style).toBe(1);
    expect(fields[4].required).toBe(false);
  });
});
