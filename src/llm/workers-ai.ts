// Workers AI バインディング経由の LlmClient 実装(Req 4.2, 4.3, 4.5)。
// 利用側は client.ts の LlmClient 契約のみに依存し、本実装を直接 import しない。
// モデル id はファクトリ(factory.ts)から注入され、本クラスにはハードコードしない(Req 4.4)。

import { type ZodType, z } from "zod"; // zod v4
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
function toJsonSchemaResponseFormat(
  schema: ZodType<unknown>,
): JsonSchemaResponseFormat | undefined {
  try {
    return { type: "json_schema", json_schema: z.toJSONSchema(schema) };
  } catch {
    return undefined;
  }
}

/**
 * Workers AI 1 回の呼び出しに許す上限(ミリ秒)。
 *
 * Workers AI の推論レイテンシは変動し、稀に応答が返らない。タイムアウトが無いと deferred
 * 継続が無限待機し Discord が「考え中…」のまま固着するため、上限超過は timeout として
 * 失敗させ、利用側を再試行案内へ正規化できるようにする。
 *
 * 値は分類モデル(qwen2.5-coder-32b)の実測に合わせる。現実的な週次チェックイン(複数活動 ×
 * 複数目標)を JSON Mode で全項目分解すると ~24s かかる実測があり、20s では正常応答を timeout で
 * 取りこぼす。deferred 継続(webhook editOriginal は最大 15 分有効)なので余裕を持って 45s とし、
 * 真のハング(無限待機)だけを timeout として打ち切る。
 */
const LLM_TIMEOUT_MS = 45000;

/**
 * JSON Mode 呼び出しで `maxTokens` 未指定時に用いる既定上限。
 *
 * Workers AI の `max_tokens` 既定値は小さく、現実的な分類 JSON(複数項目)を途中で truncate して
 * しまう。切れた JSON は `JSON.parse` 失敗 → `invalid_output` となり、短い入力では再現せず長い入力
 * でのみ間欠失敗する原因になる。JSON Mode では出力欠落が即失敗に直結するため、未指定時は十分大きい
 * 既定を充てて truncate を防ぐ(テキスト補完経路はプロバイダ既定のままとする)。
 */
const JSON_MODE_DEFAULT_MAX_TOKENS = 2048;

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
    //
    // maxTokens 未指定時は JSON Mode 既定上限を充てる。プロバイダ既定は小さく、複数項目の分類 JSON を
    // truncate して JSON.parse 失敗 → invalid_output を招くため、JSON 経路では明示的に底上げする。
    const jsonRequest: LlmCompletionRequest = {
      ...request,
      maxTokens: request.maxTokens ?? JSON_MODE_DEFAULT_MAX_TOKENS,
    };
    const text = await this.runText(jsonRequest, toJsonSchemaResponseFormat(schema));
    if (!text.ok) {
      // 基盤呼び出しの失敗は provider_error / timeout のまま表面化させる。
      return text;
    }

    // JSON Mode 有効時、Workers AI は response をパース済みオブジェクトで返す(文字列 JSON ではない)。
    // 文字列の場合のみ JSON.parse し、既にオブジェクトならそのまま zod 検証へ渡す。
    const raw: unknown = text.value;
    let parsed: unknown;
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw);
      } catch (cause) {
        // 診断: パース失敗は多くが max_tokens 由来の truncate。出力本文は残さず、長さと末尾が
        // 閉じ括弧で終わるか(= 途中で切れた兆候)だけをログして truncate を切り分け可能にする。
        const endsClosed = /[}\]]\s*$/.test(raw);
        console.error(
          `workers-ai.completeJson: JSON パース失敗 len=${raw.length} endsClosed=${endsClosed}`,
        );
        return {
          ok: false,
          error: {
            kind: "invalid_output",
            message: "LLM 応答を JSON としてパースできませんでした",
            cause,
          },
        };
      }
    } else {
      parsed = raw;
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      // 診断: スキーマ不一致は値ではなく issue の path:code のみログする(出力本文は残さない)。
      const issuePaths = result.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`)
        .join(",");
      console.error(
        `workers-ai.completeJson: スキーマ不一致 type=${typeof raw} issues=${issuePaths}`,
      );
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
      const output = (await this.runWithTimeout(inputs)) as AiTextGenerationOutput;
      return { ok: true, value: output.response ?? "" };
    } catch (cause) {
      // 診断(一時): ai.run の実際の例外内容をログし、provider_error の真因を確認する。
      console.error(
        `workers-ai.runText: AI呼び出し失敗 ${
          cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
        }`,
      );
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

  /**
   * `ai.run` をタイムアウト付きで実行する。{@link LLM_TIMEOUT_MS} 超過時は name="TimeoutError"
   * で reject し、無限待機(Discord「考え中…」固着)を防ぐ。成功/失敗いずれでもタイマーは解除する。
   */
  private runWithTimeout(inputs: AiTextGenerationInput): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Workers AI 応答が ${LLM_TIMEOUT_MS}ms を超過しました`);
        error.name = "TimeoutError";
        reject(error);
      }, LLM_TIMEOUT_MS);
    });
    const run = this.ai.run(this.model, inputs as AiModels[typeof this.model]["inputs"]);
    return Promise.race([run, timeout]).finally(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    });
  }
}
