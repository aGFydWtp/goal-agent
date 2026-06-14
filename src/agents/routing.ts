import { getAgentByName } from "agents";
import type { Env } from "../env";
import type { EvaluationCycleAgent } from "./evaluation-cycle-agent";
import type { GoalAgent } from "./goal-agent";
import { cycleAgentName, goalAgentName } from "./ids";

/**
 * Agent 取得ルーティングヘルパー(§6 ID 規約 / design.md「Agent IDs + Routing」)。
 *
 * 上位機能(Worker Entry など)が一貫した方法で Agent を特定・取得・委譲するための
 * 単一の入口。名前は ids.ts の規約組立を再利用し(独自に書式を再導出しない)、
 * 名前ベースのアドレッシング(`getAgentByName`)で論理 DO インスタンスへ解決する。
 *
 * 決定性(Req 3.6): 同一引数は同一の §6 規約名を生成し、同名は同一論理 DO
 * インスタンスへ解決するため、複数回の取得要求は常に同一インスタンスに解決する。
 */

/**
 * (userId, cycleId) から EvaluationCycleAgent(サイクル単位のデータ権威)を取得する
 * (Req 3.3)。`evaluation:{userId}:{cycleId}` 名で名前解決する。
 */
export function getCycleAgent(
  env: Env,
  userId: string,
  cycleId: string,
): Promise<DurableObjectStub<EvaluationCycleAgent>> {
  return getAgentByName(env.EvaluationCycleAgent, cycleAgentName(userId, cycleId));
}

/**
 * (userId, cycleId, goalId) から GoalAgent(目標単位ロジック)を取得する
 * (Req 3.4)。`evaluation:{userId}:{cycleId}:goal:{goalId}` 名で名前解決する。
 */
export function getGoalAgent(
  env: Env,
  userId: string,
  cycleId: string,
  goalId: string,
): Promise<DurableObjectStub<GoalAgent>> {
  return getAgentByName(env.GoalAgent, goalAgentName(userId, cycleId, goalId));
}
