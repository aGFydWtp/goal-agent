// `/checkin` コマンドハンドラ(checkin-classification Checkin Command Handler / Req 1.1, 1.2, 1.5)。
//
// design「薄いハンドラ層 + Agent ドメインメソッド」に従い、discord-gateway の
// InteractionContext から実行ユーザーを読み、対象サイクル有無の確認(resolveCheckinActiveCycle)
// → 促し + [入力する] ボタン / サイクル未作成案内の整形を行う薄層に徹する。LLM 非依存の起点
// 処理なので即時(type4 ephemeral)で完結する。
//
// 対象サイクル有り: 促し文 + [入力する] ボタンを ephemeral 応答(Req 1.1)。ボタン押下で
// checkin modal を開く導線(input-button ハンドラ)へつなぐ。
// 対象サイクル無し: サイクル未作成である旨と先にサイクル/目標を用意する案内のみを ephemeral
// 応答し、分類フローを開始しない(ボタンを出さない、Req 1.2)。
//
// すべての応答は ephemeral(Req 1.5)。
//
// 依存方向: handlers → messages / custom-ids / domain / routing(左方向のみ)。

import type { DiscordEnv } from "../../discord/env";
import type {
  HandlerResult,
  InteractionContext,
  InteractionHandler,
  MessageActionRow,
} from "../../discord/types";
import { getUserCycleAuthority } from "../../goal-management/routing";
import { CHECKIN_INPUT_BUTTON_ID } from "../custom-ids";
import { resolveCheckinActiveCycle } from "../domain/checkin-operations";
import { formatCheckinPromptMessage } from "../messages";

// message component button のスタイル値(数値リテラル / workerd enum 問題回避。types.ts の
// MessageButtonStyle は 1=Primary / 2=Secondary / 3=Success / 4=Danger)。入力導線の主要操作
// なので Primary を用いる。
const PRIMARY = 1; // MessageButtonStyle.Primary

/** [入力する] ボタンを 1 つ内包する message action row(Req 1.1, 1.3)。 */
const inputButtonRow: MessageActionRow = {
  type: 1,
  components: [
    {
      type: 2,
      custom_id: CHECKIN_INPUT_BUTTON_ID,
      label: "入力する",
      style: PRIMARY,
    },
  ],
};

/** サイクル未作成時の案内文(分類フローを開始しない、Req 1.2)。 */
const NO_CYCLE_GUIDANCE =
  "アクティブな評価サイクルがまだありません。先に `/cycle create` でサイクルを作成し、`/goal add` で評価目標を登録してから `/checkin` を実行してください。";

/**
 * `/checkin` ハンドラ(Req 1.1, 1.2, 1.5)。
 *
 * 1. `getUserCycleAuthority` で実行ユーザーのデータ権威を取得し、`resolveCheckinActiveCycle`
 *    で対象サイクル有無を確認する。
 * 2. サイクル無し(`no_cycle`)→ サイクル未作成案内のみの ephemeral 応答。ボタンを出さず
 *    分類フローを開始しない(Req 1.2)。
 * 3. サイクル有り → 促し文 + [入力する] ボタンを ephemeral 応答(Req 1.1)。
 *
 * すべての応答は ephemeral(Req 1.5)。
 */
export const checkinCommandHandler: InteractionHandler = {
  async handle(ctx: InteractionContext, env: DiscordEnv): Promise<HandlerResult> {
    const authority = await getUserCycleAuthority(env, ctx.userId);
    const resolved = await resolveCheckinActiveCycle(authority, ctx.userId);

    if (!resolved.ok) {
      return { mode: "reply", ephemeral: true, content: NO_CYCLE_GUIDANCE };
    }

    return {
      mode: "reply",
      ephemeral: true,
      content: formatCheckinPromptMessage(),
      components: [inputButtonRow],
    };
  },
};
