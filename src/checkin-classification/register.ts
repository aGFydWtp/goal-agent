// checkin-classification のハンドラ登録とコマンド定義集約 (task 4.1 / Req 1.1, 6.4)。
//
// design「File Structure Plan `register.ts`」「Modified Files」に従い、本モジュールは
// checkin-classification の各ハンドラを discord-gateway のレジストリへ識別子(コマンド名 /
// custom_id / 接頭辞)で登録し、`/checkin` のコマンド定義を集約点へ追加する配線層である。
// ゲートウェイの登録機構(registry / commands/definitions)は変更せず、その公開 API
// (registerHandler / registerPrefixHandler / registerCommandDefinition)を呼ぶだけで完結する
// (Req 6.4: 登録手段を再定義しない)。
//
// なお design 記述「EvaluationCycleAgent 骨格が宣言する責務メソッドの中身を埋める」は
// infra boundary test(Req 6.2)と矛盾するため適用しない。Agent にはドメインメソッドを追加せず、
// ドメインロジックは worker 側(domain/checkin-operations.ts)に置き、Agent の汎用揮発 KV
// (putEphemeral/getEphemeral/deleteEphemeral)のみを pending 保持に使う(routing ブリッジ)。
//
// 登録識別子の規約:
//  - command は dispatch(`nameOf()`)が `interaction.data.name` で解決するためコマンド名で登録。
//  - modal / 入力ボタンは固定 custom_id で登録(完全一致)。
//  - 保存/修正/破棄ボタンは custom_id に pendingId を埋め込む動的 custom_id のため、接頭辞
//    (`checkin:save:` 等。区切り `:` を含めて誤一致を防ぐ)で登録し、registry の最長前方一致
//    ディスパッチで解決する。
//
// production は `src/index.ts` が本関数をロードして起動時に一度呼ぶ。テストは reset 後に本関数を
// 明示呼び出しして登録状態を分離できるよう、登録ロジックを関数として export する。
//
// 依存方向: `commands.ts` / `custom-ids.ts` → `register.ts` → `handlers/*`(左方向のみ)。

import { registerCommandDefinition } from "../discord/commands/definitions";
import { registerContinuation } from "../discord/continuation";
import { registerHandler, registerPrefixHandler } from "../discord/registry";
import { CHECKIN_COMMAND_NAME, checkinCommandDefinitions } from "./commands";
import {
  CHECKIN_DISCARD_BUTTON_ID,
  CHECKIN_EDIT_BUTTON_ID,
  CHECKIN_INPUT_BUTTON_ID,
  CHECKIN_MODAL_ID,
  CHECKIN_SAVE_BUTTON_ID,
} from "./custom-ids";
import { checkinCommandHandler } from "./handlers/checkin-command";
import {
  CHECKIN_CLASSIFICATION_CONTINUATION_KEY,
  checkinClassificationContinuation,
  checkinModalSubmitHandler,
} from "./handlers/checkin-modal-submit";
import { discardButtonHandler } from "./handlers/discard-button";
import { editButtonHandler } from "./handlers/edit-button";
import { inputButtonHandler } from "./handlers/input-button";
import { saveButtonHandler } from "./handlers/save-button";

// 動的ボタン custom_id の区切り。custom-ids.ts の build* が pendingId 前に付ける `:` と一致させ、
// 接頭辞に含めることで `checkin:save` が `checkin:saveXXX` 等へ誤一致しないようにする。
const PENDING_BUTTON_SEPARATOR = ":";

/**
 * checkin-classification の登録配線(Req 1.1, 6.4)。
 *
 * `/checkin` コマンド・[入力する] ボタン・checkin modal submit は固定識別子で完全一致登録し、
 * [保存]/[修正]/[破棄] ボタンは pendingId 埋め込みの動的 custom_id のため接頭辞で登録する。
 * 最後に `/checkin` のコマンド定義を discord-gateway の集約点へ追加する(機構は変更しない)。
 */
export function registerCheckinClassification(): void {
  registerHandler("command", CHECKIN_COMMAND_NAME, checkinCommandHandler);
  registerHandler("component", CHECKIN_INPUT_BUTTON_ID, inputButtonHandler);
  registerHandler("modal", CHECKIN_MODAL_ID, checkinModalSubmitHandler);

  // modal submit は `mode:"deferred-persistent"` を返すため、分類継続を起動時に登録する。
  // top-level 副作用(index.ts が本関数を呼ぶ)で登録するため Worker fetch / DO 双方の isolate に
  // 反映され、DO alarm 上の lookupContinuation が解決できる(discord-gateway Req 8.6 / tasks.md L227)。
  registerContinuation(CHECKIN_CLASSIFICATION_CONTINUATION_KEY, checkinClassificationContinuation);

  registerPrefixHandler(
    "component",
    `${CHECKIN_SAVE_BUTTON_ID}${PENDING_BUTTON_SEPARATOR}`,
    saveButtonHandler,
  );
  registerPrefixHandler(
    "component",
    `${CHECKIN_EDIT_BUTTON_ID}${PENDING_BUTTON_SEPARATOR}`,
    editButtonHandler,
  );
  registerPrefixHandler(
    "component",
    `${CHECKIN_DISCARD_BUTTON_ID}${PENDING_BUTTON_SEPARATOR}`,
    discardButtonHandler,
  );

  for (const definition of checkinCommandDefinitions) {
    registerCommandDefinition(definition);
  }
}
