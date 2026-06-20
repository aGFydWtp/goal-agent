import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";
import type { LlmClient } from "../src/llm/client";
import { createLlmClient } from "../src/llm/factory";
import { WorkersAiLlmClient } from "../src/llm/workers-ai";
import type { Env } from "../src/env";

// `Ai` バインディングは @cloudflare/workers-types(workers tsconfig)経由でのみ提供されるため、
// node プロジェクトのこのテストではフェイクを構築して `unknown` 経由でキャストする。
// run の戻り値だけを差し替える最小フェイクで十分(Task 3.2 はモック前提のユニットテスト)。
type FakeAi = { run: (model: string, inputs: unknown) => Promise<unknown> };

function makeAi(run: FakeAi["run"]): Ai {
  return { run } as unknown as Ai;
}

// WorkersAiLlmClient のコンストラクタは `keyof AiModels` を要求するため、
// 実在するモデル id を明示型で指定する(任意の有効なモデルでよい)。
const MODEL: keyof AiModels = "@cf/meta/llama-3.1-8b-instruct-fp8";

describe("WorkersAiLlmClient.complete (Req 4.2, 4.3)", () => {
  it("成功時は AI 応答の response テキストを value として返す", async () => {
    const ai = makeAi(async () => ({ response: "hello" }));
    const client = new WorkersAiLlmClient(ai, MODEL);

    const result = await client.complete({ prompt: "hi" });

    expect(result).toEqual({ ok: true, value: "hello" });
  });

  it("注入されたモデル id で AI バインディングを呼び出す", async () => {
    const run = vi.fn(async () => ({ response: "ok" }));
    const client = new WorkersAiLlmClient(makeAi(run), MODEL);

    await client.complete({ prompt: "p", maxTokens: 64, temperature: 0.2 });

    expect(run).toHaveBeenCalledTimes(1);
    // vi.fn の実装は引数を宣言しないため calls[0] は [] | undefined と推論される。
    // 直前で呼び出し回数を 1 と検証済みのため、unknown 経由で実引数タプルへ読み替える。
    const [model, inputs] = run.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(model).toBe(MODEL);
    // maxTokens → max_tokens のマッピングと temperature 透過を確認。
    expect(inputs.max_tokens).toBe(64);
    expect(inputs.temperature).toBe(0.2);
    expect(inputs.prompt).toBe("p");
  });

  it("AI 呼び出しが throw した場合は provider_error を返す", async () => {
    const ai = makeAi(async () => {
      throw new Error("upstream down");
    });
    const client = new WorkersAiLlmClient(ai, MODEL);

    const result = await client.complete({ prompt: "hi" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.kind).toBe("provider_error");
    expect(result.error.cause).toBeInstanceOf(Error);
  });

  // 中断/タイムアウト(name=AbortError|TimeoutError)は timeout へマッピングされること(Req 4.5)。
  // workers-ai.ts runText は cause.name で timeout / provider_error を判別する。
  it.each([["AbortError"], ["TimeoutError"]])(
    "AI 呼び出しが %s で reject した場合は timeout を返す",
    async (name) => {
      const ai = makeAi(async () => {
        const err = new Error("aborted");
        err.name = name;
        throw err;
      });
      const client = new WorkersAiLlmClient(ai, MODEL);

      const result = await client.complete({ prompt: "hi" });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.kind).toBe("timeout");
      expect(result.error.cause).toBeInstanceOf(Error);
    },
  );
});

describe("WorkersAiLlmClient.completeJson (Req 4.2, 4.5, design completeJson contract)", () => {
  const schema = z.object({ score: z.number(), label: z.string() });

  it("成功時はパース済みでスキーマ準拠の値を返す(型は schema から導出)", async () => {
    const ai = makeAi(async () => ({
      response: JSON.stringify({ score: 0.8, label: "good" }),
    }));
    const client = new WorkersAiLlmClient(ai, MODEL);

    const result = await client.completeJson({ prompt: "p" }, schema);

    expect(result).toEqual({ ok: true, value: { score: 0.8, label: "good" } });
    if (result.ok) {
      expectTypeOf(result.value).toEqualTypeOf<{ score: number; label: string }>();
    }
  });

  it("JSON Mode で response がオブジェクト(パース済み)の場合も検証して返す", async () => {
    // JSON Mode 有効時、Workers AI は response を文字列ではなくオブジェクトで返す。
    // JSON.parse を通さず、そのまま zod 検証へ渡して成功すること(回帰: invalid_output 化を防ぐ)。
    const ai = makeAi(async () => ({ response: { score: 0.8, label: "good" } }));
    const client = new WorkersAiLlmClient(ai, MODEL);

    const result = await client.completeJson({ prompt: "p" }, schema);

    expect(result).toEqual({ ok: true, value: { score: 0.8, label: "good" } });
  });

  it("response_format(json_schema)を付与して JSON Mode を要求する", async () => {
    const run = vi.fn(async () => ({
      response: JSON.stringify({ score: 0.8, label: "good" }),
    }));
    const client = new WorkersAiLlmClient(makeAi(run), MODEL);

    await client.completeJson({ prompt: "p" }, schema);

    const [, inputs] = run.mock.calls[0] as unknown as [string, Record<string, unknown>];
    const responseFormat = inputs.response_format as { type: string; json_schema: unknown };
    expect(responseFormat.type).toBe("json_schema");
    // zod スキーマ由来の JSON Schema(object)が同梱されていること。
    expect(responseFormat.json_schema).toBeTypeOf("object");
  });

  it("maxTokens 未指定の JSON 呼び出しは truncate 防止の既定 max_tokens を付与する", async () => {
    // 回帰: max_tokens 未指定だと Workers AI 既定値が小さく、複数項目の分類 JSON が truncate されて
    // JSON.parse 失敗 → invalid_output になる。JSON 経路では十分大きい既定が必ず渡ること。
    const run = vi.fn(async () => ({
      response: JSON.stringify({ score: 0.8, label: "good" }),
    }));
    const client = new WorkersAiLlmClient(makeAi(run), MODEL);

    await client.completeJson({ prompt: "p" }, schema);

    const [, inputs] = run.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(typeof inputs.max_tokens).toBe("number");
    expect(inputs.max_tokens as number).toBeGreaterThanOrEqual(2048);
  });

  it("maxTokens 明示指定時は呼び出し側の値を尊重する(既定で上書きしない)", async () => {
    const run = vi.fn(async () => ({
      response: JSON.stringify({ score: 0.8, label: "good" }),
    }));
    const client = new WorkersAiLlmClient(makeAi(run), MODEL);

    await client.completeJson({ prompt: "p", maxTokens: 128 }, schema);

    const [, inputs] = run.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(inputs.max_tokens).toBe(128);
  });

  it("complete(非 JSON)は response_format を付与しない", async () => {
    const run = vi.fn(async () => ({ response: "ok" }));
    const client = new WorkersAiLlmClient(makeAi(run), MODEL);

    await client.complete({ prompt: "p" });

    const [, inputs] = run.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(inputs.response_format).toBeUndefined();
  });

  it("JSON パース失敗時は invalid_output を返し cause に SyntaxError を載せる", async () => {
    const ai = makeAi(async () => ({ response: "not json{" }));
    const client = new WorkersAiLlmClient(ai, MODEL);

    const result = await client.completeJson({ prompt: "p" }, schema);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.kind).toBe("invalid_output");
    // JSON.parse 由来の診断情報(SyntaxError)が cause に伝播していること。
    expect(result.error.cause).toBeInstanceOf(SyntaxError);
  });

  // 構造化出力のパース失敗(invalid_output)の網羅。
  // 応答テキストが JSON にならない各種ケース(空 / 空白のみ / 途中で切れた JSON)を
  // いずれも invalid_output として表面化させること。
  it.each([
    ["空文字列", ""],
    ["空白のみ", "   \n  "],
    ["途中で切れた JSON", '{"score":0.8,'],
    ["閉じられていない配列", "[1, 2"],
  ])("不正な応答 (%s) は invalid_output を返す", async (_label, response) => {
    const ai = makeAi(async () => ({ response }));
    const client = new WorkersAiLlmClient(ai, MODEL);

    const result = await client.completeJson({ prompt: "p" }, schema);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.kind).toBe("invalid_output");
    expect(result.error.cause).toBeInstanceOf(SyntaxError);
  });

  // response フィールド欠落時も runText が "" にフォールバックし、
  // 結果として JSON パース失敗 → invalid_output になること。
  it("AI 応答に response が欠落する場合も invalid_output を返す", async () => {
    const ai = makeAi(async () => ({}));
    const client = new WorkersAiLlmClient(ai, MODEL);

    const result = await client.completeJson({ prompt: "p" }, schema);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.kind).toBe("invalid_output");
  });

  it("スキーマ不一致時は invalid_output を返し cause に zod issue を載せる", async () => {
    const ai = makeAi(async () => ({
      // score が文字列でスキーマに不一致。
      response: JSON.stringify({ score: "nope", label: 123 }),
    }));
    const client = new WorkersAiLlmClient(ai, MODEL);

    const result = await client.completeJson({ prompt: "p" }, schema);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.kind).toBe("invalid_output");
    expect(Array.isArray(result.error.cause)).toBe(true);
    expect((result.error.cause as unknown[]).length).toBeGreaterThan(0);
  });

  it("基盤呼び出し失敗時は provider_error として表面化する", async () => {
    const ai = makeAi(async () => {
      throw new Error("boom");
    });
    const client = new WorkersAiLlmClient(ai, MODEL);

    const result = await client.completeJson({ prompt: "p" }, schema);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.kind).toBe("provider_error");
  });

  // completeJson でも中断/タイムアウトは timeout として表面化すること(Req 4.5)。
  it("基盤呼び出しが TimeoutError で失敗した場合は timeout として表面化する", async () => {
    const ai = makeAi(async () => {
      const err = new Error("deadline exceeded");
      err.name = "TimeoutError";
      throw err;
    });
    const client = new WorkersAiLlmClient(ai, MODEL);

    const result = await client.completeJson({ prompt: "p" }, schema);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.kind).toBe("timeout");
  });
});

describe("createLlmClient factory (Req 4.4)", () => {
  it("LlmClient を実装したクライアントを返し、注入された AI を利用する", async () => {
    const run = vi.fn(async () => ({ response: "from factory" }));
    const env = { AI: makeAi(run) } as unknown as Env;

    const client = createLlmClient(env);

    expectTypeOf(client).toMatchTypeOf<LlmClient>();
    expect(typeof client.complete).toBe("function");
    expect(typeof client.completeJson).toBe("function");

    const result = await client.complete({ prompt: "p" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, value: "from factory" });
  });
});
