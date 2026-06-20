import type { APIInteraction } from "discord-api-types/v10";
import { InteractionType } from "discord-interactions";

import { enqueueDeferredContinuation } from "./continuation";
import type { DiscordEnv } from "./env";
import { createFollowup } from "./followup";
import { lookupHandler } from "./registry";
import { deferred, modal, type ResponseOptions, reply } from "./response";
import type {
  DeferredContinuationEnvelope,
  InteractionContext,
  InteractionKind,
  MessageActionRow,
  MessageOptions,
} from "./types";

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

/**
 * Discord interaction type → ローカル {@link InteractionKind} の対応 (Req 3.1-3.3)。
 *
 * `type` は interaction payload の数値(type 2/3/5)。比較に用いる
 * {@link InteractionType} は本番 workerd 上で値が正しく解決される `discord-interactions`
 * の runtime enum(`APPLICATION_COMMAND=2` 等)。`discord-api-types` の enum 値は
 * workerd バンドル上で undefined に解決される既知の不具合があるため使わない。
 */
function kindOf(type: number): InteractionKind | null {
  switch (type) {
    case InteractionType.APPLICATION_COMMAND:
      return "command";
    case InteractionType.MESSAGE_COMPONENT:
      return "component";
    case InteractionType.MODAL_SUBMIT:
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
 * command interaction の first-level subcommand / subcommand group 名を取り出す。
 *
 * slash command の options は `data.options[0]` 先頭が subcommand(option type 1)または
 * subcommand group(option type 2)のとき、その `name` を結合キー
 * (`"<top-level> <subcommand>"`、例 `"goal status"`)の構成に用いる。
 *
 * 比較は数値リテラル(1=Subcommand / 2=SubcommandGroup)で行う。`kindOf` と同様、
 * `discord-api-types` の enum 値は workerd バンドル上で undefined に解決される既知の
 * 不具合を避けるため、enum メンバではなく数値を直接比較する。
 *
 * スコープ(意図的に最小化): subcommand group の場合でも結合キーには first-level の
 * group 名のみを用いる(group 配下の subcommand を `"<top-level> <group> <sub>"` まで
 * 展開しない)。本ゲートウェイの解決対象(`goal status` / `evidence list` 等)は
 * first-level 名で十分に区別でき、過度な入れ子展開は不要なため。
 *
 * command 以外の種別、または subcommand を伴わない command では `null` を返す。
 */
function subcommandName(interaction: APIInteraction): string | null {
  const data = (interaction as { data?: { options?: unknown } }).data;
  const options = data?.options;
  if (!Array.isArray(options) || options.length === 0) {
    return null;
  }
  const first = options[0] as { type?: unknown; name?: unknown };
  // option type 1=Subcommand / 2=SubcommandGroup(数値直接比較 / enum 解決揺れ回避)。
  if ((first.type === 1 || first.type === 2) && typeof first.name === "string") {
    return first.name;
  }
  return null;
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

/**
 * reply 結果(ephemeral + components)を {@link MessageOptions} へ正規化する
 * (task 6.4, Req 4.8)。
 *
 * `exactOptionalPropertyTypes` 下では `undefined` の明示的な代入を避けるため、値が
 * 定義されている場合のみキーを含める。`components` は message 用 action row / button
 * (Req 4.8)で、即時応答(type4)の `data.components` へ反映される。button 固有の
 * 業務判断はゲートウェイに置かず、下位機能ハンドラが供給した値をそのまま渡す (Req 4.11)。
 */
function replyOpts(ephemeral?: boolean, components?: MessageActionRow[]): MessageOptions {
  const opts: MessageOptions = {};
  if (ephemeral !== undefined) {
    opts.ephemeral = ephemeral;
  }
  if (components !== undefined) {
    opts.components = components;
  }
  return opts;
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

  // command は最具体優先で解決する: まず結合キー `"<top-level> <subcommand>"`
  // (例 `"goal status"`)を試し、未登録なら top-level キー(例 `"goal"`)へフォール
  // バックする(後方互換)。component / modal は custom_id の完全 / 前方一致のみ(従来通り)。
  // `ctx.name` は top-level 名のまま不変(既存ハンドラの ctx.name / ctx.raw 参照に影響しない)。
  const sub = ctxResult.kind === "command" ? subcommandName(interaction as APIInteraction) : null;
  const handler =
    (sub !== null ? lookupHandler("command", `${ctxResult.name} ${sub}`) : null) ??
    lookupHandler(ctxResult.kind, ctxResult.name);
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
      // 即時応答(type4)。components 付きなら data.components に message 用 button を載せる(Req 4.8)。
      return Response.json(reply(result.content, replyOpts(result.ephemeral, result.components)));
    case "deferred": {
      // 初期 deferred 応答(type5)を即返し、重い処理を waitUntil で継続する(Req 4.1, 4.3)。
      const { run } = result;
      const followup = createFollowup(env, ctxResult.token);
      // run が reject すると editOriginal が呼ばれず deferred(「考え中…」)が永久固着する。
      // 例外は必ず捕捉し、理由をログへ出した上でユーザーへ失敗通知へ正規化する。
      ctx.waitUntil(
        run(followup).catch(async (cause) => {
          console.error(
            `dispatch.deferred: 継続処理が例外で終了 ${
              cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
            }`,
          );
          await followup.editOriginal(
            "処理中にエラーが発生しました。お手数ですが、もう一度お試しください。",
          );
        }),
      );
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
    case "deferred-persistent": {
      // budget(waitUntil)を超えうる継続を初期応答ライフタイムから切り離す(Req 8.1)。
      // type5(DEFERRED)を即返し、waitUntil で primary cycle agent へ継続を enqueue する。
      // envelope は ctx.token・DISCORD_APPLICATION_ID・継続キー・payload から組み立てる。
      // enqueue 自体の失敗は失敗 follow-up へフォールバックし、deferred(「考え中…」)の
      // 固着を防ぐ(Req 8.5)。本処理(分類・判定・生成)は alarm 側で走るためここでは待たない。
      const { continuation, ephemeral } = result;
      const envelope: DeferredContinuationEnvelope = {
        interactionToken: ctxResult.token,
        applicationId: env.DISCORD_APPLICATION_ID,
        continuationKey: continuation.key,
        payload: continuation.payload,
      };
      ctx.waitUntil(
        enqueueDeferredContinuation(env, ctxResult.userId, envelope).catch(async (cause) => {
          console.error(
            `dispatch.deferred-persistent: enqueue 失敗 ${
              cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
            }`,
          );
          await createFollowup(env, ctxResult.token).editOriginal(
            "処理中にエラーが発生しました。お手数ですが、もう一度お試しください。",
          );
        }),
      );
      return Response.json(deferred(ephemeralOpts(ephemeral)));
    }
    default:
      // 既知の 4 変種(reply/deferred/deferred-persistent/modal)以外は規約外。型上は到達
      // しないが、ランタイム安全のため判別可能なエラーへ正規化する(bare satisfies never では
      // 戻り値経路を満たさない)。
      return errorResponse("この操作は現在利用できません。");
  }
}
