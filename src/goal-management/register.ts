import { registerCommandDefinition } from "../discord/commands/definitions";
import { registerHandler } from "../discord/registry";
import {
  CYCLE_COMMAND_NAME,
  EVIDENCE_COMMAND_NAME,
  GOAL_COMMAND_NAME,
  GOAL_MODAL_ID,
  goalManagementCommandDefinitions,
} from "./commands";
import { cycleCreateHandler } from "./handlers/cycle-create";
import { evidenceDeleteHandler } from "./handlers/evidence-delete";
import { goalAddHandler } from "./handlers/goal-add";
import { goalModalSubmitHandler } from "./handlers/goal-modal-submit";

/**
 * goal-management のハンドラ登録とコマンド定義集約 (Req 1.1, 2.1, 3.1, 6.4 /
 * design.md File Structure Plan `register.ts` L126, Integration L320, Modified Files L142)。
 *
 * 本モジュールは goal-management の 4 ハンドラを discord-gateway のレジストリへ識別子
 * (コマンド名 / custom_id)で登録し、3 コマンド定義を discord-gateway のコマンド定義
 * 集約点へ追加する配線層である。ゲートウェイの登録機構(`registry.ts` /
 * `commands/definitions.ts`)は変更せず、その公開 API(`registerHandler` /
 * `registerCommandDefinition`)を呼ぶだけで完結する(Req 6.4: 登録手段を再定義しない)。
 *
 * 登録識別子の規約(commands.ts 注記・design L320):
 *  - command は discord-gateway の dispatch(`nameOf()`)が `interaction.data.name`
 *    (トップレベルコマンド名)で解決するため、registry キーもトップレベルコマンド名
 *    (`cycle` / `goal` / `evidence`)で登録する。サブコマンド(`create` / `add` /
 *    `delete`)はハンドラが `ctx.raw` から読む。
 *  - modal は custom_id({@link GOAL_MODAL_ID})で照合されるため、その custom_id で登録する。
 *
 * ハンドラ ⇄ 識別子の対応:
 *  - `("command", "cycle")`    → {@link cycleCreateHandler}(`/cycle create` / Req 1.1)。
 *  - `("command", "goal")`     → {@link goalAddHandler}(`/goal add` modal 提示 / Req 2.1)。
 *  - `("modal", GOAL_MODAL_ID)` → {@link goalModalSubmitHandler}(目標 modal submit / Req 2.1)。
 *  - `("command", "evidence")` → {@link evidenceDeleteHandler}(`/evidence delete` / Req 3.1)。
 *
 * production は `src/index.ts` が本関数をロードして起動時に一度呼ぶ(design L142 承認済み)。
 * テストは reset 後に本関数を明示呼び出しして登録状態を分離できるよう、登録ロジックを
 * 関数として export する(module 読込時の副作用にしない)。
 *
 * 依存方向: `commands.ts` → `register.ts` → `handlers/*`(design L144)。本モジュールは
 * discord-gateway の登録 API と自スペックの定義 / ハンドラのみを参照する。
 */
export function registerGoalManagement(): void {
  // ハンドラを識別子(コマンド名 / custom_id)でレジストリへ登録する (Req 1.1, 2.1, 3.1)。
  registerHandler("command", CYCLE_COMMAND_NAME, cycleCreateHandler);
  registerHandler("command", GOAL_COMMAND_NAME, goalAddHandler);
  registerHandler("modal", GOAL_MODAL_ID, goalModalSubmitHandler);
  registerHandler("command", EVIDENCE_COMMAND_NAME, evidenceDeleteHandler);

  // コマンド定義を discord-gateway の集約点へ追加する(機構は変更しない / Req 6.4)。
  for (const definition of goalManagementCommandDefinitions) {
    registerCommandDefinition(definition);
  }
}
