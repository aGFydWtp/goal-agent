import type { RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v10";

/**
 * checkin-classification の `/checkin` application command 定義 (Req 1.1)。
 *
 * 本モジュールは Discord command 定義の公開のみを所有し、登録配線・handlers・domain・registry
 * には依存しない。workerd 上の enum 解決問題を避けるため、runtime の DAT enum 値は
 * goal-management と同じく数値リテラルで記す。
 */

/** `/checkin` のトップレベルコマンド名(dispatch / registry キー)。 */
export const CHECKIN_COMMAND_NAME = "checkin";

// Discord application command の type 値(数値リテラル / workerd enum 問題回避)。
const CHAT_INPUT = 1 as const; // ApplicationCommandType.ChatInput

/** `/checkin`(引数なし)の application command 定義。 */
export const checkinCommandDefinition: RESTPostAPIApplicationCommandsJSONBody = {
  name: CHECKIN_COMMAND_NAME,
  description: "今週の実績を入力して評価目標へ分類",
  type: CHAT_INPUT,
};

/**
 * checkin-classification が供給する application command 定義一式。
 *
 * 後続 task の register.ts が discord-gateway の集約点へ追加する。本モジュール自体は
 * 登録処理を行わない。
 */
export const checkinCommandDefinitions: RESTPostAPIApplicationCommandsJSONBody[] = [
  checkinCommandDefinition,
];
