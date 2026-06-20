// `/draft` コマンドハンドラ(status-and-draft Draft Command Handler /
// Req 5.3, 5.5, 5.6, 5.7, 5.8, 5.9, 8.2)。
//
// design「`/draft` System Flow(生成→調整→保存)」の生成起点を担う薄層:
// 1. サブコマンド(goal / all)から生成対象 DraftTarget を読む。goal は goal オプション必須で、
//    欠落は即時 ephemeral 案内(生成フローを開始しない)。
// 2. ドラフト生成は LLM 呼び出しを伴い 3 秒以内に完了しない可能性があるため deferred(type5,
//    ephemeral)を宣言し、生成・整形を follow-up で継続する(Req 5.3)。
// 3. 生成成功で §8.7 ドラフト本文 + 調整 4 種/[保存] ボタンを follow-up し、揮発ドラフトを
//    infra 揮発 KV へ保持する(routing ブリッジ)。失敗は理由別(見つからない/証跡不足/生成失敗)に
//    案内し、pending を作らない(Req 5.6, 5.7, 5.8)。
//
// ビジネスルール(対象解決・証跡集約・生成・検証・pending 保持)はドメイン層へ委譲し、ハンドラは
// 入出力変換と応答整形のみを担う。全応答は ephemeral(Req 5.9, 8.2)。
//
// 依存方向: handlers → commands / custom-ids / messages / routing / domain /
// goal-management routing / llm factory(左方向のみ)。

import type {
  APIApplicationCommandInteractionDataOption,
  APIChatInputApplicationCommandInteraction,
} from "discord-api-types/v10";

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
import { DRAFT_ALL_SUBCOMMAND, DRAFT_GOAL_SUBCOMMAND, DRAFT_OPT_GOAL } from "../commands";
import {
  createPendingDraftStore,
  type DraftTarget,
  generateDraft,
} from "../domain/draft-operations";
import { formatDraft } from "../messages";
import { getDraftEphemeralKv, persistPendingDraft } from "../routing";
import { draftButtonsRow } from "./draft-buttons";

// Discord application command option の type 値(数値リテラル / workerd enum 問題回避)。
const SUBCOMMAND = 1; // ApplicationCommandOptionType.Subcommand
const STRING = 3; // ApplicationCommandOptionType.String

/** goal オプション欠落・規約外 payload 時の即時 ephemeral 案内(生成フローを開始しない)。 */
const INVALID_INPUT_NOTICE =
  "ドラフト生成の対象を読み取れませんでした。`/draft goal <目標ID>` または `/draft all` を指定してください。";

/** 対象目標が非所有/不存在のときの案内(他ユーザーデータを露出しない / Req 5.6, 8.1)。 */
const NOT_FOUND_NOTICE =
  "対象の評価目標が見つかりません。アクティブな評価サイクルと自分の目標 ID を確認してください。";

/** 対象証跡が無いときの案内(誇張補完しない / Req 5.7)。 */
const NO_EVIDENCE_NOTICE =
  "証跡が未保存のため、十分なドラフトを生成できません。チェックインで証跡を記録してから再度お試しください。";

/** LLM 生成/検証が失敗したときの再試行案内(ドラフトは保存しない / Req 5.8)。 */
const GENERATION_FAILED_NOTICE =
  "ドラフト生成に失敗しました。お手数ですが、もう一度 `/draft` からお試しください。";

/**
 * `ctx.raw` から `draft` コマンドの生成対象を読む。
 *
 * `goal` サブコマンドは goal オプション(STRING)必須で `{ kind:"goal", goalId }` を返す。
 * `all` サブコマンドは `{ kind:"all" }`。goal オプション欠落・サブコマンド不在・規約外 payload は
 * `null`(呼び出し側が即時 ephemeral 案内へ正規化する)。
 */
function extractTarget(ctx: InteractionContext): DraftTarget | null {
  const interaction = ctx.raw as APIChatInputApplicationCommandInteraction;
  const topOptions = interaction.data.options;
  if (topOptions === undefined) {
    return null;
  }

  const subcommand = topOptions.find((opt) => opt.type === SUBCOMMAND);
  if (subcommand === undefined || subcommand.type !== SUBCOMMAND) {
    return null;
  }

  if (subcommand.name === DRAFT_ALL_SUBCOMMAND) {
    return { kind: "all" };
  }

  if (subcommand.name === DRAFT_GOAL_SUBCOMMAND) {
    const goalId = stringOptionValue(subcommand.options ?? [], DRAFT_OPT_GOAL);
    if (goalId === null) {
      return null;
    }
    return { kind: "goal", goalId };
  }

  return null;
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
 * ドラフトを生成し、結果を follow-up で送る deferred 継続(Req 5.3, 5.5-5.8)。
 *
 * 生成成功 → §8.7 ドラフト + 調整/保存ボタンを送り、揮発ドラフトを KV へ保持する。失敗は理由別
 * (not_found / no_evidence / generation_failed)の案内へ正規化し、pending を作らない。
 */
async function runGenerate(
  env: DiscordEnv,
  userId: string,
  target: DraftTarget,
  followup: Followup,
): Promise<void> {
  const authority = await getUserCycleAuthority(env, userId);
  const store = createPendingDraftStore();
  const result = await generateDraft(
    authority,
    defaultDeps(),
    createLlmClient(env),
    store,
    userId,
    target,
  );
  if (!result.ok) {
    await followup.editOriginal(reasonNotice(result.reason));
    return;
  }

  const pending = store.drafts.get(result.draftPendingId);
  if (pending === undefined) {
    // 直前に保持したはずの pending が無いのは想定外。pending を残さず再試行案内へ正規化する。
    await followup.editOriginal(GENERATION_FAILED_NOTICE);
    return;
  }
  const kv = await getDraftEphemeralKv(env, userId);
  await persistPendingDraft(kv, pending);

  await followup.editOriginal(formatDraft(result.content), {
    components: [draftButtonsRow(result.draftPendingId)],
  });
}

/** 生成失敗 reason を §5.6/5.7/5.8 のユーザー向け案内へ正規化する。 */
function reasonNotice(reason: "not_found" | "no_evidence" | "generation_failed"): string {
  if (reason === "not_found") return NOT_FOUND_NOTICE;
  if (reason === "no_evidence") return NO_EVIDENCE_NOTICE;
  return GENERATION_FAILED_NOTICE;
}

/**
 * `/draft` ハンドラ(Req 5.3, 5.5-5.9, 8.2)。
 *
 * goal オプション欠落・規約外 payload は deferred せず即時 ephemeral 案内。対象が読めた場合は
 * deferred を宣言し、生成と §8.7 提示を {@link runGenerate} で継続する。すべて ephemeral。
 */
export const draftCommandHandler: InteractionHandler = {
  handle(ctx: InteractionContext, _env: DiscordEnv): HandlerResult {
    const target = extractTarget(ctx);
    if (target === null) {
      return { mode: "reply", ephemeral: true, content: INVALID_INPUT_NOTICE };
    }

    return {
      mode: "deferred-persistent",
      ephemeral: true,
      continuation: {
        key: DRAFT_GENERATE_CONTINUATION_KEY,
        payload: { userId: ctx.userId, target: targetToPayload(target) },
      },
    };
  },
};

/** `/draft` 生成継続のレジストリキー(discord-gateway Req 8.6 adoption)。 */
export const DRAFT_GENERATE_CONTINUATION_KEY = "draft:generate";

/** {@link DraftTarget} を JSON シリアライズ可能な payload 形へ変換する。 */
function targetToPayload(target: DraftTarget): ContinuationPayload {
  return target.kind === "goal" ? { kind: "goal", goalId: target.goalId } : { kind: "all" };
}

/** payload の `target` フィールドを {@link DraftTarget} へ復元する(規約外は null)。 */
function payloadToTarget(value: unknown): DraftTarget | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const obj = value as { kind?: unknown; goalId?: unknown };
  if (obj.kind === "all") {
    return { kind: "all" };
  }
  if (obj.kind === "goal" && typeof obj.goalId === "string") {
    return { kind: "goal", goalId: obj.goalId };
  }
  return null;
}

/**
 * `/draft` 生成を DO alarm 上で実行する永続継続(Req 8.1, 8.6)。
 *
 * ~24s の LLM 生成を `ctx.waitUntil` budget から切り離し「考え中…」固着を防ぐ(checkin と同型)。
 * payload から `userId`/`target` を復元し {@link runGenerate} へ委譲する。
 */
export const draftGenerateContinuation: Continuation = async (
  env: DiscordEnv,
  payload: ContinuationPayload,
  followup: Followup,
): Promise<void> => {
  const userId = payload.userId;
  const target = payloadToTarget(payload.target);
  if (typeof userId !== "string" || target === null) {
    throw new Error("draft 生成継続: payload に userId/target がありません");
  }
  await runGenerate(env, userId, target, followup);
};
