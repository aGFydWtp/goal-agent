// notifications の通知文整形ヘルパー(§9.1 チェックイン文 / §9.3 アラート文)。
//
// 責務: 状態件数・アラート理由を §9 の構造を持つ日本語テキストへ整形する純粋関数。
// データ取得・判定・配信・ボタン部品生成は持たない(Delivery / Domain Operations が担う)。
// status-and-draft/messages.ts と同型で、構造化されたテキストのみを返す。

import type { GoalStatus } from "../types";

/** §9.1 チェックイン文の入力促し(今週やったことの入力を促す主目的)。 */
const CHECKIN_PROMPT = "今週やったことを入力してください。";

/** §9.1 の状態件数セクション見出し。 */
const CHECKIN_COUNTS_HEADER = "現在の状態:";

/** §9.3 アラート文のヘッダ。 */
const ALERT_HEADER = "アラート";

/** §9.3 の理由セクション見出し。 */
const ALERT_REASONS_HEADER = "理由:";

/** §9.3 で理由が1件も無いときのフォールバック行(Domain 層は通常 ≥1 件を渡す)。 */
const ALERT_REASON_FALLBACK = "- 状態の変化を検出しました。";

/**
 * GoalStatus を §9.1/§9.3 の人間向けラベル(capitalized 英語)へマップする。
 * status-and-draft/messages.ts の STATUS_LABELS と同一表記で揃える。
 */
const STATUS_LABELS: Record<GoalStatus, string> = {
  green: "Green",
  yellow: "Yellow",
  red: "Red",
  gray: "Gray",
};

/** §9.1 チェックイン文に埋め込む Green/Yellow/Red の件数。 */
export interface StatusCounts {
  green: number;
  yellow: number;
  red: number;
}

/**
 * §9.1 のチェックイン文を組み立てる(Req 2.2, 2.4)。
 * 今週やったことの入力促しに Green/Yellow/Red の件数を埋め込む。
 * 目標0件でも全0件として3件数を全て表示し、件数行を省略しない(Req 2.4)。
 */
export function buildCheckinMessage(counts: StatusCounts): string {
  return [
    CHECKIN_PROMPT,
    "",
    CHECKIN_COUNTS_HEADER,
    `${STATUS_LABELS.green}: ${counts.green}`,
    `${STATUS_LABELS.yellow}: ${counts.yellow}`,
    `${STATUS_LABELS.red}: ${counts.red}`,
  ].join("\n");
}

/**
 * §9.3 のアラート文を組み立てる(Req 5.1, 5.2)。
 * 目標名・新状態・成立理由(状態悪化/証跡なし継続/残り日数 等)を含め、
 * 改善導線として対象目標の `/goal status <goalId>` 案内を末尾に付す(Req 5.2)。
 * 理由が空でも有効なメッセージを返す(フォールバック行を補う)。
 */
export function buildAlertMessage(args: {
  goalId: string;
  goalTitle: string;
  newStatus: GoalStatus;
  reasons: string[];
}): string {
  const lines: string[] = [ALERT_HEADER, ""];

  lines.push(`目標: ${args.goalTitle}`);
  lines.push(`状態: ${STATUS_LABELS[args.newStatus]}`);
  lines.push("");

  lines.push(ALERT_REASONS_HEADER);
  if (args.reasons.length === 0) {
    lines.push(ALERT_REASON_FALLBACK);
  } else {
    for (const reason of args.reasons) {
      lines.push(`- ${reason}`);
    }
  }
  lines.push("");

  // 改善導線(Req 5.2): goalId を実値で補間した /goal status コマンド案内。
  lines.push(`改善するには: /goal status ${args.goalId}`);

  return lines.join("\n");
}
