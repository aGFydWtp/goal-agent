// [破棄] ボタンハンドラ(checkin-classification Discard Button Handler / Req 3.4, 3.6, 3.7)。
//
// design「確認提示」フローの破棄経路を担う薄層:
// 1. custom_id から pendingId を抽出し、infra 揮発 KV から pending 分類を hydrate する。
// 2. pending を所有者スコープで破棄(discardPendingClassification)。不在/別人は not_found
//    (操作不可通知 / Req 3.7)。破棄成功で揮発 KV のキーも削除し、確定されない旨を通知。
//
// LLM 非依存・即時完結のため reply(type4, ephemeral)で応答する。全応答は ephemeral(Req 3.6)。
//
// 依存方向: handlers → custom-ids / routing / domain(左方向のみ)。

import type { DiscordEnv } from "../../discord/env";
import type { HandlerResult, InteractionContext, InteractionHandler } from "../../discord/types";
import { parseCheckinDiscardButtonId } from "../custom-ids";
import { discardPendingClassification } from "../domain/checkin-operations";
import { getCheckinEphemeralKv, hydratePendingStore, pendingCheckinKey } from "../routing";

/** pending 不在/別人で破棄できない場合の通知(他ユーザーデータを露出しない / Req 3.7)。 */
const NOT_FOUND_NOTICE =
  "この分類案はすでに確定/破棄済みか、操作できません。もう一度 `/checkin` からやり直してください。";

/** custom_id 不正で pendingId が取れない場合の通知。 */
const INVALID_BUTTON_NOTICE = "この操作は受け付けられませんでした。";

/** 破棄完了の通知(証跡は作らない / Req 3.4)。 */
const DISCARDED_NOTICE = "分類案を破棄しました。記録は作成していません。";

/** ephemeral な reply 応答を組み立てる(Req 3.6)。 */
function ephemeralReply(content: string): HandlerResult {
  return { mode: "reply", ephemeral: true, content };
}

/**
 * [破棄] ボタンハンドラ(Req 3.4, 3.7)。
 *
 * custom_id から pendingId を抽出し、所有者スコープで pending を破棄する。不在/別人は
 * 操作不可として通知し、破棄成功時は揮発 KV のキーも削除して破棄通知を返す。
 */
export const discardButtonHandler: InteractionHandler = {
  async handle(ctx: InteractionContext, env: DiscordEnv): Promise<HandlerResult> {
    const pendingId = parseCheckinDiscardButtonId(ctx.name);
    if (pendingId === null) {
      return ephemeralReply(INVALID_BUTTON_NOTICE);
    }

    const kv = await getCheckinEphemeralKv(env, ctx.userId);
    const store = await hydratePendingStore(kv, pendingId);
    const result = discardPendingClassification(store, ctx.userId, pendingId);
    if (!result.ok) {
      return ephemeralReply(NOT_FOUND_NOTICE);
    }

    await kv.delete(pendingCheckinKey(pendingId));
    return ephemeralReply(DISCARDED_NOTICE);
  },
};
