import { Agent } from "agents";
import type { Env } from "../env";

/**
 * 目標単位ロジックの論理 Agent (Req 3.1)。
 *
 * 本タスク (1.1) では Durable Object バインディングと `new_sqlite_classes`
 * マイグレーションを成立させるための最小スケルトンのみを提供する。
 * 親 EvaluationCycleAgent へのデータ委譲・責務境界メソッドは
 * 後続タスク (4.3) で実装される。
 */
export class GoalAgent extends Agent<Env> {}
