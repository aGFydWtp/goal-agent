import type { EvaluationCycleAgent } from "./agents/evaluation-cycle-agent";
import type { GoalAgent } from "./agents/goal-agent";

/**
 * Worker 実行環境のバインディング契約 (Req 1.4)。
 *
 * - `AI`: Cloudflare Workers AI バインディング。`LlmClient` の初期実装が利用する。
 * - `EvaluationCycleAgent` / `GoalAgent`: Durable Object 名前空間バインディング。
 *   ルーティングヘルパーがインスタンスを取得する起点となる。
 *
 * 必須バインディングが `wrangler` 設定から欠けている場合、本型を経由するコードは
 * 型レベルで不足を検出できる。
 */
export interface Env {
  AI: Ai;
  EvaluationCycleAgent: DurableObjectNamespace<EvaluationCycleAgent>;
  GoalAgent: DurableObjectNamespace<GoalAgent>;
}
