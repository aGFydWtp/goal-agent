import type { DiscordEnv } from "./env";
import { editWebhookMessage, sendWebhookMessage } from "./rest";
import type { Followup } from "./types";

/**
 * deferred ハンドラ向け follow-up 送信ユーティリティ (Req 4.2, 4.4)。
 *
 * design.md §messaging「followup.ts: editOriginal(PATCH @original)と
 * sendFollowup(POST)。失敗を判別可能に返す」の通り、本応答の編集と追加 follow-up の
 * 送信手段を {@link Followup} 契約として公開する。低レベル REST 操作は task 2.3 の
 * `./rest`(`editWebhookMessage` / `sendWebhookMessage`)へ委譲し、その正規化済み
 * {@link import("./types").SendResult} をそのまま返す:
 *  - editOriginal → `PATCH /webhooks/{application_id}/{interaction_token}/messages/@original`
 *  - send         → `POST /webhooks/{application_id}/{interaction_token}`
 *
 * 失敗判別: rest.ts の正規化により 403→forbidden、404→not_found、その他非 2xx→rest_error。
 * Discord は失効した interaction token への webhook 操作へ 404 を返すため、token 失効は
 * `not_found` として伝播する(完了状態 / Req 4.4)。送信は例外を投げず、結果値で判別する。
 *
 * 依存方向: 本モジュールは `./env`・`./rest`・`./types` のみを参照し、dispatch /
 * proactive を import しない(上方向 import 禁止 / design 依存方向)。
 *
 * 生成手段は dispatch の deferred 経路が利用する。application id は env から取得するため、
 * 生成に必要なのは env と interaction token のみ。生成した {@link Followup} を
 * `HandlerResult` の deferred 変種の `run` に渡すことで、ハンドラが本応答 / 失敗通知を送る。
 */

/**
 * 指定 interaction token に紐づく {@link Followup} を生成する (Req 4.2, 4.4)。
 *
 * dispatch の deferred 経路が初期応答(type5)後、`env` と当該 interaction の `token` から
 * 本関数で {@link Followup} を生成し、ハンドラの `run` に渡す。application id は
 * {@link DiscordEnv.DISCORD_APPLICATION_ID} から webhook URL 構築時に rest.ts が用いる。
 *
 * @param env Discord secrets を含む実行環境(application id を含む)。
 * @param interactionToken follow-up に用いる interaction token (Req 4.1)。
 */
export function createFollowup(env: DiscordEnv, interactionToken: string): Followup {
  return {
    editOriginal(content, opts) {
      return editWebhookMessage(env, interactionToken, content, opts);
    },
    send(content, opts) {
      return sendWebhookMessage(env, interactionToken, content, opts);
    },
  };
}
