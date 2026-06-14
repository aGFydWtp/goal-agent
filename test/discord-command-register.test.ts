import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v10";

import {
  commandDefinitions,
  registerCommandDefinition,
  resetCommandDefinitions,
} from "../src/discord/commands/definitions";
import { registerCommands } from "../src/discord/commands/register";

// コマンド登録スクリプト(task 3.4)のユニットテスト (Req 2.2, 2.3, 2.4)。
//
// 方針: `globalThis.fetch` を `vi.fn()` で差し替え、登録手段が
//  - 認証情報あり + guildId なし → グローバル PUT /applications/{appId}/commands
//  - guildId 指定 → ギルド PUT /applications/{appId}/guilds/{guildId}/commands
//  - body は集約コマンド定義配列(bulk overwrite による冪等登録)
//  - `Authorization: Bot {token}`、ベース URL discord.com/api/v10
// で fetch を呼ぶことを検証する。実ネットワークアクセスは行わない。
//
// 認証情報欠落(application id / bot token が空)時は fetch を一切呼ばず、
// 不足を示す判別可能なエラーを返す(何も登録しない / Req 2.3)。

const BASE = "https://discord.com/api/v10";

const APP_ID = "app-123";
const BOT_TOKEN = "bot-token-xyz";

/** テスト用のサンプルコマンド定義。 */
function sampleDefinition(name: string): RESTPostAPIApplicationCommandsJSONBody {
  return { name, description: `${name} description` };
}

/** 200 を返す fetch モックを設定する。 */
function mockFetch(status = 200, body: unknown = {}): ReturnType<typeof vi.fn> {
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
  resetCommandDefinitions();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetCommandDefinitions();
});

describe("registerCommands: グローバル登録(guildId なし)", () => {
  it("PUT /applications/{appId}/commands に Bot 認証付きで集約定義を bulk overwrite する", async () => {
    const fn = mockFetch();
    const definitions = [sampleDefinition("cycle"), sampleDefinition("goal")];

    const result = await registerCommands(APP_ID, BOT_TOKEN, definitions);

    expect(result).toEqual({ ok: true, scope: "global", count: 2 });
    const { url, init } = callArgs(fn);
    expect(url).toBe(`${BASE}/applications/${APP_ID}/commands`);
    // bulk overwrite は PUT で行う(冪等登録)。
    expect(init.method).toBe("PUT");
    expect(header(init, "authorization")).toBe(`Bot ${BOT_TOKEN}`);
    expect(header(init, "content-type")).toBe("application/json");
    // body は受け取ったコマンド定義配列そのもの。
    expect(JSON.parse(init.body as string)).toEqual(definitions);
  });

  it("集約点(commandDefinitions)に追加した定義をそのまま登録できる", async () => {
    const fn = mockFetch();
    registerCommandDefinition(sampleDefinition("status"));

    const result = await registerCommands(APP_ID, BOT_TOKEN, commandDefinitions);

    expect(result).toEqual({ ok: true, scope: "global", count: 1 });
    const { init } = callArgs(fn);
    expect(JSON.parse(init.body as string)).toEqual([sampleDefinition("status")]);
  });
});

describe("registerCommands: ギルド登録(guildId 指定 / Req 2.4)", () => {
  it("PUT /applications/{appId}/guilds/{guildId}/commands に bulk overwrite する", async () => {
    const fn = mockFetch();
    const definitions = [sampleDefinition("cycle")];

    const result = await registerCommands(APP_ID, BOT_TOKEN, definitions, {
      guildId: "guild-999",
    });

    expect(result).toEqual({ ok: true, scope: "guild", count: 1 });
    const { url, init } = callArgs(fn);
    expect(url).toBe(`${BASE}/applications/${APP_ID}/guilds/guild-999/commands`);
    expect(init.method).toBe("PUT");
    expect(header(init, "authorization")).toBe(`Bot ${BOT_TOKEN}`);
    expect(JSON.parse(init.body as string)).toEqual(definitions);
  });
});

describe("registerCommands: 認証情報欠落(Req 2.3)", () => {
  it("application id 欠落時は fetch を呼ばず missing_credentials エラーを返す", async () => {
    const fn = mockFetch();

    const result = await registerCommands("", BOT_TOKEN, [sampleDefinition("cycle")]);

    if (result.ok || result.reason !== "missing_credentials") {
      throw new Error("unreachable: should be missing_credentials failure");
    }
    expect(result.missing).toContain("DISCORD_APPLICATION_ID");
    // 何も登録しない: fetch を一切呼ばない。
    expect(fn).not.toHaveBeenCalled();
  });

  it("bot token 欠落時は fetch を呼ばず missing_credentials エラーを返す", async () => {
    const fn = mockFetch();

    const result = await registerCommands(APP_ID, "", [sampleDefinition("cycle")]);

    if (result.ok || result.reason !== "missing_credentials") {
      throw new Error("unreachable: should be missing_credentials failure");
    }
    expect(result.missing).toContain("DISCORD_BOT_TOKEN");
    expect(fn).not.toHaveBeenCalled();
  });

  it("両方欠落時は両方の不足を報告し fetch を呼ばない", async () => {
    const fn = mockFetch();

    const result = await registerCommands("", "", []);

    if (result.ok || result.reason !== "missing_credentials") {
      throw new Error("unreachable: should be missing_credentials failure");
    }
    expect(result.missing).toEqual(
      expect.arrayContaining(["DISCORD_APPLICATION_ID", "DISCORD_BOT_TOKEN"]),
    );
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("registerCommands: REST 失敗の正規化", () => {
  it("非 2xx 応答を rest_error(status 付き)に正規化する", async () => {
    mockFetch(500);

    const result = await registerCommands(APP_ID, BOT_TOKEN, [
      sampleDefinition("cycle"),
    ]);

    expect(result).toEqual({ ok: false, reason: "rest_error", status: 500 });
  });
});
