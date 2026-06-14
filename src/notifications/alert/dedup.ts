// notifications の重複抑止フィルタ(task 2.3 / Req 4.8 / design「Alert Triggers + Dedup」)。
//
// 責務: `evaluateTriggers` が算出した成立トリガ群から、同一サイクル内で同一トリガ
// (目標 × トリガ種別)を既に送信済みのものを除外する純フィルタを提供する(Req 4.8)。
// 判定は永続化された送信履歴(`alert_sent_log`)を `isAlreadySent` 経由で READ するのみで、
// 履歴を書き換えない。よって何度適用しても結果が変わらない(冪等)。
//
// 設計上の位置づけ:
// - 送信履歴への記録(`recordSent`)は domain 層(task 6.2)が配信成功後にのみ行う(Req 6.4)。
//   本フィルタは送信前判定であり、書き込みを一切行わない(READ 専用)。
// - 依存は読み取りメソッドだけで十分なため `Pick<AlertStateStore, "isAlreadySent">` に絞り、
//   結合度を最小化する(store の他メソッドには依存しない)。
//
// 期限トリガの週跨ぎ冪等性(Req 4.5, 4.6, 4.8):
//   `evaluateTriggers` は 1 評価につき kind ごとに最大 1 件しか返さない(評価内重複なし)。
//   したがって本フィルタが残日数閾値の「跨ぎ」を再計算する必要はなく、送信履歴のみで冪等に成立判定できる。
//   例: 前週に `cycle_end_30d` を送信済みなら、今週 30d/14d 双方が fired しても 30d は履歴で除外され、
//   新たに閾値を跨いだ `cycle_end_14d` のみが通過する。

import type { AlertStateStore } from "../state/alert-state";
import type { FiredTrigger } from "./triggers";

/**
 * 同一サイクル内で未送信のトリガのみを返す重複抑止フィルタ(Req 4.8)。
 *
 * `fired` のうち、(user, cycle, goal, kind) が送信履歴(`alert_sent_log`)に未記録のものだけを
 * 入力順を保って返す。判定は `store.isAlreadySent` の READ のみで行い、履歴は変更しない(冪等)。
 * 送信履歴への記録は配信成功後に domain 層が行う責務であり、本関数は `recordSent` を呼ばない(Req 6.4)。
 *
 * @param store 送信済み判定の読み取り口(`isAlreadySent` のみ要求)。
 * @param userId 所有ユーザー ID(Req 3.5 所有者スコープ)。
 * @param cycleId 評価サイクル ID(同一サイクル内でのみ重複抑止する)。
 * @param fired `evaluateTriggers` が算出した成立トリガ群(kind ごとに最大 1 件)。
 * @returns 未送信のトリガのみを入力順に並べた配列。
 */
export function filterUnsentTriggers(
  store: Pick<AlertStateStore, "isAlreadySent">,
  userId: string,
  cycleId: string,
  fired: readonly FiredTrigger[],
): FiredTrigger[] {
  return fired.filter(
    (trigger) => !store.isAlreadySent(userId, cycleId, trigger.goalId, trigger.kind),
  );
}
