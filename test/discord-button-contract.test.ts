// message component button 契約の統合テスト(task 6.5 / Req 4.8, 4.9, 4.10, 4.11)。
//
// dispatch → response / followup → rest を貫通し、以下を一貫して検証する:
//  1. mode:"reply" + components で type4 応答の data.components に action row/button が含まれる(Req 4.8)
//  2. deferred の followup.editOriginal / send で webhook body に button が含まれる(Req 4.9)
//  3. button の custom_id を持つ type3 interaction が component handler へ振り分けられる(Req 4.10)
//
// 方針: 単体テスト群(6.2 response / 6.3 followup / 6.4 dispatch)が各層を個別に検証する
// のに対し、本統合テストは dispatchInteraction を起点に実際の応答ボディ / webhook 送信 /
// 振り分けを通しで確認する。`globalThis.fetch` をモックし、waitUntil 継続を手動駆動する。
// 実行環境: vitest projects の "node" プロジェクト(dispatch は workerd-safe な
// discord-interactions の runtime enum を用いるため、応答 type 値は本番と一致する)。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// dispatch は `./continuation`→`../agents/routing`(→ `agents` / `cloudflare:`)を推移的に
// import する。node プロジェクトでは `cloudflare:` ローダ非対応のため routing をモックして
// 鎖を断つ(本テストは deferred-persistent 経路を踏まないため benign stub で十分)。
vi.mock("../src/agents/routing", () => ({
  PRIMARY_CYCLE_KEY: "primary",
  getCycleAgent: vi.fn(async () => ({ scheduleDeferredContinuation: vi.fn(async () => {}) })),
}));

import { dispatchInteraction } from "../src/discord/dispatch";
import type { DiscordEnv } from "../src/discord/env";
import { registerHandler, resetDefaultRegistry } from "../src/discord/registry";
import type {
  Followup,
  HandlerResult,
  InteractionContext,
  InteractionHandler,
  MessageActionRow,
} from "../src/discord/types";

const BASE = "https://discord.com/api/v10";

/** dispatch → followup → rest が参照するのは application id のみ。 */
const env = {
  DISCORD_BOT_TOKEN: "bot-token-xyz",
  DISCORD_APPLICATION_ID: "app-123",
  DISCORD_PUBLIC_KEY: "pubkey",
} as unknown as DiscordEnv;

/** 確認ダイアログ相当の message 用 action row / button(下位機能が所有する想定)。 */
const confirmRow: MessageActionRow = {
  type: 1,
  components: [
    { type: 2, custom_id: "goal:confirm", label: "確定", style: 1 },
    { type: 2, custom_id: "goal:cancel", label: "取消", style: 4 },
  ],
};

/** waitUntil に登録された Promise を捕捉する fake ExecutionContext。 */
function fakeCtx(): { ctx: ExecutionContext; scheduled: Promise<unknown>[] } {
  const scheduled: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>): void {
      scheduled.push(p);
    },
    passThroughOnException(): void {},
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, scheduled };
}

/** 指定ステータス/ボディの Response を返す fetch モックを設定する。 */
function mockFetch(status: number, body: unknown = {}): ReturnType<typeof vi.fn> {
  const fn = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

/** ギルド文脈の command interaction(type2)payload。 */
function commandInteraction(name: string): unknown {
  return {
    id: "interaction-1",
    application_id: "app-123",
    type: 2,
    token: "tok-cmd",
    version: 1,
    guild_id: "guild-1",
    channel_id: "chan-1",
    member: { user: { id: "user-guild" } },
    data: { id: "cmd-id", name, type: 1 },
  };
}

/** button 押下による message component interaction(type3)payload。 */
function componentInteraction(customId: string): unknown {
  return {
    id: "interaction-2",
    application_id: "app-123",
    type: 3,
    token: "tok-comp",
    version: 1,
    guild_id: "guild-1",
    channel_id: "chan-1",
    member: { user: { id: "user-guild" } },
    data: { custom_id: customId, component_type: 2 },
  };
}

/** HandlerResult を返す固定ハンドラを作る。ctx を捕捉して文脈検証に使う。 */
function handlerReturning(result: HandlerResult): {
  handler: InteractionHandler;
  seen: { ctx: InteractionContext | null };
} {
  const seen: { ctx: InteractionContext | null } = { ctx: null };
  const handler: InteractionHandler = {
    handle(ctx) {
      seen.ctx = ctx;
      return result;
    },
  };
  return { handler, seen };
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  resetDefaultRegistry();
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("button 即時応答: reply + components → type4 data.components(Req 4.8)", () => {
  it("command ハンドラの reply に載せた button が type4 応答へ通しで反映される", async () => {
    const { handler } = handlerReturning({
      mode: "reply",
      content: "この目標で確定しますか?",
      components: [confirmRow],
    });
    registerHandler("command", "goal_confirm", handler);
    const { ctx } = fakeCtx();

    const res = await dispatchInteraction(commandInteraction("goal_confirm"), env, ctx);

    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.type).toBe(4); // CHANNEL_MESSAGE_WITH_SOURCE
    const data = body.data as Record<string, unknown>;
    expect(data.content).toBe("この目標で確定しますか?");
    expect(data.components).toEqual([confirmRow]);
    // action row(type1)内に button(type2)が含まれる。
    const rows = data.components as MessageActionRow[];
    expect(rows[0]?.type).toBe(1);
    expect(rows[0]?.components[0]?.type).toBe(2);
    expect(rows[0]?.components[0]?.custom_id).toBe("goal:confirm");
  });
});

describe("button follow-up: deferred → editOriginal / send で webhook body に button(Req 4.9)", () => {
  it("deferred の本応答(editOriginal)に button が含まれる(dispatch→waitUntil→followup→rest 通し)", async () => {
    const fn = mockFetch(200);
    const result: HandlerResult = {
      mode: "deferred",
      run: async (followup: Followup) => {
        await followup.editOriginal("処理が完了しました。続けますか?", { components: [confirmRow] });
      },
    };
    const { handler } = handlerReturning(result);
    registerHandler("command", "goal_async", handler);
    const { ctx, scheduled } = fakeCtx();

    const res = await dispatchInteraction(commandInteraction("goal_async"), env, ctx);

    // 初期応答は type5(button は初期応答ではなく follow-up へ載せる / design L373)。
    const initial = await bodyOf(res);
    expect(initial.type).toBe(5);

    // waitUntil 継続を駆動 → follow-up PATCH @original の webhook body に button が含まれる。
    await Promise.all(scheduled);
    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/webhooks/app-123/tok-cmd/messages/@original`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({
      content: "処理が完了しました。続けますか?",
      components: [confirmRow],
    });
  });

  it("追加 follow-up(send)にも button を載せられる", async () => {
    const fn = mockFetch(200);
    const result: HandlerResult = {
      mode: "deferred",
      run: async (followup: Followup) => {
        await followup.send("補足です", { components: [confirmRow] });
      },
    };
    const { handler } = handlerReturning(result);
    registerHandler("command", "goal_extra", handler);
    const { ctx, scheduled } = fakeCtx();

    await dispatchInteraction(commandInteraction("goal_extra"), env, ctx);
    await Promise.all(scheduled);

    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/webhooks/app-123/tok-cmd`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ content: "補足です", components: [confirmRow] });
  });
});

describe("button → component ディスパッチ: type3 が同一 custom_id 規約で戻る(Req 4.10, 4.11)", () => {
  it("reply に載せた button の custom_id を持つ type3 interaction が component handler へ振り分けられる", async () => {
    // 表示側(reply)で出した custom_id と同一値で押下 interaction(type3)が届く。
    const { handler, seen } = handlerReturning({
      mode: "reply",
      content: "確定しました",
      ephemeral: true,
    });
    registerHandler("component", "goal:confirm", handler);
    const { ctx } = fakeCtx();

    const res = await dispatchInteraction(componentInteraction("goal:confirm"), env, ctx);

    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.type).toBe(4);
    const c = seen.ctx as InteractionContext;
    expect(c.kind).toBe("component");
    expect(c.name).toBe("goal:confirm");
    expect(c.userId).toBe("user-guild");
  });

  it("未登録 custom_id の button 押下は判別可能なエラー応答(ephemeral)へ正規化される", async () => {
    const { ctx } = fakeCtx();

    const res = await dispatchInteraction(componentInteraction("goal:unregistered"), env, ctx);

    const data = (await bodyOf(res)).data as Record<string, unknown>;
    expect(data.flags).toBe(64);
    expect(typeof data.content).toBe("string");
  });
});
