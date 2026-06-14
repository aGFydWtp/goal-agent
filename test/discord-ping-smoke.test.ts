import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

// PING スモークテスト (task 5.2 / Req 1.4)。
//
// 実行プロジェクト: "workers"(Cloudflare Workers ランタイム + ExecutionContext)。
//
// 目的: Discord 開発者ポータルの「Interactions Endpoint URL」登録時に Discord が行う
// 検証(正しい署名付き PING を送って PONG が返るか)相当の疎通を、実 worker.fetch 経路で
// スモーク確認する。これにより、署名検証 → PING 判定 → PONG 応答の一連が本番 workerd
// ランタイム上で成立することを保証する(enum 値が workerd で正しく解決される証跡も兼ねる)。
//
// 既存の task 4.1 統合テスト(discord-worker-interactions.test.ts)は PING/PONG に加え
// 署名不正・dispatch 委譲・後方互換を網羅するが、本ファイルは「エンドポイント登録検証
// 相当の疎通」というスモーク観点に絞り、正しい署名 + PING → 200 PONG の end-to-end を
// 単独の最小スモークとして固定する。

const ENDPOINT = "http://x/interactions";

// Discord プロトコル定数(数値リテラルで固定し、enum 解決の揺れに依存しない)。
const TYPE_PING = 1;
const RESP_PONG = 1;

/**
 * テスト用 Ed25519 鍵ペアを生成し、Discord 署名規約(`timestamp || body` の署名)に
 * 沿った署名生成器と raw 32 バイト公開鍵(hex)を返す。
 *
 * discord-interactions の verifyKey は raw hex 公開鍵を WebCrypto に import して
 * `timestamp + body` を検証するため、同一規約で署名すれば workerd 上で検証が成功する。
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

describe("PING スモーク: エンドポイント登録検証相当の疎通 (Req 1.4)", () => {
  it("正しい署名付き PING(type1)を送ると Worker が 200 で PONG(type1)を返す", async () => {
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

    // Discord はエンドポイント登録時に PONG(type1)JSON が 200 で返ることを要求する。
    expect(res.status).toBe(200);
    const json = (await res.json()) as { type: number };
    expect(json.type).toBe(RESP_PONG);
  });
});
