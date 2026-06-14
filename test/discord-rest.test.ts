import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  type DmOpenResult,
  editWebhookMessage,
  openDmChannel,
  sendChannelMessage,
  sendWebhookMessage,
} from "../src/discord/rest";
import type { DiscordEnv } from "../src/discord/env";
import type { SendResult } from "../src/discord/types";

// Discord REST クライアント(task 2.3)のユニットテスト (Req 4.2, 5.1, 5.4)。
//
// 方針: `globalThis.fetch` を `vi.fn()` で差し替え、各 REST 操作が
//  - 正しい URL(https://discord.com/api/v10 ベース)
//  - 正しい HTTP メソッド
//  - bot 認証経路では `Authorization: Bot {token}`、webhook 経路では Authorization なし
//  - 正しい JSON ボディ
// で fetch を呼ぶことを検証する。実ネットワークアクセスは行わない。
//
// 非 2xx 正規化: 403→forbidden、404→not_found、その他非 2xx→rest_error(status 付き)。
// DM open は成功時に channelId を返す専用結果型 {@link DmOpenResult} を持つ。

const BASE = "https://discord.com/api/v10";

/** テスト用の最小 DiscordEnv。REST クライアントが参照するのは bot token のみ。 */
const env = {
  DISCORD_BOT_TOKEN: "bot-token-xyz",
  DISCORD_APPLICATION_ID: "app-123",
  DISCORD_PUBLIC_KEY: "pubkey",
} as unknown as DiscordEnv;

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

describe("editWebhookMessage: webhook @original メッセージ編集(PATCH)", () => {
  it("正しい URL・メソッド・ボディで fetch を呼ぶ(webhook 経路は Authorization なし)", async () => {
    const fn = mockFetch(200);

    const result = await editWebhookMessage(env, "tok-abc", "本応答です");

    expect(result).toEqual({ ok: true });
    const { url, init } = callArgs(fn);
    expect(url).toBe(`${BASE}/webhooks/app-123/tok-abc/messages/@original`);
    expect(init.method).toBe("PATCH");
    // webhook 経路は token をパスに含むため bot Authorization を付与しない。
    expect(header(init, "authorization")).toBeUndefined();
    expect(header(init, "content-type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ content: "本応答です" });
  });

  it("ephemeral フラグ(64)をボディに反映する", async () => {
    const fn = mockFetch(200);

    await editWebhookMessage(env, "tok-abc", "本応答", { ephemeral: true });

    const { init } = callArgs(fn);
    expect(JSON.parse(init.body as string)).toEqual({ content: "本応答", flags: 64 });
  });

  it("403 を forbidden に正規化する", async () => {
    mockFetch(403);
    const result = await editWebhookMessage(env, "tok-abc", "x");
    expect(result).toEqual({ ok: false, reason: "forbidden", status: 403 });
  });

  it("404 を not_found に正規化する(token 失効等)", async () => {
    mockFetch(404);
    const result = await editWebhookMessage(env, "tok-abc", "x");
    expect(result).toEqual({ ok: false, reason: "not_found", status: 404 });
  });

  it("その他非 2xx を rest_error(status 付き)に正規化する", async () => {
    mockFetch(500);
    const result = await editWebhookMessage(env, "tok-abc", "x");
    expect(result).toEqual({ ok: false, reason: "rest_error", status: 500 });
  });

  it("429(レート制限)も MVP では rest_error として伝播する", async () => {
    mockFetch(429);
    const result = await editWebhookMessage(env, "tok-abc", "x");
    expect(result).toEqual({ ok: false, reason: "rest_error", status: 429 });
  });
});

describe("sendWebhookMessage: follow-up メッセージ送信(POST)", () => {
  it("正しい URL・メソッド・ボディで fetch を呼ぶ(webhook 経路は Authorization なし)", async () => {
    const fn = mockFetch(200);

    const result = await sendWebhookMessage(env, "tok-abc", "追加メッセージ");

    expect(result).toEqual({ ok: true });
    const { url, init } = callArgs(fn);
    expect(url).toBe(`${BASE}/webhooks/app-123/tok-abc`);
    expect(init.method).toBe("POST");
    expect(header(init, "authorization")).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({ content: "追加メッセージ" });
  });

  it("ephemeral フラグ(64)をボディに反映する", async () => {
    const fn = mockFetch(200);

    await sendWebhookMessage(env, "tok-abc", "x", { ephemeral: true });

    const { init } = callArgs(fn);
    expect(JSON.parse(init.body as string)).toEqual({ content: "x", flags: 64 });
  });

  it("403 を forbidden に正規化する", async () => {
    mockFetch(403);
    const result = await sendWebhookMessage(env, "tok-abc", "x");
    expect(result).toEqual({ ok: false, reason: "forbidden", status: 403 });
  });
});

describe("openDmChannel: DM チャンネル open(POST /users/@me/channels)", () => {
  it("bot Authorization 付きで正しい URL・ボディに fetch を呼び、成功時に channelId を返す", async () => {
    const fn = mockFetch(200, { id: "dm-chan-789" });

    const result = await openDmChannel(env, "user-555");

    expect(result).toEqual({ ok: true, channelId: "dm-chan-789" });
    const { url, init } = callArgs(fn);
    expect(url).toBe(`${BASE}/users/@me/channels`);
    expect(init.method).toBe("POST");
    // bot 認証経路は Authorization: Bot {token} を付与する。
    expect(header(init, "authorization")).toBe("Bot bot-token-xyz");
    expect(header(init, "content-type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ recipient_id: "user-555" });
  });

  it("成功結果は ok===true で channelId にナローイングできる(専用結果型)", async () => {
    mockFetch(200, { id: "dm-chan-789" });
    const result = await openDmChannel(env, "user-555");
    expectTypeOf(result).toEqualTypeOf<DmOpenResult>();
    if (result.ok) {
      expectTypeOf(result.channelId).toEqualTypeOf<string>();
      expect(result.channelId).toBe("dm-chan-789");
    } else {
      throw new Error("unreachable: result should narrow to ok branch");
    }
  });

  it("403(DM 不可)を forbidden に正規化する", async () => {
    mockFetch(403);
    const result = await openDmChannel(env, "user-555");
    expect(result).toEqual({ ok: false, reason: "forbidden", status: 403 });
  });

  it("その他非 2xx を rest_error に正規化する", async () => {
    mockFetch(500);
    const result = await openDmChannel(env, "user-555");
    expect(result).toEqual({ ok: false, reason: "rest_error", status: 500 });
  });
});

describe("sendChannelMessage: チャンネルメッセージ送信(POST /channels/{id}/messages)", () => {
  it("bot Authorization 付きで正しい URL・メソッド・ボディに fetch を呼ぶ", async () => {
    const fn = mockFetch(200);

    const result = await sendChannelMessage(env, "chan-999", "フォールバック送信");

    expect(result).toEqual({ ok: true });
    const { url, init } = callArgs(fn);
    expect(url).toBe(`${BASE}/channels/chan-999/messages`);
    expect(init.method).toBe("POST");
    expect(header(init, "authorization")).toBe("Bot bot-token-xyz");
    expect(JSON.parse(init.body as string)).toEqual({ content: "フォールバック送信" });
  });

  it("403 を forbidden に正規化する", async () => {
    mockFetch(403);
    const result = await sendChannelMessage(env, "chan-999", "x");
    expect(result).toEqual({ ok: false, reason: "forbidden", status: 403 });
  });

  it("404 を not_found に正規化する", async () => {
    mockFetch(404);
    const result = await sendChannelMessage(env, "chan-999", "x");
    expect(result).toEqual({ ok: false, reason: "not_found", status: 404 });
  });
});

describe("SendResult 型整合", () => {
  it("非 DM-open 操作は SendResult を返す(共通正規化)", async () => {
    mockFetch(200);
    const result: SendResult = await sendChannelMessage(env, "c", "x");
    expect(result.ok).toBe(true);
  });
});
