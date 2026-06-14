// goal modal submit ハンドラ(goal-management Goal Modal Submit Handler / Req 2.2, 2.3, 2.5, 2.6, 2.7, 4.4)。
//
// design「`/goal add` フロー(modal → submit)」L191-201 に従い、本ハンドラは modal 送信の
// 各フィールド値を取り出し、必須検証(validation.ts)→ 目標登録ドメイン呼び出し(addGoal)→
// GoalAgent 確立(getUserGoalAgent 経由の親委譲読み取りで実在確認)→ 結果整形を行う薄層に徹する。
//
// ビジネスルール(対象サイクル解決・所有者強制・初期ステータス gray・dueDate 畳み込み)は
// ドメイン層へ委譲し、ハンドラは入出力変換と応答整形のみを担う。応答はすべて ephemeral(Req 4.4)。
//
// 依存方向: handlers → validation / routing / domain(左方向のみ)。

import type {
  APIModalSubmitInteraction,
  ModalSubmitActionRowComponent,
  ModalSubmitComponent,
} from "discord-api-types/v10";

import type { DiscordEnv } from "../../discord/env";
import type { HandlerResult, InteractionContext, InteractionHandler } from "../../discord/types";
import {
  GOAL_FIELD_DESCRIPTION,
  GOAL_FIELD_DUE_DATE,
  GOAL_FIELD_EVALUATION_POINTS,
  GOAL_FIELD_SUCCESS_CRITERIA,
  GOAL_FIELD_TITLE,
} from "../commands";
import { addGoal, defaultDeps, type GoalInput } from "../domain/cycle-operations";
import { getGoalDefinition } from "../domain/goal-operations";
import { getUserCycleAuthority, getUserGoalAgent } from "../routing";
import { validateGoalFields } from "../validation";

// Discord modal action row / text input の component type 値(数値リテラル / workerd enum 問題回避)。
const ACTION_ROW = 1; // ComponentType.ActionRow
const TEXT_INPUT = 4; // ComponentType.TextInput

/** modal 送信の生フィールド値(custom_id で引いた文字列。未指定は空文字)。 */
interface ModalFieldValues {
  title: string;
  description: string;
  successCriteria: string;
  evaluationPoints: string;
  dueDate: string;
}

/** ephemeral な reply 応答を組み立てる(Req 4.4)。 */
function ephemeralReply(content: string): HandlerResult {
  return { mode: "reply", ephemeral: true, content };
}

/**
 * modal submit payload の action row 群を走査し、各 text input の custom_id → value を引く
 * lookup を構築する。規約外の component(action row / text input 以外)は無視する。
 */
function buildFieldLookup(ctx: InteractionContext): Map<string, string> {
  const interaction = ctx.raw as APIModalSubmitInteraction;
  const lookup = new Map<string, string>();
  const rows = interaction.data.components;
  if (rows === undefined) {
    return lookup;
  }
  for (const row of rows) {
    if (row.type !== ACTION_ROW) {
      continue;
    }
    for (const component of componentsOf(row)) {
      if (component.type === TEXT_INPUT && typeof component.value === "string") {
        lookup.set(component.custom_id, component.value);
      }
    }
  }
  return lookup;
}

/** action row が内包する component 群を取り出す(無ければ空配列)。 */
function componentsOf(row: ModalSubmitActionRowComponent): readonly ModalSubmitComponent[] {
  return row.components ?? [];
}

/** lookup から 5 フィールドを取り出す(未指定/欠落は空文字として扱う)。 */
function extractFields(ctx: InteractionContext): ModalFieldValues {
  const lookup = buildFieldLookup(ctx);
  return {
    title: lookup.get(GOAL_FIELD_TITLE) ?? "",
    description: lookup.get(GOAL_FIELD_DESCRIPTION) ?? "",
    successCriteria: lookup.get(GOAL_FIELD_SUCCESS_CRITERIA) ?? "",
    evaluationPoints: lookup.get(GOAL_FIELD_EVALUATION_POINTS) ?? "",
    dueDate: lookup.get(GOAL_FIELD_DUE_DATE) ?? "",
  };
}

/** 不足項目名を日本語ラベルへ整形し、不足を示すメッセージを組み立てる(Req 2.5)。 */
function missingFieldsMessage(missing: string[]): string {
  const labels: Record<string, string> = { title: "目標名", description: "目標本文" };
  const names = missing.map((m) => labels[m] ?? m).join("・");
  return `必須項目が不足しています(${names})。目標名と目標本文を入力してください。`;
}

/** 空文字を null へ正規化する(任意フィールドは空なら未指定扱い)。 */
function emptyToNull(value: string): string | null {
  return value.length === 0 ? null : value;
}

/**
 * goal modal submit ハンドラ(Req 2.2, 2.3, 2.5, 2.6, 2.7, 4.4)。
 *
 * 1. `ctx.raw` から 5 フィールド値を custom_id で抽出(未指定は空文字)。
 * 2. `validateGoalFields` で必須(目標名・目標本文)検証。欠落なら addGoal を呼ばず
 *    不足項目を示す ephemeral 応答(Req 2.5)。
 * 3. `getUserCycleAuthority` でデータ権威を取得し `addGoal` を呼ぶ(対象サイクルは
 *    ドメインが内部解決)。
 *    - `no_cycle` → 先にサイクル作成が必要な旨の ephemeral 応答(Req 2.6)。
 *    - `ok` → `getUserGoalAgent` で GoalAgent を確立し、親委譲読み取り(`getGoalDefinition`)で
 *      保存済み目標が読めることを確認(Req 2.3)。その後、目標名を含む ephemeral 確認応答
 *      (Req 2.7, 4.4)。
 */
export const goalModalSubmitHandler: InteractionHandler = {
  async handle(ctx: InteractionContext, env: DiscordEnv): Promise<HandlerResult> {
    const fields = extractFields(ctx);

    const required = validateGoalFields(fields.title, fields.description);
    if (!required.ok) {
      return ephemeralReply(missingFieldsMessage(required.missing));
    }

    const input: GoalInput = {
      title: fields.title,
      description: fields.description,
      successCriteria: emptyToNull(fields.successCriteria),
      evaluationPoints: emptyToNull(fields.evaluationPoints),
      dueDate: emptyToNull(fields.dueDate),
    };

    const authority = await getUserCycleAuthority(env, ctx.userId);
    const result = await addGoal(authority, defaultDeps(), ctx.userId, input);
    if (!result.ok) {
      // 現状 addGoal の失敗 reason は no_cycle のみ(Req 2.6)。
      return ephemeralReply(
        "目標を追加する対象サイクルがありません。先に `/cycle create` でサイクルを作成してください。",
      );
    }

    const { goal } = result;
    // GoalAgent を確立し(Req 2.3)、親権威への委譲読み取りで保存済み目標が読めることを確認する。
    const goalAgent = await getUserGoalAgent(env, ctx.userId, goal.id);
    await getGoalDefinition(goalAgent, ctx.userId, goal.cycle_id, goal.id);

    return ephemeralReply(`目標「${goal.title}」を登録しました。`);
  },
};
