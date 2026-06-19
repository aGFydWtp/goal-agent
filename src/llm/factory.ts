// LLM クライアント生成ファクトリ(Req 4.4)。
// プロバイダ選択(Workers AI)とモデル id をこの 1 ファイルに集約する。
// 利用側は createLlmClient(env) が返す LlmClient のみに依存するため、
// プロバイダ/モデルの差し替えは本ファイルの変更だけで完結する。

import type { Env } from "../env";
import type { LlmClient } from "./client";
import { WorkersAiLlmClient } from "./workers-ai";

// プロバイダ/モデル選択の単一集約点。変更時はここだけを編集する(Req 4.4)。
//
// JSON Mode(response_format: json_schema)対応モデルを選ぶ。当初の invalid_output は
// モデルの賢さではなく応答(object)の受け取りバグが原因で、それは completeJson 側で解消済み。
// 70B は JSON Mode の guided 生成が重く Workers AI 上で応答が返らず「考え中」hang を招いたため、
// JSON Mode 対応・非廃止・ライセンスゲート無し・低〜中レイテンシのモデルを採用する。
// 経緯: 2026-05-30 に旧世代(llama-3-8b / hermes-2-pro 等)が一斉廃止され実行時 AiError 5028、
// llama-3.2-11b-vision はライセンス未同意で AiError 5016、70B は guided 生成が重く応答 hang。
// 実スキーマで複数モデルを実測(/__admin/ai-probe)した結果、qwen2.5-coder-32b が
// 「スキーマ遵守が堅牢・出力/レイテンシともに最も一貫(~7s)・廃止/ゲート無し」で最良だった。
// 速度最優先なら llama-3.2-3b-instruct(~1.5s)へ1行変更可(分解の一貫性はやや劣る)。
const MODEL: keyof AiModels = "@cf/qwen/qwen2.5-coder-32b-instruct";

/**
 * 環境バインディングから既定の `LlmClient` を構築して返す。
 * 現在の実装は Workers AI(`env.AI`)を用いる。
 */
export function createLlmClient(env: Env): LlmClient {
  return new WorkersAiLlmClient(env.AI, MODEL);
}
