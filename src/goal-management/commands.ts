import type { RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v10";

/**
 * goal-management のコマンド定義と modal custom_id 規約 (Req 1.1, 2.1, 3.1)。
 *
 * `/cycle create`・`/goal add`・`/evidence delete` の application command 定義と、
 * goal 入力 modal の custom_id 規約を型付きで公開する(design.md File Structure Plan
 * `commands.ts` / Components「Command Definitions + Register」)。本モジュールは
 * 「定義の公開」のみを所有し、discord-gateway の集約点への登録配線(task 4.1
 * `register.ts`)は行わない。
 *
 * 依存方向: 本モジュールは `discord-api-types` の型のみを参照する(handlers / domain /
 * registry を import しない)。型のみの依存であり実行時依存は持たない。
 *
 * 重要な統合事実: discord-gateway の `src/discord/dispatch.ts` `nameOf()` は command を
 * `interaction.data.name`(トップレベルコマンド名のみ)で解決し、サブコマンド名は見ない。
 * したがって登録キー(task 4.1 の `registerHandler("command", <name>, ...)`)は
 * トップレベルコマンド名(`"cycle"` / `"goal"` / `"evidence"`)でなければディスパッチが
 * 当たらない。本モジュールはトップレベルコマンド名とサブコマンド名 / オプション名の双方を
 * 定数として export し、ハンドラ(task 3.x)が `ctx.raw` からサブコマンド + オプションを
 * 読めるようにする。
 *
 * enum 値の扱い: 当リポジトリは `discord-api-types` の enum 値が workerd バンドル上で
 * undefined に解決される既知問題のため、ランタイムで DAT enum 値を使わない(`response.ts` /
 * `dispatch.ts` のコメント参照)。コマンド定義はモジュールロード時にオブジェクトとして
 * 構築されるため、`type` 値は数値リテラルで記し、`discord-api-types` の型は型注釈としてのみ
 * 用いる。
 */

// ── コマンド名 / サブコマンド名 / オプション名(registry キー・narrow 用)──

/** `/cycle` のトップレベルコマンド名(dispatch / registry キー)。 */
export const CYCLE_COMMAND_NAME = "cycle";
/** `/cycle create` のサブコマンド名。 */
export const CYCLE_CREATE_SUBCOMMAND = "create";
/** `/cycle create` の name オプション(サイクル名)。 */
export const CYCLE_OPT_NAME = "name";
/** `/cycle create` の start オプション(開始日)。 */
export const CYCLE_OPT_START = "start";
/** `/cycle create` の end オプション(終了日)。 */
export const CYCLE_OPT_END = "end";

/** `/goal` のトップレベルコマンド名(dispatch / registry キー)。 */
export const GOAL_COMMAND_NAME = "goal";
/** `/goal add` のサブコマンド名(modal を開く)。 */
export const GOAL_ADD_SUBCOMMAND = "add";

/** `/evidence` のトップレベルコマンド名(dispatch / registry キー)。 */
export const EVIDENCE_COMMAND_NAME = "evidence";
/** `/evidence delete` のサブコマンド名。 */
export const EVIDENCE_DELETE_SUBCOMMAND = "delete";
/** `/evidence delete` の id オプション(証跡 ID)。 */
export const EVIDENCE_OPT_ID = "id";

// ── goal modal の custom_id 規約(modal submit 照合キー / Req 2.1)──

/** goal 入力 modal の custom_id(modal submit ハンドラの照合キー)。 */
export const GOAL_MODAL_ID = "goal_modal";
/** 目標名フィールドの custom_id。 */
export const GOAL_FIELD_TITLE = "goal_title";
/** 目標本文フィールドの custom_id。 */
export const GOAL_FIELD_DESCRIPTION = "goal_description";
/** 達成条件フィールドの custom_id。 */
export const GOAL_FIELD_SUCCESS_CRITERIA = "goal_success_criteria";
/** 評価観点フィールドの custom_id。 */
export const GOAL_FIELD_EVALUATION_POINTS = "goal_evaluation_points";
/** 期限フィールドの custom_id。 */
export const GOAL_FIELD_DUE_DATE = "goal_due_date";

// Discord application command の type 値(数値リテラル / workerd enum 問題回避)。
const CHAT_INPUT = 1 as const; // ApplicationCommandType.ChatInput
const SUBCOMMAND = 1 as const; // ApplicationCommandOptionType.Subcommand
const STRING = 3 as const; // ApplicationCommandOptionType.String

/**
 * `/cycle create`(name/start/end)の application command 定義 (Req 1.1)。
 *
 * トップレベル `cycle`(CHAT_INPUT)の下に `create` サブコマンドを持ち、その options に
 * `name`・`start`・`end`(いずれも STRING, required)を持つ。
 */
const cycleCommand: RESTPostAPIApplicationCommandsJSONBody = {
  name: CYCLE_COMMAND_NAME,
  description: "評価サイクルを管理",
  type: CHAT_INPUT,
  options: [
    {
      name: CYCLE_CREATE_SUBCOMMAND,
      description: "評価サイクルを作成",
      type: SUBCOMMAND,
      options: [
        {
          name: CYCLE_OPT_NAME,
          description: "サイクル名",
          type: STRING,
          required: true,
        },
        {
          name: CYCLE_OPT_START,
          description: "開始日 (例: 2026-04-01)",
          type: STRING,
          required: true,
        },
        {
          name: CYCLE_OPT_END,
          description: "終了日 (例: 2026-09-30)",
          type: STRING,
          required: true,
        },
      ],
    },
  ],
};

/**
 * `/goal add` の application command 定義 (Req 2.1)。
 *
 * トップレベル `goal`(CHAT_INPUT)の下に `add` サブコマンドを持つ。modal を開くため
 * サブコマンドはオプションを持たない。
 */
const goalCommand: RESTPostAPIApplicationCommandsJSONBody = {
  name: GOAL_COMMAND_NAME,
  description: "評価目標を管理",
  type: CHAT_INPUT,
  options: [
    {
      name: GOAL_ADD_SUBCOMMAND,
      description: "評価目標を登録",
      type: SUBCOMMAND,
    },
  ],
};

/**
 * `/evidence delete`(id)の application command 定義 (Req 3.1)。
 *
 * トップレベル `evidence`(CHAT_INPUT)の下に `delete` サブコマンドを持ち、その options に
 * `id`(STRING, required)を持つ。
 */
const evidenceCommand: RESTPostAPIApplicationCommandsJSONBody = {
  name: EVIDENCE_COMMAND_NAME,
  description: "証跡を管理",
  type: CHAT_INPUT,
  options: [
    {
      name: EVIDENCE_DELETE_SUBCOMMAND,
      description: "証跡を削除",
      type: SUBCOMMAND,
      options: [
        {
          name: EVIDENCE_OPT_ID,
          description: "削除する証跡の ID",
          type: STRING,
          required: true,
        },
      ],
    },
  ],
};

/**
 * goal-management が供給する application command 定義一式 (Req 1.1, 2.1, 3.1)。
 *
 * 後段の登録処理(task 4.1 `register.ts`)がこの配列を読み取り、discord-gateway の
 * `registerCommandDefinition`(`src/discord/commands/definitions.ts`)経由で集約点へ
 * 追加する。本モジュールは登録配線を行わず、定義の公開のみを所有する。
 */
export const goalManagementCommandDefinitions: RESTPostAPIApplicationCommandsJSONBody[] =
  [cycleCommand, goalCommand, evidenceCommand];
