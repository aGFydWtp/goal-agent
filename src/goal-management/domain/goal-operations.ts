// GoalAgent のドメイン操作(goal-management Goal Domain Operations)。
//
// 設計上の配置(design「Goal Domain Operations」L397-410 準拠): GoalAgent はステートレスで、
// 自前のスキーマ/書き込み権威を持たない。目標定義の取得要求を親 EvaluationCycleAgent(データ権威)
// の `getGoal` へ委譲する。infra 骨格(`src/agents/*.ts`)は変更せず、純粋関数として実装する。

import type { GoalRow } from "../../types";
import { type CycleDataAuthority, getGoal } from "./cycle-operations";

/**
 * 目標定義の取得を親 Cycle(データ権威)の `getGoal` へ委譲する(Req 2.3, 5.2, 5.3)。
 *
 * GoalAgent は書き込み権威・自前スキーマを持たないため、取得結果は親権威と一致する
 * (design Invariants: GoalAgent は書き込み権威を持たない)。所有者スコープ・サイクルスコープの
 * 検証はすべて委譲先 `getGoal` が担う(非所有/別サイクル/不存在は `null`)。
 *
 * @param authority サイクルデータ権威(委譲先 `getGoal` が消費)。
 * @param userId 実行ユーザー(= 所有者)識別子。
 * @param cycleId 対象サイクル識別子。
 * @param goalId 取得対象の目標識別子。
 * @returns 所有かつ同一サイクルの目標行。非所有/別サイクル/不存在は `null`。
 */
export async function getGoalDefinition(
  authority: CycleDataAuthority,
  userId: string,
  cycleId: string,
  goalId: string,
): Promise<GoalRow | null> {
  return getGoal(authority, userId, cycleId, goalId);
}
