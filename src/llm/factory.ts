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
// JSON Mode 対応・非廃止・低レイテンシのモデルを採用する。2026-05-30 に旧世代モデルが一斉廃止
// され、llama-3-8b-instruct / hermes-2-pro-mistral-7b はいずれも実行時 AiError 5028(deprecated)
// を投げた。70B(llama-3.3-70b-fp8-fast)は JSON Mode の guided 生成が重く応答 hang を多発させた。
// そこで、公式 JSON Mode 対応リストにあり workers-types にも存在し、廃止世代より新しい
// llama-3.2-11b-vision-instruct(テキスト入力可)を選ぶ。11B で 70B より高速。
// 対応モデル一覧: https://developers.cloudflare.com/workers-ai/features/json-mode/
const MODEL: keyof AiModels = "@cf/meta/llama-3.2-11b-vision-instruct";

/**
 * 環境バインディングから既定の `LlmClient` を構築して返す。
 * 現在の実装は Workers AI(`env.AI`)を用いる。
 */
export function createLlmClient(env: Env): LlmClient {
  return new WorkersAiLlmClient(env.AI, MODEL);
}
