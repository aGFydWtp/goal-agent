import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { createFollowup } from "../src/discord/followup";
import type { DiscordEnv } from "../src/discord/env";
import type { Followup, HandlerResult, SendResult } from "../src/discord/types";

// follow-up 送信ユーティリティ(task 2.4)のユニットテスト (Req 4.2, 4.4)。
//
// 方針: `globalThis.fetch` を `vi.fn()` で差し替え、`createFollowup` が生成する
// {@link Followup} の各操作が rest.ts の低レベル REST 操作を経由して
//  - editOriginal → PATCH /webhooks/{app}/{token}/messages/@original(本応答編集)
//  - send → POST /webhooks/{app}/{token}(追加 follow-up 送信)
// を正しい URL/メソッド/ボディで呼ぶことを検証する。実ネットワークアクセスは行わない。
//
// 失敗判別: rest.ts の正規化により 403→forbidden、404→not_found(token 失効)、
// その他非 2xx→rest_error が SendResult としてそのまま伝播することを確認する
// (完了状態: token 失効時に not_found を返す / Req 4.4)。

const BASE = "https://discord.com/api/v10";

/** テスト用の最小 DiscordEnv。followup → rest が参照するのは application id のみ。 */
const env = {
  DISCORD_BOT_TOKEN: "bot-token-xyz",
  DISCORD_APPLICATION_ID: "app-123",
  DISCORD_PUBLIC_KEY: "pubkey",
} as unknown as DiscordEnv;

const TOKEN = "interaction-token-abc";

/** 指定ステータス/ボディの Response を返す fetch モックを設定する。 */
function mockFetch(status: number, body: unknown = {}): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

/** fetch モックの呼び出し引数(url, init)を取り出す。 */
function callArgs(fn: ReturnType<typeof vi.fn>): { url: string; init: RequestInit } {
  const [url, init] = fn.mock.calls[0] as [string, RequestInit];
  return { url, init };
}

/** init.headers から指定ヘッダを正規化して取得(大小無視)。 */
function header(init: RequestInit, name: string): string | undefined {
  const headers = new Headers(init.headers);
  return headers.get(name) ?? undefined;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createFollowup: Followup インスタンス生成", () => {
  it("Followup 契約(editOriginal / send)に適合するインスタンスを返す", () => {
    const followup = createFollowup(env, TOKEN);
    expectTypeOf(followup).toEqualTypeOf<Followup>();
    expect(typeof followup.editOriginal).toBe("function");
    expect(typeof followup.send).toBe("function");
  });
});

describe("editOriginal: @original webhook 編集(PATCH)で本応答を送る", () => {
  it("正しい URL・メソッド・ボディで fetch を呼ぶ(webhook 経路は Authorization なし)", async () => {
    const fn = mockFetch(200);

    const result = await createFollowup(env, TOKEN).editOriginal("本応答です");

    expect(result).toEqual({ ok: true });
    const { url, init } = callArgs(fn);
    expect(url).toBe(`${BASE}/webhooks/app-123/${TOKEN}/messages/@original`);
    expect(init.method).toBe("PATCH");
    expect(header(init, "authorization")).toBeUndefined();
    expect(header(init, "content-type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ content: "本応答です" });
  });

  it("ephemeral オプションをボディの flag(64)へ反映する", async () => {
    const fn = mockFetch(200);

    await createFollowup(env, TOKEN).editOriginal("本応答", { ephemeral: true });

    const { init } = callArgs(fn);
    expect(JSON.parse(init.body as string)).toEqual({ content: "本応答", flags: 64 });
  });

  it("403 を forbidden に判別可能に返す", async () => {
    mockFetch(403);
    const result = await createFollowup(env, TOKEN).editOriginal("x");
    expect(result).toEqual({ ok: false, reason: "forbidden", status: 403 });
  });

  it("token 失効(404)を not_found に判別可能に返す", async () => {
    mockFetch(404);
    const result = await createFollowup(env, TOKEN).editOriginal("x");
    expect(result).toEqual({ ok: false, reason: "not_found", status: 404 });
  });

  it("その他非 2xx を rest_error(status 付き)に返す", async () => {
    mockFetch(500);
    const result = await createFollowup(env, TOKEN).editOriginal("x");
    expect(result).toEqual({ ok: false, reason: "rest_error", status: 500 });
  });
});

describe("send: 追加 follow-up 送信(POST)で失敗通知等を送る", () => {
  it("正しい URL・メソッド・ボディで fetch を呼ぶ(webhook 経路は Authorization なし)", async () => {
    const fn = mockFetch(200);

    const result = await createFollowup(env, TOKEN).send("処理に失敗しました");

    expect(result).toEqual({ ok: true });
    const { url, init } = callArgs(fn);
    expect(url).toBe(`${BASE}/webhooks/app-123/${TOKEN}`);
    expect(init.method).toBe("POST");
    expect(header(init, "authorization")).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({ content: "処理に失敗しました" });
  });

  it("ephemeral オプションをボディの flag(64)へ反映する", async () => {
    const fn = mockFetch(200);

    await createFollowup(env, TOKEN).send("通知", { ephemeral: true });

    const { init } = callArgs(fn);
    expect(JSON.parse(init.body as string)).toEqual({ content: "通知", flags: 64 });
  });

  it("token 失効(404)を not_found に判別可能に返す", async () => {
    mockFetch(404);
    const result = await createFollowup(env, TOKEN).send("x");
    expect(result).toEqual({ ok: false, reason: "not_found", status: 404 });
  });

  it("403 を forbidden に判別可能に返す", async () => {
    mockFetch(403);
    const result = await createFollowup(env, TOKEN).send("x");
    expect(result).toEqual({ ok: false, reason: "forbidden", status: 403 });
  });
});

describe("deferred 経路統合: run(followup) が本応答および失敗通知を送れる", () => {
  it("deferred の run に Followup を渡すと本応答(editOriginal)を送れる", async () => {
    const fn = mockFetch(200);

    // dispatch の deferred 経路を模した利用: HandlerResult.deferred の run へ
    // createFollowup の生成物を渡し、run 内で本応答を送る。
    const handlerResult: Extract<HandlerResult, { mode: "deferred" }> = {
      mode: "deferred",
      run: async (followup: Followup) => {
        const sent: SendResult = await followup.editOriginal("重い処理の結果");
        expect(sent).toEqual({ ok: true });
      },
    };

    await handlerResult.run(createFollowup(env, TOKEN));

    const { url, init } = callArgs(fn);
    expect(url).toBe(`${BASE}/webhooks/app-123/${TOKEN}/messages/@original`);
    expect(init.method).toBe("PATCH");
  });

  it("run 内で失敗通知(send)を送れ、token 失効時は not_found を伝播する", async () => {
    mockFetch(404);

    const run = async (followup: Followup): Promise<SendResult> =>
      followup.send("処理に失敗しました");

    const result = await run(createFollowup(env, TOKEN));
    expect(result).toEqual({ ok: false, reason: "not_found", status: 404 });
  });
});
