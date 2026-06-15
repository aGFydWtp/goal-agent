// `/goal status` コマンドハンドラ(status-and-draft Goal Status Command Handler /
// Req 3.1, 3.3, 3.4, 3.5, 3.6, 8.2)。
//
// design「薄いハンドラ層 + ドメインメソッド」に従い、InteractionContext の goal サブコマンド
// オプションから対象目標 ID を読み、deferred で単一目標判定(determineGoalStatus)を行って
// §8.5(状態・見立て・証跡・不足・次アクション)を follow-up する薄層に徹する。
//
// goalId 未指定(規約外 payload / 空)→ 目標指定を促す ephemeral 即時応答(Req 3.6)。
// 目標あり → deferred(ephemeral, type5)を 3 秒以内に返し(Req 3.3)、対象サイクルを解決して
// determineGoalStatus を呼ぶ。非所有/不存在/サイクル不在はすべて「見つからない」に正規化し、
// 他ユーザーのデータの存在を露出しない(Req 3.4, 8.1)。証跡無しの判断材料不足は §8.5 内で案内される
// (Req 3.5、messages 層が担う)。
//
// すべての応答は本人のみが閲覧できる ephemeral 文脈(Req 3.6, 8.2)。
//
// 依存方向: handlers → commands(定数)/ messages / domain / goal-management(routing/domain) /
// llm factory(左方向のみ)。

import type {
  APIApplicationCommandInteractionDataOption,
  APIChatInputApplicationCommandInteraction,
} from "discord-api-types/v10";

import type { DiscordEnv } from "../../discord/env";
import type { HandlerResult, InteractionContext, InteractionHandler } from "../../discord/types";
import { defaultDeps, resolveActiveCycle } from "../../goal-management/domain/cycle-operations";
import { getUserCycleAuthority } from "../../goal-management/routing";
import { createLlmClient } from "../../llm/factory";
import { GOAL_STATUS_OPT_GOAL, GOAL_STATUS_SUBCOMMAND } from "../commands";
import { determineGoalStatus } from "../domain/status-operations";
import { formatGoalStatus } from "../messages";

// Discord application command option の type 値(数値リテラル / workerd enum 問題回避。
// cycle-create.ts と同様にランタイムでは数値比較する)。
const SUBCOMMAND = 1; // ApplicationCommandOptionType.Subcommand
const STRING = 3; // ApplicationCommandOptionType.String

/** 目標 ID 未指定時の案内(目標を指定して再実行を促す / Req 3.6)。 */
const MISSING_GOAL_GUIDANCE =
  "対象の評価目標を指定してください。`/goal status` の goal オプションに目標 ID を指定して実行してください。";

/**
 * 非所有/不存在/サイクル不在を同一の「見つからない」に正規化した案内(Req 3.4, 8.1)。
 * 他ユーザーのデータの存在を露出しないため、状態や証跡などの詳細は一切含めない。
 */
const NOT_FOUND_GUIDANCE = "指定された評価目標が見つかりません。";

/**
 * `ctx.raw` から `goal` コマンドの `status` サブコマンドの goal オプション値を取り出す。
 *
 * discord-api-types の型で narrow しつつ、option の判別はランタイムで数値比較する
 * (DAT enum 値は workerd バンドルで undefined に解決される既知問題のため。commands.ts のコメント参照)。
 * サブコマンド/オプションが欠ける、または空文字の場合は `null` を返し、呼び出し側が ephemeral 案内へ正規化する。
 */
function extractGoalId(ctx: InteractionContext): string | null {
  const interaction = ctx.raw as APIChatInputApplicationCommandInteraction;
  const topOptions = interaction.data.options;
  if (topOptions === undefined) {
    return null;
  }

  const subcommand = topOptions.find(
    (opt) => opt.type === SUBCOMMAND && opt.name === GOAL_STATUS_SUBCOMMAND,
  );
  if (subcommand === undefined || subcommand.type !== SUBCOMMAND) {
    return null;
  }

  const subOptions = subcommand.options;
  if (subOptions === undefined) {
    return null;
  }

  const value = stringOptionValue(subOptions, GOAL_STATUS_OPT_GOAL);
  if (value === null || value.trim().length === 0) {
    return null;
  }
  return value;
}

/** 指定名の STRING option 値を取り出す。無ければ `null`。 */
function stringOptionValue(
  options: readonly APIApplicationCommandInteractionDataOption[],
  name: string,
): string | null {
  const opt = options.find((o) => o.name === name);
  if (opt === undefined || opt.type !== STRING || typeof opt.value !== "string") {
    return null;
  }
  return opt.value;
}

/**
 * `/goal status` ハンドラ(Req 3.1, 3.3, 3.4, 3.5, 3.6, 8.2)。
 *
 * 1. goal オプションから目標 ID を抽出。未指定なら目標指定を促す ephemeral 即時応答(Req 3.6)。
 * 2. 目標ありなら deferred(ephemeral)を返す(Req 3.3)。継続では対象サイクルを `resolveActiveCycle`
 *    で解決し、不在/判定 not_found を「見つからない」に正規化(Req 3.4)。所有目標は
 *    `determineGoalStatus` → §8.5 形式(状態・見立て・証跡・不足・次アクション)を follow-up する
 *    (Req 3.1, 3.5)。
 */
export const goalStatusCommandHandler: InteractionHandler = {
  handle(ctx: InteractionContext, env: DiscordEnv): HandlerResult {
    const goalId = extractGoalId(ctx);
    if (goalId === null) {
      return { mode: "reply", ephemeral: true, content: MISSING_GOAL_GUIDANCE };
    }

    const userId = ctx.userId;
    return {
      mode: "deferred",
      ephemeral: true,
      run: async (followup) => {
        const authority = await getUserCycleAuthority(env, userId);
        const cycle = await resolveActiveCycle(authority, userId);
        if (cycle === null) {
          await followup.editOriginal(NOT_FOUND_GUIDANCE);
          return;
        }

        const result = await determineGoalStatus(
          authority,
          defaultDeps(),
          createLlmClient(env),
          userId,
          cycle.id,
          goalId,
        );
        if (!result.ok) {
          await followup.editOriginal(NOT_FOUND_GUIDANCE);
          return;
        }

        await followup.editOriginal(
          formatGoalStatus(result.goal, result.verdict, result.evidence, result.shortfalls),
        );
      },
    };
  },
};
