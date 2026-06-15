// notifications のアラートトリガ算出ドメイン(task 2.1 / Req 4.7)。
//
// 半期終了までの残り日数を、対象サイクルの終了日(`evaluation_cycles.end_date`)と現在日付から
// 算出する。status-and-draft の `utcDayDiff` と同じ UTC 暦日基準で差を取り、コードベース全体で
// 日数差の振る舞いを一致させる(時刻成分は切り捨て、UTC の暦日同士で差分)。
//
// task 2.2 で本ファイルに `evaluateTriggers`(§9.3 トリガ評価)を追加する。`evaluateTriggers` は
// 純関数であり SQL / I/O を行わない。証跡経過(`latestEvidenceAgeDays`)・残日数
// (`daysUntilCycleEnd`)は domain 層で事前算出され引数として渡される。

import type { GoalStatus } from "../../types";
import type { AlertTriggerKind } from "../state/alert-state";

/** 1 日のミリ秒数。日数差計算に用いる。 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 半期終了までの残り日数(UTC 暦日)を返す(Req 4.7)。
 *
 * `now` から `cycleEndDate`(サイクル終了日)までの UTC 暦日差を整数で返す。終了日が未来なら正、
 * 終了当日は 0、過去なら負。両辺とも時刻成分を切り捨てて UTC の暦日同士で差を取るため、`now` の
 * 時刻(time-of-day)は結果を変えない。
 *
 * @param cycleEndDate サイクル終了日。`YYYY-MM-DD` または ISO8601 timestamp 文字列
 *   (`evaluation_cycles.end_date` に対応)。
 * @param now 基準となる現在日時。
 * @returns `now` から `cycleEndDate` までの整数 UTC 暦日数。
 * @throws いずれかの日付が解析不能(Invalid Date)な場合。
 */
export function daysUntilCycleEnd(cycleEndDate: string, now: Date): number {
  const endDate = new Date(cycleEndDate);
  if (Number.isNaN(endDate.getTime()) || Number.isNaN(now.getTime())) {
    throw new Error("invalid date for days-until-cycle-end");
  }
  const nowUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const endUtc = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate());
  return Math.round((endUtc - nowUtc) / MS_PER_DAY);
}

/** 証跡なし停滞トリガの閾値日数(2 週間 = 14 日)。Req 4.4。 */
const NO_EVIDENCE_THRESHOLD_DAYS = 14;
/** 半期終了 30 日前トリガの残日数閾値。Req 4.5。 */
const CYCLE_END_30D_THRESHOLD = 30;
/** 半期終了 14 日前トリガの残日数閾値。Req 4.6。 */
const CYCLE_END_14D_THRESHOLD = 14;

/**
 * `evaluateTriggers` の入力(§9.3)。直近状態・新状態・証跡経過・残日数を受け取る純データ。
 * `previousStatus === null` は当該目標の初回判定(Req 3.4)を表す。
 * `latestEvidenceAgeDays === null` は証跡 0 件(年齢計測不能)を表す。
 */
export interface TriggerInput {
  goalId: string;
  goalTitle: string;
  newStatus: GoalStatus;
  /** 保持中の直近状態。null = 初回判定(Req 3.4)。 */
  previousStatus: GoalStatus | null;
  /** 最新証跡からの経過日数。null = 証跡 0 件(Req 4.4 の age ベース判定では非成立扱い)。 */
  latestEvidenceAgeDays: number | null;
  /** 半期終了までの残日数(`daysUntilCycleEnd` の算出値)。 */
  daysUntilCycleEnd: number;
}

/**
 * 成立したトリガ 1 件(§9.3)。`goalId`/`goalTitle`/`newStatus` は入力から引き継ぐ。
 * `reasons` は成立理由を説明する日本語の理由行(非空)。
 */
export interface FiredTrigger {
  goalId: string;
  goalTitle: string;
  kind: AlertTriggerKind;
  newStatus: GoalStatus;
  /** §9.3 理由行(状態悪化 / 証跡なし継続 / 残り日数 等)。非空。 */
  reasons: string[];
}

/**
 * §9.3 トリガ評価ロジック(純関数 / SQL・I/O なし)。
 *
 * 保持中の直近状態と新状態を比較した悪化遷移(Req 3.2, 4.2, 4.3)、証跡なし2週継続
 * (Req 4.4)、半期終了 30/14 日前(Req 4.5, 4.6)を評価し、成立したトリガを kind ごとに
 * 1 件ずつ返す。証跡経過・残日数は呼び出し側で事前算出され、入力として渡される。
 *
 * @param input 評価対象目標の状態・証跡経過・残日数。
 * @returns 成立したトリガの配列(成立なしは空配列)。kind ごとに最大 1 件。
 */
export function evaluateTriggers(input: TriggerInput): FiredTrigger[] {
  const fired: FiredTrigger[] = [];
  const base = {
    goalId: input.goalId,
    goalTitle: input.goalTitle,
    newStatus: input.newStatus,
  } as const;

  // --- 状態悪化遷移(Req 3.2, 4.2, 4.3) ---
  // Req 3.4: 直近状態が未保持(初回 = previousStatus === null)の場合は悪化遷移を成立させない。
  // 初回抑止は遷移トリガにのみ適用し、停滞・期限トリガには適用しない(previousStatus 非依存)。
  if (input.previousStatus !== null) {
    // green_to_yellow(Req 3.2, 4.2): Green→Yellow の悪化で成立。
    if (input.previousStatus === "green" && input.newStatus === "yellow") {
      fired.push({
        ...base,
        kind: "green_to_yellow",
        reasons: [`状態悪化: green → yellow に遷移しました。`],
      });
    }
    // yellow_to_red(Req 3.2, 4.3): Yellow→Red の悪化で成立。
    if (input.previousStatus === "yellow" && input.newStatus === "red") {
      fired.push({
        ...base,
        kind: "yellow_to_red",
        reasons: [`状態悪化: yellow → red に遷移しました。`],
      });
    }
  }

  // --- 証跡なし2週継続(Req 4.4) ---
  // 最新証跡からの経過が 14 日以上で成立。null(証跡 0 件)は age ベースの本トリガでは非成立とする。
  // この null 扱いは task 6.2 の「証跡経過2週超で no_evidence_2w が成立」という age ベースの文言に基づく
  // 判断であり、証跡アンカーを持たない目標は本トリガの計測対象外とみなす(CONCERNS 参照)。
  if (
    input.latestEvidenceAgeDays !== null &&
    input.latestEvidenceAgeDays >= NO_EVIDENCE_THRESHOLD_DAYS
  ) {
    fired.push({
      ...base,
      kind: "no_evidence_2w",
      reasons: [
        `証跡なし継続: 最新証跡から ${input.latestEvidenceAgeDays} 日経過しています(2週間以上)。`,
      ],
    });
  }

  // --- 半期終了期限トリガ(Req 4.5, 4.6) ---
  // 残日数が閾値以下で成立。残日数 ≤ 14 のときは 30d と 14d の両方が成立しうる(週次 dedup は task 2.3 の責務)。
  // cycle_end_30d(Req 4.5): 残日数 30 以下で成立。
  if (input.daysUntilCycleEnd <= CYCLE_END_30D_THRESHOLD) {
    fired.push({
      ...base,
      kind: "cycle_end_30d",
      reasons: [`残り日数: 半期終了まで ${input.daysUntilCycleEnd} 日(30日以内)です。`],
    });
  }
  // cycle_end_14d(Req 4.6): 残日数 14 以下で成立。
  if (input.daysUntilCycleEnd <= CYCLE_END_14D_THRESHOLD) {
    fired.push({
      ...base,
      kind: "cycle_end_14d",
      reasons: [`残り日数: 半期終了まで ${input.daysUntilCycleEnd} 日(14日以内)です。`],
    });
  }

  return fired;
}
