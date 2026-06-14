import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { registerHandler, resetDefaultRegistry } from "../src/discord/registry";
import type { HandlerResult, InteractionContext, ModalActionRow } from "../src/discord/types";
import worker from "../src/index";

// Discord interaction type / response type の数値定数(discord-api-types v10 と一致)。
// テストバンドルの enum 解決揺れを避けるため、payload/アサーションは数値リテラルで固定する。
const TYPE_PING = 1;
const TYPE_APPLICATION_COMMAND = 2;
const RESP_PONG = 1;
const RESP_CHANNEL_MESSAGE_WITH_SOURCE = 4;
const RESP_MODAL = 9;

// interactions パスの Worker エントリー統合テスト(Req 1.2, 1.3, 1.4, 1.6)。
//
// 実行プロジェクト: "workers"(Cloudflare Workers ランタイム + ExecutionContext)。
// index.ts は dispatch の deferred 継続で ctx.waitUntil を使うため、
// createExecutionContext で生成した ctx を fetch(request, env, ctx) に渡す。
//
// 検証内容:
//  - 署名ヘッダ欠落の POST /interactions → 401(Req 1.3、ハンドラ処理前)。
//  - 改竄署名(検証失敗)の POST /interactions → 401(Req 1.2)。
//  - 正しい署名 + PING(type1)→ PONG(type1)JSON(Req 1.4)。
//  - 正しい署名 + 非 PING(command type2)→ dispatch へ委譲され、登録ハンドラまで
//    実ディスパッチされて type4(CHANNEL_MESSAGE_WITH_SOURCE)応答が workerd 上で
//    返ること(Req 1.6: 委譲が実応答まで疎通 / response・dispatch が workerd で動作)。
//  - 正しい署名 + 非 PING(command type2)→ modal ハンドラへ実ディスパッチされて
//    type9(MODAL)応答が返ること(Req 4.7)。
//  - 既存の `/`・`/__health/wiring`・404 経路が回帰しないこと(後方互換)。

const ENDPOINT = "http://x/interactions";

/**
 * テスト用 Ed25519 鍵ペアを生成し、Discord 署名規約(timestamp || body の署名)に
 * 沿った署名生成器と、公開鍵(raw 32 バイトの hex)を返す。
 *
 * Discord/verifyKey は raw hex 公開鍵を WebCrypto に import して `timestamp+body` を
 * 検証するため、同一規約で署名すれば workers ランタイム上で検証が成功する。
 */
async function makeSigner(): Promise<{
  publicKeyHex: string;
  sign: (timestamp: string, body: string) => Promise<string>;
}> {
  const keyPair = (await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;

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

/** 検証済み非 PING(command type2)interaction の最小 payload を作る。 */
function commandPayload(name: string): Record<string, unknown> {
  return {
    id: "interaction-id",
    type: TYPE_APPLICATION_COMMAND,
    token: "interaction-token",
    data: { name },
    member: { user: { id: "user-1" } },
  };
}

describe("Worker エントリー: interactions パス", () => {
  beforeEach(() => {
    // テスト独立性のためデフォルトレジストリを毎回初期化する。
    resetDefaultRegistry();
  });

  it("署名ヘッダ欠落の POST /interactions は 401 を返す(Req 1.3)", async () => {
    const req = new Request(ENDPOINT, {
      method: "POST",
      body: JSON.stringify({ type: TYPE_PING }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });

  it("改竄署名の POST /interactions は 401 を返す(Req 1.2)", async () => {
    const { publicKeyHex } = await makeSigner();
    const body = JSON.stringify({ type: TYPE_PING });
    const req = new Request(ENDPOINT, {
      method: "POST",
      headers: {
        "X-Signature-Ed25519": "00".repeat(64),
        "X-Signature-Timestamp": "1700000000",
      },
      body,
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, { ...env, DISCORD_PUBLIC_KEY: publicKeyHex }, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });

  it("正しい署名 + PING(type1)は PONG(type1)JSON を返す(Req 1.4)", async () => {
    const { publicKeyHex, sign } = await makeSigner();
    const timestamp = "1700000000";
    const body = JSON.stringify({ type: TYPE_PING });
    const signature = await sign(timestamp, body);
    const req = new Request(ENDPOINT, {
      method: "POST",
      headers: {
        "X-Signature-Ed25519": signature,
        "X-Signature-Timestamp": timestamp,
      },
      body,
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, { ...env, DISCORD_PUBLIC_KEY: publicKeyHex }, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { type: number };
    expect(json.type).toBe(RESP_PONG);
  });

  it("正しい署名 + 非 PING(command)は登録ハンドラへ実ディスパッチされ type4 を返す(Req 1.6)", async () => {
    // command ハンドラを登録(即時 reply 応答)。dispatch/response が workerd 上で
    // 正常動作することを、type4 応答が返ることで実証する(enum 値の workerd 解決の証跡)。
    registerHandler("command", "ping-cmd", {
      handle(ctx: InteractionContext): HandlerResult {
        return { mode: "reply", content: `hello ${ctx.userId}` };
      },
    });

    const { publicKeyHex, sign } = await makeSigner();
    const timestamp = "1700000000";
    const body = JSON.stringify(commandPayload("ping-cmd"));
    const signature = await sign(timestamp, body);
    const req = new Request(ENDPOINT, {
      method: "POST",
      headers: {
        "X-Signature-Ed25519": signature,
        "X-Signature-Timestamp": timestamp,
      },
      body,
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, { ...env, DISCORD_PUBLIC_KEY: publicKeyHex }, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(RESP_CHANNEL_MESSAGE_WITH_SOURCE);
    expect(json.data.content).toBe("hello user-1");
  });

  it("正しい署名 + 非 PING(command)は modal ハンドラへ実ディスパッチされ type9 を返す(Req 4.7)", async () => {
    const components: ModalActionRow[] = [
      {
        type: 1,
        components: [{ type: 4, custom_id: "field", label: "ラベル", style: 1 }],
      },
    ];
    registerHandler("command", "open-modal", {
      handle(): HandlerResult {
        return { mode: "modal", customId: "modal-id", title: "タイトル", components };
      },
    });

    const { publicKeyHex, sign } = await makeSigner();
    const timestamp = "1700000000";
    const body = JSON.stringify(commandPayload("open-modal"));
    const signature = await sign(timestamp, body);
    const req = new Request(ENDPOINT, {
      method: "POST",
      headers: {
        "X-Signature-Ed25519": signature,
        "X-Signature-Timestamp": timestamp,
      },
      body,
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, { ...env, DISCORD_PUBLIC_KEY: publicKeyHex }, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const json = (await res.json()) as { type: number; data: { custom_id: string } };
    expect(json.type).toBe(RESP_MODAL);
    expect(json.data.custom_id).toBe("modal-id");
  });
});

describe("Worker エントリー: 既存経路の後方互換", () => {
  it("GET / は 200 を維持する", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://x/"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
  });

  it("GET /__health/wiring は 200 を維持する", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://x/__health/wiring"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
  });

  it("未知パスは 404 を維持する", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://x/unknown"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
  });
});
