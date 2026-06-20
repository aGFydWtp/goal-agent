// ドラフト調整ボタンハンドラ(status-and-draft Refine Button Handler /
// Req 6.5, 6.6, 6.7, 5.9, 8.2)。4 種([短くする]/[成果を強める]/[課題を明確にする]/[上司向けにする])。
//
// design「`/draft` System Flow」の調整経路を担う薄層:
// 1. custom_id から kind と draftPendingId を抽出(parseRefineButtonId)。不正は即時 ephemeral 案内。
// 2. 再生成は LLM 呼び出しを伴うため deferred(type5, ephemeral)を宣言し、follow-up で継続する。
// 3. infra 揮発 KV から pending ドラフトを hydrate し、refineDraft で kind 別に再生成 → §8.7 +
//    調整/保存ボタンを再提示し、更新済み pending を KV へ再 persist する(Req 6.5)。
//    pending 不在/別人は操作不可(Req 6.6)、再生成失敗は直前ドラフトを維持して失敗案内(Req 6.7)。
//
// ビジネスルール(所有者照合・再生成・pending 更新)はドメイン層へ委譲し、ハンドラは入出力変換と
// 応答整形のみを担う。全応答は ephemeral(Req 5.9, 8.2)。
//
// 依存方向: handlers → custom-ids / messages / routing / domain / goal-management routing /
// llm factory(左方向のみ)。

import type { DiscordEnv } from "../../discord/env";
import type {
  Continuation,
  ContinuationPayload,
  Followup,
  HandlerResult,
  InteractionContext,
  InteractionHandler,
} from "../../discord/types";
import { defaultDeps } from "../../goal-management/domain/cycle-operations";
import { getUserCycleAuthority } from "../../goal-management/routing";
import { createLlmClient } from "../../llm/factory";
import { parseRefineButtonId, REFINE_KINDS, type RefineKind } from "../custom-ids";
import { refineDraft } from "../domain/draft-operations";
import { formatDraft } from "../messages";
import { getDraftEphemeralKv, hydratePendingDraftStore, persistPendingDraft } from "../routing";
import { draftButtonsRow } from "./draft-buttons";

/** custom_id 不正で kind/draftPendingId が取れない場合の即時通知。 */
const INVALID_BUTTON_NOTICE = "この操作は受け付けられませんでした。";

/** pending 不在/別人で調整できない場合の通知(他ユーザーデータを露出しない / Req 6.6, 8.1)。 */
const NOT_FOUND_NOTICE =
  "このドラフトはすでに失効しているか、操作できません。もう一度 `/draft` から生成してください。";

/** 再生成失敗時の案内(直前ドラフトは保持されている / Req 6.7)。 */
const REFINE_FAILED_NOTICE =
  "ドラフトの調整に失敗しました。直前のドラフトはそのまま残っています。もう一度お試しください。";

/**
 * pending を hydrate して kind 別に再生成し、結果を follow-up で送る deferred 継続(Req 6.5-6.7)。
 *
 * 再生成成功 → §8.7 + 調整/保存ボタンを再提示し、更新済み pending を KV へ再 persist する。
 * pending 不在/別人は操作不可、再生成失敗は直前ドラフト維持の案内へ正規化する。
 */
async function runRefine(
  env: DiscordEnv,
  userId: string,
  draftPendingId: string,
  kind: RefineKind,
  followup: Followup,
): Promise<void> {
  const authority = await getUserCycleAuthority(env, userId);
  const kv = await getDraftEphemeralKv(env, userId);
  const store = await hydratePendingDraftStore(kv, draftPendingId);

  const result = await refineDraft(
    authority,
    defaultDeps(),
    createLlmClient(env),
    store,
    userId,
    draftPendingId,
    kind,
  );
  if (!result.ok) {
    await followup.editOriginal(
      result.reason === "not_found" ? NOT_FOUND_NOTICE : REFINE_FAILED_NOTICE,
    );
    return;
  }

  // 更新済み pending(refineDraft が store の内容を in-place 更新)を KV へ再 persist する。
  const pending = store.drafts.get(draftPendingId);
  if (pending !== undefined) {
    await persistPendingDraft(kv, pending);
  }

  await followup.editOriginal(formatDraft(result.content), {
    components: [draftButtonsRow(draftPendingId)],
  });
}

/**
 * ドラフト調整ボタンハンドラ(Req 6.5, 6.6, 6.7)。
 *
 * custom_id から kind/draftPendingId を抽出できない場合は即時 ephemeral 通知。抽出できた場合は
 * deferred を宣言し、再生成と §8.7 再提示を {@link runRefine} で継続する。すべて ephemeral。
 */
export const refineButtonHandler: InteractionHandler = {
  handle(ctx: InteractionContext, _env: DiscordEnv): HandlerResult {
    const parsed = parseRefineButtonId(ctx.name);
    if (parsed === null) {
      return { mode: "reply", ephemeral: true, content: INVALID_BUTTON_NOTICE };
    }

    return {
      mode: "deferred-persistent",
      ephemeral: true,
      continuation: {
        key: DRAFT_REFINE_CONTINUATION_KEY,
        payload: { userId: ctx.userId, draftPendingId: parsed.draftPendingId, kind: parsed.kind },
      },
    };
  },
};

/** ドラフト調整(refine)継続のレジストリキー(discord-gateway Req 8.6 adoption)。 */
export const DRAFT_REFINE_CONTINUATION_KEY = "draft:refine";

/** 文字列を {@link RefineKind} へ絞り込む(規約外は null)。 */
function toRefineKind(value: unknown): RefineKind | null {
  return REFINE_KINDS.find((k) => k === value) ?? null;
}

/**
 * ドラフト調整(refine)を DO alarm 上で実行する永続継続(Req 8.1, 8.6)。
 *
 * ~24s の LLM 再生成を `ctx.waitUntil` budget から切り離し「考え中…」固着を防ぐ(checkin と同型)。
 * payload から `userId`/`draftPendingId`/`kind` を復元し {@link runRefine} へ委譲する。
 */
export const draftRefineContinuation: Continuation = async (
  env: DiscordEnv,
  payload: ContinuationPayload,
  followup: Followup,
): Promise<void> => {
  const userId = payload.userId;
  const draftPendingId = payload.draftPendingId;
  const kind = toRefineKind(payload.kind);
  if (typeof userId !== "string" || typeof draftPendingId !== "string" || kind === null) {
    throw new Error("draft 調整継続: payload に userId/draftPendingId/kind がありません");
  }
  await runRefine(env, userId, draftPendingId, kind, followup);
};
