import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// interaction ディスパッチャ(task 3.2)のユニットテスト
// (Req 1.6, 3.1-3.5, 4.1-4.3, 4.7)。
//
// 方針:
//  - レジストリは `resetDefaultRegistry()` で各テスト前に初期化し、テスト間汚染を防ぐ。
//  - `ExecutionContext` は `waitUntil` のみを持つ fake を渡し、登録された Promise を
//    捕捉して deferred 経路の継続処理を手動駆動する(`node` プロジェクトで足りる)。
//  - follow-up の REST 送信は `globalThis.fetch` を `vi.fn()` で差し替えて検証する。
//
// 完了状態(tasks.md 3.2): command が対応ハンドラへ振り分けられ、deferred 経路で
// type5 即返→follow-up 送信、modal 経路で type9 が返り、未登録で判別可能エラーが
// 返ることを確認する。

const BASE = "https://discord.com/api/v10";

/** テスト用の最小 DiscordEnv。dispatch → followup → rest が参照するのは application id のみ。 */
const env = {
  DISCORD_BOT_TOKEN: "bot-token-xyz",
  DISCORD_APPLICATION_ID: "app-123",
  DISCORD_PUBLIC_KEY: "pubkey",
} as unknown as DiscordEnv;

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

/** DM 文脈の command interaction(type2)payload。 */
function dmCommandInteraction(name: string): unknown {
  return {
    id: "interaction-dm",
    application_id: "app-123",
    type: 2,
    token: "tok-dm",
    version: 1,
    channel_id: "dm-chan",
    user: { id: "user-dm" },
    data: { id: "cmd-id", name, type: 1 },
  };
}

/** component interaction(type3)payload。 */
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

/** modal submit interaction(type5)payload。 */
function modalSubmitInteraction(customId: string): unknown {
  return {
    id: "interaction-3",
    application_id: "app-123",
    type: 5,
    token: "tok-modal",
    version: 1,
    guild_id: "guild-1",
    channel_id: "chan-1",
    member: { user: { id: "user-guild" } },
    data: { custom_id: customId, components: [] },
  };
}

/** HandlerResult を返す固定ハンドラを作る。ctx を捕捉して文脈検証に使う。 */
function handlerReturning(
  result: HandlerResult | ((ctx: InteractionContext) => HandlerResult),
): { handler: InteractionHandler; seen: { ctx: InteractionContext | null } } {
  const seen: { ctx: InteractionContext | null } = { ctx: null };
  const handler: InteractionHandler = {
    handle(ctx) {
      seen.ctx = ctx;
      return typeof result === "function" ? result(ctx) : result;
    },
  };
  return { handler, seen };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  resetDefaultRegistry();
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("dispatchInteraction: command(type2)→ reply(type4)", () => {
  it("登録された command ハンドラへ振り分け、reply で type4 を返す", async () => {
    const { handler } = handlerReturning({ mode: "reply", content: "やあ" });
    registerHandler("command", "ping", handler);
    const { ctx } = fakeCtx();

    const res = await dispatchInteraction(commandInteraction("ping"), env, ctx);

    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.type).toBe(4); // CHANNEL_MESSAGE_WITH_SOURCE
    expect(body.data).toEqual({ content: "やあ" });
  });

  it("ephemeral reply は flag 64 を立てる", async () => {
    const { handler } = handlerReturning({ mode: "reply", content: "秘密", ephemeral: true });
    registerHandler("command", "secret", handler);
    const { ctx } = fakeCtx();

    const res = await dispatchInteraction(commandInteraction("secret"), env, ctx);
    const body = await bodyOf(res);
    expect(body.data).toEqual({ content: "秘密", flags: 64 });
  });
});

describe("dispatchInteraction: InteractionContext 構築(Req 3.5, 6.1)", () => {
  it("ギルド command の文脈を構築する(member.user.id / isDm=false)", async () => {
    const { handler, seen } = handlerReturning({ mode: "reply", content: "x" });
    registerHandler("command", "ctxcmd", handler);
    const { ctx } = fakeCtx();

    await dispatchInteraction(commandInteraction("ctxcmd"), env, ctx);

    expect(seen.ctx).not.toBeNull();
    const c = seen.ctx as InteractionContext;
    expect(c.kind).toBe("command");
    expect(c.name).toBe("ctxcmd");
    expect(c.userId).toBe("user-guild");
    expect(c.channelId).toBe("chan-1");
    expect(c.isDm).toBe(false);
    expect(c.interactionId).toBe("interaction-1");
    expect(c.token).toBe("tok-cmd");
  });

  it("DM command の文脈を構築する(user.id / isDm=true)", async () => {
    const { handler, seen } = handlerReturning({ mode: "reply", content: "x" });
    registerHandler("command", "dmcmd", handler);
    const { ctx } = fakeCtx();

    await dispatchInteraction(dmCommandInteraction("dmcmd"), env, ctx);

    const c = seen.ctx as InteractionContext;
    expect(c.userId).toBe("user-dm");
    expect(c.isDm).toBe(true);
    expect(c.channelId).toBe("dm-chan");
  });
});

describe("dispatchInteraction: deferred(type5)→ waitUntil → follow-up(Req 4.1-4.3)", () => {
  it("type5 を即返し、継続処理を waitUntil に登録する。継続は follow-up PATCH @original を呼ぶ", async () => {
    const fn = mockFetch(200);
    // run の開始を制御するためのゲート。dispatch が初期応答を返した時点では
    // 重い処理(follow-up)がまだ完了していないことを検証する。
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result: HandlerResult = {
      mode: "deferred",
      run: async (followup: Followup) => {
        await gate; // ゲートが開くまで重い処理を保留。
        await followup.editOriginal("重い処理の結果");
      },
    };
    const { handler } = handlerReturning(result);
    registerHandler("command", "slow", handler);
    const { ctx, scheduled } = fakeCtx();

    const res = await dispatchInteraction(commandInteraction("slow"), env, ctx);

    // 初期応答: type5 即返。継続(follow-up)はゲート保留中でまだ呼ばれていない。
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.type).toBe(5); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
    expect(fn).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);

    // waitUntil に登録された継続を駆動 → follow-up REST が呼ばれる。
    release();
    await Promise.all(scheduled);
    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/webhooks/app-123/tok-cmd/messages/@original`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ content: "重い処理の結果" });
  });

  it("ephemeral deferred は初期応答に flag 64 を立てる", async () => {
    mockFetch(200);
    const result: HandlerResult = {
      mode: "deferred",
      ephemeral: true,
      run: async () => {},
    };
    const { handler } = handlerReturning(result);
    registerHandler("command", "slowsecret", handler);
    const { ctx } = fakeCtx();

    const res = await dispatchInteraction(commandInteraction("slowsecret"), env, ctx);
    const body = await bodyOf(res);
    expect(body.type).toBe(5);
    expect(body.data).toEqual({ flags: 64 });
  });
});

describe("dispatchInteraction: modal(type9)→(Req 4.7)", () => {
  it("modal ハンドラは type9 を返し、customId/title/text input を payload に含む", async () => {
    const result: HandlerResult = {
      mode: "modal",
      customId: "checkin_modal",
      title: "チェックイン",
      components: [
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: "note",
              label: "メモ",
              style: 2,
            },
          ],
        },
      ],
    };
    const { handler } = handlerReturning(result);
    registerHandler("command", "checkin", handler);
    const { ctx } = fakeCtx();

    const res = await dispatchInteraction(commandInteraction("checkin"), env, ctx);

    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.type).toBe(9); // MODAL
    const data = body.data as Record<string, unknown>;
    expect(data.custom_id).toBe("checkin_modal");
    expect(data.title).toBe("チェックイン");
    expect(data.components).toEqual(result.components);
  });
});

describe("dispatchInteraction: reply に button を載せる配線(task 6.4, Req 4.8, 4.10)", () => {
  const row: MessageActionRow = {
    type: 1,
    components: [{ type: 2, custom_id: "btn:confirm", label: "確定", style: 1 }],
  };

  it("HandlerResult.components 付き reply を type4 応答の data.components へ反映する", async () => {
    const { handler } = handlerReturning({
      mode: "reply",
      content: "実行しますか?",
      components: [row],
    });
    registerHandler("command", "ask", handler);
    const { ctx } = fakeCtx();

    const res = await dispatchInteraction(commandInteraction("ask"), env, ctx);

    const body = await bodyOf(res);
    expect(body.type).toBe(4);
    const data = body.data as Record<string, unknown>;
    expect(data.content).toBe("実行しますか?");
    expect(data.components).toEqual([row]);
  });

  it("ephemeral + components 付き reply は flags(64)と components の双方を反映する", async () => {
    const { handler } = handlerReturning({
      mode: "reply",
      content: "本人のみ",
      ephemeral: true,
      components: [row],
    });
    registerHandler("command", "asksecret", handler);
    const { ctx } = fakeCtx();

    const res = await dispatchInteraction(commandInteraction("asksecret"), env, ctx);

    const data = (await bodyOf(res)).data as Record<string, unknown>;
    expect(data.flags).toBe(64);
    expect(data.components).toEqual([row]);
  });

  it("components 無し reply は data.components を出力しない(既存挙動維持)", async () => {
    const { handler } = handlerReturning({ mode: "reply", content: "ただの応答" });
    registerHandler("command", "plain", handler);
    const { ctx } = fakeCtx();

    const res = await dispatchInteraction(commandInteraction("plain"), env, ctx);
    const data = (await bodyOf(res)).data as Record<string, unknown>;
    expect(data.components).toBeUndefined();
  });

  it("button 押下(type3, 同一 custom_id)が既存 custom_id 規約で component handler へ戻る(Req 4.10)", async () => {
    // reply に載せた button の custom_id と同じ値で type3 interaction を送ると、
    // component handler へ振り分けられる(button 固有の業務判断はゲートウェイに無い)。
    const { handler, seen } = handlerReturning({ mode: "reply", content: "押された" });
    registerHandler("component", "btn:confirm", handler);
    const { ctx } = fakeCtx();

    const res = await dispatchInteraction(componentInteraction("btn:confirm"), env, ctx);

    const body = await bodyOf(res);
    expect(body.type).toBe(4);
    const c = seen.ctx as InteractionContext;
    expect(c.kind).toBe("component");
    expect(c.name).toBe("btn:confirm");
  });
});

describe("dispatchInteraction: component(type3)/ modal submit(type5)振り分け(Req 3.2, 3.3)", () => {
  it("component を custom_id でハンドラへ振り分ける(kind=component)", async () => {
    const { handler, seen } = handlerReturning({ mode: "reply", content: "押された" });
    registerHandler("component", "btn:confirm", handler);
    const { ctx } = fakeCtx();

    const res = await dispatchInteraction(componentInteraction("btn:confirm"), env, ctx);

    const body = await bodyOf(res);
    expect(body.type).toBe(4);
    const c = seen.ctx as InteractionContext;
    expect(c.kind).toBe("component");
    expect(c.name).toBe("btn:confirm");
  });

  it("modal submit を custom_id でハンドラへ振り分ける(kind=modal)", async () => {
    const { handler, seen } = handlerReturning({ mode: "reply", content: "提出された" });
    registerHandler("modal", "checkin_modal", handler);
    const { ctx } = fakeCtx();

    const res = await dispatchInteraction(modalSubmitInteraction("checkin_modal"), env, ctx);

    const body = await bodyOf(res);
    expect(body.type).toBe(4);
    const c = seen.ctx as InteractionContext;
    expect(c.kind).toBe("modal");
    expect(c.name).toBe("checkin_modal");
  });
});

describe("dispatchInteraction: 未登録ハンドラ(Req 3.4)", () => {
  it("未登録 command に対し判別可能なエラー応答(ephemeral type4)を返す", async () => {
    const { ctx } = fakeCtx();

    const res = await dispatchInteraction(commandInteraction("unknown"), env, ctx);

    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.type).toBe(4);
    const data = body.data as Record<string, unknown>;
    // ephemeral(個人データ露出なし)で「未対応」を示す。
    expect(data.flags).toBe(64);
    expect(typeof data.content).toBe("string");
    expect((data.content as string).length).toBeGreaterThan(0);
  });
});

describe("dispatchInteraction: ハンドラ例外の正規化", () => {
  it("ハンドラが例外を投げたら ephemeral エラー応答へ正規化する(個人データ露出なし)", async () => {
    const handler: InteractionHandler = {
      handle() {
        throw new Error("内部 user-id=user-guild の詳細");
      },
    };
    registerHandler("command", "boom", handler);
    const { ctx } = fakeCtx();

    const res = await dispatchInteraction(commandInteraction("boom"), env, ctx);

    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.type).toBe(4);
    const data = body.data as Record<string, unknown>;
    expect(data.flags).toBe(64);
    // 例外メッセージの生データ(個人 ID 等)を露出しない。
    expect(data.content as string).not.toContain("user-guild");
  });
});
