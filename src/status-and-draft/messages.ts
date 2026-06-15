// status-and-draft の応答整形ヘルパー(§8.4/§8.5/§8.6/§8.7)。
//
// 責務: 状態判定結果・証跡・ドラフトを spec §8 の構造へ整形する純粋関数。
// 所有者強制・データ取得・ボタン部品生成(custom_id 付与)はハンドラ層(task 6.x)が担い、
// 本モジュールは構造化されたテキストのみを返す(checkin-classification/messages.ts と同型)。

// design 契約は EntityRow を `../persistence/repository` から import と記すが、
// repository.ts は EntityRow を再 export しないため、正規の参照元 `../types` から取得する
// (共有型の単一参照元規約。Implementation Notes / Data Contracts 準拠)。
import type { EntityRow, GoalStatus, Usefulness } from "../types";
import type { DraftContent } from "./draft/schema";
import type { StatusVerdict } from "./status/schema";

/** §8.4 のヘッダ。半期サイクル名は呼び出し側で前置しても良いが既定は固定文言。 */
const STATUS_OVERVIEW_HEADER = "評価目標ステータス";

/** §8.6 のヘッダ。 */
const EVIDENCE_LIST_HEADER = "保存済み証跡";

/** §8.7 のヘッダ。 */
const DRAFT_HEADER = "自己評価ドラフト";

/** 見立て(reason)が欠落しているときのフォールバック文言(Req 1.5)。 */
const REASON_MISSING_FALLBACK = "見立ては取得できませんでした。";

/** 証跡未保存時の案内(Req 4.3)。 */
const EVIDENCE_EMPTY_GUIDANCE =
  "証跡がまだ未保存です。チェックインで証跡を記録すると、ここに表示されます。";

/** 目標の証跡が未保存のときの案内(§8.5 内、Req 3.5)。 */
const GOAL_EVIDENCE_EMPTY_GUIDANCE = "証跡が未保存のため、判断材料が不足しています。";

/** §8.7 のボタン提示テキスト(Req 5.5, 6.5)。実体ボタンはハンドラが生成する。 */
const DRAFT_BUTTON_LABELS = [
  "[短くする]",
  "[成果を強める]",
  "[課題を明確にする]",
  "[上司向けにする]",
  "[保存]",
] as const;

/** GoalStatus を §8.4/§8.5 の人間向けラベル(capitalized 英語)へマップする。 */
const STATUS_LABELS: Record<GoalStatus, string> = {
  green: "Green",
  yellow: "Yellow",
  red: "Red",
  gray: "Gray",
};

/** usefulness を §8.6 の日本語ラベルへマップする。 */
const USEFULNESS_LABELS: Record<Usefulness, string> = {
  low: "低",
  medium: "中",
  high: "高",
};

/** usefulness ごとの §8.6「補足」ガイダンス(証跡そのものに補足列は無いため導出)。 */
const USEFULNESS_NOTES: Record<Usefulness, string> = {
  low: "現状では評価の裏付けとしては弱いです。成果物や共有実績があるとより強い証跡になります。",
  medium: "調査実績としては使えるが、成果物や共有実績があるとより強い。",
  high: "成果や効果が示されており、評価の裏付けとして強い証跡です。",
};

/**
 * 全目標の状態/理由 + 今週やるとよいことを §8.4 形式へ整形する(Req 2.2)。
 * 空配列のハンドリング(サイクル/目標不在の案内)は呼び出し側の責務。
 */
export function formatStatusOverview(
  results: ReadonlyArray<{ goal: EntityRow<"goals">; verdict: StatusVerdict }>,
): string {
  const lines: string[] = [STATUS_OVERVIEW_HEADER, ""];

  for (const { goal, verdict } of results) {
    lines.push(goal.title);
    lines.push(`状態: ${STATUS_LABELS[verdict.status]}`);
    lines.push("理由:");
    lines.push(resolveReason(verdict));
    lines.push("");
  }

  lines.push("今週やるとよいこと:");
  const actionLines = collectWeeklyActions(results);
  if (actionLines.length === 0) {
    lines.push("- なし");
  } else {
    lines.push(...actionLines);
  }

  return lines.join("\n");
}

/**
 * 単一目標の状態・見立て・証跡一覧・不足・次アクションを §8.5 形式へ整形する(Req 3.1)。
 * 証跡が空のときは保存済み証跡欄に未保存案内を入れる(Req 3.5)。
 */
export function formatGoalStatus(
  goal: EntityRow<"goals">,
  verdict: StatusVerdict,
  evidence: ReadonlyArray<EntityRow<"evidence">>,
  shortfalls: string[],
): string {
  const lines: string[] = [];

  lines.push(`目標: ${goal.title}`);
  lines.push(`状態: ${STATUS_LABELS[verdict.status]}`);
  lines.push("");
  lines.push("Agent の見立て:");
  lines.push(resolveReason(verdict));
  lines.push("");

  lines.push("保存済み証跡:");
  if (evidence.length === 0) {
    lines.push(GOAL_EVIDENCE_EMPTY_GUIDANCE);
  } else {
    for (const item of evidence) {
      lines.push(`- ${item.evidence_date} ${item.body}`);
    }
  }
  lines.push("");

  lines.push("不足:");
  if (shortfalls.length === 0) {
    lines.push("- なし");
  } else {
    for (const shortfall of shortfalls) {
      lines.push(`- ${shortfall}`);
    }
  }
  lines.push("");

  lines.push("次アクション:");
  if (verdict.nextActions.length === 0) {
    lines.push("- なし");
  } else {
    verdict.nextActions.forEach((action, index) => {
      lines.push(`${index + 1}. ${action}`);
    });
  }

  return lines.join("\n");
}

/**
 * 証跡 + 紐づく目標 + 使いやすさ + 補足を §8.6 形式へ整形する(Req 4.1)。
 * items が空のときは未保存案内を返す(Req 4.3)。
 */
export function formatEvidenceList(
  items: ReadonlyArray<{ evidence: EntityRow<"evidence">; linkedGoalTitles: string[] }>,
): string {
  if (items.length === 0) {
    return [EVIDENCE_LIST_HEADER, "", EVIDENCE_EMPTY_GUIDANCE].join("\n");
  }

  const lines: string[] = [EVIDENCE_LIST_HEADER, ""];

  for (const { evidence, linkedGoalTitles } of items) {
    lines.push(evidence.evidence_date);
    lines.push("内容:");
    lines.push(evidence.body);
    lines.push("");
    lines.push("紐づく目標:");
    if (linkedGoalTitles.length === 0) {
      lines.push("- なし");
    } else {
      for (const title of linkedGoalTitles) {
        lines.push(`- ${title}`);
      }
    }
    lines.push("");
    lines.push("評価への使いやすさ:");
    lines.push(USEFULNESS_LABELS[evidence.usefulness]);
    lines.push("");
    lines.push("補足:");
    lines.push(USEFULNESS_NOTES[evidence.usefulness]);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/**
 * ドラフト本文を §8.7 形式へ整形し、調整/保存ボタン提示用テキストを返す(Req 5.5, 6.5)。
 * speculativeNotes は「推測」として明示する(Req 5.4)。実体ボタンはハンドラが生成する。
 */
export function formatDraft(content: DraftContent): string {
  const lines: string[] = [DRAFT_HEADER, ""];

  lines.push(content.facts);
  lines.push("");
  lines.push(content.interpretation);
  lines.push("");
  lines.push(content.issues);
  lines.push("");
  lines.push(content.nextActions);

  if (content.speculativeNotes.length > 0) {
    lines.push("");
    lines.push("推測:");
    for (const note of content.speculativeNotes) {
      lines.push(`- ${note}`);
    }
  }

  lines.push("");
  lines.push(...DRAFT_BUTTON_LABELS);

  return lines.join("\n");
}

/** verdict の reason を返す。reasonMissing かつ空のときはフォールバック文言。 */
function resolveReason(verdict: StatusVerdict): string {
  if (verdict.reasonMissing && verdict.reason.trim() === "") {
    return REASON_MISSING_FALLBACK;
  }
  return verdict.reason;
}

/** 目標横断の「今週やるとよいこと」行(目標名: アクション)を集約する。 */
function collectWeeklyActions(
  results: ReadonlyArray<{ goal: EntityRow<"goals">; verdict: StatusVerdict }>,
): string[] {
  const lines: string[] = [];
  for (const { goal, verdict } of results) {
    for (const action of verdict.nextActions) {
      lines.push(`- ${goal.title}: ${action}`);
    }
  }
  return lines;
}
