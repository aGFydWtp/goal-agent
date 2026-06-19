// LLM クライアント生成ファクトリ(Req 4.4)。
// プロバイダ選択(Workers AI)とモデル id をこの 1 ファイルに集約する。
// 利用側は createLlmClient(env) が返す LlmClient のみに依存するため、
// プロバイダ/モデルの差し替えは本ファイルの変更だけで完結する。

import type { Env } from "../env";
import type { LlmClient } from "./client";
import { WorkersAiLlmClient } from "./workers-ai";

// プロバイダ/モデル選択の単一集約点。変更時はここだけを編集する(Req 4.4)。
//
// JSON Mode(response_format: json_schema)対応モデルを選ぶ。旧 8B fp8 は JSON Mode 非対応で
// 構造化出力が安定せず invalid_output を多発させたため、JSON Mode 対応かつ上位グレードの
// llama-3.3-70b-instruct-fp8-fast へ更新する。
// 対応モデル一覧: https://developers.cloudflare.com/workers-ai/features/json-mode/
const MODEL: keyof AiModels = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * 環境バインディングから既定の `LlmClient` を構築して返す。
 * 現在の実装は Workers AI(`env.AI`)を用いる。
 */
export function createLlmClient(env: Env): LlmClient {
  return new WorkersAiLlmClient(env.AI, MODEL);
}
