// [修正] ボタンハンドラ(checkin-classification Edit Button Handler / Req 3.5, 3.6, 3.7)。
//
// design「確認提示」フローの修正経路を担う薄層。MVP では分類のやり直しを「元の自由文を
// 編集して再送信する」体験で提供する:
// 1. custom_id から pendingId を抽出し、infra 揮発 KV から pending 分類を hydrate する。
// 2. pending が無ければ(不在/別人)操作不可通知(Req 3.7)。
// 3. pending があれば、元の raw テキストを value に充填した checkin modal(CHECKIN_MODAL_ID)を
//    再提示する。再送信は通常の modal submit 経路で再分類され、新しい確認案が出る。混乱を避ける
//    ため、再提示時に旧 pending を破棄する(再送信で新しい pending が作られる)。
//
// modal を開く応答(type9)は即時。pending 読み取り・旧 pending 破棄のため async で完結する。
//
// 依存方向: handlers → custom-ids / routing / domain / discord 契約型(左方向のみ)。

import type { DiscordEnv } from "../../discord/env";
import type {
  HandlerResult,
  InteractionContext,
  InteractionHandler,
  ModalActionRow,
} from "../../discord/types";
import { CHECKIN_INPUT_FIELD_ID, CHECKIN_MODAL_ID, parseCheckinEditButtonId } from "../custom-ids";
import { getPendingClassification } from "../domain/checkin-operations";
import { getCheckinEphemeralKv, hydratePendingStore, pendingCheckinKey } from "../routing";

// Discord modal text input の style 値(数値リテラル / workerd enum 問題回避。1=Short / 2=Paragraph)。
const PARAGRAPH = 2; // TextInputStyle.Paragraph

/** pending 不在/別人で修正できない場合の通知(他ユーザーデータを露出しない / Req 3.7)。 */
const NOT_FOUND_NOTICE =
  "この分類案はすでに確定/破棄済みか、操作できません。もう一度 `/checkin` からやり直してください。";

/** custom_id 不正で pendingId が取れない場合の通知。 */
const INVALID_BUTTON_NOTICE = "この操作は受け付けられませんでした。";

/** 元の自由文を value に充填した checkin modal の action row を組み立てる(Req 3.5)。 */
function editModalRows(rawText: string): ModalActionRow[] {
  return [
    {
      type: 1,
      components: [
        {
          type: 4,
          custom_id: CHECKIN_INPUT_FIELD_ID,
          label: "今週やったこと",
          style: PARAGRAPH,
          required: true,
          value: rawText,
        },
      ],
    },
  ];
}

/**
 * [修正] ボタンハンドラ(Req 3.5, 3.7)。
 *
 * pending の元自由文を充填した checkin modal を再提示する。旧 pending は破棄し、再送信で
 * 新たな分類・確認案へつなぐ。pending 不在/別人は操作不可として通知する。
 */
export const editButtonHandler: InteractionHandler = {
  async handle(ctx: InteractionContext, env: DiscordEnv): Promise<HandlerResult> {
    const pendingId = parseCheckinEditButtonId(ctx.name);
    if (pendingId === null) {
      return { mode: "reply", ephemeral: true, content: INVALID_BUTTON_NOTICE };
    }

    const kv = await getCheckinEphemeralKv(env, ctx.userId);
    const store = await hydratePendingStore(kv, pendingId);
    const pending = getPendingClassification(store, ctx.userId, pendingId);
    if (pending === null) {
      return { mode: "reply", ephemeral: true, content: NOT_FOUND_NOTICE };
    }

    // 旧 pending を破棄し、再送信で新しい pending が作られるようにする(二重 pending を避ける)。
    await kv.delete(pendingCheckinKey(pendingId));

    return {
      mode: "modal",
      customId: CHECKIN_MODAL_ID,
      title: "今週の実績を修正",
      components: editModalRows(pending.rawText),
    };
  },
};
