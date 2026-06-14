import type { DiscordEnv } from "./env";
import { openDmChannel, sendChannelMessage } from "./rest";
import type { SendResult } from "./types";

/**
 * プロアクティブ送信ヘルパー (Req 5.1, 5.2, 5.3, 5.5, 6.3, 6.4)。
 *
 * design.md §messaging「proactive.ts: DM open→送信→403 で個人用フォールバック
 * チャンネル→未指定時は失敗返却。公開チャンネル宛任意送信を公開しない」および
 * §System Flows「プロアクティブ送信フロー(DM → フォールバック)」の通り、interaction
 * 以外の契機(週次通知・アラート等)で対象ユーザーへメッセージを届ける手段を提供する。
 *
 * フロー:
 *  1. {@link openDmChannel} で対象ユーザーの DM チャンネルを open(Req 5.1)。
 *  2. 得た channelId へ {@link sendChannelMessage} で送信(Req 5.1)。
 *  3. DM 送信(open または send)が 403(forbidden / DM 不可)のとき:
 *     - `fallbackChannelId` 指定あり → そのチャンネルへ送信(Req 5.2)。
 *     - 未指定 → `forbidden` を判別可能に返す(Req 5.3)。
 *  4. 403 以外の失敗(not_found / rest_error)はフォールバックせずそのまま伝播する。
 *
 * 403 の扱い: design 図は DM 送信(send)での 403 を扱うが、DM 不可は DM チャンネル
 * open(`POST /users/@me/channels`)でも 403 として現れうる。いずれも「DM が届けられない」
 * という同一意味を持つため、open / send どちらの 403 でも同様にフォールバック判定する。
 *
 * プライバシー境界(Req 5.5, 6.3, 6.4 / §Security):送信先は DM、または呼び出し元が
 * 個人用非公開チャンネルとして渡す `fallbackChannelId` に限定する。本モジュールは
 * {@link sendDirectMessage} のみを公開し、公開チャンネルや任意のチャンネルへ送る汎用
 * 送信関数を export しない。低レベルの {@link sendChannelMessage} は `./rest` 側の関数で
 * あり、本ヘルパー経由では DM / 指定フォールバック以外の宛先には用いられない。
 *
 * 依存方向: 本モジュールは `./env`・`./rest`・`./types` のみを参照し、dispatch /
 * followup を import しない(上方向 import 禁止 / design 依存方向)。
 *
 * 失敗は例外を投げず、正規化済みの {@link SendResult} として返す(rest.ts の正規化を継承:
 * 403→forbidden、404→not_found、その他非 2xx→rest_error)。
 */

/**
 * 対象ユーザーへプロアクティブにメッセージを送信する (Req 5.1, 5.2, 5.3)。
 *
 * DM チャンネルを open して送信し、DM 不可(403)時は `fallbackChannelId` 指定があれば
 * 個人用フォールバックチャンネルへ送信する。フォールバック未指定の DM 失敗時は
 * `forbidden` を返す。403 以外の失敗はそのまま伝播する。
 *
 * @param env Discord secrets を含む実行環境(bot token を含む / Req 5.4)。
 * @param userId 送信対象ユーザーの ID。
 * @param content 送信するメッセージ本文。
 * @param fallbackChannelId DM 不可時のフォールバック先(個人用非公開チャンネル前提 / 任意)。
 * @returns 送信結果。成功で `{ ok: true }`、失敗は判別可能な {@link SendResult}。
 */
export async function sendDirectMessage(
  env: DiscordEnv,
  userId: string,
  content: string,
  fallbackChannelId?: string,
): Promise<SendResult> {
  const dmResult = await sendViaDm(env, userId, content);

  if (dmResult.ok) {
    return dmResult;
  }

  // DM 不可(403)はフォールバック判定の対象。それ以外の失敗はそのまま伝播する。
  if (dmResult.reason !== "forbidden") {
    return dmResult;
  }

  // 403 だがフォールバック先が無い → 呼び出し元が判別できる形で失敗を返す(Req 5.3)。
  if (fallbackChannelId === undefined) {
    return dmResult;
  }

  // 個人用フォールバックチャンネルへ送信する(Req 5.2, 5.5, 6.3)。
  return sendChannelMessage(env, fallbackChannelId, content);
}

/**
 * DM チャンネルを open して送信する内部ヘルパー (Req 5.1)。
 *
 * open / send いずれの失敗も正規化済み {@link SendResult} として返す。DM open が 403 の
 * 場合は DM 不可を表す `forbidden` を返し、呼び出し元のフォールバック判定に委ねる。
 */
async function sendViaDm(
  env: DiscordEnv,
  userId: string,
  content: string,
): Promise<SendResult> {
  const opened = await openDmChannel(env, userId);
  if (!opened.ok) {
    // DmOpenResult の失敗変種は SendResult の失敗変種と構造的に一致するため、
    // そのまま返して exactOptionalPropertyTypes 下でも status の任意性を保つ。
    return opened;
  }
  return sendChannelMessage(env, opened.channelId, content);
}
