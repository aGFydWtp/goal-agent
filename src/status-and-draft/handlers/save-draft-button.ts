// [保存] ボタンハンドラ(status-and-draft Save Draft Button Handler /
// Req 7.3, 7.4, 5.9, 8.2)。
//
// design「`/draft` System Flow」の保存経路を担う薄層:
// 1. custom_id から draftPendingId を抽出(parseSaveDraftButtonId)。不正は即時 ephemeral 案内。
// 2. infra 揮発 KV から pending ドラフトを hydrate し、saveDraft で drafts へ確定保存する。
//    pending 不在/別人は操作不可(保存しない / Req 7.4)、成功は保存通知(Req 7.3)。
//
// 保存は LLM 非依存(揮発 pending を drafts へ書き込むのみ)で 3 秒以内に完了するため、即時応答
// (type4, ephemeral)で完結させる。`handle` は async で pending hydrate と保存を行い、本応答を
// 返す。saveDraft は pending を破棄しない(調整→再保存の UX を維持。design §8.7 でボタンが残る)。
//
// ビジネスルール(所有者照合・確定保存)はドメイン層へ委譲し、ハンドラは入出力変換と応答整形のみを
// 担う。全応答は ephemeral(Req 5.9, 8.2)。
//
// 依存方向: handlers → custom-ids / routing / domain / goal-management routing(左方向のみ)。

import type { DiscordEnv } from "../../discord/env";
import type { HandlerResult, InteractionContext, InteractionHandler } from "../../discord/types";
import { defaultDeps } from "../../goal-management/domain/cycle-operations";
import { getUserCycleAuthority } from "../../goal-management/routing";
import { parseSaveDraftButtonId } from "../custom-ids";
import { saveDraft } from "../domain/draft-operations";
import { getDraftEphemeralKv, hydratePendingDraftStore } from "../routing";

/** custom_id 不正で draftPendingId が取れない場合の即時通知。 */
const INVALID_BUTTON_NOTICE = "この操作は受け付けられませんでした。";

/** pending 不在/別人で保存できない場合の通知(他ユーザーデータを露出しない / Req 7.4, 8.1)。 */
const NOT_FOUND_NOTICE =
  "このドラフトはすでに失効しているか、操作できません。もう一度 `/draft` から生成してください。";

/** 保存完了通知(Req 7.3)。 */
const SAVED_NOTICE = "ドラフトを保存しました。後で評価文として参照・流用できます。";

/**
 * [保存] ボタンハンドラ(Req 7.3, 7.4)。
 *
 * custom_id から draftPendingId を抽出できない場合は即時 ephemeral 通知。抽出できた場合は揮発 KV
 * から pending を hydrate し、`saveDraft` で drafts へ確定保存する。pending 不在/別人は操作不可、
 * 成功は保存通知を返す。すべて即時 ephemeral 応答(LLM 非依存)。
 */
export const saveDraftButtonHandler: InteractionHandler = {
  async handle(ctx: InteractionContext, env: DiscordEnv): Promise<HandlerResult> {
    const draftPendingId = parseSaveDraftButtonId(ctx.name);
    if (draftPendingId === null) {
      return { mode: "reply", ephemeral: true, content: INVALID_BUTTON_NOTICE };
    }

    const authority = await getUserCycleAuthority(env, ctx.userId);
    const kv = await getDraftEphemeralKv(env, ctx.userId);
    const store = await hydratePendingDraftStore(kv, draftPendingId);
    const result = await saveDraft(authority, defaultDeps(), store, ctx.userId, draftPendingId);

    return {
      mode: "reply",
      ephemeral: true,
      content: result.ok ? SAVED_NOTICE : NOT_FOUND_NOTICE,
    };
  },
};
