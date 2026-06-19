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
// JSON Mode 対応かつ低レイテンシの 8B-fast を採用する(分類は構造化抽出で 8B で十分)。
// 対応モデル一覧: https://developers.cloudflare.com/workers-ai/features/json-mode/
const MODEL: keyof AiModels = "@cf/meta/llama-3.1-8b-instruct-fast";

/**
 * 環境バインディングから既定の `LlmClient` を構築して返す。
 * 現在の実装は Workers AI(`env.AI`)を用いる。
 */
export function createLlmClient(env: Env): LlmClient {
  return new WorkersAiLlmClient(env.AI, MODEL);
}
