// Ed25519 署名検証(src/discord/verify.ts)の検証 (Req 1.1, 1.2, 1.3, 1.5 /
// design.md §verify "Signature Verify" Service Interface L314-349)。
//
// 完了条件(tasks 2.1): 正しい署名で検証成功し interaction をパースして返す、
// 改竄署名で `invalid_signature`、署名ヘッダ(signature または timestamp)欠落で
// `missing_headers` を返す。
//
// 本テストは discord-interactions の `verifyKey` をモックせず、Node の `node:crypto`
// で実際の Ed25519 鍵ペアを生成・署名し、本物の暗号検証が通る/落ちることを確認する。
// `verifyKey` は公開鍵を hex 文字列(raw 32byte)で受け取るため、生成した公開鍵の
// raw 値(JWK の `x` = base64url)を hex 化して渡す。
//
// 実行環境: vitest projects の "node" プロジェクト(純粋ロジック。globalThis.crypto.subtle
// を用いる discord-interactions の verifyKey を Node 上で実行する)。

import {
  type KeyObject,
  generateKeyPairSync,
  sign as nodeSign,
} from "node:crypto";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { verifyInteraction } from "../src/discord/verify";

/** Ed25519 鍵ペアを生成し、公開鍵を discord-interactions が要求する hex 文字列で返す。 */
function generateEd25519(): {
  publicKeyHex: string;
  privateKey: KeyObject;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // raw 公開鍵(32byte)を JWK の x(base64url)から取り出して hex 化する。
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  const publicKeyHex = Buffer.from(jwk.x, "base64url").toString("hex");
  return { publicKeyHex, privateKey };
}

/** Discord の署名規約(timestamp + body を結合して署名)に従い hex 署名を作る。 */
function signRequest(
  privateKey: KeyObject,
  timestamp: string,
  body: string,
): string {
  const message = Buffer.from(timestamp + body);
  return nodeSign(null, message, privateKey).toString("hex");
}

describe("verifyInteraction", () => {
  const timestamp = "1700000000";
  const interaction = { type: 1, id: "abc", application_id: "app" };
  const body = JSON.stringify(interaction);

  it("正しい署名で ok:true を返し interaction をパースして返す (Req 1.1)", async () => {
    const { publicKeyHex, privateKey } = generateEd25519();
    const signature = signRequest(privateKey, timestamp, body);

    const result = await verifyInteraction(
      body,
      signature,
      timestamp,
      publicKeyHex,
    );

    expect(result.ok).toBe(true);
    // ok:true の分岐でのみ interaction が供給される(パース済みオブジェクト)。
    if (result.ok) {
      expect(result.interaction).toEqual(interaction);
    }
  });

  it("改竄署名で invalid_signature を返す (Req 1.2)", async () => {
    const { publicKeyHex, privateKey } = generateEd25519();
    const valid = signRequest(privateKey, timestamp, body);
    // 末尾 hex を 1 文字差し替えて署名を改竄(長さ・hex 形式は維持)。
    const lastChar = valid.slice(-1);
    const tampered = valid.slice(0, -1) + (lastChar === "0" ? "1" : "0");

    const result = await verifyInteraction(
      body,
      tampered,
      timestamp,
      publicKeyHex,
    );

    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("別の鍵で署名された署名は invalid_signature を返す (Req 1.2)", async () => {
    const signer = generateEd25519();
    const other = generateEd25519();
    const signature = signRequest(signer.privateKey, timestamp, body);

    // 署名者とは別の公開鍵で検証 → 検証失敗。
    const result = await verifyInteraction(
      body,
      signature,
      timestamp,
      other.publicKeyHex,
    );

    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("signature ヘッダ欠落(null)で missing_headers を返す (Req 1.3)", async () => {
    const { publicKeyHex } = generateEd25519();

    const result = await verifyInteraction(body, null, timestamp, publicKeyHex);

    expect(result).toEqual({ ok: false, reason: "missing_headers" });
  });

  it("timestamp ヘッダ欠落(null)で missing_headers を返す (Req 1.3)", async () => {
    const { publicKeyHex, privateKey } = generateEd25519();
    const signature = signRequest(privateKey, timestamp, body);

    const result = await verifyInteraction(body, signature, null, publicKeyHex);

    expect(result).toEqual({ ok: false, reason: "missing_headers" });
  });

  it("両ヘッダ欠落(null)で missing_headers を返す (Req 1.3)", async () => {
    const { publicKeyHex } = generateEd25519();

    const result = await verifyInteraction(body, null, null, publicKeyHex);

    expect(result).toEqual({ ok: false, reason: "missing_headers" });
  });

  it("検証は raw body に対して行う(成功時のみ raw body をパースする / design Invariants)", async () => {
    const { publicKeyHex, privateKey } = generateEd25519();
    // 空白を含む raw body。再シリアライズすると署名と一致しなくなるため、
    // 検証が raw body に対して行われていることを担保する。
    const rawBody = `{ "type" : 1 , "id" : "x" }`;
    const signature = signRequest(privateKey, timestamp, rawBody);

    const result = await verifyInteraction(
      rawBody,
      signature,
      timestamp,
      publicKeyHex,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.interaction).toEqual({ type: 1, id: "x" });
    }
  });
});
