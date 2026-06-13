import { Agent } from "agents";
import type { Env } from "../env";

/**
 * サイクル単位のデータ権威となる Agent (Req 3.1)。
 *
 * 本タスク (1.1) では Durable Object バインディングと `new_sqlite_classes`
 * マイグレーションを成立させるための最小スケルトンのみを提供する。
 * `onStart` でのマイグレーション適用・Repository 保持・責務境界メソッドは
 * 後続タスク (4.2) で実装される。
 */
export class EvaluationCycleAgent extends Agent<Env> {}
