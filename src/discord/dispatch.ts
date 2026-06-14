import {
  type APIInteraction,
  InteractionType,
} from "discord-api-types/v10";

import type { DiscordEnv } from "./env";
import { createFollowup } from "./followup";
import { lookupHandler } from "./registry";
import { type ResponseOptions, deferred, modal, reply } from "./response";
import type { InteractionContext, InteractionKind } from "./types";

/**
 * interaction ディスパッチャ (Req 1.6, 3.1-3.5, 4.1-4.3, 4.7 / design.md §dispatch
 * "Interaction Dispatcher" L377-406・受信フロー L137-178)。
 *
 * 検証済み・非 PING の interaction を受け取り、種別を判定して {@link InteractionContext}
 * を構築し、レジストリで照合したハンドラを実行して応答を組み立てる。応答ボディは
 * `response.ts` の純粋関数で生成し、本モジュールが {@link Response.json} で包んで返す
 * (worker entry はこの Response をそのまま Discord へ返す想定)。
 *
 * 依存方向: 本モジュールは registry / response / followup / types / env のみを参照し、
 * worker entry(`src/index.ts`)を import しない(index が dispatch を import する側。
 * 上方向 import 禁止 / design 依存方向)。
 *
 * 応答経路(Req 4.1/4.2/4.3/4.5/4.7):
 *  - `reply`    → type4(CHANNEL_MESSAGE_WITH_SOURCE)を即返す。
 *  - `deferred` → type5(DEFERRED_...)を即返し、`ctx.waitUntil` で重い処理を継続。
 *                 継続側は {@link createFollowup} 経由で follow-up により本応答を送る。
 *  - `modal`    → type9(MODAL)を初期応答として返す。
 *
 * 不変条件: 初期応答は 3 秒以内に返る(重い処理は waitUntil 側 / design Invariant)。
 */

/** Discord interaction type → ローカル {@link InteractionKind} の対応 (Req 3.1-3.3)。 */
function kindOf(type: InteractionType): InteractionKind | null {
  switch (type) {
    case InteractionType.ApplicationCommand:
      return "command";
    case InteractionType.MessageComponent:
      return "component";
    case InteractionType.ModalSubmit:
      return "modal";
    default:
      // PING(検証済み非 PING 前提のため到達しない)・autocomplete 等は非対象。
      return null;
  }
}

/**
 * interaction payload から識別子(command 名 / component・modal の custom_id)を取り出す。
 *
 * command(type2)は `data.name`、component(type3)/ modal(type5)は `data.custom_id`。
 */
function nameOf(kind: InteractionKind, interaction: APIInteraction): string | null {
  if (kind === "command") {
    const data = (interaction as { data?: { name?: unknown } }).data;
    return typeof data?.name === "string" ? data.name : null;
  }
  const data = (interaction as { data?: { custom_id?: unknown } }).data;
  return typeof data?.custom_id === "string" ? data.custom_id : null;
}

/**
 * 実行ユーザー ID を取り出す (Req 6.1)。DM は `interaction.user.id`、ギルドは
 * `interaction.member.user.id`。どちらか供給される側を採る。
 */
function userIdOf(interaction: APIInteraction): string | null {
  const member = (interaction as { member?: { user?: { id?: unknown } } }).member;
  if (member && typeof member.user?.id === "string") {
    return member.user.id;
  }
  const user = (interaction as { user?: { id?: unknown } }).user;
  return typeof user?.id === "string" ? user.id : null;
}

/**
 * 検証済み非 PING interaction から {@link InteractionContext} を構築する (Req 3.5, 6.1)。
 *
 * 種別・識別子・実行ユーザー ID のいずれかが欠ける(規約外 payload)場合は `null` を返し、
 * 呼び出し元はエラー応答へ正規化する。
 */
function buildContext(interaction: APIInteraction): InteractionContext | null {
  const kind = kindOf(interaction.type);
  if (kind === null) {
    return null;
  }
  const name = nameOf(kind, interaction);
  const userId = userIdOf(interaction);
  if (name === null || userId === null) {
    return null;
  }
  const guildId = (interaction as { guild_id?: unknown }).guild_id;
  const channelIdRaw = (interaction as { channel_id?: unknown }).channel_id;
  return {
    kind,
    name,
    userId,
    channelId: typeof channelIdRaw === "string" ? channelIdRaw : null,
    isDm: typeof guildId !== "string",
    interactionId: interaction.id,
    token: interaction.token,
    raw: interaction,
  };
}

/**
 * ephemeral フラグを {@link ResponseOptions} へ正規化する。
 *
 * `exactOptionalPropertyTypes` 下では `ephemeral: undefined` を明示的に渡せないため、
 * 値が定義されている場合のみキーを含める。
 */
function ephemeralOpts(ephemeral?: boolean): ResponseOptions {
  return ephemeral === undefined ? {} : { ephemeral };
}

/** ephemeral なエラー応答を JSON Response として返す(個人データ露出なし / Req 3.4)。 */
function errorResponse(message: string): Response {
  return Response.json(reply(message, { ephemeral: true }));
}

/**
 * 検証済み・非 PING の interaction をディスパッチする (design Service Interface)。
 *
 * @param interaction 署名検証済み・非 PING の interaction(parsed)。
 * @param env Discord secrets を含む実行環境。
 * @param ctx Cloudflare の {@link ExecutionContext}。deferred 継続を `waitUntil` に登録する。
 * @returns Discord へ返す初期応答 {@link Response}。
 */
export async function dispatchInteraction(
  interaction: unknown,
  env: DiscordEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const ctxResult = buildContext(interaction as APIInteraction);
  if (ctxResult === null) {
    // 種別判定不能・規約外 payload は判別可能なエラー応答へ正規化する(Req 3.4)。
    return errorResponse("この操作は受け付けられません。");
  }

  const handler = lookupHandler(ctxResult.kind, ctxResult.name);
  if (handler === null) {
    // 未登録ハンドラ: 判別可能なエラー応答(Req 3.4)。
    return errorResponse("この操作には対応していません。");
  }

  let result: Awaited<ReturnType<typeof handler.handle>>;
  try {
    result = await handler.handle(ctxResult, env);
  } catch {
    // ハンドラ例外は ephemeral エラー応答へ正規化する(例外メッセージ等の個人データを露出しない)。
    return errorResponse("処理中にエラーが発生しました。");
  }

  switch (result.mode) {
    case "reply":
      // 即時応答(type4)。
      return Response.json(reply(result.content, ephemeralOpts(result.ephemeral)));
    case "deferred": {
      // 初期 deferred 応答(type5)を即返し、重い処理を waitUntil で継続する(Req 4.1, 4.3)。
      const { run } = result;
      const followup = createFollowup(env, ctxResult.token);
      ctx.waitUntil(run(followup));
      return Response.json(deferred(ephemeralOpts(result.ephemeral)));
    }
    case "modal":
      // modal を開く初期応答(type9)(Req 4.7)。
      return Response.json(
        modal({
          customId: result.customId,
          title: result.title,
          components: result.components,
        }),
      );
  }
}
