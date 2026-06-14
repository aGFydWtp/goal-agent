import type { GoalStatusContext } from "./rules";

/** LLM 補完への入力(system + prompt)。checkin の `LlmPromptRequest` と同型。 */
export type StatusPromptRequest = Readonly<{
  system: string;
  prompt: string;
}>;

/** 値が未設定・空白のみなら「未設定」表示へ落とす。 */
function orUnset(value: string | null): string {
  return value !== null && value.trim().length > 0 ? value : "未設定";
}

/**
 * §13.2 ステータス見立てのプロンプトを組み立てる(Req 1.1, 1.3)。
 *
 * 目標定義(title/description)・達成条件(successCriteria)・評価観点(evaluationPoints)・
 * 保存済み証跡(body/evidenceDate/usefulness)・半期終了までの日数(daysUntilCycleEnd)を
 * 反映し、status/reason/risks/nextActions を含む構造化結果を求める。
 *
 * 注: design は入力に「マイルストーン」を挙げるが `GoalStatusContext` に該当フィールドは
 * 存在しないため、利用可能なコンテキストのみで構成する(milestone フィールドは新設しない)。
 */
export function buildStatusPrompt(ctx: GoalStatusContext): StatusPromptRequest {
  const evidenceLines =
    ctx.evidence.length > 0
      ? ctx.evidence
          .map(
            (item, index) =>
              `${index + 1}. 評価日付: ${item.evidenceDate}
   使いやすさ: ${item.usefulness}
   内容: ${item.body}`,
          )
          .join("\n")
      : "保存済み証跡なし";

  return {
    system:
      "あなたは半期評価目標の進捗状況を見立てるアシスタントです。保存済み証跡が裏付ける事実に基づき、誇張せず判断してください。必ず指定された JSON 形式だけを返してください。",
    prompt: `以下の目標定義・達成条件・保存済み証跡・期限情報から、現在の状態を見立ててください。

## 目標定義
title: ${ctx.title}
description: ${ctx.description}
達成条件: ${orUnset(ctx.successCriteria)}
評価観点: ${orUnset(ctx.evaluationPoints)}

## 保存済み証跡
${evidenceLines}

## 期限情報
半期終了までの日数: ${ctx.daysUntilCycleEnd}

## 出力要件
- §13.2 の JSON 形式で返してください。
- status は green / yellow / red / gray のいずれかにしてください。
- reason には状態と判断根拠を簡潔に書いてください。
- risks には進捗を妨げ得るリスクを文字列配列で入れてください(なければ空配列)。
- nextActions には次に取るとよい行動を文字列配列で入れてください(なければ空配列)。
- 保存済み証跡にない内容を事実として断定しないでください。

## JSON 形
{
  "status": "green",
  "reason": "状態の判断根拠",
  "risks": ["想定されるリスク"],
  "nextActions": ["次に取るとよい行動"]
}`,
  };
}
