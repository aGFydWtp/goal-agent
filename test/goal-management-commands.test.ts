// goal-management のコマンド定義(src/goal-management/commands.ts)の検証
// (Req 1.1, 2.1, 3.1 / design.md File Structure Plan L125 `commands.ts`、
// Data Contracts & Integration L298-320、Components「Command Definitions + Register」L261)。
//
// 完了条件(task 1.3): `/cycle create`(name/start/end)・`/goal add`・`/evidence delete`(id)の
// application command 定義と、goal 入力 modal の custom_id 規約(GOAL_MODAL_ID と各フィールド
// custom_id)が型付きで公開され、後段の登録処理(task 4.1)から参照できる。
//
// 重要な統合事実: discord-gateway の dispatch は command をトップレベルコマンド名
// (`interaction.data.name`)で解決する。よってコマンド定義の name は
// "cycle"/"goal"/"evidence"(トップレベル)であり、サブコマンドはその options に置く。
//
// 実行環境: vitest projects の "node" プロジェクト(純粋データ定義)。

import { describe, expect, it } from "vitest";
import type { RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v10";
import {
  CYCLE_COMMAND_NAME,
  CYCLE_CREATE_SUBCOMMAND,
  CYCLE_OPT_END,
  CYCLE_OPT_NAME,
  CYCLE_OPT_START,
  EVIDENCE_COMMAND_NAME,
  EVIDENCE_DELETE_SUBCOMMAND,
  EVIDENCE_OPT_ID,
  GOAL_ADD_SUBCOMMAND,
  GOAL_COMMAND_NAME,
  GOAL_FIELD_DESCRIPTION,
  GOAL_FIELD_DUE_DATE,
  GOAL_FIELD_EVALUATION_POINTS,
  GOAL_FIELD_SUCCESS_CRITERIA,
  GOAL_FIELD_TITLE,
  GOAL_MODAL_ID,
  goalManagementCommandDefinitions,
} from "../src/goal-management/commands";

// Discord application command option type の数値(discord-api-types enum 値と一致)。
const SUBCOMMAND = 1; // ApplicationCommandOptionType.Subcommand
const STRING = 3; // ApplicationCommandOptionType.String
const CHAT_INPUT = 1; // ApplicationCommandType.ChatInput

/** name でコマンド定義を取得する(無ければテスト失敗用に undefined)。 */
function findCommand(
  name: string,
): RESTPostAPIApplicationCommandsJSONBody | undefined {
  return goalManagementCommandDefinitions.find((c) => c.name === name);
}

/** options 配列(存在しない型を含む union を絞り込む)を安全に取り出す。 */
function optionsOf(
  cmd: RESTPostAPIApplicationCommandsJSONBody | undefined,
): readonly { name?: string; type?: number; options?: unknown }[] {
  if (cmd === undefined) return [];
  const opts = (cmd as { options?: unknown }).options;
  return Array.isArray(opts) ? opts : [];
}

describe("goal-management command definitions", () => {
  it("3 件のコマンド定義を公開し、コマンド名はユニークである", () => {
    expect(goalManagementCommandDefinitions).toHaveLength(3);
    const names = goalManagementCommandDefinitions.map((c) => c.name);
    expect(new Set(names).size).toBe(3);
    expect(names).toEqual(
      expect.arrayContaining([
        CYCLE_COMMAND_NAME,
        GOAL_COMMAND_NAME,
        EVIDENCE_COMMAND_NAME,
      ]),
    );
  });

  it("各コマンドのトップレベル name が定数と一致し CHAT_INPUT(type 1)である", () => {
    for (const name of [
      CYCLE_COMMAND_NAME,
      GOAL_COMMAND_NAME,
      EVIDENCE_COMMAND_NAME,
    ]) {
      const cmd = findCommand(name);
      expect(cmd, `command ${name} should exist`).toBeDefined();
      // type 省略時は CHAT_INPUT 既定だが、明示の場合は 1 であること。
      const type = (cmd as { type?: number }).type;
      if (type !== undefined) expect(type).toBe(CHAT_INPUT);
      expect((cmd as { description?: string }).description).toBeTruthy();
    }
  });

  it("cycle コマンドは create サブコマンドと name/start/end(STRING, required)を持つ", () => {
    const cmd = findCommand(CYCLE_COMMAND_NAME);
    const sub = optionsOf(cmd).find((o) => o.name === CYCLE_CREATE_SUBCOMMAND);
    expect(sub, "create subcommand").toBeDefined();
    expect(sub?.type).toBe(SUBCOMMAND);

    const subOpts = Array.isArray(sub?.options)
      ? (sub?.options as { name?: string; type?: number; required?: boolean }[])
      : [];
    for (const optName of [CYCLE_OPT_NAME, CYCLE_OPT_START, CYCLE_OPT_END]) {
      const opt = subOpts.find((o) => o.name === optName);
      expect(opt, `option ${optName}`).toBeDefined();
      expect(opt?.type).toBe(STRING);
      expect(opt?.required).toBe(true);
    }
  });

  it("goal コマンドは add サブコマンドを持ち(オプション無し)", () => {
    const cmd = findCommand(GOAL_COMMAND_NAME);
    const sub = optionsOf(cmd).find((o) => o.name === GOAL_ADD_SUBCOMMAND);
    expect(sub, "add subcommand").toBeDefined();
    expect(sub?.type).toBe(SUBCOMMAND);
    const subOpts = Array.isArray(sub?.options) ? sub?.options : [];
    expect(subOpts).toHaveLength(0);
  });

  it("evidence コマンドは delete サブコマンドと id(STRING, required)を持つ", () => {
    const cmd = findCommand(EVIDENCE_COMMAND_NAME);
    const sub = optionsOf(cmd).find((o) => o.name === EVIDENCE_DELETE_SUBCOMMAND);
    expect(sub, "delete subcommand").toBeDefined();
    expect(sub?.type).toBe(SUBCOMMAND);

    const subOpts = Array.isArray(sub?.options)
      ? (sub?.options as { name?: string; type?: number; required?: boolean }[])
      : [];
    const idOpt = subOpts.find((o) => o.name === EVIDENCE_OPT_ID);
    expect(idOpt, "id option").toBeDefined();
    expect(idOpt?.type).toBe(STRING);
    expect(idOpt?.required).toBe(true);
  });

  it("goal modal の custom_id 規約が定義され、いずれも空でなくユニークである", () => {
    const ids = [
      GOAL_MODAL_ID,
      GOAL_FIELD_TITLE,
      GOAL_FIELD_DESCRIPTION,
      GOAL_FIELD_SUCCESS_CRITERIA,
      GOAL_FIELD_EVALUATION_POINTS,
      GOAL_FIELD_DUE_DATE,
    ];
    for (const id of ids) {
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("コマンド名/サブコマンド名/オプション名の定数が空でない", () => {
    const names = [
      CYCLE_COMMAND_NAME,
      CYCLE_CREATE_SUBCOMMAND,
      CYCLE_OPT_NAME,
      CYCLE_OPT_START,
      CYCLE_OPT_END,
      GOAL_COMMAND_NAME,
      GOAL_ADD_SUBCOMMAND,
      EVIDENCE_COMMAND_NAME,
      EVIDENCE_DELETE_SUBCOMMAND,
      EVIDENCE_OPT_ID,
    ];
    for (const n of names) {
      expect(typeof n).toBe("string");
      expect(n.length).toBeGreaterThan(0);
    }
  });
});
