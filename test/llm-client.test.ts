import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  LlmClient,
  LlmCompletionRequest,
  LlmError,
  LlmResult,
} from "../src/llm/client";

// Req 4.1 完了条件: 利用側はプロバイダ実装(WorkersAiLlmClient / factory)を一切知らず、
// インターフェイスとエラー/結果型のみを import して型チェックが通ること。
describe("LlmClient interface and error/result types (provider-agnostic)", () => {
  it("構成可能な成功結果は ok===true で value にナローイングできる", () => {
    const result: LlmResult<string> = { ok: true, value: "hello" };

    expect(result.ok).toBe(true);
    if (result.ok) {
      // ナローイング: ok===true 分岐で .value が string として参照可能。
      expectTypeOf(result.value).toEqualTypeOf<string>();
      expect(result.value).toBe("hello");
    } else {
      throw new Error("unreachable: result should narrow to the ok branch");
    }
  });

  it("構成可能な失敗結果は ok===false で error にナローイングできる", () => {
    const error: LlmError = {
      kind: "provider_error",
      message: "boom",
      cause: new Error("upstream"),
    };
    const result: LlmResult<string> = { ok: false, error };

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // ナローイング: ok===false 分岐で .error が LlmError として参照可能。
      expectTypeOf(result.error).toEqualTypeOf<LlmError>();
      expect(["provider_error", "timeout", "invalid_output"]).toContain(
        result.error.kind,
      );
    } else {
      throw new Error("unreachable: result should narrow to the error branch");
    }
  });

  it("LlmError.kind は 3 つの判別リテラルのみを取りうる", () => {
    expectTypeOf<LlmError["kind"]>().toEqualTypeOf<
      "provider_error" | "timeout" | "invalid_output"
    >();

    const kinds: ReadonlyArray<LlmError["kind"]> = [
      "provider_error",
      "timeout",
      "invalid_output",
    ];
    expect(kinds).toHaveLength(3);
  });

  it("LlmCompletionRequest は prompt 必須・他は任意である", () => {
    const minimal: LlmCompletionRequest = { prompt: "p" };
    const full: LlmCompletionRequest = {
      system: "s",
      prompt: "p",
      maxTokens: 256,
      temperature: 0.2,
    };

    expect(minimal.prompt).toBe("p");
    expect(full.system).toBe("s");
  });

  it("LlmClient はプロバイダ非依存に実装可能なシグネチャを公開する", () => {
    // プロバイダ実装を一切知らずにインターフェイスへ準拠できることの型レベル確認。
    expectTypeOf<LlmClient["complete"]>().toEqualTypeOf<
      (request: LlmCompletionRequest) => Promise<LlmResult<string>>
    >();
    expectTypeOf<LlmClient>().toMatchTypeOf<{
      complete: (r: LlmCompletionRequest) => Promise<LlmResult<string>>;
    }>();
  });
});
