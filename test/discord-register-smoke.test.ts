import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v10";

import {
  commandDefinitions,
  registerCommandDefinition,
  resetCommandDefinitions,
} from "../src/discord/commands/definitions";
import { registerCommands } from "../src/discord/commands/register";

// コマンド登録スモークテスト (task 5.2 / Req 2.1, 2.2, 2.4)。
//
// 実行プロジェクト: "node"(registerCommands は fetch ベースの純粋ロジックのため)。
//
// 目的: 「集約点 → 登録スクリプト」の end-to-end 疎通をスモーク確認する。
// すなわち、下位スペックが registerCommandDefinition で集約点 commandDefinitions へ
// 追加した定義が、registerCommands(appId, botToken, commandDefinitions) を通じて
// モック fetch に対し bulk overwrite(PUT)登録として発行されることを、集約配列を
// 経由して end-to-end で示す。グローバル(Req 2.1, 2.2)とギルド(Req 2.4)の両経路を確認する。
//
// 既存の task 3.4 ユニットテスト(discord-command-register.test.ts)は register 単体の
// URL/method/認証/欠落エラーを網羅するが、本ファイルは「集約点へ追加 → その集約配列を
// そのまま register へ渡す」という統合疎通をスモーク観点で補完する(明示の definitions
// 配列ではなく集約点 commandDefinitions を流路にする点が固有)。

const BASE = "https://discord.com/api/v10";
const APP_ID = "smoke-app-1";
const BOT_TOKEN = "smoke-bot-token";

/** テスト用のサンプルコマンド定義。 */
function sampleDefinition(name: string): RESTPostAPIApplicationCommandsJSONBody {
  return { name, description: `${name} description` };
}

/** 200 を返す fetch モックを設定する(実ネットワークアクセスはしない)。 */
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
  // 集約点はモジュールスコープの共有状態なので、テスト独立性のため毎回初期化する。
  resetCommandDefinitions();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetCommandDefinitions();
});

describe("登録スモーク: 集約点 → register の end-to-end", () => {
  it("集約点に追加した定義が グローバル PUT へ bulk overwrite 登録される (Req 2.1, 2.2)", async () => {
    const fn = mockFetch();

    // 下位スペックが集約点へ自分の定義を追加する流れを再現する (Req 2.1)。
    registerCommandDefinition(sampleDefinition("cycle"));
    registerCommandDefinition(sampleDefinition("goal"));

    // 登録スクリプトは集約配列 commandDefinitions をそのまま読み取って登録する。
    const result = await registerCommands(APP_ID, BOT_TOKEN, commandDefinitions);

    expect(result).toEqual({ ok: true, scope: "global", count: 2 });

    const { url, init } = callArgs(fn);
    expect(url).toBe(`${BASE}/applications/${APP_ID}/commands`);
    // bulk overwrite は PUT(冪等登録 / Req 2.2)。
    expect(init.method).toBe("PUT");
    expect(header(init, "authorization")).toBe(`Bot ${BOT_TOKEN}`);
    // body は集約点へ追加した定義配列そのもの。
    expect(JSON.parse(init.body as string)).toEqual([
      sampleDefinition("cycle"),
      sampleDefinition("goal"),
    ]);
  });

  it("集約点に追加した定義が ギルド PUT へ bulk overwrite 登録される (Req 2.4)", async () => {
    const fn = mockFetch();

    registerCommandDefinition(sampleDefinition("status"));

    const result = await registerCommands(APP_ID, BOT_TOKEN, commandDefinitions, {
      guildId: "smoke-guild-7",
    });

    expect(result).toEqual({ ok: true, scope: "guild", count: 1 });

    const { url, init } = callArgs(fn);
    expect(url).toBe(`${BASE}/applications/${APP_ID}/guilds/smoke-guild-7/commands`);
    expect(init.method).toBe("PUT");
    expect(header(init, "authorization")).toBe(`Bot ${BOT_TOKEN}`);
    expect(JSON.parse(init.body as string)).toEqual([sampleDefinition("status")]);
  });
});
