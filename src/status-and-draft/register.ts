import type {
  APIApplicationCommandOption,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord-api-types/v10";

import { commandDefinitions, registerCommandDefinition } from "../discord/commands/definitions";
import { registerContinuation } from "../discord/continuation";
import { registerHandler, registerPrefixHandler } from "../discord/registry";
import { EVIDENCE_COMMAND_NAME, GOAL_COMMAND_NAME } from "../goal-management/commands";
import {
  DRAFT_COMMAND_NAME,
  draftCommandDefinition,
  EVIDENCE_LIST_SUBCOMMAND,
  evidenceListSubcommandDefinition,
  GOAL_STATUS_SUBCOMMAND,
  goalStatusSubcommandDefinition,
  STATUS_COMMAND_NAME,
  statusCommandDefinition,
} from "./commands";
import {
  CLARIFY_BTN,
  MANAGER_BTN,
  SAVE_DRAFT_BTN,
  SHORTEN_BTN,
  STRENGTHEN_BTN,
} from "./custom-ids";
import {
  DRAFT_GENERATE_CONTINUATION_KEY,
  draftCommandHandler,
  draftGenerateContinuation,
} from "./handlers/draft-command";
import { evidenceListCommandHandler } from "./handlers/evidence-list-command";
import {
  GOAL_STATUS_CONTINUATION_KEY,
  goalStatusCommandHandler,
  goalStatusContinuation,
} from "./handlers/goal-status-command";
import {
  DRAFT_REFINE_CONTINUATION_KEY,
  draftRefineContinuation,
  refineButtonHandler,
} from "./handlers/refine-button";
import { saveDraftButtonHandler } from "./handlers/save-draft-button";
import {
  STATUS_OVERVIEW_CONTINUATION_KEY,
  statusCommandHandler,
  statusOverviewContinuation,
} from "./handlers/status-command";

/**
 * status-and-draft のハンドラ登録・コマンド定義集約・サブコマンドマージ (task 6.3 /
 * Req 2.1, 3.1, 4.1, 5.1, 8.3, 8.4 / design.md Components「Command Definitions + Register」、
 * Modified Files `register.ts`、Boundary Commitments)。
 *
 * 本モジュールは status-and-draft の 4 コマンドハンドラ・4 種の調整ボタン・保存ボタンを
 * discord-gateway のレジストリへ規約適合で登録し、コマンド定義を集約点へ追加する配線層で
 * ある。ゲートウェイの登録機構(`registry.ts` / `commands/definitions.ts`)は変更せず、その
 * 公開 API(`registerHandler` / `registerPrefixHandler` / `registerCommandDefinition`)を
 * 呼ぶだけで完結する。
 *
 * 登録識別子の規約(dispatch 解決規約に整合 / `src/discord/dispatch.ts` L202-209):
 *  - command は最具体優先で結合キー `"<top-level> <subcommand>"` を先に照合し、無ければ
 *    トップレベル名へフォールバックする。よって:
 *      - `/goal status`    → 結合キー `"goal status"` で登録(goal-management の `/goal add`
 *        はトップレベル `goal` で登録済みのため、`"goal add"` は結合キー未登録 →
 *        トップレベル `goal` 解決で後方互換が保たれる / Req 8.3)。
 *      - `/evidence list`  → 結合キー `"evidence list"` で登録(同様に `/evidence delete` は
 *        トップレベル `evidence` 解決で後方互換)。
 *      - `/status`・`/draft` → トップレベル名で登録(`/draft goal`・`/draft all` は
 *        結合キー未登録のためトップレベル `draft` へフォールバック解決)。
 *  - button は draftPendingId(調整ボタンは加えて kind)を custom_id へ埋め込む動的
 *    custom_id のため、区切り `:` を含む接頭辞で登録し、registry の最長前方一致で解決する
 *    (checkin-classification と同じ方針 / Req 8.4)。
 *
 * コマンド定義の集約とマージ(Req 8.3, 8.4):
 *  - `/status`・`/draft` のトップレベル定義は集約点へそのまま追加する。
 *  - `/goal status`・`/evidence list` は goal-management が所有する `goal`・`evidence` の
 *    トップレベル定義へサブコマンドを「登録時マージ」する。Discord はトップレベル名ごとに
 *    1 定義しか許さないため、status-and-draft は `goal`/`evidence` を再定義せず、既存定義へ
 *    `status`/`list` サブコマンドを合流させる。goal-management のソース・エクスポート
 *    singleton は変更せず、集約配列内のエントリを浅いクローンで差し替える(in-place 変更を
 *    避け、reset + 再登録で重複蓄積しない / Req 8.3)。
 *
 * production は `src/index.ts` が本関数を `registerGoalManagement()` の後にロードして起動時へ
 * 一度呼ぶ(goal/evidence 定義が集約点に存在してからマージするため順序が重要)。テストは
 * reset 後に明示呼び出しして登録状態を分離できるよう、登録ロジックを関数として export する。
 *
 * 依存方向: `commands.ts` / `custom-ids.ts` → `register.ts` → `handlers/*`(左方向のみ)。
 */

// 動的ボタン custom_id の区切り。custom-ids.ts の build* が draftPendingId 前に付ける `:` と
// 一致させ、接頭辞に含めることで `draft:save` が `draft:saveXXX` 等へ誤一致しないようにする。
const PENDING_BUTTON_SEPARATOR = ":";

/**
 * status-and-draft 所有のサブコマンドを、集約点 {@link commandDefinitions} 内の指定
 * トップレベル定義へマージする (Req 8.3, 8.4)。
 *
 * 対象トップレベル定義が見つかった場合は、その配列エントリを浅いクローン
 * (`options` も新配列)へ差し替えてサブコマンドを追加する。元オブジェクト(goal-management の
 * エクスポート singleton)は変更しない。見つからない場合は防御的に独立定義を push する。
 */
function mergeSubcommandIntoCommand(
  topLevelName: string,
  subcommand: APIApplicationCommandOption,
): void {
  const index = commandDefinitions.findIndex((d) => d.name === topLevelName);
  if (index === -1) {
    // 防御的フォールバック: 対象が未登録なら独立した CHAT_INPUT 定義として追加する。
    const standalone: RESTPostAPIChatInputApplicationCommandsJSONBody = {
      name: topLevelName,
      description: topLevelName,
      type: 1,
      options: [subcommand],
    };
    registerCommandDefinition(standalone);
    return;
  }
  // マージ対象(goal / evidence)は CHAT_INPUT(options を持つ)。浅いクローン + options 追加で
  // 差し替え、元オブジェクト(goal-management の export singleton)は変更しない。
  const existing = commandDefinitions[index] as RESTPostAPIChatInputApplicationCommandsJSONBody;
  const merged: RESTPostAPIChatInputApplicationCommandsJSONBody = {
    ...existing,
    options: [...(existing.options ?? []), subcommand],
  };
  commandDefinitions[index] = merged;
}

/**
 * status-and-draft の登録配線 (Req 2.1, 3.1, 4.1, 5.1, 8.3, 8.4)。
 *
 * `registerGoalManagement()` の後に呼ぶこと(goal/evidence のトップレベル定義が集約点に
 * 存在してから `status`/`list` をマージするため)。
 */
export function registerStatusAndDraft(): void {
  // コマンドハンドラを規約適合キー(結合キー / トップレベル名)でレジストリへ登録する。
  registerHandler("command", STATUS_COMMAND_NAME, statusCommandHandler);
  registerHandler(
    "command",
    `${GOAL_COMMAND_NAME} ${GOAL_STATUS_SUBCOMMAND}`,
    goalStatusCommandHandler,
  );
  registerHandler(
    "command",
    `${EVIDENCE_COMMAND_NAME} ${EVIDENCE_LIST_SUBCOMMAND}`,
    evidenceListCommandHandler,
  );
  registerHandler("command", DRAFT_COMMAND_NAME, draftCommandHandler);

  // 4 ハンドラは `mode:"deferred-persistent"` を返すため、各継続を起動時に登録する(checkin と同型)。
  // top-level 副作用(index.ts が本関数を呼ぶ)で登録するため Worker fetch / DO 双方の isolate に
  // 反映され、DO alarm 上の lookupContinuation が解決できる(discord-gateway Req 8.6)。
  registerContinuation(STATUS_OVERVIEW_CONTINUATION_KEY, statusOverviewContinuation);
  registerContinuation(GOAL_STATUS_CONTINUATION_KEY, goalStatusContinuation);
  registerContinuation(DRAFT_GENERATE_CONTINUATION_KEY, draftGenerateContinuation);
  registerContinuation(DRAFT_REFINE_CONTINUATION_KEY, draftRefineContinuation);

  // 4 種の調整ボタンは動的 custom_id 接頭辞で登録(kind は接頭辞に符号化済み →
  // refineButtonHandler が内部で parse する)。保存ボタンも接頭辞で登録する。
  for (const base of [SHORTEN_BTN, STRENGTHEN_BTN, CLARIFY_BTN, MANAGER_BTN]) {
    registerPrefixHandler("component", `${base}${PENDING_BUTTON_SEPARATOR}`, refineButtonHandler);
  }
  registerPrefixHandler(
    "component",
    `${SAVE_DRAFT_BTN}${PENDING_BUTTON_SEPARATOR}`,
    saveDraftButtonHandler,
  );

  // /status・/draft の定義は集約点へそのまま追加する。
  registerCommandDefinition(statusCommandDefinition);
  registerCommandDefinition(draftCommandDefinition);

  // /goal status・/evidence list は goal-management 所有の定義へサブコマンドをマージする
  // (ソース不変・クローン差し替え)。registerGoalManagement の後に呼ばれる前提。
  mergeSubcommandIntoCommand(GOAL_COMMAND_NAME, goalStatusSubcommandDefinition);
  mergeSubcommandIntoCommand(EVIDENCE_COMMAND_NAME, evidenceListSubcommandDefinition);
}
