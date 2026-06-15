// checkin-classification のハンドラ登録とコマンド定義集約の検証(task 4.1 / Req 1.1, 6.4)。
//
// 完了条件: `registerCheckinClassification()` を呼ぶと、`/checkin` コマンド・[入力する] ボタン・
// checkin modal submit が完全一致で、保存/修正/破棄ボタンが pendingId 埋め込みの動的 custom_id でも
// 接頭辞ディスパッチで対応ハンドラへ解決される。さらに `/checkin` 定義が集約点に含まれる。
//
// 方針: discord-gateway の登録機構(registry / definitions)は変更せず公開 API を呼ぶだけである
// ことを検証する。routing/llm factory は `cloudflare:` スキームを引くため mock で import チェーンを
// 断つ(ハンドラ実行はしない)。実行環境: vitest "node" プロジェクト。

import { beforeEach, describe, expect, it, vi } from "vitest";

import { commandDefinitions, resetCommandDefinitions } from "../src/discord/commands/definitions";
import { lookupHandler, resetDefaultRegistry } from "../src/discord/registry";

vi.mock("../src/agents/routing", () => ({
  getCycleAgent: vi.fn(),
  getGoalAgent: vi.fn(),
}));
vi.mock("../src/llm/factory", () => ({
  createLlmClient: vi.fn(),
}));

const { registerCheckinClassification } = await import("../src/checkin-classification/register");
const { CHECKIN_COMMAND_NAME } = await import("../src/checkin-classification/commands");
const {
  CHECKIN_INPUT_BUTTON_ID,
  CHECKIN_MODAL_ID,
  buildCheckinSaveButtonId,
  buildCheckinEditButtonId,
  buildCheckinDiscardButtonId,
} = await import("../src/checkin-classification/custom-ids");
const { checkinCommandHandler } = await import(
  "../src/checkin-classification/handlers/checkin-command"
);
const { inputButtonHandler } = await import("../src/checkin-classification/handlers/input-button");
const { checkinModalSubmitHandler } = await import(
  "../src/checkin-classification/handlers/checkin-modal-submit"
);
const { saveButtonHandler } = await import("../src/checkin-classification/handlers/save-button");
const { editButtonHandler } = await import("../src/checkin-classification/handlers/edit-button");
const { discardButtonHandler } = await import(
  "../src/checkin-classification/handlers/discard-button"
);

beforeEach(() => {
  resetDefaultRegistry();
  resetCommandDefinitions();
});

describe("registerCheckinClassification: 固定識別子の完全一致登録", () => {
  it("/checkin コマンド・[入力する] ボタン・checkin modal が対応ハンドラへ解決する (1.1)", () => {
    registerCheckinClassification();

    expect(lookupHandler("command", CHECKIN_COMMAND_NAME)).toBe(checkinCommandHandler);
    expect(lookupHandler("component", CHECKIN_INPUT_BUTTON_ID)).toBe(inputButtonHandler);
    expect(lookupHandler("modal", CHECKIN_MODAL_ID)).toBe(checkinModalSubmitHandler);
  });
});

describe("registerCheckinClassification: 動的 custom_id の接頭辞ディスパッチ", () => {
  it("保存/修正/破棄ボタンが pendingId 埋め込みでも対応ハンドラへ解決する (3.2)", () => {
    registerCheckinClassification();

    expect(lookupHandler("component", buildCheckinSaveButtonId("abc123"))).toBe(saveButtonHandler);
    expect(lookupHandler("component", buildCheckinEditButtonId("abc123"))).toBe(editButtonHandler);
    expect(lookupHandler("component", buildCheckinDiscardButtonId("abc123"))).toBe(
      discardButtonHandler,
    );
    // 異なる pendingId でも同じハンドラへ解決する。
    expect(lookupHandler("component", buildCheckinSaveButtonId("xyz-999"))).toBe(saveButtonHandler);
  });

  it("接頭辞が紛らわしい未登録 custom_id には誤解決しない", () => {
    registerCheckinClassification();
    // `checkin:savezzz` は `checkin:save:` 接頭辞に一致しない(区切り `:` を含むため)。
    expect(lookupHandler("component", "checkin:savezzz")).toBeNull();
    expect(lookupHandler("component", "other:save:abc")).toBeNull();
  });
});

describe("registerCheckinClassification: コマンド定義集約", () => {
  it("/checkin のコマンド定義が集約点に追加される (1.1, 6.4)", () => {
    registerCheckinClassification();

    const names = commandDefinitions.map((definition) => definition.name);
    expect(names).toContain(CHECKIN_COMMAND_NAME);
  });
});
