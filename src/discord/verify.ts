import { verifyKey } from "discord-interactions";

/**
 * 署名検証の結果 (design.md §verify "Signature Verify" Service Interface L334-345)。
 *
 * - `ok: true` … 検証成功。`interaction` に raw body をパースしたオブジェクトを供給する。
 * - `ok: false` … 呼び出し元は 401 を返す (Req 1.2, 1.3)。`reason` で欠落と検証失敗を判別する。
 *   - `missing_headers` … signature または timestamp ヘッダが欠落 (Req 1.3)。
 *   - `invalid_signature` … 署名検証に失敗 (Req 1.2)。
 */
export type VerifyResult =
  | { ok: true; interaction: unknown }
  | { ok: false; reason: "missing_headers" | "invalid_signature" };

/**
 * Discord interactions リクエストの Ed25519 署名を検証する (Req 1.1, 1.2, 1.3, 1.5)。
 *
 * `X-Signature-Ed25519`(signature) / `X-Signature-Timestamp`(timestamp)ヘッダと
 * raw body を、`DISCORD_PUBLIC_KEY`(publicKey 引数)を用いて検証する。検証は
 * raw body に対して行い、パース後の再シリアライズは使わない(design Invariants)。
 * 成功時のみ raw body を JSON.parse して interaction を返す。
 *
 * publicKey は呼び出し元(Worker Entry)が env から供給する。本関数は env / response /
 * registry を参照せず、署名検証の責務のみを担う(依存方向: verify → discord-interactions)。
 *
 * @param rawBody 受信した生のボディ文字列(JSON パース前)。
 * @param signature `X-Signature-Ed25519` ヘッダ値。欠落時は null。
 * @param timestamp `X-Signature-Timestamp` ヘッダ値。欠落時は null。
 * @param publicKey Discord 公開鍵(hex 文字列。Req 1.5 の環境設定値)。
 */
export async function verifyInteraction(
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  publicKey: string,
): Promise<VerifyResult> {
  // ヘッダ欠落はハンドラ処理前に判別し、検証失敗と区別する (Req 1.3)。
  if (signature === null || timestamp === null) {
    return { ok: false, reason: "missing_headers" };
  }

  // discord-interactions の verifyKey は raw body・署名・timestamp・公開鍵(hex)を受け取り
  // Ed25519 検証結果を Promise<boolean> で返す。raw body をそのまま渡す(Invariants)。
  const isValid = await verifyKey(rawBody, signature, timestamp, publicKey);
  if (!isValid) {
    return { ok: false, reason: "invalid_signature" };
  }

  // 検証成功時のみ raw body をパースして interaction を供給する。
  return { ok: true, interaction: JSON.parse(rawBody) };
}
