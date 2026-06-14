import type { Env } from "../env";

/**
 * Discord 入出力ゲートウェイが必要とする secrets / 設定の型宣言 (Req 1.5, 2.2, 5.4, 6.3)。
 *
 * infra-foundation が確立した {@link Env}(AI / Agent バインディング)を交差して
 * Discord secrets を追加する。これにより Discord パスのコードは infra のバインディングと
 * Discord secrets の双方を単一の `DiscordEnv` 型で参照できる。
 *
 * Cloudflare Workers の secret / var は string 型でバインドされるため、各フィールドは
 * `string` で宣言する。必須 secrets を非 optional で宣言することで、`wrangler` 設定や
 * `wrangler secret` 投入から欠けている場合に型レベル/起動時で不足を検出できる
 * (欠落が `undefined` として黙って通り抜けない)。
 */
export interface DiscordSecrets {
  /**
   * Discord 公開鍵。interactions エンドポイントの Ed25519 署名検証に用いる (Req 1.5)。
   */
  DISCORD_PUBLIC_KEY: string;

  /**
   * Discord アプリケーション ID。slash command 登録手段が Discord API への
   * 登録先を特定するために用いる (Req 2.2)。
   */
  DISCORD_APPLICATION_ID: string;

  /**
   * Discord bot token。コマンド登録・follow-up webhook・プロアクティブ送信など
   * bot 認証を要する REST 呼び出しに用いる (Req 2.2, 5.4)。
   */
  DISCORD_BOT_TOKEN: string;

  /**
   * 個人用フォールバックチャンネル ID(任意設定)。
   *
   * プロアクティブ送信時に対象ユーザーが DM を許可しておらず(403)、呼び出し元が
   * 個別のフォールバック先を指定しない場合に用いる、個人用非公開チャンネルの既定値
   * (Req 6.3)。未設定でも起動可能とするため optional とする。設定される送信先は
   * DM/個人用非公開チャンネルに限定され、公開チャンネルは前提としない。
   */
  DISCORD_FALLBACK_CHANNEL_ID?: string;
}

/**
 * Discord ゲートウェイ用の実行環境契約 (Req 1.5, 2.2, 5.4, 6.3)。
 *
 * infra-foundation の {@link Env} を交差し、{@link DiscordSecrets} を追加する。
 * Discord パスのハンドラ・検証・REST・登録手段はこの型を受け取り、infra のバインディングと
 * Discord secrets の双方を型安全に参照する。
 */
export type DiscordEnv = Env & DiscordSecrets;
