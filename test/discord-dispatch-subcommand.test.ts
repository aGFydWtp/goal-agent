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
import type { HandlerResult, InteractionContext, InteractionHandler } from "../src/discord/types";

// command + subcommand 解決のユニットテスト
// (discord-gateway dispatch: command の最具体優先・後方互換フォールバック)。
//
// 方針:
//  - レジストリは `resetDefaultRegistry()` で各テスト前に初期化し、テスト間汚染を防ぐ。
//  - dispatcher は command interaction について、まず結合キー `"<top-level> <subcommand>"`
//    (例 `"goal status"`)でハンドラを照合し、未登録なら top-level キー(例 `"goal"`)へ
//    フォールバックする。既存挙動(top-level のみ)を壊さないことを検証する。
//  - subcommand は data.options[0] の type が 1(Subcommand)または 2(SubcommandGroup)の
//    ときのその name(first-level)を用いる。

/** テスト用の最小 DiscordEnv。本テストは reply 経路のみ用いるため値の中身は参照されない。 */
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

/**
 * ギルド文脈の command interaction(type2)payload。`options` を渡すと slash command の
 * options(subcommand 等)として data.options に載せる。
 */
function commandInteraction(name: string, options?: { type: number; name: string }[]): unknown {
  const data: Record<string, unknown> = { id: "cmd-id", name, type: 1 };
  if (options !== undefined) {
    data.options = options;
  }
  return {
    id: "interaction-1",
    application_id: "app-123",
    type: 2,
    token: "tok-cmd",
    version: 1,
    guild_id: "guild-1",
    channel_id: "chan-1",
    member: { user: { id: "user-guild" } },
    data,
  };
}

/** content を返す固定 reply ハンドラを作る。ctx を捕捉して文脈検証に使う。 */
function replyHandler(content: string): {
  handler: InteractionHandler;
  seen: { ctx: InteractionContext | null };
} {
  const seen: { ctx: InteractionContext | null } = { ctx: null };
  const handler: InteractionHandler = {
    handle(ctx): HandlerResult {
      seen.ctx = ctx;
      return { mode: "reply", content };
    },
  };
  return { handler, seen };
}

async function contentOf(res: Response): Promise<string> {
  const body = (await res.json()) as { data?: { content?: unknown } };
  return String(body.data?.content);
}

beforeEach(() => {
  resetDefaultRegistry();
});

afterEach(() => {
  resetDefaultRegistry();
});

describe("dispatchInteraction: command + subcommand 解決(最具体優先)", () => {
  it("`(command, 'goal status')` 登録時、/goal status(options=[{type:1,name:'status'}])は結合キーへ振り分ける", async () => {
    const { handler } = replyHandler("status-handler");
    registerHandler("command", "goal status", handler);
    const { ctx } = fakeCtx();

    const res = await dispatchInteraction(
      commandInteraction("goal", [{ type: 1, name: "status" }]),
      env,
      ctx,
    );

    expect(await contentOf(res)).toBe("status-handler");
  });

  it("結合キー未登録時、/goal add(options=[{type:1,name:'add'}])は top-level 'goal' へフォールバックする", async () => {
    const { handler } = replyHandler("goal-toplevel");
    registerHandler("command", "goal", handler);
    const { ctx } = fakeCtx();

    const res = await dispatchInteraction(
      commandInteraction("goal", [{ type: 1, name: "add" }]),
      env,
      ctx,
    );

    expect(await contentOf(res)).toBe("goal-toplevel");
  });

  it("subcommand 無しの /status は top-level 'status' へ解決する", async () => {
    const { handler } = replyHandler("status-toplevel");
    registerHandler("command", "status", handler);
    const { ctx } = fakeCtx();

    const res = await dispatchInteraction(commandInteraction("status"), env, ctx);

    expect(await contentOf(res)).toBe("status-toplevel");
  });

  it("'goal' と 'goal status' の双方が登録済みなら、/goal status は具体・/goal add は top-level に当たる", async () => {
    const { handler: top } = replyHandler("goal-toplevel");
    const { handler: specific } = replyHandler("goal-status-specific");
    registerHandler("command", "goal", top);
    registerHandler("command", "goal status", specific);
    const { ctx } = fakeCtx();

    const resStatus = await dispatchInteraction(
      commandInteraction("goal", [{ type: 1, name: "status" }]),
      env,
      ctx,
    );
    const resAdd = await dispatchInteraction(
      commandInteraction("goal", [{ type: 1, name: "add" }]),
      env,
      ctx,
    );

    expect(await contentOf(resStatus)).toBe("goal-status-specific");
    expect(await contentOf(resAdd)).toBe("goal-toplevel");
  });

  it("結合キーへ振り分けても ctx.name は top-level 名(例 'goal')のままである", async () => {
    const { handler, seen } = replyHandler("status-handler");
    registerHandler("command", "goal status", handler);
    const { ctx } = fakeCtx();

    await dispatchInteraction(commandInteraction("goal", [{ type: 1, name: "status" }]), env, ctx);

    expect(seen.ctx).not.toBeNull();
    expect((seen.ctx as InteractionContext).name).toBe("goal");
  });

  it("SubcommandGroup(type:2)も first-level 名で結合キーへ振り分ける", async () => {
    const { handler } = replyHandler("group-handler");
    registerHandler("command", "evidence list", handler);
    const { ctx } = fakeCtx();

    const res = await dispatchInteraction(
      commandInteraction("evidence", [{ type: 2, name: "list" }]),
      env,
      ctx,
    );

    expect(await contentOf(res)).toBe("group-handler");
  });
});
