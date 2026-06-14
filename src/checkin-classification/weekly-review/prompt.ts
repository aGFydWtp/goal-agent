import type { Usefulness } from "../../types/enums";
import type { RelevanceScore } from "../../types/llm-shared";
import type { LlmPromptRequest } from "../classification/prompt";

type WeeklyReviewPromptGoal = Readonly<{
  id: string;
  title: string;
  description: string;
  success_criteria: string | null;
}>;

type WeeklyReviewPromptCheckin = Readonly<{
  id: string;
  raw_text: string;
}>;

type WeeklyReviewPromptLinkedGoal = Readonly<{
  goalId: string;
  relevanceScore: RelevanceScore;
  reason: string | null;
}>;

type WeeklyReviewPromptEvidence = Readonly<{
  id: string;
  title: string | null;
  body: string;
  usefulness: Usefulness;
  linkedGoals: ReadonlyArray<WeeklyReviewPromptLinkedGoal>;
}>;

export type BuildWeeklyReviewPromptInput = Readonly<{
  goals: ReadonlyArray<WeeklyReviewPromptGoal>;
  weekStartDate: string;
  checkins: ReadonlyArray<WeeklyReviewPromptCheckin>;
  evidence: ReadonlyArray<WeeklyReviewPromptEvidence>;
}>;

export function buildWeeklyReviewPrompt({
  goals,
  weekStartDate,
  checkins,
  evidence,
}: BuildWeeklyReviewPromptInput): LlmPromptRequest {
  return {
    system:
      "あなたは保存済みチェックインと証跡から週次レビューを作るアシスタントです。必ず指定された JSON 形式だけを返してください。",
    prompt: `保存済み内容をもとに、週次レビューを summary / risks / next_actions の JSON で生成してください。

## 対象週
${weekStartDate}

## 目標一覧
${formatGoals(goals)}

## 保存済みチェックイン
${formatCheckins(checkins)}

## 保存済み証跡
${formatEvidence(evidence)}

## 出力要件
- summary: 今週の進捗を事実ベースで 1〜3 文にまとめる文字列。
- risks: 評価目標の達成に向けた不足・懸念を配列で列挙する。無ければ空配列。
- next_actions: 来週やるとよい具体的な次アクションを配列で列挙する。無ければ空配列。
- JSON のキーは summary, risks, next_actions の 3 つだけにしてください。

## JSON 形
{
  "summary": "今週の要約",
  "risks": ["不足または懸念"],
  "next_actions": ["次にやること"]
}`,
  };
}

function formatGoals(goals: ReadonlyArray<WeeklyReviewPromptGoal>): string {
  if (goals.length === 0) {
    return "目標なし";
  }

  return goals
    .map(
      (goal, index) => `${index + 1}. id: ${goal.id}
   title: ${goal.title}
   description: ${goal.description}
   達成条件: ${goal.success_criteria ?? "未設定"}`,
    )
    .join("\n\n");
}

function formatCheckins(checkins: ReadonlyArray<WeeklyReviewPromptCheckin>): string {
  if (checkins.length === 0) {
    return "チェックインなし";
  }

  return checkins
    .map(
      (checkin, index) => `${index + 1}. id: ${checkin.id}
   raw_text: ${checkin.raw_text}`,
    )
    .join("\n\n");
}

function formatEvidence(evidenceItems: ReadonlyArray<WeeklyReviewPromptEvidence>): string {
  if (evidenceItems.length === 0) {
    return "証跡なし";
  }

  return evidenceItems
    .map(
      (evidence, index) => `${index + 1}. id: ${evidence.id}
   title: ${evidence.title ?? "未設定"}
   body: ${evidence.body}
   usefulness: ${evidence.usefulness}
   linkedGoals:
${formatLinkedGoals(evidence.linkedGoals)}`,
    )
    .join("\n\n");
}

function formatLinkedGoals(linkedGoals: ReadonlyArray<WeeklyReviewPromptLinkedGoal>): string {
  if (linkedGoals.length === 0) {
    return "     - なし";
  }

  return linkedGoals
    .map(
      (linkedGoal) => `     - goalId: ${linkedGoal.goalId}
       relevanceScore: ${linkedGoal.relevanceScore}
       reason: ${linkedGoal.reason ?? "未設定"}`,
    )
    .join("\n");
}
