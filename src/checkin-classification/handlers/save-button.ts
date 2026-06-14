// [保存] ボタンハンドラ(checkin-classification Save Button Handler /
// Req 3.3, 3.6, 3.7, 4.1-4.6, 5.1, 5.2, 5.3, 5.5)。
//
// design「保存 → 週次レビュー生成」フローに従う薄層:
// 1. custom_id から pendingId を抽出し、infra 揮発 KV から pending 分類を hydrate する。
// 2. 証跡化ドメインメソッド(saveClassifiedCheckin)で checkins/evidence/evidence_goal_links を
//    所有者スコープで一括保存。pending 不在/別人は not_found(操作不可通知 / Req 3.7)。
// 3. 続けて週次レビュー生成(generateWeeklyReview)を呼び、保存後メッセージ(§14.2)を返す。
//    レビュー失敗時も証跡保存は保持し、保存完了 + レビュー失敗を通知(Req 5.5)。
//
// 週次レビュー生成は LLM 呼び出しを含み 3 秒以内に完了しない可能性があるため、本ハンドラは
// deferred(type5, ephemeral)を宣言し、保存・レビュー・整形を waitUntil 継続で行い follow-up
// で本応答を送る(Discord の 3 秒初期応答制約)。全応答は ephemeral(Req 3.6)。
//
// 依存方向: handlers → custom-ids / messages / routing / domain / goal-management routing /
// llm factory(左方向のみ)。

import type { DiscordEnv } from "../../discord/env";
import type {
  Followup,
  HandlerResult,
  InteractionContext,
  InteractionHandler,
} from "../../discord/types";
import { defaultDeps } from "../../goal-management/domain/cycle-operations";
import { getUserCycleAuthority } from "../../goal-management/routing";
import { createLlmClient } from "../../llm/factory";
import { parseCheckinSaveButtonId } from "../custom-ids";
import {
  generateWeeklyReview,
  getPendingClassification,
  saveClassifiedCheckin,
} from "../domain/checkin-operations";
import { formatPostSaveMessage } from "../messages";
import { getCheckinEphemeralKv, hydratePendingStore, pendingCheckinKey } from "../routing";

/** pending 不在/別人で確定できない場合の通知(他ユーザーデータを露出しない / Req 3.7)。 */
const NOT_FOUND_NOTICE =
  "この分類案はすでに確定/破棄済みか、操作できません。もう一度 `/checkin` からやり直してください。";

/** custom_id 不正で pendingId が取れない場合の通知。 */
const INVALID_BUTTON_NOTICE = "この操作は受け付けられませんでした。";

/** 保存自体に失敗した場合の通知(部分書き込みは残さない / Req 4.6)。 */
const SAVE_FAILED_NOTICE = "保存に失敗しました。お手数ですが、もう一度お試しください。";

/** 週次レビュー生成に失敗したが証跡は保存できた場合の通知(Req 5.5)。 */
const REVIEW_FAILED_NOTICE =
  "保存しました。今週のレビュー生成には失敗しましたが、入力内容は記録されています。";

/**
 * 証跡化 → 週次レビュー生成 → 保存後メッセージ整形を行う deferred 継続。
 *
 * pending 不在/別人/保存失敗/レビュー失敗をそれぞれ ephemeral 通知へ正規化する。
 */
async function runSave(
  env: DiscordEnv,
  userId: string,
  pendingId: string,
  followup: Followup,
): Promise<void> {
  const authority = await getUserCycleAuthority(env, userId);
  const kv = await getCheckinEphemeralKv(env, userId);
  const store = await hydratePendingStore(kv, pendingId);

  // 週次レビュー生成に必要な cycleId は保存で pending が破棄される前に読む。
  const pending = getPendingClassification(store, userId, pendingId);
  if (pending === null) {
    await followup.editOriginal(NOT_FOUND_NOTICE);
    return;
  }

  const deps = defaultDeps();
  const saveResult = await saveClassifiedCheckin(authority, deps, store, { userId, pendingId });
  if (!saveResult.ok) {
    await followup.editOriginal(
      saveResult.reason === "not_found" ? NOT_FOUND_NOTICE : SAVE_FAILED_NOTICE,
    );
    return;
  }

  // 保存確定後に揮発 KV の pending を破棄する(domain は hydrate した一時 store のみを更新する)。
  await kv.delete(pendingCheckinKey(pendingId));

  const reviewResult = await generateWeeklyReview(authority, deps, createLlmClient(env), {
    userId,
    cycleId: pending.cycleId,
    weekStartDate: saveResult.weekStartDate,
  });
  if (!reviewResult.ok) {
    // 証跡保存は確定済みとして保持し、レビュー失敗のみ通知する(Req 5.5)。
    await followup.editOriginal(REVIEW_FAILED_NOTICE);
    return;
  }

  await followup.editOriginal(formatPostSaveMessage(reviewResult.review));
}

/**
 * [保存] ボタンハンドラ(Req 3.3, 3.7, 4.*, 5.*)。
 *
 * custom_id から pendingId を抽出できない場合は即時 ephemeral 通知。抽出できた場合は deferred を
 * 宣言し、証跡化 → 週次レビュー → 保存後メッセージを {@link runSave} で継続する。
 */
export const saveButtonHandler: InteractionHandler = {
  handle(ctx: InteractionContext, env: DiscordEnv): HandlerResult {
    const pendingId = parseCheckinSaveButtonId(ctx.name);
    if (pendingId === null) {
      return { mode: "reply", ephemeral: true, content: INVALID_BUTTON_NOTICE };
    }

    const userId = ctx.userId;
    return {
      mode: "deferred",
      ephemeral: true,
      run: (followup) => runSave(env, userId, pendingId, followup),
    };
  },
};
