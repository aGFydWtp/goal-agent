// `/status` コマンドハンドラ(status-and-draft Status Command Handler / Req 2.1-2.6, 8.2)。
//
// design「薄いハンドラ層 + ドメインメソッド」に従い、discord-gateway の InteractionContext から
// 実行ユーザーを読み、サイクル/目標の有無を安価な read で確認してから deferred 判定へ進む薄層に
// 徹する。状態判定(ルール + LLM)はドメイン層(determineAllStatuses)へ委譲し、ハンドラは
// 入出力変換と応答整形(§8.4)のみを担う。
//
// サイクル無し → サイクル未作成案内のみを ephemeral 即時応答し、判定を行わない(Req 2.4)。
// 目標無し → 目標未登録案内を ephemeral 即時応答(Req 2.5)。いずれも LLM を呼ばない。
// 目標あり → deferred(ephemeral, type5)を 3 秒以内に返し、全目標判定を follow-up で提示する
// (Req 2.1, 2.2, 2.3)。
//
// すべての応答は本人のみが閲覧できる ephemeral 文脈(Req 2.6, 8.2)。
//
// 依存方向: handlers → messages / domain / goal-management(routing/domain) / llm factory(左方向のみ)。

import type { DiscordEnv } from "../../discord/env";
import type {
  Continuation,
  ContinuationPayload,
  Followup,
  HandlerResult,
  InteractionContext,
  InteractionHandler,
} from "../../discord/types";
import {
  defaultDeps,
  listGoals,
  resolveActiveCycle,
} from "../../goal-management/domain/cycle-operations";
import { getUserCycleAuthority } from "../../goal-management/routing";
import { createLlmClient } from "../../llm/factory";
import { determineAllStatuses } from "../domain/status-operations";
import { formatStatusOverview } from "../messages";

/** アクティブサイクル未作成時の案内(判定を行わない / Req 2.4)。 */
const NO_CYCLE_GUIDANCE =
  "アクティブな評価サイクルがまだありません。先に `/cycle create` でサイクルを作成し、`/goal add` で評価目標を登録してから `/status` を実行してください。";

/** 目標未登録時の案内(Req 2.5)。 */
const NO_GOALS_GUIDANCE =
  "アクティブなサイクルに評価目標がまだ登録されていません。`/goal add` で評価目標を登録してから `/status` を実行してください。";

/** 判定が成立しなかった場合の防御的案内(競合などで no_cycle/no_goals に落ちた場合)。 */
const STATUS_UNAVAILABLE_GUIDANCE =
  "現在ステータスを表示できませんでした。お手数ですが、もう一度 `/status` を実行してください。";

/**
 * `/status` ハンドラ(Req 2.1-2.6, 8.2)。
 *
 * 1. `getUserCycleAuthority` でデータ権威を取得し、`resolveActiveCycle` でアクティブサイクルを
 *    確認する。無ければ判定を行わずサイクル未作成案内を ephemeral 即時応答(Req 2.4)。
 * 2. `listGoals` で目標を確認し、空なら目標未登録案内を ephemeral 即時応答(Req 2.5)。
 * 3. 目標ありなら deferred(ephemeral)を返し、`determineAllStatuses` の判定結果を §8.4 形式で
 *    follow-up する(Req 2.1, 2.2, 2.3)。判定が no_cycle/no_goals に落ちた場合は防御的案内へ正規化する。
 */
export const statusCommandHandler: InteractionHandler = {
  async handle(ctx: InteractionContext, env: DiscordEnv): Promise<HandlerResult> {
    const authority = await getUserCycleAuthority(env, ctx.userId);

    const cycle = await resolveActiveCycle(authority, ctx.userId);
    if (cycle === null) {
      return { mode: "reply", ephemeral: true, content: NO_CYCLE_GUIDANCE };
    }

    const goals = await listGoals(authority, ctx.userId, cycle.id);
    if (goals.length === 0) {
      return { mode: "reply", ephemeral: true, content: NO_GOALS_GUIDANCE };
    }

    return {
      mode: "deferred-persistent",
      ephemeral: true,
      continuation: {
        key: STATUS_OVERVIEW_CONTINUATION_KEY,
        payload: { userId: ctx.userId },
      },
    };
  },
};

/** `/status` 全目標判定継続のレジストリキー(discord-gateway Req 8.6 adoption)。 */
export const STATUS_OVERVIEW_CONTINUATION_KEY = "status:overview";

/**
 * `/status` 全目標判定を DO alarm 上で実行する永続継続(Req 8.1, 8.6)。
 *
 * ~24s の LLM 判定を `ctx.waitUntil` budget から切り離し「考え中…」固着を防ぐ(checkin と同型)。
 * payload から `userId` を復元し authority を再取得して判定・整形・follow-up を行う。
 */
export const statusOverviewContinuation: Continuation = async (
  env: DiscordEnv,
  payload: ContinuationPayload,
  followup: Followup,
): Promise<void> => {
  const userId = payload.userId;
  if (typeof userId !== "string") {
    throw new Error("status 継続: payload に userId がありません");
  }
  const authority = await getUserCycleAuthority(env, userId);
  const result = await determineAllStatuses(authority, defaultDeps(), createLlmClient(env), userId);
  if (!result.ok) {
    await followup.editOriginal(STATUS_UNAVAILABLE_GUIDANCE);
    return;
  }
  await followup.editOriginal(formatStatusOverview(result.results));
};
