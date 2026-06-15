import type { RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v10";

/**
 * コマンド登録スクリプト (Req 2.2, 2.3, 2.4 / design.md §commands
 * "Command Definitions / Register" L466, File Structure Plan
 * `commands/register.ts` L127, Batch/Job Contract L470-474)。
 *
 * 集約されたコマンド定義(`commands/definitions.ts` の {@link
 * RESTPostAPIApplicationCommandsJSONBody} 配列)を、Discord アプリケーション ID と
 * bot token を用いて Discord API へ登録する。登録は Discord の **bulk overwrite
 * (PUT)** を用いるため冪等であり、再実行しても集約定義で常に上書きされる(Req 2.2)。
 *
 * - guildId 未指定: グローバル `PUT /applications/{application_id}/commands`(Req 2.2)。
 * - guildId 指定: ギルド `PUT /applications/{application_id}/guilds/{guild_id}/commands`
 *   (開発用のギルド単位登録 / Req 2.4)。
 *
 * 認証情報(application id / bot token)が欠落(空文字)している場合は **fetch を
 * 呼ばず**、不足している設定を示す判別可能なエラーを返す。何も登録しない(Req 2.3)。
 *
 * 依存方向: 本モジュールは `discord-api-types` の型のみを参照し、ゲートウェイ内部の
 * dispatch / registry / rest 等を import しない(design L133「commands/ は登録専用で
 * env/types のみ参照」)。実行時の HTTP は `fetch` のみで行う(`@discordjs/rest` や
 * full discord.js は使わない / design.md §Technology Stack)。
 *
 * 本モジュールは登録ロジックを純粋な関数 {@link registerCommands} として公開する。
 * CLI から実行する場合も、認証情報・集約定義を引数として本関数へ渡す薄いラッパに留め、
 * 登録ロジックはここに集約する(テスト容易性のため)。
 */

/** Discord REST API ベース URL(API v10)。 */
const API_BASE = "https://discord.com/api/v10";

/** {@link registerCommands} の任意オプション。 */
export interface RegisterCommandsOptions {
  /**
   * 開発用のギルド単位登録先 (Req 2.4)。指定時は当該ギルドへ登録し、
   * 未指定時はグローバル登録となる。
   */
  readonly guildId?: string;
}

/** 認証情報欠落時に不足を示す環境設定キー。 */
export type MissingCredential = "DISCORD_APPLICATION_ID" | "DISCORD_BOT_TOKEN";

/**
 * コマンド登録の結果型 (Req 2.2, 2.3, 2.4)。
 *
 * - 成功: 登録スコープ(global / guild)と登録したコマンド数を返す。
 * - 認証情報欠落: `missing_credentials` と不足キー配列を返す(何も登録していない / Req 2.3)。
 * - REST 失敗: `rest_error` と HTTP ステータスを返す。
 */
export type RegisterResult =
  | { ok: true; scope: "global" | "guild"; count: number }
  | { ok: false; reason: "missing_credentials"; missing: MissingCredential[] }
  | { ok: false; reason: "rest_error"; status: number; body: string };

/**
 * 集約されたコマンド定義を Discord API へ bulk overwrite 登録する (Req 2.2, 2.3, 2.4)。
 *
 * 認証情報(application id / bot token)が欠落している場合は fetch を呼ばず、
 * 不足キーを含む `missing_credentials` エラーを返す(Req 2.3)。認証情報が揃っている
 * 場合は、guildId 指定の有無に応じてグローバルまたはギルドのエンドポイントへ
 * `PUT`(bulk overwrite)でコマンド定義配列を送信する。
 *
 * @param applicationId Discord アプリケーション ID(`DISCORD_APPLICATION_ID`)。
 * @param botToken Discord bot token(`DISCORD_BOT_TOKEN`)。
 * @param definitions 登録するコマンド定義集合(集約点 `commandDefinitions` を渡す)。
 * @param options 任意。`guildId` 指定でギルド単位登録(Req 2.4)。
 */
export async function registerCommands(
  applicationId: string,
  botToken: string,
  definitions: readonly RESTPostAPIApplicationCommandsJSONBody[],
  options?: RegisterCommandsOptions,
): Promise<RegisterResult> {
  const missing: MissingCredential[] = [];
  if (applicationId === "") {
    missing.push("DISCORD_APPLICATION_ID");
  }
  if (botToken === "") {
    missing.push("DISCORD_BOT_TOKEN");
  }
  // 認証情報欠落時は何も登録せず(fetch を呼ばず)エラーを返す (Req 2.3)。
  if (missing.length > 0) {
    return { ok: false, reason: "missing_credentials", missing };
  }

  const guildId = options?.guildId;
  const url =
    guildId === undefined
      ? `${API_BASE}/applications/${applicationId}/commands`
      : `${API_BASE}/applications/${applicationId}/guilds/${guildId}/commands`;

  // bulk overwrite は PUT で行う(冪等登録 / Req 2.2)。body は定義配列そのもの。
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bot ${botToken}`,
    },
    body: JSON.stringify(definitions),
  });

  if (!res.ok) {
    return { ok: false, reason: "rest_error", status: res.status, body: await res.text() };
  }

  return {
    ok: true,
    scope: guildId === undefined ? "global" : "guild",
    count: definitions.length,
  };
}
