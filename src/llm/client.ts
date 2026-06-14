// LLM 抽象化レイヤの公開インターフェイスとエラー/結果型(Req 4.1, 4.5、design §"LlmClient + WorkersAiLlmClient + Factory")。
// このモジュールは「契約」のみを所有する。プロバイダ実装(WorkersAiLlmClient)と
// ファクトリ(createLlmClient)は別タスク(3.2)が所有し、ここでは参照しない。
// 利用側はこの client.ts のみに依存し、プロバイダ実装を直接 import しない(Req 4.4 の不変条件)。

import type { ZodType } from "zod"; // zod v4

/**
 * テキスト補完および構造化 JSON 出力に共通する入力。
 * `prompt` のみ必須。その他はプロバイダ既定に委ねる任意項目。
 */
export interface LlmCompletionRequest {
  system?: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * LLM 呼び出し失敗を利用側が判別・処理できる形で表す判別可能エラー(Req 4.5)。
 * - provider_error: プロバイダ/ネットワーク障害など呼び出し自体の失敗。
 * - timeout: 呼び出しがタイムアウトした。
 * - invalid_output: 応答の JSON パース失敗またはスキーマ不一致。
 */
export interface LlmError {
  kind: "provider_error" | "timeout" | "invalid_output";
  message: string;
  cause?: unknown;
}

/**
 * 成功/失敗を `ok` で判別する結果型。例外を投げず常にこの型で返す。
 * `ok === true` で `value`、`ok === false` で `error` にナローイングできる。
 */
export type LlmResult<T> = { ok: true; value: T } | { ok: false; error: LlmError };

/**
 * プロバイダ固有 API を隠蔽した LLM 共通インターフェイス(Req 4.1)。
 * 構造化出力は呼び出し側が渡す zod v4 スキーマで検証し、戻り値の型は
 * そのスキーマから導出される(`T = z.infer<typeof schema>`)。
 */
export interface LlmClient {
  complete(request: LlmCompletionRequest): Promise<LlmResult<string>>;
  // 構造化出力は zod スキーマで検証。戻り値の型は schema から導出(T = z.infer<typeof schema>)。
  completeJson<T>(request: LlmCompletionRequest, schema: ZodType<T>): Promise<LlmResult<T>>;
}
