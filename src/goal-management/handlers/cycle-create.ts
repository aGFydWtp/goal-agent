// `/cycle create` コマンドハンドラ(goal-management Cycle Create Handler / Req 1.1, 1.3, 1.4, 1.6, 4.4)。
//
// design「薄いハンドラ層 + Agent ドメインメソッド」に従い、discord-gateway の
// InteractionContext から実行ユーザー・name/start/end を読み、期間検証(validation.ts)→
// サイクル作成ドメイン呼び出し(createCycle)→結果整形を行う薄層に徹する。ビジネスルール
// (重複検出・所有者付与)はドメイン層へ委譲し、ハンドラは入出力変換と応答整形のみを担う。
//
// 応答はすべて ephemeral(Req 4.4)。検証 NG・重複・規約外 payload はいずれも ephemeral
// エラー応答に正規化し、成功時はサイクル名と期間を含む ephemeral 確認応答を返す。
//
// 依存方向: handlers → validation / routing / domain(左方向のみ)。

import type {
  APIApplicationCommandInteractionDataOption,
  APIChatInputApplicationCommandInteraction,
} from "discord-api-types/v10";

import type { DiscordEnv } from "../../discord/env";
import type { HandlerResult, InteractionContext, InteractionHandler } from "../../discord/types";
import {
  CYCLE_CREATE_SUBCOMMAND,
  CYCLE_OPT_END,
  CYCLE_OPT_NAME,
  CYCLE_OPT_START,
} from "../commands";
import { createCycle, defaultDeps } from "../domain/cycle-operations";
import { getUserCycleAuthority } from "../routing";
import { validateCyclePeriod } from "../validation";

// Discord application command option の type 値(数値リテラル / workerd enum 問題回避。
// commands.ts と同様にランタイムでは数値比較する)。
const SUBCOMMAND = 1; // ApplicationCommandOptionType.Subcommand
const STRING = 3; // ApplicationCommandOptionType.String

/** `/cycle create` 入力の抽出結果。 */
interface CycleCreateInput {
  name: string;
  start: string;
  end: string;
}

/** ephemeral な reply 応答を組み立てる(Req 4.4)。 */
function ephemeralReply(content: string): HandlerResult {
  return { mode: "reply", ephemeral: true, content };
}

/**
 * `ctx.raw` から `cycle` コマンドの `create` サブコマンドの name/start/end を取り出す。
 *
 * discord-api-types の型で narrow しつつ、option の判別はランタイムで数値比較する
 * (DAT enum 値は workerd バンドルで undefined に解決される既知問題のため。dispatch.ts /
 * commands.ts のコメント参照)。いずれかが欠ける規約外 payload では `null` を返し、
 * 呼び出し側が ephemeral エラーへ正規化する。
 */
function extractInput(ctx: InteractionContext): CycleCreateInput | null {
  const interaction = ctx.raw as APIChatInputApplicationCommandInteraction;
  const topOptions = interaction.data.options;
  if (topOptions === undefined) {
    return null;
  }

  const subcommand = topOptions.find(
    (opt) => opt.type === SUBCOMMAND && opt.name === CYCLE_CREATE_SUBCOMMAND,
  );
  if (subcommand === undefined || subcommand.type !== SUBCOMMAND) {
    return null;
  }

  const subOptions = subcommand.options;
  if (subOptions === undefined) {
    return null;
  }

  const name = stringOptionValue(subOptions, CYCLE_OPT_NAME);
  const start = stringOptionValue(subOptions, CYCLE_OPT_START);
  const end = stringOptionValue(subOptions, CYCLE_OPT_END);
  if (name === null || start === null || end === null) {
    return null;
  }
  return { name, start, end };
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

/** 期間検証 NG の reason をユーザー向けの日本語メッセージへ整形する(Req 1.4)。 */
function periodErrorMessage(reason: "invalid_date" | "end_before_start"): string {
  if (reason === "invalid_date") {
    return "開始日または終了日を日付として解釈できません。`YYYY-MM-DD` の形式で入力してください。";
  }
  return "終了日は開始日と同日かそれ以降にしてください。";
}

/**
 * `/cycle create` ハンドラ(Req 1.1, 1.3, 1.4, 1.6, 4.4)。
 *
 * 1. `ctx.raw` から name/start/end を抽出(規約外 payload は ephemeral エラーへ正規化)。
 * 2. `validateCyclePeriod` で期間検証。NG なら作成へ進まず ephemeral エラー応答(Req 1.4)。
 * 3. `getUserCycleAuthority` でデータ権威を取得し `createCycle` を呼ぶ。
 *    - `duplicate` → 既存サイクルがある旨の ephemeral エラー応答(Req 1.5 相当)。
 *    - `ok` → サイクル名と期間(開始〜終了)を含む ephemeral 確認応答(Req 1.3, 1.6, 4.4)。
 */
export const cycleCreateHandler: InteractionHandler = {
  async handle(ctx: InteractionContext, env: DiscordEnv): Promise<HandlerResult> {
    const input = extractInput(ctx);
    if (input === null) {
      return ephemeralReply("コマンドの入力を読み取れませんでした。");
    }

    const period = validateCyclePeriod(input.start, input.end);
    if (!period.ok) {
      return ephemeralReply(periodErrorMessage(period.reason));
    }

    const authority = await getUserCycleAuthority(env, ctx.userId);
    const result = await createCycle(
      authority,
      defaultDeps(),
      ctx.userId,
      input.name,
      input.start,
      input.end,
    );
    if (!result.ok) {
      // 現状 createCycle の失敗 reason は duplicate のみ(Req 1.5 相当)。
      return ephemeralReply(
        `「${input.name}」という名前のサイクルは既に存在します。別の名前を指定してください。`,
      );
    }

    const { cycle } = result;
    return ephemeralReply(
      `サイクル「${cycle.name}」を作成しました(期間: ${cycle.start_date}〜${cycle.end_date})。`,
    );
  },
};
