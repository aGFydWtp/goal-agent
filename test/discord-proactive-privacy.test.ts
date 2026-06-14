import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DiscordEnv } from "../src/discord/env";
import * as proactive from "../src/discord/proactive";
import { sendDirectMessage } from "../src/discord/proactive";

// プロアクティブ送信のプライバシー境界テスト (task 5.3 / Req 5.1, 5.2, 5.3, 5.5, 6.3, 6.4)。
//
// 観点: 2.5(test/discord-proactive.test.ts)が DM 成功・403 フォールバック・forbidden の
// 各「挙動」をユニット検証するのに対し、本テストは §15 / Req 5.5・6.3・6.4 の
// 「プライバシー境界の構造的強制」を主眼に置く。すなわち:
//
//  (A) 公開された送信経路が DM(/users/@me/channels open → /channels/{dmId}/messages)
//      および呼び出し元が個人用非公開チャンネルとして明示した fallbackChannelId へ送る
//      経路のみであり、それ以外の任意チャンネルへ向く fetch が一切発生しないこと
//      (全 fetch 呼び出しの宛先 URL を許可集合に対して網羅検証する)。
//  (B) 公開チャンネルへ任意送信できる汎用 API(sendToChannel / broadcast / sendPublic 等)を
//      proactive モジュールが export していないこと(export 面の集合検証 / Req 6.4)。
//  (C) 3 パス(DM 成功 / 403+fallback / 403 fallback 無し failure)が、いずれも上記の
//      宛先限定を破らないこと。
//
// 実ネットワークなし: globalThis.fetch を vi.fn() で差し替える。design.md §Security
// 「公開チャンネル宛の任意送信 API を公開しない」を構造で担保する。

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

/** fetch モックに記録された全呼び出しの宛先 URL を取り出す。 */
function requestedUrls(fn: ReturnType<typeof vi.fn>): string[] {
  return fn.mock.calls.map((args) => (args as [string, RequestInit])[0]);
}

/**
 * 与えられた URL がプライバシー境界上「許可された宛先」かを判定する。
 *
 * 許可するのは次の 2 種のみ:
 *  - DM チャンネル open: POST /users/@me/channels
 *  - チャンネルメッセージ送信: POST /channels/{id}/messages のうち、id が
 *    許可済みチャンネル集合(open で得た DM channelId、または明示 fallbackChannelId)に
 *    属するもの。
 *
 * これにより「呼び出し元が指定していない任意のチャンネル ID へ送る経路が存在しない」ことを
 * URL レベルで強制検証する。
 */
function assertUrlIsAllowed(url: string, allowedChannelIds: Set<string>): void {
  if (url === `${BASE}/users/@me/channels`) {
    return; // DM open は常に許可。
  }
  const match = url.match(
    /^https:\/\/discord\.com\/api\/v10\/channels\/([^/]+)\/messages$/,
  );
  expect(
    match,
    `予期しない送信先 URL(プライバシー境界違反の疑い): ${url}`,
  ).not.toBeNull();
  const channelId = match?.[1];
  expect(
    channelId !== undefined && allowedChannelIds.has(channelId),
    `許可されていないチャンネル ${channelId ?? "?"} へ送信している(許可: ${[
      ...allowedChannelIds,
    ].join(", ")})`,
  ).toBe(true);
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("プライバシー境界: 送信先 URL の限定 (Req 5.5, 6.3, 6.4)", () => {
  it("DM 成功パスでは DM open と DM channelId 宛のみへ fetch し、他チャンネルへ送らない", async () => {
    const fn = mockFetchSequence([
      { status: 200, body: { id: "dm-chan-1" } }, // open DM
      { status: 200 }, // send to DM
    ]);

    const result = await sendDirectMessage(env, "user-555", "個人評価データ");

    expect(result).toEqual({ ok: true });

    // DM open で得た channelId のみが許可宛先。fallback は無い。
    const allowed = new Set<string>(["dm-chan-1"]);
    for (const url of requestedUrls(fn)) {
      assertUrlIsAllowed(url, allowed);
    }
    // 公開チャンネル等、許可外チャンネルへの送信が 1 件も無いこと。
    expect(requestedUrls(fn)).toEqual([
      `${BASE}/users/@me/channels`,
      `${BASE}/channels/dm-chan-1/messages`,
    ]);
  });

  it("403+fallback パスでは DM open・DM channelId・明示 fallbackChannelId のみへ fetch する", async () => {
    const fn = mockFetchSequence([
      { status: 200, body: { id: "dm-chan-1" } }, // open DM
      { status: 403 }, // send to DM → forbidden
      { status: 200 }, // send to fallback
    ]);

    const result = await sendDirectMessage(
      env,
      "user-555",
      "個人評価データ",
      "personal-private-chan-9",
    );

    expect(result).toEqual({ ok: true });

    // 許可宛先 = DM channelId + 呼び出し元が明示した個人用非公開チャンネルのみ。
    const allowed = new Set<string>(["dm-chan-1", "personal-private-chan-9"]);
    for (const url of requestedUrls(fn)) {
      assertUrlIsAllowed(url, allowed);
    }
    // フォールバック先は呼び出し元指定の ID とちょうど一致し、それ以外の任意宛先が無い。
    expect(requestedUrls(fn)).toEqual([
      `${BASE}/users/@me/channels`,
      `${BASE}/channels/dm-chan-1/messages`,
      `${BASE}/channels/personal-private-chan-9/messages`,
    ]);
  });

  it("fallback 未指定の DM 不可(403)時は failure を返し、追加チャンネルへ送信しない", async () => {
    const fn = mockFetchSequence([
      { status: 200, body: { id: "dm-chan-1" } }, // open DM
      { status: 403 }, // send to DM → forbidden
    ]);

    const result = await sendDirectMessage(env, "user-555", "個人評価データ");

    // 呼び出し元が判別できる failure(Req 5.3)。公開チャンネルへの暗黙フォールバックは無い。
    expect(result).toEqual({ ok: false, reason: "forbidden", status: 403 });

    // DM 関連の 2 リクエストのみ。フォールバック先が無いので 3 件目の送信は発生しない。
    const allowed = new Set<string>(["dm-chan-1"]);
    for (const url of requestedUrls(fn)) {
      assertUrlIsAllowed(url, allowed);
    }
    expect(requestedUrls(fn)).toEqual([
      `${BASE}/users/@me/channels`,
      `${BASE}/channels/dm-chan-1/messages`,
    ]);
  });

  it("fallbackChannelId を渡しても DM が成功すれば fallback チャンネルへは一切送らない", async () => {
    // 「個人用非公開のはずの fallback 先であっても、不要な送信は行わない」= 最小宛先。
    const fn = mockFetchSequence([
      { status: 200, body: { id: "dm-chan-1" } }, // open DM
      { status: 200 }, // send to DM (成功)
    ]);

    const result = await sendDirectMessage(
      env,
      "user-555",
      "個人評価データ",
      "personal-private-chan-9",
    );

    expect(result).toEqual({ ok: true });
    // fallback 先 URL が呼ばれていないことを明示的に確認。
    expect(requestedUrls(fn)).not.toContain(
      `${BASE}/channels/personal-private-chan-9/messages`,
    );
    expect(requestedUrls(fn)).toEqual([
      `${BASE}/users/@me/channels`,
      `${BASE}/channels/dm-chan-1/messages`,
    ]);
  });
});

describe("プライバシー境界: 公開チャンネル送信 API の非露出 (Req 6.4)", () => {
  it("proactive の関数 export は sendDirectMessage のみで、汎用チャンネル送信を提供しない", () => {
    const functionExports = Object.keys(proactive).filter(
      (key) => typeof (proactive as Record<string, unknown>)[key] === "function",
    );
    // 公開された送信経路は DM 限定ヘルパー 1 つだけ。
    expect(functionExports).toEqual(["sendDirectMessage"]);
  });

  it("公開チャンネル/ブロードキャストを示唆する送信 API を export 名に持たない", () => {
    // 任意チャンネルや全体配信を可能にする汎用送信関数が露出していないことを構造で担保。
    const forbiddenPattern =
      /sendToChannel|sendChannel|sendPublic|publicChannel|broadcast|announce|sendMessage(?!.*direct)/i;
    for (const name of Object.keys(proactive)) {
      expect(
        forbiddenPattern.test(name),
        `禁止された汎用送信 API らしき export を検出: ${name}`,
      ).toBe(false);
    }
  });

  it("呼び出し元が channelId だけを指定して公開チャンネルへ送れる任意送信シグネチャを持たない", () => {
    // proactive の公開 API は (env, userId, content, fallbackChannelId?) のみ。
    // 第 2 引数は userId(DM 解決のための識別子)であって任意 channelId ではないため、
    // 「呼び出し元が宛先チャンネルを自由指定して公開チャンネルへ送る」経路は構造上存在しない。
    // ここでは公開 export 集合が sendDirectMessage のみであることを再確認することで、
    // channelId 起点の汎用送信関数が無いことを保証する。
    const exportedNames = Object.keys(proactive);
    expect(exportedNames).toContain("sendDirectMessage");
    const otherFunctions = exportedNames.filter(
      (key) =>
        key !== "sendDirectMessage" &&
        typeof (proactive as Record<string, unknown>)[key] === "function",
    );
    expect(otherFunctions).toEqual([]);
  });
});
