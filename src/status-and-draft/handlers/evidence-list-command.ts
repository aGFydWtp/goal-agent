// `/evidence list` コマンドハンドラ(status-and-draft Evidence List Command Handler /
// Req 4.1, 4.3, 4.4, 8.2)。
//
// design「薄いハンドラ層 + ドメインメソッド」に従い、InteractionContext から実行ユーザーを読み、
// 所有者スコープの証跡を `listEvidenceWithLinks` で取得して §8.6 形式へ整形する薄層に徹する。
// LLM を伴わない閲覧操作なので deferred せず即時(type4 ephemeral)で完結する。
//
// 証跡無しは整形関数が未保存案内を返すため(Req 4.3)、ハンドラ側で分岐は持たない。所有者スコープの
// 取得はドメイン層が保証し、他ユーザーの証跡を含めない(Req 4.4, 8.1)。
//
// すべての応答は本人のみが閲覧できる ephemeral 文脈(Req 4.4, 8.2)。
//
// 依存方向: handlers → messages / domain / goal-management routing(左方向のみ)。

import type { DiscordEnv } from "../../discord/env";
import type {
  HandlerResult,
  InteractionContext,
  InteractionHandler,
} from "../../discord/types";
import { getUserCycleAuthority } from "../../goal-management/routing";
import { listEvidenceWithLinks } from "../domain/evidence-view";
import { formatEvidenceList } from "../messages";

/**
 * `/evidence list` ハンドラ(Req 4.1, 4.3, 4.4, 8.2)。
 *
 * `getUserCycleAuthority` で実行ユーザーのデータ権威を取得し、`listEvidenceWithLinks` で所有者スコープの
 * 証跡(紐づく目標名付き)を取得、`formatEvidenceList` で §8.6 形式へ整形して ephemeral 即時応答する。
 * 証跡無しは整形関数が未保存案内を返す(Req 4.3)。LLM を伴わないため deferred しない。
 */
export const evidenceListCommandHandler: InteractionHandler = {
  async handle(ctx: InteractionContext, env: DiscordEnv): Promise<HandlerResult> {
    const authority = await getUserCycleAuthority(env, ctx.userId);
    const items = await listEvidenceWithLinks(authority, ctx.userId);
    return { mode: "reply", ephemeral: true, content: formatEvidenceList(items) };
  },
};
