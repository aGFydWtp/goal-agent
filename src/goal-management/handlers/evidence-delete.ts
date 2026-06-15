// `/evidence delete` コマンドハンドラ(goal-management Evidence Delete Handler / Req 3.1, 3.3, 3.4, 3.5, 4.4)。
//
// design「薄いハンドラ層 + Agent ドメインメソッド」(design Components「Evidence Delete Handler」/
// `/evidence delete` フロー L205-227)に従い、discord-gateway の InteractionContext から
// 実行ユーザー・証跡 ID を読み、証跡削除ドメイン呼び出し(deleteEvidence)→結果整形を行う
// 薄層に徹する。所有者検証・連動削除などのビジネスルールはドメイン層(deleteEvidence)へ
// 委譲し、ハンドラは入出力変換と応答整形のみを担う。
//
// 応答はすべて ephemeral(Req 4.4)。規約外 payload はエラー応答に正規化し、不存在・非所有は
// 同一の「見つからない」応答へ正規化して他ユーザーデータの存在を露出しない(Req 3.3, 3.4)。
// 成功時は削除完了を示す ephemeral 応答を返す(Req 3.1, 3.5)。
//
// 依存方向: handlers → routing / domain(左方向のみ)。

import type {
  APIApplicationCommandInteractionDataOption,
  APIChatInputApplicationCommandInteraction,
} from "discord-api-types/v10";

import type { DiscordEnv } from "../../discord/env";
import type { HandlerResult, InteractionContext, InteractionHandler } from "../../discord/types";
import { EVIDENCE_DELETE_SUBCOMMAND, EVIDENCE_OPT_ID } from "../commands";
import { deleteEvidence } from "../domain/cycle-operations";
import { getUserCycleAuthority } from "../routing";

// Discord application command option の type 値(数値リテラル / workerd enum 問題回避。
// commands.ts / cycle-create.ts と同様にランタイムでは数値比較する)。
const SUBCOMMAND = 1; // ApplicationCommandOptionType.Subcommand
const STRING = 3; // ApplicationCommandOptionType.String

/** 不存在・非所有を区別しない「見つからない」文言(露出防止 / Req 3.3, 3.4)。 */
const NOT_FOUND_MESSAGE = "指定された証跡が見つかりませんでした。ID を確認してください。";

/** ephemeral な reply 応答を組み立てる(Req 4.4)。 */
function ephemeralReply(content: string): HandlerResult {
  return { mode: "reply", ephemeral: true, content };
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
 * `ctx.raw` から `evidence` コマンドの `delete` サブコマンドの id を取り出す。
 *
 * discord-api-types の型で narrow しつつ、option の判別はランタイムで数値比較する
 * (DAT enum 値は workerd バンドルで undefined に解決される既知問題のため。cycle-create.ts /
 * commands.ts のコメント参照)。id が欠ける規約外 payload では `null` を返し、呼び出し側が
 * ephemeral エラーへ正規化する。
 */
function extractEvidenceId(ctx: InteractionContext): string | null {
  const interaction = ctx.raw as APIChatInputApplicationCommandInteraction;
  const topOptions = interaction.data.options;
  if (topOptions === undefined) {
    return null;
  }

  const subcommand = topOptions.find(
    (opt) => opt.type === SUBCOMMAND && opt.name === EVIDENCE_DELETE_SUBCOMMAND,
  );
  if (subcommand === undefined || subcommand.type !== SUBCOMMAND) {
    return null;
  }

  const subOptions = subcommand.options;
  if (subOptions === undefined) {
    return null;
  }

  return stringOptionValue(subOptions, EVIDENCE_OPT_ID);
}

/**
 * `/evidence delete` ハンドラ(Req 3.1, 3.3, 3.4, 3.5, 4.4)。
 *
 * 1. `ctx.raw` から証跡 ID を抽出(規約外 payload は ephemeral エラーへ正規化)。
 * 2. `getUserCycleAuthority` でデータ権威を取得し `deleteEvidence(authority, ctx.userId, id)` を呼ぶ。
 *    - `not_found` → 「見つからない」ephemeral 応答(不存在・非所有を区別せず同一文言。
 *      他ユーザーデータの存在を露出しない / Req 3.3, 3.4)。
 *    - `ok` → 削除完了を示す ephemeral 応答(Req 3.1, 3.5)。
 *
 * 所有者検証・連動削除はドメイン(`deleteEvidence`)へ委譲し、ハンドラはビジネスルールを持たない。
 */
export const evidenceDeleteHandler: InteractionHandler = {
  async handle(ctx: InteractionContext, env: DiscordEnv): Promise<HandlerResult> {
    const evidenceId = extractEvidenceId(ctx);
    if (evidenceId === null) {
      return ephemeralReply("コマンドの入力を読み取れませんでした。");
    }

    const authority = await getUserCycleAuthority(env, ctx.userId);
    const result = await deleteEvidence(authority, ctx.userId, evidenceId);
    if (!result.ok) {
      // 不存在・非所有のいずれも同一文言へ正規化(露出防止 / Req 3.3, 3.4)。
      return ephemeralReply(NOT_FOUND_MESSAGE);
    }

    return ephemeralReply("証跡を削除しました。");
  },
};
