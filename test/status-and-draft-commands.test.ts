// status-and-draft のコマンド定義と custom_id 規約の検証
// (Req 2.1, 3.1, 4.1, 5.1, 5.2, 5.5, 6.1, 6.2, 6.3, 6.4, 7.1 /
//  design.md File Structure Plan `commands.ts`・`custom-ids.ts`、
//  Components「Command Definitions + Register」、handlers Implementation Notes、
//  Requirements Traceability 5.5)。
//
// 完了条件(task 1.1): `/status`・`/draft` の application command 定義と、
// `/goal status`・`/evidence list` のサブコマンド/オプション名定数が型付きで公開され、
// 4 種の調整ボタン([短くする]=shorten /[成果を強める]=strengthen /
// [課題を明確にする]=clarify /[上司向けにする]=manager)と[保存]ボタンの custom_id で
// draftPendingId(調整ボタンは kind も)の埋め込み→抽出が往復で一致する。

import type { RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import {
  DRAFT_ALL_SUBCOMMAND,
  DRAFT_COMMAND_NAME,
  DRAFT_GOAL_SUBCOMMAND,
  DRAFT_OPT_GOAL,
  EVIDENCE_LIST_OPT_NONE,
  EVIDENCE_LIST_SUBCOMMAND,
  GOAL_STATUS_OPT_GOAL,
  GOAL_STATUS_SUBCOMMAND,
  STATUS_COMMAND_NAME,
  draftCommandDefinition,
  statusAndDraftCommandDefinitions,
  statusCommandDefinition,
} from "../src/status-and-draft/commands";
import type { RefineKind } from "../src/status-and-draft/custom-ids";
import {
  CLARIFY_BTN,
  MANAGER_BTN,
  REFINE_KINDS,
  SAVE_DRAFT_BTN,
  SHORTEN_BTN,
  STRENGTHEN_BTN,
  buildRefineButtonId,
  buildSaveDraftButtonId,
  parseRefineButtonId,
  parseSaveDraftButtonId,
} from "../src/status-and-draft/custom-ids";

const CHAT_INPUT = 1; // ApplicationCommandType.ChatInput
const SUBCOMMAND = 1; // ApplicationCommandOptionType.Subcommand
const STRING = 3; // ApplicationCommandOptionType.String

type CommandOption = {
  name: string;
  type: number;
  required?: boolean;
  options?: CommandOption[];
};

function optionsOf(
  cmd: RESTPostAPIApplicationCommandsJSONBody | CommandOption,
): CommandOption[] {
  const opts = (cmd as { options?: unknown }).options;
  return Array.isArray(opts) ? (opts as CommandOption[]) : [];
}

function findOption(
  cmd: RESTPostAPIApplicationCommandsJSONBody | CommandOption,
  name: string,
): CommandOption | undefined {
  return optionsOf(cmd).find((o) => o.name === name);
}

describe("status-and-draft command definitions", () => {
  it("/status を引数なしのトップレベルコマンドとして公開する", () => {
    expect(statusCommandDefinition.name).toBe(STATUS_COMMAND_NAME);
    expect(statusCommandDefinition.name).toBe("status");
    expect((statusCommandDefinition as { type?: number }).type).toBe(CHAT_INPUT);
    expect(statusCommandDefinition.description).toBeTruthy();
    expect(optionsOf(statusCommandDefinition)).toHaveLength(0);
  });

  it("/draft を goal / all サブコマンドを持つトップレベルコマンドとして公開する", () => {
    expect(draftCommandDefinition.name).toBe(DRAFT_COMMAND_NAME);
    expect(draftCommandDefinition.name).toBe("draft");
    expect((draftCommandDefinition as { type?: number }).type).toBe(CHAT_INPUT);

    const goalSub = findOption(draftCommandDefinition, DRAFT_GOAL_SUBCOMMAND);
    const allSub = findOption(draftCommandDefinition, DRAFT_ALL_SUBCOMMAND);
    expect(goalSub?.type).toBe(SUBCOMMAND);
    expect(allSub?.type).toBe(SUBCOMMAND);
  });

  it("/draft goal サブコマンドが goal オプション(STRING, required)を持つ", () => {
    const goalSub = findOption(draftCommandDefinition, DRAFT_GOAL_SUBCOMMAND);
    expect(goalSub).toBeDefined();
    const goalOpt = goalSub && findOption(goalSub, DRAFT_OPT_GOAL);
    expect(goalOpt?.type).toBe(STRING);
    expect(goalOpt?.required).toBe(true);
  });

  it("/draft all サブコマンドはオプションを持たない", () => {
    const allSub = findOption(draftCommandDefinition, DRAFT_ALL_SUBCOMMAND);
    expect(allSub).toBeDefined();
    expect(allSub && optionsOf(allSub)).toHaveLength(0);
  });

  it("status-and-draft 固有の新規コマンド定義配列(status / draft のみ)を公開する", () => {
    // goal / evidence のトップレベルは goal-management が所有するため本配列には含めない。
    expect(statusAndDraftCommandDefinitions).toEqual([
      statusCommandDefinition,
      draftCommandDefinition,
    ]);
  });

  it("/goal status のサブコマンド名・goal オプション名定数を公開する", () => {
    expect(GOAL_STATUS_SUBCOMMAND).toBe("status");
    expect(typeof GOAL_STATUS_OPT_GOAL).toBe("string");
    expect(GOAL_STATUS_OPT_GOAL.length).toBeGreaterThan(0);
  });

  it("/evidence list のサブコマンド名定数を公開する", () => {
    expect(EVIDENCE_LIST_SUBCOMMAND).toBe("list");
    // /evidence list はオプションを持たない(マーカー定数で表現)。
    expect(EVIDENCE_LIST_OPT_NONE).toEqual([]);
  });
});

describe("status-and-draft custom ids", () => {
  it("各ボタンのベース custom_id が空でなくユニークである", () => {
    const ids = [SHORTEN_BTN, STRENGTHEN_BTN, CLARIFY_BTN, MANAGER_BTN, SAVE_DRAFT_BTN];
    for (const id of ids) {
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("REFINE_KINDS が4種(shorten/strengthen/clarify/manager)を列挙する", () => {
    expect([...REFINE_KINDS].sort()).toEqual(
      ["clarify", "manager", "shorten", "strengthen"].sort(),
    );
  });

  it.each(REFINE_KINDS)(
    "調整ボタン(%s)custom_id に kind と draftPendingId を埋め、両方を往復で復元できる",
    (kind: RefineKind) => {
      const draftPendingId = "draft_01HZY8Z2R4X6A9B3C5D7E9F";
      const customId = buildRefineButtonId(kind, draftPendingId);

      const parsed = parseRefineButtonId(customId);
      expect(parsed).toEqual({ kind, draftPendingId });
    },
  );

  it("[保存]ボタン custom_id で draftPendingId を埋め、同じ値を抽出できる", () => {
    const draftPendingId = "draft_save_01HZY8Z2R4X6A9B3C5D7E9F";
    const customId = buildSaveDraftButtonId(draftPendingId);

    expect(parseSaveDraftButtonId(customId)).toBe(draftPendingId);
  });

  it("調整ボタンと保存ボタンの custom_id を取り違えて解析しない", () => {
    const draftPendingId = "draft-cross-check";
    // 保存パーサは調整ボタン custom_id を受け付けない。
    expect(
      parseSaveDraftButtonId(buildRefineButtonId("shorten", draftPendingId)),
    ).toBe(null);
    // 調整パーサは保存ボタン custom_id を受け付けない。
    expect(parseRefineButtonId(buildSaveDraftButtonId(draftPendingId))).toBe(null);
  });

  it("draftPendingId にセパレータを含んでも安全に往復する(encode/decode)", () => {
    const draftPendingId = "draft:with:colons and spaces";
    expect(
      parseSaveDraftButtonId(buildSaveDraftButtonId(draftPendingId)),
    ).toBe(draftPendingId);
    expect(
      parseRefineButtonId(buildRefineButtonId("manager", draftPendingId)),
    ).toEqual({ kind: "manager", draftPendingId });
  });

  it("空の draftPendingId を build で拒否する", () => {
    expect(() => buildSaveDraftButtonId("")).toThrow(RangeError);
    expect(() => buildRefineButtonId("shorten", "")).toThrow(RangeError);
  });

  it("空 ID・不正形式・未知 kind を parse で null として扱う", () => {
    expect(parseSaveDraftButtonId(SAVE_DRAFT_BTN)).toBe(null);
    expect(parseSaveDraftButtonId(`${SAVE_DRAFT_BTN}:`)).toBe(null);
    expect(parseRefineButtonId(SHORTEN_BTN)).toBe(null);
    expect(parseRefineButtonId(`${SHORTEN_BTN}:`)).toBe(null);
    // 未知の prefix。
    expect(parseRefineButtonId("draft:unknown:pending")).toBe(null);
    expect(parseSaveDraftButtonId("draft:unknown:pending")).toBe(null);
  });
});
