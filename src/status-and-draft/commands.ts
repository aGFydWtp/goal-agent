import type {
  APIApplicationCommandOption,
  RESTPostAPIApplicationCommandsJSONBody,
} from "discord-api-types/v10";

/**
 * status-and-draft のコマンド定義 (Req 2.1, 3.1, 4.1, 5.1, 5.2 /
 * design.md File Structure Plan `commands.ts`、Boundary Commitments
 * 「コマンド定義の供給」、Components「Command Definitions + Register」)。
 *
 * 本モジュールは Discord application command 定義およびサブコマンド/オプション名の
 * 「定義の公開」のみを所有し、discord-gateway の集約点への登録配線(後続 task 6.x の
 * `register.ts`)・handlers・domain には依存しない。型のみ(`discord-api-types`)を
 * 参照し、実行時依存は持たない。
 *
 * 重要な統合事実(ディスパッチ): discord-gateway の `src/discord/dispatch.ts` `nameOf()`
 * は command を `interaction.data.name`(トップレベルコマンド名のみ)で解決し、サブコマンド名は
 * 見ない。本スペック固有の新規コマンドは `/status`(トップレベル `status`)・`/draft`
 * (トップレベル `draft`)であり、これらのトップレベル名でディスパッチが当たる。
 *
 * 重要な境界事実(`/goal status`・`/evidence list`): `goal`・`evidence` のトップレベル
 * コマンドは goal-management が既に所有している(`src/goal-management/commands.ts` の
 * `goalCommand`・`evidenceCommand`)。したがって status-and-draft が独立した `goal`/
 * `evidence` のトップレベル定義を集約点へ重複追加すると、登録時(bulk overwrite)に
 * 名前衝突を起こす。`/goal status`・`/evidence list` を実体化するには、既存 `goal`/
 * `evidence` 定義へ `status`/`list` サブコマンドを追加する統合が必要だが、それは後続
 * task 6.x の責務であり本 task では解決しない。本モジュールはサブコマンド名・オプション名の
 * 定数のみを export し、ハンドラ(後続 task)が `ctx.raw` からサブコマンド + オプションを
 * 読めるようにする。
 *
 * enum 値の扱い: 当リポジトリは `discord-api-types` の enum 値が workerd バンドル上で
 * undefined に解決される既知問題のため、ランタイムで DAT enum 値を使わない
 * (goal-management / checkin-classification の `commands.ts` と同じ方針)。コマンド定義は
 * モジュールロード時にオブジェクトとして構築されるため、`type` 値は数値リテラルで記し、
 * `discord-api-types` の型は型注釈としてのみ用いる。
 */

// ── トップレベルコマンド名(dispatch / registry キー)──

/** `/status` のトップレベルコマンド名(dispatch / registry キー)。 */
export const STATUS_COMMAND_NAME = "status";

/** `/draft` のトップレベルコマンド名(dispatch / registry キー)。 */
export const DRAFT_COMMAND_NAME = "draft";

// ── /draft サブコマンド名 / オプション名 ──

/** `/draft goal` のサブコマンド名(特定目標のドラフト生成)。 */
export const DRAFT_GOAL_SUBCOMMAND = "goal";
/** `/draft goal` の goal オプション(対象目標 ID)。 */
export const DRAFT_OPT_GOAL = "goal";
/** `/draft all` のサブコマンド名(半期全体のドラフト生成)。 */
export const DRAFT_ALL_SUBCOMMAND = "all";

// ── /goal status サブコマンド名 / オプション名(goal-management 所有の `goal` 配下)──
//
// 重要: `goal` のトップレベルは goal-management が所有する。本定数は後続 task 6.x が
// 既存 `goal` 定義へ `status` サブコマンドを追加し、ハンドラが narrow するための名前のみを
// 供給する。本モジュールは `goal` のトップレベル定義を再定義しない。

/** `/goal status` のサブコマンド名。 */
export const GOAL_STATUS_SUBCOMMAND = "status";
/** `/goal status` の goal オプション(対象目標 ID)。 */
export const GOAL_STATUS_OPT_GOAL = "goal";

// ── /evidence list サブコマンド名(goal-management 所有の `evidence` 配下)──
//
// 重要: `evidence` のトップレベルは goal-management が所有する。本定数は後続 task 6.x が
// 既存 `evidence` 定義へ `list` サブコマンドを追加するための名前のみを供給する。

/** `/evidence list` のサブコマンド名。 */
export const EVIDENCE_LIST_SUBCOMMAND = "list";
/** `/evidence list` はオプションを持たない(空オプションのマーカー)。 */
export const EVIDENCE_LIST_OPT_NONE: readonly string[] = [];

// Discord application command の type 値(数値リテラル / workerd enum 問題回避)。
const CHAT_INPUT = 1 as const; // ApplicationCommandType.ChatInput
const SUBCOMMAND = 1 as const; // ApplicationCommandOptionType.Subcommand
const STRING = 3 as const; // ApplicationCommandOptionType.String

/**
 * `/status`(引数なし)の application command 定義 (Req 2.1)。
 *
 * トップレベル `status`(CHAT_INPUT)。半期全体の各目標状態を一覧表示するため
 * オプションを持たない。
 */
export const statusCommandDefinition: RESTPostAPIApplicationCommandsJSONBody = {
  name: STATUS_COMMAND_NAME,
  description: "半期全体の各目標の状態と理由、今週やるとよいことを一覧表示",
  type: CHAT_INPUT,
};

/**
 * `/draft`(goal / all)の application command 定義 (Req 5.1, 5.2)。
 *
 * トップレベル `draft`(CHAT_INPUT)の下に `goal`(goal オプション付き)と `all`
 * (オプションなし)サブコマンドを持つ。`goal` は特定目標、`all` は半期全体の自己評価
 * ドラフトを生成する。
 */
export const draftCommandDefinition: RESTPostAPIApplicationCommandsJSONBody = {
  name: DRAFT_COMMAND_NAME,
  description: "保存済み証跡から自己評価ドラフトを生成",
  type: CHAT_INPUT,
  options: [
    {
      name: DRAFT_GOAL_SUBCOMMAND,
      description: "特定の評価目標のドラフトを生成",
      type: SUBCOMMAND,
      options: [
        {
          name: DRAFT_OPT_GOAL,
          description: "対象の評価目標 ID",
          type: STRING,
          required: true,
        },
      ],
    },
    {
      name: DRAFT_ALL_SUBCOMMAND,
      description: "半期全体のドラフトを生成",
      type: SUBCOMMAND,
    },
  ],
};

/**
 * status-and-draft が供給する「固有の新規」application command 定義一式
 * (Req 2.1, 5.1, 5.2)。
 *
 * `/status`・`/draft` のみを含む。`/goal status`・`/evidence list` は goal-management
 * 所有の `goal`/`evidence` トップレベルへサブコマンドを追加する形で実体化するため、
 * 本配列には含めない(統合は後続 task 6.x の責務)。後続の登録処理(`register.ts`)が
 * この配列を読み取り、discord-gateway の `registerCommandDefinition` 経由で集約点へ
 * 追加する。本モジュールは登録配線を行わない。
 */
export const statusAndDraftCommandDefinitions: RESTPostAPIApplicationCommandsJSONBody[] = [
  statusCommandDefinition,
  draftCommandDefinition,
];

/**
 * `/goal status` のサブコマンド定義 (Req 2.1 / 8.3, 8.4)。
 *
 * goal-management 所有の `goal` トップレベル定義へ「登録時マージ」されるサブコマンド
 * (`register.ts` の `mergeSubcommandIntoCommand`)。Discord はトップレベルコマンド名ごとに
 * 1 定義しか許さないため、status-and-draft は `goal` 全体を再定義せず、この `status`
 * サブコマンドだけを供給し、既存 `goal`(`add`)へ合流させる。
 *
 * `status` は対象目標を指す `goal`(STRING, required)オプションを 1 つ持つ。
 */
export const goalStatusSubcommandDefinition: APIApplicationCommandOption = {
  name: GOAL_STATUS_SUBCOMMAND,
  description: "指定した評価目標の状態と理由、今週やるとよいことを表示",
  type: SUBCOMMAND,
  options: [
    {
      name: GOAL_STATUS_OPT_GOAL,
      description: "対象の評価目標 ID",
      type: STRING,
      required: true,
    },
  ],
};

/**
 * `/evidence list` のサブコマンド定義 (Req 4.1 / 8.3, 8.4)。
 *
 * goal-management 所有の `evidence` トップレベル定義へ「登録時マージ」されるサブコマンド
 * (`register.ts`)。`list` はオプションを持たない(半期全体の証跡を一覧表示する)。
 */
export const evidenceListSubcommandDefinition: APIApplicationCommandOption = {
  name: EVIDENCE_LIST_SUBCOMMAND,
  description: "保存済みの証跡を一覧表示",
  type: SUBCOMMAND,
};
