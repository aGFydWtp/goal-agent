import type { ClassificationResult } from "./classification/schema";
import type { WeeklyReview } from "./weekly-review/schema";

export type ClassificationGoalLabel = Readonly<{
  id: string;
  title: string;
}>;

export type StatusOutlook = Readonly<{
  goalLabel: string;
  status: string;
  reason: string;
}>;

type ClassificationItem = ClassificationResult["items"][number];
type CandidateGoal = ClassificationItem["candidateGoals"][number];

export function formatCheckinPromptMessage(): string {
  return "今週やったことを雑に書いてください。評価目標に関係あるかどうかはこちらで分類します。";
}

export function formatClassificationConfirmation(
  result: ClassificationResult,
  goals: ReadonlyArray<ClassificationGoalLabel> | ReadonlyMap<string, string>,
): string {
  const goalTitles = toGoalTitleMap(goals);
  const goalSections = collectGoalSections(result, goalTitles);
  const lines = ["分類案を作りました。", ""];

  for (const section of goalSections) {
    lines.push(`## ${section.title}`);
    for (const entry of section.entries) {
      lines.push(...formatClassifiedItem(entry.item, entry.candidate));
    }
    lines.push("");
  }

  const unclassifiedItems = result.items.filter((item) => item.candidateGoals.length === 0);
  if (unclassifiedItems.length > 0) {
    lines.push("## 未分類");
    for (const item of unclassifiedItems) {
      lines.push(...formatUnclassifiedItem(item));
    }
    lines.push("");
  }

  lines.push("この内容で保存しますか?");
  return lines.join("\n");
}

export function formatPostSaveMessage(review: WeeklyReview, statusOutlook?: StatusOutlook): string {
  const lines = ["保存しました。", "", "## 今週の見立て", review.summary];

  if (statusOutlook !== undefined) {
    lines.push(
      "",
      `ステータス見立て: ${statusOutlook.goalLabel}: ${statusOutlook.status}`,
      `理由: ${statusOutlook.reason}`,
    );
  }

  lines.push("", "## 気になるリスク", ...formatListOrNone(review.risks));
  lines.push("", "## 来週やるとよいこと", ...formatListOrNone(review.next_actions));

  return lines.join("\n");
}

export const formatPrompt = formatCheckinPromptMessage;
export const formatConfirmation = formatClassificationConfirmation;
export const formatPostSave = formatPostSaveMessage;

function toGoalTitleMap(
  goals: ReadonlyArray<ClassificationGoalLabel> | ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  if (isGoalLabelArray(goals)) {
    return new Map(goals.map((goal) => [goal.id, goal.title]));
  }

  return goals;
}

function isGoalLabelArray(
  goals: ReadonlyArray<ClassificationGoalLabel> | ReadonlyMap<string, string>,
): goals is ReadonlyArray<ClassificationGoalLabel> {
  return Array.isArray(goals);
}

function collectGoalSections(
  result: ClassificationResult,
  goalTitles: ReadonlyMap<string, string>,
) {
  const entriesByGoalId = new Map<
    string,
    Array<Readonly<{ item: ClassificationItem; candidate: CandidateGoal }>>
  >();

  for (const item of result.items) {
    for (const candidate of item.candidateGoals) {
      const entries = entriesByGoalId.get(candidate.goalId) ?? [];
      entries.push({ item, candidate });
      entriesByGoalId.set(candidate.goalId, entries);
    }
  }

  const orderedGoalIds = [
    ...[...goalTitles.keys()].filter((goalId) => entriesByGoalId.has(goalId)),
    ...[...entriesByGoalId.keys()]
      .filter((goalId) => !goalTitles.has(goalId))
      .sort((left, right) => left.localeCompare(right)),
  ];

  return orderedGoalIds.map((goalId) => ({
    title: goalTitles.get(goalId) ?? goalId,
    entries: entriesByGoalId.get(goalId) ?? [],
  }));
}

function formatClassifiedItem(
  item: ClassificationItem,
  candidate: CandidateGoal,
): ReadonlyArray<string> {
  return [
    `- ${item.text}`,
    `  証跡タイトル: ${item.suggestedEvidenceTitle}`,
    `  有用度: ${item.usefulness}`,
    `  関連度: ${formatRelevanceScore(candidate.relevanceScore)}`,
    `  理由: ${candidate.reason}`,
  ];
}

function formatUnclassifiedItem(item: ClassificationItem): ReadonlyArray<string> {
  return [
    `- ${item.text}`,
    `  証跡タイトル: ${item.suggestedEvidenceTitle}`,
    `  有用度: ${item.usefulness}`,
  ];
}

function formatRelevanceScore(score: number): string {
  return Number.isInteger(score) ? score.toFixed(1) : String(score);
}

function formatListOrNone(items: ReadonlyArray<string>): ReadonlyArray<string> {
  if (items.length === 0) {
    return ["- なし"];
  }

  return items.map((item) => `- ${item}`);
}
