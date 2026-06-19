// Workers AI バインディング経由の LlmClient 実装(Req 4.2, 4.3, 4.5)。
// 利用側は client.ts の LlmClient 契約のみに依存し、本実装を直接 import しない。
// モデル id はファクトリ(factory.ts)から注入され、本クラスにはハードコードしない(Req 4.4)。

import { z, type ZodType } from "zod"; // zod v4
import type { LlmClient, LlmCompletionRequest, LlmResult } from "./client";

/** Workers AI JSON Mode の response_format(プレーン JSON Schema を渡す)。 */
interface JsonSchemaResponseFormat {
  type: "json_schema";
  json_schema: unknown;
}

/**
 * zod スキーマを Workers AI JSON Mode 用の response_format へ変換する。
 *
 * 変換不能なスキーマでは JSON 強制を諦め、従来のプロンプト頼み経路へフォールバックする
 * (undefined を返す)。検証は呼び出し側の zod safeParse が引き続き担保する。
 */
function toJsonSchemaResponseFormat(schema: ZodType<unknown>): JsonSchemaResponseFormat | undefined {
  try {
    return { type: "json_schema", json_schema: z.toJSONSchema(schema) };
  } catch {
    return undefined;
  }
}

/**
 * Cloudflare Workers AI バインディングを用いた `LlmClient` 実装。
 *
 * - `complete`: テキスト補完。成功時は応答テキストを返す。
 * - `completeJson`: テキストを取得後 `JSON.parse` → zod `safeParse` で検証する。
 *   パース失敗・スキーマ不一致はいずれも `invalid_output`(Req 4.5)。
 *
 * 例外は投げず、常に `LlmResult` を返す。AI 呼び出し自体の失敗は `provider_error`
 * (中断/タイムアウトが判別できる場合は `timeout`)へマッピングする。
 */
export class WorkersAiLlmClient implements LlmClient {
  // モデル id は factory から注入する(Req 4.4: プロバイダ/モデル選択を 1 箇所へ集約)。
  constructor(
    private readonly ai: Ai,
    private readonly model: keyof AiModels,
  ) {}

  async complete(request: LlmCompletionRequest): Promise<LlmResult<string>> {
    const text = await this.runText(request);
    if (!text.ok) {
      return text;
    }
    return { ok: true, value: text.value };
  }

  async completeJson<T>(request: LlmCompletionRequest, schema: ZodType<T>): Promise<LlmResult<T>> {
    // JSON Mode 対応モデルへ schema を渡し、出力をスキーマ準拠 JSON に拘束する。
    // 変換/拘束が効かない場合も後続の JSON.parse + safeParse が検証を担保する。
    const text = await this.runText(request, toJsonSchemaResponseFormat(schema));
    if (!text.ok) {
      // 基盤呼び出しの失敗は provider_error / timeout のまま表面化させる。
      return text;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text.value);
    } catch (cause) {
      return {
        ok: false,
        error: {
          kind: "invalid_output",
          message: "LLM 応答を JSON としてパースできませんでした",
          cause,
        },
      };
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      return {
        ok: false,
        error: {
          kind: "invalid_output",
          message: "LLM 応答がスキーマに適合しませんでした",
          // zod の issue 配列を cause に載せ、利用側が詳細を参照できるようにする。
          cause: result.error.issues,
        },
      };
    }

    return { ok: true, value: result.data };
  }

  /**
   * Workers AI を呼び出してテキストを取得する共通経路。
   * `system` が指定された場合は messages 形式、未指定なら prompt 形式で渡す。
   */
  private async runText(
    request: LlmCompletionRequest,
    responseFormat?: JsonSchemaResponseFormat,
  ): Promise<LlmResult<string>> {
    const inputs: AiTextGenerationInput = request.system
      ? {
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.prompt },
          ],
        }
      : { prompt: request.prompt };

    if (request.maxTokens !== undefined) {
      inputs.max_tokens = request.maxTokens;
    }
    if (request.temperature !== undefined) {
      inputs.temperature = request.temperature;
    }
    if (responseFormat !== undefined) {
      // workers-types は response_format を型に含めないため Record 経由で付与する。
      (inputs as Record<string, unknown>).response_format = responseFormat;
    }

    try {
      const output = (await this.ai.run(
        this.model,
        inputs as AiModels[typeof this.model]["inputs"],
      )) as AiTextGenerationOutput;
      return { ok: true, value: output.response ?? "" };
    } catch (cause) {
      // 中断/タイムアウトを区別できる場合は timeout、その他の AI 障害は provider_error。
      const aborted =
        cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError");
      return {
        ok: false,
        error: {
          kind: aborted ? "timeout" : "provider_error",
          message: cause instanceof Error ? cause.message : "Workers AI の呼び出しに失敗しました",
          cause,
        },
      };
    }
  }
}
