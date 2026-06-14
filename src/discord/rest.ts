import type { DiscordEnv } from "./env";
import type { SendResult } from "./types";

/**
 * fetch ベースの薄い Discord REST クライアント (Req 4.2, 5.1, 5.4)。
 *
 * design.md §messaging「Discord REST Client」の通り、`fetch` + `Authorization: Bot {token}`
 * の最小ラッパとして以下の低レベル REST 操作を提供する:
 *  - webhook @original メッセージ編集(follow-up 本応答 / Req 4.2)
 *  - webhook follow-up メッセージ送信(Req 4.2)
 *  - DM チャンネル open(プロアクティブ送信の前段 / Req 5.1)
 *  - チャンネルメッセージ送信(DM / 個人用フォールバック先への送信 / Req 5.1, 5.4)
 *
 * 上位の followup.ts(task 2.4)/ proactive.ts(task 2.5)がこれらを利用する。
 * 本モジュールは依存方向の制約に従い `./env`・`./types` のみを参照し、followup /
 * proactive / dispatch を import しない(上方向 import 禁止)。
 *
 * 認証方針(Discord REST 仕様準拠):
 *  - webhook 実行 / 編集経路(`/webhooks/{application_id}/{interaction_token}`)は
 *    token がパスに含まれるため `Authorization` を付与しない。
 *  - bot 認証経路(`/users/@me/channels`・`/channels/{id}/messages`)は
 *    `Authorization: Bot {token}` を付与する。
 *
 * エラー方針: REST 失敗は例外を投げず、判別可能な {@link SendResult} へ正規化する
 *  - 403 → `forbidden`
 *  - 404 → `not_found`
 *  - その他非 2xx → `rest_error`(`status` を含む)
 * 429(レート制限)は MVP では `rest_error` として伝播する(高度なリトライは対象外 /
 * design.md §messaging Risks)。
 *
 * @discordjs/rest や full discord.js は使わず、`fetch` のみで実装する
 * (design.md §Technology Stack)。
 */

/** Discord REST API ベース URL(API v10)。 */
const API_BASE = "https://discord.com/api/v10";

/** Discord の ephemeral message flag(本人のみ可視 / Req 4.6 相当)。 */
const EPHEMERAL_FLAG = 64;

/** webhook / channel 送信の任意オプション。 */
export interface SendOptions {
  /** true のとき ephemeral(本人のみ可視)フラグ(64)をボディに付与する。 */
  readonly ephemeral?: boolean;
}

/**
 * DM チャンネル open の結果型 (Req 5.1)。
 *
 * {@link SendResult} は成功時に payload を持たないが、DM open は後続のメッセージ送信に
 * 必要なチャンネル ID を返す必要があるため、専用の結果型をローカル定義する。失敗側の
 * 形(`reason` / `status`)は {@link SendResult} の失敗変種と一致させ、呼び出し側の
 * 正規化処理を統一する。
 */
export type DmOpenResult =
  | { ok: true; channelId: string }
  | { ok: false; reason: "forbidden" | "not_found" | "rest_error"; status?: number };

/** メッセージ送信ボディ(content + 任意 ephemeral flag)。 */
interface MessageBody {
  content: string;
  flags?: number;
}

/** content と ephemeral オプションから Discord メッセージボディを組み立てる。 */
function messageBody(content: string, opts?: SendOptions): MessageBody {
  return opts?.ephemeral ? { content, flags: EPHEMERAL_FLAG } : { content };
}

/**
 * 非 2xx の HTTP ステータスを {@link SendResult} の失敗値へ正規化する。
 * 403→forbidden / 404→not_found / その他→rest_error(status 付き)。
 */
function normalizeFailure(status: number): Extract<SendResult, { ok: false }> {
  if (status === 403) {
    return { ok: false, reason: "forbidden", status };
  }
  if (status === 404) {
    return { ok: false, reason: "not_found", status };
  }
  return { ok: false, reason: "rest_error", status };
}

/** JSON ボディ付き REST 呼び出しを発行する。bot 認証経路では Authorization を付与する。 */
async function request(
  method: string,
  url: string,
  body: unknown,
  authToken?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (authToken !== undefined) {
    headers.authorization = `Bot ${authToken}`;
  }
  return fetch(url, {
    method,
    headers,
    body: JSON.stringify(body),
  });
}

/**
 * webhook の @original メッセージを編集して deferred の本応答を送る (Req 4.2)。
 *
 * `PATCH /webhooks/{application_id}/{interaction_token}/messages/@original`。webhook
 * 経路のため Authorization は付与しない。
 */
export async function editWebhookMessage(
  env: DiscordEnv,
  interactionToken: string,
  content: string,
  opts?: SendOptions,
): Promise<SendResult> {
  const url = `${API_BASE}/webhooks/${env.DISCORD_APPLICATION_ID}/${interactionToken}/messages/@original`;
  const res = await request("PATCH", url, messageBody(content, opts));
  return res.ok ? { ok: true } : normalizeFailure(res.status);
}

/**
 * 追加の follow-up メッセージを webhook 経由で送信する (Req 4.2)。
 *
 * `POST /webhooks/{application_id}/{interaction_token}`。webhook 経路のため
 * Authorization は付与しない。
 */
export async function sendWebhookMessage(
  env: DiscordEnv,
  interactionToken: string,
  content: string,
  opts?: SendOptions,
): Promise<SendResult> {
  const url = `${API_BASE}/webhooks/${env.DISCORD_APPLICATION_ID}/${interactionToken}`;
  const res = await request("POST", url, messageBody(content, opts));
  return res.ok ? { ok: true } : normalizeFailure(res.status);
}

/**
 * 対象ユーザーの DM チャンネルを open し、チャンネル ID を返す (Req 5.1, 5.4)。
 *
 * `POST /users/@me/channels`(body: `{ recipient_id }`)。bot 認証経路のため
 * `Authorization: Bot {token}` を付与する。成功時はレスポンスの `id` を
 * {@link DmOpenResult.channelId} として返し、後続のメッセージ送信に用いる。
 */
export async function openDmChannel(env: DiscordEnv, recipientId: string): Promise<DmOpenResult> {
  const url = `${API_BASE}/users/@me/channels`;
  const res = await request("POST", url, { recipient_id: recipientId }, env.DISCORD_BOT_TOKEN);
  if (!res.ok) {
    return normalizeFailure(res.status);
  }
  const channel = (await res.json()) as { id: string };
  return { ok: true, channelId: channel.id };
}

/**
 * 指定チャンネルへメッセージを送信する (Req 5.1, 5.4)。
 *
 * `POST /channels/{channel_id}/messages`(body: `{ content }`)。bot 認証経路のため
 * `Authorization: Bot {token}` を付与する。DM チャンネルおよび個人用フォールバック
 * チャンネルへの送信に用いる(送信先の限定は呼び出し側 proactive.ts が担保)。
 */
export async function sendChannelMessage(
  env: DiscordEnv,
  channelId: string,
  content: string,
  opts?: SendOptions,
): Promise<SendResult> {
  const url = `${API_BASE}/channels/${channelId}/messages`;
  const res = await request("POST", url, messageBody(content, opts), env.DISCORD_BOT_TOKEN);
  return res.ok ? { ok: true } : normalizeFailure(res.status);
}
