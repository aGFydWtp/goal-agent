import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerHandler, resetDefaultRegistry } from "../src/discord/registry";
import type {
  Followup,
  HandlerResult,
  InteractionContext,
  ModalActionRow,
} from "../src/discord/types";
import worker from "../src/index";

// 検証〜ディスパッチ統合テスト(task 5.1 / Req 1.6, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.7)。
//
// 実行プロジェクト: "workers"(Cloudflare Workers ランタイム / workerd + ExecutionContext)。
//
// 位置づけ(既存テストとの非重複):
//  - `test/discord-dispatch.test.ts` は `node` プロジェクトで dispatch を直接呼ぶユニット
//    テスト。CJS interop で動くため、discord-api-types enum 値の workerd 解決不具合
//    (Implementation Notes P0)を見逃し得る。
//  - `test/discord-worker-interactions.test.ts` は workers プロジェクトの署名込み統合だが、
//    PING/PONG・command→type4・command→modal type9・401・後方互換に限定される。
//  - 本ファイルは 5.1 が要求する以下の観点を、**署名済みリクエストを worker.fetch へ通す
//    完全経路**(署名検証 → ディスパッチ → 応答 / waitUntil 継続)で workerd 上で検証する:
//      * component(type3)/ modal submit(type5)の custom_id 振り分け(Req 3.2, 3.3)。
//      * deferred 経路の type5 即返 + waitUntil 完了後の follow-up PATCH @original(Req 4.1-4.3)。
//      * 即時応答(type4)が署名経路でも返ること(Req 4.x)。
//      * modal を開く type9 応答(customId/title/text input を含む)(Req 4.7)。
//      * 未登録 interaction の判別可能エラー応答(ephemeral)(Req 3.4)。
//      * InteractionContext 構築(userId/kind/name/isDm/channelId/token)がハンドラへ正しく
//        渡ること(Req 3.5, 6.1)。
//
// CONCERNS(設計判断): 「署名済み」要件と worker.fetch 疎通を重視し、index.ts 経由の
// 完全経路で検証する。deferred の follow-up 完了は createExecutionContext で生成した
// 実 ExecutionContext + waitOnExecutionContext(ctx) で待つ(fake ctx ではなく実 waitUntil
// を駆動する)。follow-up の REST 送信先は globalThis.fetch モックで観測する。

const ENDPOINT = "http://x/interactions";
const REST_BASE = "https://discord.com/api/v10";

// interaction type(payload)/ 応答 type の数値定数。enum 解決揺れを避けるため数値で固定する。
const RESP_CHANNEL_MESSAGE_WITH_SOURCE = 4;
const RESP_DEFERRED = 5;
const RESP_MODAL = 9;

/**
 * テスト用 Ed25519 鍵ペアを生成し、Discord 署名規約(timestamp || body の署名)に沿った
 * 署名生成器と公開鍵(raw 32 バイトの hex)を返す。`test/discord-worker-interactions.test.ts`
 * が確立したヘルパパターンを踏襲する。
 */
async function makeSigner(): Promise<{
  publicKeyHex: string;
  sign: (timestamp: string, body: string) => Promise<string>;
}> {
  const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;

  const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const publicKeyHex = [...rawPublic].map((b) => b.toString(16).padStart(2, "0")).join("");

  const encoder = new TextEncoder();
  const sign = async (timestamp: string, body: string): Promise<string> => {
    const message = encoder.encode(timestamp + body);
    const signature = new Uint8Array(
      await crypto.subtle.sign({ name: "Ed25519" }, keyPair.privateKey, message),
    );
    return [...signature].map((b) => b.toString(16).padStart(2, "0")).join("");
  };

  return { publicKeyHex, sign };
}

/** 署名済みリクエストを構築するヘルパ。payload を JSON 化し正しい署名ヘッダを付ける。 */
async function signedRequest(
  signer: Awaited<ReturnType<typeof makeSigner>>,
  payload: unknown,
): Promise<Request> {
  const timestamp = "1700000000";
  const body = JSON.stringify(payload);
  const signature = await signer.sign(timestamp, body);
  return new Request(ENDPOINT, {
    method: "POST",
    headers: {
      "X-Signature-Ed25519": signature,
      "X-Signature-Timestamp": timestamp,
    },
    body,
  });
}

/** ギルド文脈の command interaction(type2)payload。 */
function commandPayload(name: string): Record<string, unknown> {
  return {
    id: "interaction-cmd",
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

/** DM 文脈の command interaction(type2)payload(guild_id なし → isDm=true)。 */
function dmCommandPayload(name: string): Record<string, unknown> {
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

/** component interaction(type3)payload。識別子は data.custom_id。 */
function componentPayload(customId: string): Record<string, unknown> {
  return {
    id: "interaction-comp",
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

/** modal submit interaction(type5)payload。識別子は data.custom_id。 */
function modalSubmitPayload(customId: string): Record<string, unknown> {
  return {
    id: "interaction-modal",
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

const originalFetch = globalThis.fetch;

/** REST 送信観測用の fetch モックを設定する(常に 200 を返す)。 */
function mockRestFetch(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(
    async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

let signer: Awaited<ReturnType<typeof makeSigner>>;

beforeEach(async () => {
  resetDefaultRegistry();
  signer = await makeSigner();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** 署名済みリクエストを worker.fetch へ通し、実 ExecutionContext の継続完了まで待つ。 */
async function fetchSigned(
  payload: unknown,
  fetchEnv: typeof env = { ...env, DISCORD_PUBLIC_KEY: signer.publicKeyHex },
): Promise<{ res: Response; ctx: ExecutionContext }> {
  const req = await signedRequest(signer, payload);
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, fetchEnv, ctx);
  await waitOnExecutionContext(ctx);
  return { res, ctx };
}

describe("検証〜ディスパッチ統合: 種別振り分け(Req 1.6, 3.1-3.3, 3.5)", () => {
  it("署名済み command(type2)→ 対応ハンドラ → reply(type4)", async () => {
    registerHandler("command", "greet", {
      handle(ctx: InteractionContext): HandlerResult {
        return { mode: "reply", content: `hi ${ctx.userId}` };
      },
    });

    const { res } = await fetchSigned(commandPayload("greet"));

    expect(res.status).toBe(200);
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(RESP_CHANNEL_MESSAGE_WITH_SOURCE);
    expect(json.data.content).toBe("hi user-guild");
  });

  it("署名済み component(type3)→ custom_id で対応ハンドラへ振り分け(kind=component)", async () => {
    const seen: { ctx: InteractionContext | null } = { ctx: null };
    registerHandler("component", "btn:confirm", {
      handle(ctx: InteractionContext): HandlerResult {
        seen.ctx = ctx;
        return { mode: "reply", content: "確定" };
      },
    });

    const { res } = await fetchSigned(componentPayload("btn:confirm"));

    expect(res.status).toBe(200);
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(RESP_CHANNEL_MESSAGE_WITH_SOURCE);
    expect(json.data.content).toBe("確定");
    expect(seen.ctx).not.toBeNull();
    expect((seen.ctx as InteractionContext).kind).toBe("component");
    expect((seen.ctx as InteractionContext).name).toBe("btn:confirm");
  });

  it("署名済み modal submit(type5)→ custom_id で対応ハンドラへ振り分け(kind=modal)", async () => {
    const seen: { ctx: InteractionContext | null } = { ctx: null };
    registerHandler("modal", "checkin_modal", {
      handle(ctx: InteractionContext): HandlerResult {
        seen.ctx = ctx;
        return { mode: "reply", content: "提出済み" };
      },
    });

    const { res } = await fetchSigned(modalSubmitPayload("checkin_modal"));

    expect(res.status).toBe(200);
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(RESP_CHANNEL_MESSAGE_WITH_SOURCE);
    expect(json.data.content).toBe("提出済み");
    expect(seen.ctx).not.toBeNull();
    expect((seen.ctx as InteractionContext).kind).toBe("modal");
    expect((seen.ctx as InteractionContext).name).toBe("checkin_modal");
  });

  it("同名でも (kind,name) が異なれば別ハンドラへ振り分く(command vs component)", async () => {
    // 同一 name "dup" を command と component の双方に登録し、kind で正しく解決されることを示す。
    registerHandler("command", "dup", {
      handle(): HandlerResult {
        return { mode: "reply", content: "from-command" };
      },
    });
    registerHandler("component", "dup", {
      handle(): HandlerResult {
        return { mode: "reply", content: "from-component" };
      },
    });

    const cmd = await fetchSigned(commandPayload("dup"));
    const comp = await fetchSigned(componentPayload("dup"));

    const cmdJson = (await cmd.res.json()) as { data: { content: string } };
    const compJson = (await comp.res.json()) as { data: { content: string } };
    expect(cmdJson.data.content).toBe("from-command");
    expect(compJson.data.content).toBe("from-component");
  });
});

describe("検証〜ディスパッチ統合: InteractionContext 構築(Req 3.5, 6.1)", () => {
  it("ギルド command の文脈(member.user.id / isDm=false / channelId / token)を渡す", async () => {
    const seen: { ctx: InteractionContext | null } = { ctx: null };
    registerHandler("command", "ctxguild", {
      handle(ctx: InteractionContext): HandlerResult {
        seen.ctx = ctx;
        return { mode: "reply", content: "x" };
      },
    });

    await fetchSigned(commandPayload("ctxguild"));

    const c = seen.ctx as InteractionContext;
    expect(c).not.toBeNull();
    expect(c.kind).toBe("command");
    expect(c.name).toBe("ctxguild");
    expect(c.userId).toBe("user-guild");
    expect(c.isDm).toBe(false);
    expect(c.channelId).toBe("chan-1");
    expect(c.interactionId).toBe("interaction-cmd");
    expect(c.token).toBe("tok-cmd");
  });

  it("DM command の文脈(user.id / isDm=true)を渡す", async () => {
    const seen: { ctx: InteractionContext | null } = { ctx: null };
    registerHandler("command", "ctxdm", {
      handle(ctx: InteractionContext): HandlerResult {
        seen.ctx = ctx;
        return { mode: "reply", content: "x" };
      },
    });

    await fetchSigned(dmCommandPayload("ctxdm"));

    const c = seen.ctx as InteractionContext;
    expect(c.userId).toBe("user-dm");
    expect(c.isDm).toBe(true);
    expect(c.channelId).toBe("dm-chan");
  });
});

describe("検証〜ディスパッチ統合: deferred 経路(Req 4.1-4.3)", () => {
  it("deferred ハンドラ → type5 即返、waitUntil 完了後に follow-up PATCH @original が呼ばれる", async () => {
    const fn = mockRestFetch();
    // run の開始をゲートで制御し、初期応答が返った時点で follow-up が未呼出であることを検証する。
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    registerHandler("command", "slow", {
      handle(): HandlerResult {
        return {
          mode: "deferred",
          run: async (followup: Followup) => {
            await gate;
            await followup.editOriginal("重い処理の結果");
          },
        };
      },
    });

    const req = await signedRequest(signer, commandPayload("slow"));
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      req,
      { ...env, DISCORD_PUBLIC_KEY: signer.publicKeyHex, DISCORD_APPLICATION_ID: "app-123" },
      ctx,
    );

    // 初期応答: type5 即返。継続(follow-up)はゲート保留中でまだ呼ばれていない。
    expect(res.status).toBe(200);
    const json = (await res.json()) as { type: number };
    expect(json.type).toBe(RESP_DEFERRED);
    expect(fn).not.toHaveBeenCalled();

    // ゲートを開いて継続を完了させ、waitOnExecutionContext で waitUntil の完了を待つ。
    release();
    await waitOnExecutionContext(ctx);

    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${REST_BASE}/webhooks/app-123/tok-cmd/messages/@original`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ content: "重い処理の結果" });
  });

  it("ephemeral deferred は初期応答に flag 64 を立てる", async () => {
    mockRestFetch();
    registerHandler("command", "slowsecret", {
      handle(): HandlerResult {
        return { mode: "deferred", ephemeral: true, run: async () => {} };
      },
    });

    const { res } = await fetchSigned(commandPayload("slowsecret"), {
      ...env,
      DISCORD_PUBLIC_KEY: signer.publicKeyHex,
      DISCORD_APPLICATION_ID: "app-123",
    });

    const json = (await res.json()) as { type: number; data: { flags?: number } };
    expect(json.type).toBe(RESP_DEFERRED);
    expect(json.data.flags).toBe(64);
  });
});

describe("検証〜ディスパッチ統合: modal を開く(Req 4.7)", () => {
  it("modal ハンドラ → type9(MODAL)に customId/title/text input(action row 内)を含む", async () => {
    const components: ModalActionRow[] = [
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
    ];
    registerHandler("command", "open-modal", {
      handle(): HandlerResult {
        return { mode: "modal", customId: "checkin_modal", title: "チェックイン", components };
      },
    });

    const { res } = await fetchSigned(commandPayload("open-modal"));

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      type: number;
      data: { custom_id: string; title: string; components: ModalActionRow[] };
    };
    expect(json.type).toBe(RESP_MODAL);
    expect(json.data.custom_id).toBe("checkin_modal");
    expect(json.data.title).toBe("チェックイン");
    expect(json.data.components).toEqual(components);
    // text input(component type 4)が action row(type 1)内に含まれること。
    expect(json.data.components[0].type).toBe(1);
    expect(json.data.components[0].components[0].type).toBe(4);
    expect(json.data.components[0].components[0].custom_id).toBe("note");
  });
});

describe("検証〜ディスパッチ統合: 未登録 interaction(Req 3.4)", () => {
  it("未登録 command → 判別可能なエラー応答(ephemeral type4)を返す", async () => {
    const { res } = await fetchSigned(commandPayload("nonexistent"));

    expect(res.status).toBe(200);
    const json = (await res.json()) as { type: number; data: { content: string; flags?: number } };
    expect(json.type).toBe(RESP_CHANNEL_MESSAGE_WITH_SOURCE);
    // ephemeral(個人データ露出なし)で「未対応」を示す。
    expect(json.data.flags).toBe(64);
    expect(typeof json.data.content).toBe("string");
    expect(json.data.content.length).toBeGreaterThan(0);
  });

  it("未登録 component(type3)→ 判別可能なエラー応答を返す", async () => {
    const { res } = await fetchSigned(componentPayload("btn:unknown"));

    expect(res.status).toBe(200);
    const json = (await res.json()) as { type: number; data: { flags?: number } };
    expect(json.type).toBe(RESP_CHANNEL_MESSAGE_WITH_SOURCE);
    expect(json.data.flags).toBe(64);
  });
});
