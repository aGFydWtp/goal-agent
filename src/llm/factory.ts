// LLM クライアント生成ファクトリ(Req 4.4)。
// プロバイダ選択(Workers AI)とモデル id をこの 1 ファイルに集約する。
// 利用側は createLlmClient(env) が返す LlmClient のみに依存するため、
// プロバイダ/モデルの差し替えは本ファイルの変更だけで完結する。

import type { Env } from "../env";
import type { LlmClient } from "./client";
import { WorkersAiLlmClient } from "./workers-ai";

// プロバイダ/モデル選択の単一集約点。変更時はここだけを編集する(Req 4.4)。
//
// JSON Mode(response_format: json_schema)で出力をスキーマ準拠 JSON に拘束できるモデルを選ぶ。
// 本番で間欠していた invalid_output の真因は「モデルが JSON Mode 非対応」でも「賢さ不足」でもなく、
// completeJson が max_tokens を渡しておらず Workers AI 既定値が小さいため、現実的な週次チェックイン
// (複数活動 × 複数目標)の分類 JSON が途中で truncate され JSON.parse 失敗していたこと。短い入力は
// 収まるため再現せず、長い入力でのみ失敗していた。修正は workers-ai.ts(JSON_MODE_DEFAULT_MAX_TOKENS)。
// 経緯: 2026-05-30 に旧世代(llama-3-8b / hermes-2-pro 等)が一斉廃止され実行時 AiError 5028、
// llama-3.2-11b-vision はライセンス未同意で AiError 5016、llama-3.1-8b-fp8 は AiError 5025(JSON Schema
// 非対応)、llama-3.1-8b-awq は AiError 5028(廃止)。実モデル実測(wrangler dev --remote)では
// qwen2.5-coder-32b が「目標リンクが正確・JSON Mode 準拠・廃止/ゲート無し」で品質最良(~24s)、
// llama-3.3-70b-fp8-fast は品質最良だが ~30s、llama-3.2-3b は ~2s と高速だが目標リンクを取りこぼす。
// deferred 継続(editOriginal は最大 15 分有効)で待てるため品質優先で qwen を採る。timeout は
// workers-ai.ts の LLM_TIMEOUT_MS=45s で実測レイテンシに合わせる。
const MODEL: keyof AiModels = "@cf/qwen/qwen2.5-coder-32b-instruct";

/**
 * 環境バインディングから既定の `LlmClient` を構築して返す。
 * 現在の実装は Workers AI(`env.AI`)を用いる。
 */
export function createLlmClient(env: Env): LlmClient {
  return new WorkersAiLlmClient(env.AI, MODEL);
}
