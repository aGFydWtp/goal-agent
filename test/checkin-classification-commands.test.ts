// checkin-classification のコマンド定義と custom_id 規約の検証
// (Req 1.1, 3.2, 3.7 / design.md File Structure Plan `commands.ts`・`custom-ids.ts`、
// Components「Command Definitions + Register」)。
//
// 完了条件(task 1.1): `/checkin` の application command 定義(引数なし)と、
// checkin modal / 入力ボタン / 保存・修正・破棄ボタンの custom_id 規約が型付きで公開され、
// 保存・修正・破棄ボタンでは pendingId の埋め込み→抽出が一致する。

import type { RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import {
  CHECKIN_COMMAND_NAME,
  checkinCommandDefinition,
  checkinCommandDefinitions,
} from "../src/checkin-classification/commands";
import {
  CHECKIN_DISCARD_BUTTON_ID,
  CHECKIN_EDIT_BUTTON_ID,
  CHECKIN_INPUT_BUTTON_ID,
  CHECKIN_MODAL_ID,
  CHECKIN_SAVE_BUTTON_ID,
  buildCheckinDiscardButtonId,
  buildCheckinEditButtonId,
  buildCheckinSaveButtonId,
  parseCheckinDiscardButtonId,
  parseCheckinEditButtonId,
  parseCheckinSaveButtonId,
} from "../src/checkin-classification/custom-ids";

const CHAT_INPUT = 1; // ApplicationCommandType.ChatInput

function optionCount(cmd: RESTPostAPIApplicationCommandsJSONBody): number {
  const opts = (cmd as { options?: unknown }).options;
  return Array.isArray(opts) ? opts.length : 0;
}

describe("checkin-classification command definitions", () => {
  it("/checkin の application command 定義を引数なしで公開する", () => {
    expect(checkinCommandDefinition.name).toBe(CHECKIN_COMMAND_NAME);
    expect(checkinCommandDefinition.name).toBe("checkin");
    expect((checkinCommandDefinition as { type?: number }).type).toBe(
      CHAT_INPUT,
    );
    expect(checkinCommandDefinition.description).toBeTruthy();
    expect(optionCount(checkinCommandDefinition)).toBe(0);
  });

  it("登録側が集約できるコマンド定義配列を公開する", () => {
    expect(checkinCommandDefinitions).toEqual([checkinCommandDefinition]);
  });
});

describe("checkin-classification custom ids", () => {
  it("modal と各ボタンのベース custom_id が空でなくユニークである", () => {
    const ids = [
      CHECKIN_MODAL_ID,
      CHECKIN_INPUT_BUTTON_ID,
      CHECKIN_SAVE_BUTTON_ID,
      CHECKIN_EDIT_BUTTON_ID,
      CHECKIN_DISCARD_BUTTON_ID,
    ];

    for (const id of ids) {
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each([
    ["save", buildCheckinSaveButtonId, parseCheckinSaveButtonId],
    ["edit", buildCheckinEditButtonId, parseCheckinEditButtonId],
    ["discard", buildCheckinDiscardButtonId, parseCheckinDiscardButtonId],
  ] as const)(
    "%s ボタン custom_id で pendingId を埋め込み、同じ値を抽出できる",
    (_name, build, parse) => {
      const pendingId = "pending_01HZY8Z2R4X6A9B3C5D7E9F";
      const customId = build(pendingId);

      expect(parse(customId)).toBe(pendingId);
    },
  );

  it("別種のボタン custom_id から pendingId を誤抽出しない", () => {
    const pendingId = "pending-cross-check";
    expect(parseCheckinSaveButtonId(buildCheckinEditButtonId(pendingId))).toBe(
      null,
    );
    expect(
      parseCheckinEditButtonId(buildCheckinDiscardButtonId(pendingId)),
    ).toBe(null);
    expect(
      parseCheckinDiscardButtonId(buildCheckinSaveButtonId(pendingId)),
    ).toBe(null);
  });

  it("空の pendingId と不正形式は null として扱う", () => {
    expect(parseCheckinSaveButtonId(CHECKIN_SAVE_BUTTON_ID)).toBe(null);
    expect(parseCheckinEditButtonId(`${CHECKIN_EDIT_BUTTON_ID}:`)).toBe(null);
    expect(parseCheckinDiscardButtonId("checkin:unknown:pending")).toBe(null);
  });
});
