import type { DiscordEnv } from "../discord/env";
import { sendDirectMessage } from "../discord/proactive";
import type { SendResult } from "../discord/types";

/**
 * Delivery Orchestrator(通知配信の単一窓口) (Req 2.3, 2.5, 5.3, 5.4, 6.1, 6.2, 6.3)。
 *
 * design.md §Delivery Orchestrator の通り、週次チェックイン / アラートの両配信経路を
 * discord-gateway の送信ヘルパー {@link sendDirectMessage} に集約する。本モジュールは
 * 「対象ユーザー ID・メッセージ・個人用フォールバックチャンネル」を送信ヘルパーへ渡し、
 * その判別可能な結果({@link SendResult})を呼び出し元(ドメイン層)へそのまま返す。
 *
 * 役割分担(再実装しない境界):
 *  - DM open → 送信 → 403 時の個人用フォールバック → REST 失敗の正規化は discord-gateway
 *    ({@link sendDirectMessage})が所有する (Req 6.2, §Reuse)。本モジュールはこれを消費する
 *    のみで、DM/403/REST 機構を自前で実装しない。
 *  - 送信履歴(「送信済み」記録)の判断は呼び出し元のドメイン層が {@link SendResult} を見て
 *    行う (Req 6.4)。本モジュールは結果を改変せず返す。
 *
 * プライバシー境界(Req 2.5, 5.4):配信経路は DM、または env に設定された個人用
 * フォールバックチャンネル({@link DiscordEnv.DISCORD_FALLBACK_CHANNEL_ID})に限定される。
 * これは構造的に担保される——`deliver` は {@link sendDirectMessage} にのみ個人用の
 * フォールバックチャンネル ID を渡し、公開チャンネル宛の汎用送信関数(例:
 * `sendChannelMessage`)を一切 import / 呼び出さないため、任意の/公開チャンネルへ送る
 * 経路が存在しない。
 */

/**
 * 対象ユーザーへ通知をプロアクティブ配信する (Req 2.3, 6.1, 6.2, 6.3)。
 *
 * env の個人用フォールバックチャンネル({@link DiscordEnv.DISCORD_FALLBACK_CHANNEL_ID})を
 * 添えて {@link sendDirectMessage} を呼び出し、DM 成功 / フォールバック成功なら
 * `{ ok: true }`、フォールバック無し 403 や REST 失敗なら判別可能な失敗結果を返す。
 *
 * 失敗時({@link SendResult.ok} が `false`)は判別可能な形でログし、例外を投げずに処理を
 * 継続して結果をそのまま返す (Req 6.3)。これにより呼び出し元(ドメイン層)が送信履歴の
 * 記録要否を判断できる (Req 6.4)。
 *
 * @param env Discord secrets を含む実行環境(bot token・個人用フォールバックチャンネル ID)。
 * @param userId 配信対象ユーザーの ID (Req 6.1)。
 * @param content 配信するメッセージ本文。
 * @returns 送信結果。成功で `{ ok: true }`、失敗は判別可能な {@link SendResult}。
 */
export async function deliver(
  env: DiscordEnv,
  userId: string,
  content: string,
): Promise<SendResult> {
  const fallbackChannelId = env.DISCORD_FALLBACK_CHANNEL_ID;
  const result = await sendDirectMessage(env, userId, content, fallbackChannelId);

  if (!result.ok) {
    // フォールバック未指定 403 / REST 失敗などを判別可能にログし、例外を投げず継続する
    // (Req 6.3)。reason / status を含めることで「送信済み」記録の判断材料を残す (Req 6.4)。
    console.error(
      `notifications.deliver: 配信失敗 userId=${userId} reason=${result.reason}` +
        (result.status !== undefined ? ` status=${result.status}` : ""),
    );
  }

  return result;
}
