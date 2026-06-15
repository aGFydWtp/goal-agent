import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DiscordEnv } from "../src/discord/env";
import { deliver } from "../src/notifications/delivery";
import type { SendResult } from "../src/discord/types";

// Delivery Orchestrator(task 4.1)の結合テスト (Req 2.3, 2.5, 5.3, 5.4, 6.1, 6.2, 6.3)。
//
// 方針: discord-gateway の実 `sendDirectMessage` を `deliver` 経由で駆動し、Discord REST 層
// (`globalThis.fetch`)のみをモックして DM open / 送信 / フォールバックの分岐を検証する。
// 403 フォールバック・REST 正規化は discord-gateway 所有のため再実装せず、実コードを通す。
// `discord-proactive.test.ts` で確立した fetch シーケンスモックの手法を踏襲する。
//
// 完了条件(タスク):
//  - DM 成功・フォールバック成功 → 成功結果 { ok: true }
//  - フォールバック無し 403 / REST 失敗 → 判別可能な失敗結果(例外を投げず処理継続)

const BASE = "https://discord.com/api/v10";

/** 1 回の fetch 呼び出しに対する応答仕様。 */
interface MockResponse {
  status: number;
  body?: unknown;
}

/**
 * 呼び出し順に応じて異なる Response を返す fetch モックを設定する。
 * responses[i] が i 回目の fetch 呼び出しに対応する。
 */
function mockFetchSequence(responses: MockResponse[]): ReturnType<typeof vi.fn> {
  let call = 0;
  const fn = vi.fn(async () => {
    const index = Math.min(call, responses.length - 1);
    const spec = responses[index];
    if (spec === undefined) {
      throw new Error("mockFetchSequence: responses must not be empty");
    }
    call += 1;
    return new Response(JSON.stringify(spec.body ?? {}), {
      status: spec.status,
      headers: { "content-type": "application/json" },
    });
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

/** n 回目(0 始まり)の fetch 呼び出し引数(url, init)を取り出す。 */
function callArgs(fn: ReturnType<typeof vi.fn>, index: number): { url: string; init: RequestInit } {
  const [url, init] = fn.mock.calls[index] as [string, RequestInit];
  return { url, init };
}

/**
 * テスト用の最小 DiscordEnv を生成する。`deliver` / `sendDirectMessage` が参照するのは
 * bot token と(任意の)フォールバックチャンネル ID のみ。
 */
function makeEnv(fallbackChannelId?: string): DiscordEnv {
  const base: Record<string, string> = {
    DISCORD_BOT_TOKEN: "bot-token-xyz",
    DISCORD_APPLICATION_ID: "app-123",
    DISCORD_PUBLIC_KEY: "pubkey",
  };
  if (fallbackChannelId !== undefined) {
    base.DISCORD_FALLBACK_CHANNEL_ID = fallbackChannelId;
  }
  return base as unknown as DiscordEnv;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("deliver: DM 成功 (Req 2.3, 6.1)", () => {
  it("DM open → DM 送信が 2xx のとき { ok: true } を返す", async () => {
    const fn = mockFetchSequence([
      { status: 200, body: { id: "dm-chan-1" } }, // open DM
      { status: 200 }, // send to DM
    ]);

    const result = await deliver(makeEnv(), "user-555", "こんにちは");

    expect(result).toEqual({ ok: true });
    // DM 経路に限定される(open + send の 2 リクエストのみ、公開チャンネルは叩かない)。
    expect(fn).toHaveBeenCalledTimes(2);
    expect(callArgs(fn, 0).url).toBe(`${BASE}/users/@me/channels`);
    expect(callArgs(fn, 1).url).toBe(`${BASE}/channels/dm-chan-1/messages`);
  });
});

describe("deliver: 403 + フォールバック成功 (Req 6.2, 5.4)", () => {
  it("DM 403 + DISCORD_FALLBACK_CHANNEL_ID 設定 + フォールバック 2xx のとき { ok: true }", async () => {
    const fn = mockFetchSequence([
      { status: 200, body: { id: "dm-chan-1" } }, // open DM
      { status: 403 }, // send to DM → forbidden
      { status: 200 }, // send to fallback
    ]);

    const result = await deliver(makeEnv("fallback-chan-9"), "user-555", "通知です");

    expect(result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(3);
    // フォールバックは env の個人用チャンネルに限定される(公開チャンネル宛送信をしない / Req 2.5, 5.4)。
    const fallback = callArgs(fn, 2);
    expect(fallback.url).toBe(`${BASE}/channels/fallback-chan-9/messages`);
    expect(JSON.parse(fallback.init.body as string)).toEqual({ content: "通知です" });
  });

  it("DISCORD_FALLBACK_CHANNEL_ID をフォールバック引数として送信ヘルパーへ渡す", async () => {
    // DM open 自体が 403 でもフォールバックへ切り替わることで、env の値が渡っていることを示す。
    const fn = mockFetchSequence([
      { status: 403 }, // open DM → forbidden
      { status: 200 }, // send to fallback
    ]);

    const result = await deliver(makeEnv("fallback-chan-77"), "user-555", "x");

    expect(result).toEqual({ ok: true });
    expect(callArgs(fn, 1).url).toBe(`${BASE}/channels/fallback-chan-77/messages`);
  });
});

describe("deliver: フォールバック無し 403 (Req 6.3)", () => {
  it("DM 403 でフォールバック未設定のとき forbidden を返し、失敗をログし、例外を投げない", async () => {
    const fn = mockFetchSequence([
      { status: 200, body: { id: "dm-chan-1" } }, // open DM
      { status: 403 }, // send to DM → forbidden
    ]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await deliver(makeEnv(), "user-555", "通知です");

    expect(result).toEqual({ ok: false, reason: "forbidden", status: 403 });
    // 失敗が判別可能にログされる(userId と reason を含む)。
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls[0]?.join(" ") ?? "";
    expect(logged).toContain("user-555");
    expect(logged).toContain("forbidden");
    // フォールバック送信は走らない(3 回目の fetch なし)。
    expect(fn).toHaveBeenCalledTimes(2);

    errorSpy.mockRestore();
  });
});

describe("deliver: REST 失敗 (Req 6.3)", () => {
  it("非 403 の REST エラー(500)は rest_error を判別可能に返し、例外を投げない", async () => {
    const fn = mockFetchSequence([
      { status: 200, body: { id: "dm-chan-1" } }, // open DM
      { status: 500 }, // send to DM → rest_error
    ]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await deliver(makeEnv("fallback-chan-9"), "user-555", "x");

    expect(result).toEqual({ ok: false, reason: "rest_error", status: 500 });
    // 403 ではないためフォールバックは行わない(送信ヘルパーの挙動)。
    expect(fn).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
  });

  it("結果は SendResult 型である(型整合)", async () => {
    mockFetchSequence([{ status: 200, body: { id: "dm-chan-1" } }, { status: 200 }]);
    const result: SendResult = await deliver(makeEnv(), "u", "x");
    expect(result.ok).toBe(true);
  });
});
