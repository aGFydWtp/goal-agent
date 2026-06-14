import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DiscordEnv } from "../src/discord/env";
import * as proactive from "../src/discord/proactive";
import { sendDirectMessage } from "../src/discord/proactive";
import type { SendResult } from "../src/discord/types";

// プロアクティブ送信ヘルパー(task 2.5)のユニットテスト (Req 5.1, 5.2, 5.3, 5.5, 6.3, 6.4)。
//
// 方針: `globalThis.fetch` を `vi.fn()` で差し替え、DM open → メッセージ送信のフローを
// 検証する。実ネットワークアクセスは行わない。design.md §プロアクティブ送信フローの通り:
//  1. POST /users/@me/channels(recipient_id)で DM チャンネルを open
//  2. POST /channels/{dmId}/messages へ送信
//  3. DM 送信(open または send)が 403 のとき:
//     - fallbackChannelId 指定あり → POST /channels/{fallback}/messages へ送信
//     - 未指定 → { ok:false, reason:"forbidden" } を返す
//  4. 403 以外の失敗(not_found / rest_error)はそのまま伝播する
//
// プライバシー境界(Req 5.5, 6.3, 6.4): 公開 API は sendDirectMessage のみで、任意の
// チャンネルへ送る汎用送信関数は export しない(task 5.3 が本格検証するが、ここでも
// export 面の最小性を構造で示す)。

const BASE = "https://discord.com/api/v10";

/** テスト用の最小 DiscordEnv。proactive が参照するのは bot token のみ。 */
const env = {
  DISCORD_BOT_TOKEN: "bot-token-xyz",
  DISCORD_APPLICATION_ID: "app-123",
  DISCORD_PUBLIC_KEY: "pubkey",
} as unknown as DiscordEnv;

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
function callArgs(
  fn: ReturnType<typeof vi.fn>,
  index: number,
): { url: string; init: RequestInit } {
  const [url, init] = fn.mock.calls[index] as [string, RequestInit];
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

describe("sendDirectMessage: DM 成功パス (Req 5.1)", () => {
  it("DM open → DM 送信の 2 リクエストを正しい URL/メソッド/ボディで発行し ok を返す", async () => {
    const fn = mockFetchSequence([
      { status: 200, body: { id: "dm-chan-1" } }, // open DM
      { status: 200 }, // send to DM
    ]);

    const result = await sendDirectMessage(env, "user-555", "こんにちは");

    expect(result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(2);

    // 1) DM open
    const open = callArgs(fn, 0);
    expect(open.url).toBe(`${BASE}/users/@me/channels`);
    expect(open.init.method).toBe("POST");
    expect(header(open.init, "authorization")).toBe("Bot bot-token-xyz");
    expect(JSON.parse(open.init.body as string)).toEqual({ recipient_id: "user-555" });

    // 2) DM 送信(open で得た channelId 宛)
    const send = callArgs(fn, 1);
    expect(send.url).toBe(`${BASE}/channels/dm-chan-1/messages`);
    expect(send.init.method).toBe("POST");
    expect(header(send.init, "authorization")).toBe("Bot bot-token-xyz");
    expect(JSON.parse(send.init.body as string)).toEqual({ content: "こんにちは" });
  });
});

describe("sendDirectMessage: 403 + fallback パス (Req 5.2, 5.5, 6.3)", () => {
  it("DM 送信が 403 のとき指定フォールバックチャンネルへ送信し ok を返す", async () => {
    const fn = mockFetchSequence([
      { status: 200, body: { id: "dm-chan-1" } }, // open DM
      { status: 403 }, // send to DM → forbidden
      { status: 200 }, // send to fallback
    ]);

    const result = await sendDirectMessage(env, "user-555", "通知です", "fallback-chan-9");

    expect(result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(3);

    // 3) フォールバックチャンネルへの送信
    const fallback = callArgs(fn, 2);
    expect(fallback.url).toBe(`${BASE}/channels/fallback-chan-9/messages`);
    expect(fallback.init.method).toBe("POST");
    expect(header(fallback.init, "authorization")).toBe("Bot bot-token-xyz");
    expect(JSON.parse(fallback.init.body as string)).toEqual({ content: "通知です" });
  });

  it("DM open 自体が 403 のときもフォールバックへ送信する(DM 不可は open でも生じうる)", async () => {
    const fn = mockFetchSequence([
      { status: 403 }, // open DM → forbidden
      { status: 200 }, // send to fallback
    ]);

    const result = await sendDirectMessage(env, "user-555", "通知です", "fallback-chan-9");

    expect(result).toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(2);
    const fallback = callArgs(fn, 1);
    expect(fallback.url).toBe(`${BASE}/channels/fallback-chan-9/messages`);
    expect(JSON.parse(fallback.init.body as string)).toEqual({ content: "通知です" });
  });
});

describe("sendDirectMessage: 403 + fallback 無し → forbidden (Req 5.3)", () => {
  it("DM 送信が 403 で fallback 未指定のとき forbidden を返す", async () => {
    const fn = mockFetchSequence([
      { status: 200, body: { id: "dm-chan-1" } }, // open DM
      { status: 403 }, // send to DM → forbidden
    ]);

    const result = await sendDirectMessage(env, "user-555", "通知です");

    expect(result).toEqual({ ok: false, reason: "forbidden", status: 403 });
    // フォールバック送信が走らない(3 回目の fetch が無い)ことを確認。
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("DM open が 403 で fallback 未指定のとき forbidden を返す", async () => {
    const fn = mockFetchSequence([
      { status: 403 }, // open DM → forbidden
    ]);

    const result = await sendDirectMessage(env, "user-555", "通知です");

    expect(result).toEqual({ ok: false, reason: "forbidden", status: 403 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("sendDirectMessage: 403 以外の失敗伝播 (Req 5.3)", () => {
  it("DM open の not_found(404)はフォールバックせずそのまま伝播する", async () => {
    const fn = mockFetchSequence([{ status: 404 }]);

    const result = await sendDirectMessage(env, "user-555", "x", "fallback-chan-9");

    expect(result).toEqual({ ok: false, reason: "not_found", status: 404 });
    // 403 ではないためフォールバック送信は行わない。
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("DM 送信の rest_error(500)はフォールバックせずそのまま伝播する", async () => {
    const fn = mockFetchSequence([
      { status: 200, body: { id: "dm-chan-1" } }, // open DM
      { status: 500 }, // send to DM → rest_error
    ]);

    const result = await sendDirectMessage(env, "user-555", "x", "fallback-chan-9");

    expect(result).toEqual({ ok: false, reason: "rest_error", status: 500 });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("フォールバック送信自体が失敗した場合はその失敗を判別可能に返す", async () => {
    const fn = mockFetchSequence([
      { status: 200, body: { id: "dm-chan-1" } }, // open DM
      { status: 403 }, // send to DM → forbidden
      { status: 404 }, // send to fallback → not_found
    ]);

    const result = await sendDirectMessage(env, "user-555", "x", "fallback-chan-9");

    expect(result).toEqual({ ok: false, reason: "not_found", status: 404 });
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe("sendDirectMessage: 型整合とプライバシー境界 (Req 5.5, 6.4)", () => {
  it("結果は SendResult 型である", async () => {
    mockFetchSequence([{ status: 200, body: { id: "dm-chan-1" } }, { status: 200 }]);
    const result: SendResult = await sendDirectMessage(env, "u", "x");
    expect(result.ok).toBe(true);
  });

  it("公開 API は sendDirectMessage のみで、任意チャンネルへの汎用送信関数を export しない", () => {
    // モジュールの export 面を最小に保つ(task 5.3 が本格検証する境界の構造的担保)。
    const exported = Object.keys(proactive).filter(
      (k) => typeof (proactive as Record<string, unknown>)[k] === "function",
    );
    expect(exported).toEqual(["sendDirectMessage"]);
    // 公開チャンネル/任意チャンネル送信を示唆する名前が露出していないこと。
    for (const name of Object.keys(proactive)) {
      expect(name).not.toMatch(/sendToChannel|sendChannel|publicChannel|broadcast/i);
    }
  });
});
