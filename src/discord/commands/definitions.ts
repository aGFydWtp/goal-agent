import type { RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v10";

/**
 * コマンド定義の単一集約点 (Req 2.1, 2.5, 7.4 / design.md §commands
 * "Command Definitions / Register" L455-466, File Structure Plan
 * `commands/definitions.ts` L125-127)。
 *
 * 各機能スペックが自分のコマンド定義(`discord-api-types` v10 の application command
 * 形 = {@link RESTPostAPIApplicationCommandsJSONBody})を追加するための集約配列を公開
 * する。本スペック(ゲートウェイ)は空の集約点を確立するだけで、`/cycle` 等の具体的な
 * コマンドの中身は一切保持しない(Req 7.4)。具体定義は下位スペックが
 * {@link registerCommandDefinition} を通じて追加し、登録スクリプト(task 3.4
 * `register.ts`)が {@link commandDefinitions} を読み取って Discord へ bulk overwrite
 * 登録する(Req 2.2, 2.4)。
 *
 * 依存方向: 本モジュールは `discord-api-types` の型のみを参照する。dispatch /
 * registry / response / rest 等のゲートウェイ内部コンポーネントは import しない
 * (design L133「commands/ は登録専用で env/types のみ参照」)。型のみの依存であり
 * 実行時依存は持たない。
 */

/**
 * コマンド定義の集約配列。初期は空(ゲートウェイは具体コマンドを保持しない / Req 7.4)。
 *
 * 下位スペックは {@link registerCommandDefinition} を呼んで自分の定義を追加する。
 * 登録スクリプトはこの配列を読み取り、Discord API へ登録する集約として利用する。
 * 参照同一性を保つため再代入はせず、追加・初期化は内部で in-place に行う。
 */
export const commandDefinitions: RESTPostAPIApplicationCommandsJSONBody[] = [];

/**
 * 下位スペックが自分のコマンド定義を集約点へ追加する。
 *
 * 各機能スペックはモジュール読み込み時などに本関数を呼び、自分の application command
 * 定義を {@link commandDefinitions} へ登録する。ゲートウェイ側は定義の中身を解釈せず、
 * 受け取った定義をそのまま集約へ蓄積する(Req 2.1, 2.5)。
 *
 * @param definition discord-api-types v10 の application command 形の定義。
 */
export function registerCommandDefinition(
  definition: RESTPostAPIApplicationCommandsJSONBody,
): void {
  commandDefinitions.push(definition);
}

/**
 * 集約を空に戻す。主にテストでの分離(beforeEach のリセット)に用いる。
 *
 * 参照同一性を維持するため新しい配列へ差し替えるのではなく in-place で空にする。
 */
export function resetCommandDefinitions(): void {
  commandDefinitions.length = 0;
}
