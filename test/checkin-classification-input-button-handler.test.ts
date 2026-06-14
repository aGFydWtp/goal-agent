// [入力する] ボタンハンドラ(checkin-classification task 3.1 / Req 1.3)のユニットテスト。
//
// ハンドラは checkin modal を開く HandlerResult を返す薄層に徹する(DO / domain 非依存)。
// よって本テストは DO を立てず、最小の InteractionContext を構築して返却 payload を構造検証
// する。modal の custom_id は CHECKIN_MODAL_ID と一致し、複数行(Paragraph)TextInput の
// custom_id が CHECKIN_INPUT_FIELD_ID であること、required:true であることを固定する。

import { describe, expect, it } from "vitest";

import type { APIInteraction } from "discord-api-types/v10";

import type { DiscordEnv } from "../src/discord/env";
import type { HandlerResult, InteractionContext } from "../src/discord/types";
import {
  CHECKIN_INPUT_FIELD_ID,
  CHECKIN_MODAL_ID,
} from "../src/checkin-classification/custom-ids";
import { inputButtonHandler } from "../src/checkin-classification/handlers/input-button";

/** [入力する] ボタンの最小 InteractionContext を構築する(modal 提示は入力に依存しない)。 */
function makeContext(): InteractionContext {
  return {
    kind: "component",
    name: "checkin:input",
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

describe("inputButtonHandler: [入力する] ボタンハンドラ", () => {
  it("checkin modal を開く HandlerResult を返す (1.3)", async () => {
    const result = await inputButtonHandler.handle(makeContext(), env);
    expect(result.mode).toBe("modal");
  });

  it("custom_id が CHECKIN_MODAL_ID と一致し、日本語タイトルを持つ (1.3)", async () => {
    const result = (await inputButtonHandler.handle(makeContext(), env)) as Extract<
      HandlerResult,
      { mode: "modal" }
    >;
    expect(result.customId).toBe(CHECKIN_MODAL_ID);
    expect(result.title.length).toBeGreaterThan(0);
  });

  it("複数行 TextInput を 1 つ持つ action row を 1 つ持つ (1.3)", async () => {
    const result = (await inputButtonHandler.handle(makeContext(), env)) as Extract<
      HandlerResult,
      { mode: "modal" }
    >;
    expect(result.components).toHaveLength(1);
    expect(result.components[0].type).toBe(1);
    expect(result.components[0].components).toHaveLength(1);
  });

  it("TextInput の custom_id / style / required が確定仕様どおり (1.3)", async () => {
    const result = (await inputButtonHandler.handle(makeContext(), env)) as Extract<
      HandlerResult,
      { mode: "modal" }
    >;
    const field = result.components[0].components[0];
    expect(field.type).toBe(4);
    expect(field.custom_id).toBe(CHECKIN_INPUT_FIELD_ID);
    // 複数行入力(Paragraph = style 2)。
    expect(field.style).toBe(2);
    expect(field.required).toBe(true);
  });
});
