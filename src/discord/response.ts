import { InteractionResponseFlags, InteractionResponseType } from "discord-interactions";

import type {
  APIInteractionResponseChannelMessageWithSource,
  APIInteractionResponseDeferredChannelMessageWithSource,
  APIInteractionResponsePong,
  APIModalInteractionResponse,
  // 応答ボディ型の `type` フィールド(DAT enum メンバ)へ実行時値をキャストするための型。
  // `import type` は実行時に消去されるため workerd の enum 値 undefined 問題は起きない。
  InteractionResponseType as ApiResponseType,
} from "discord-api-types/v10";

import type { HandlerResult } from "./types";

/**
 * Discord interaction の応答ボディ生成ユーティリティ (Req 1.4, 4.1, 4.5, 4.6, 4.7, 6.2)。
 *
 * design.md §response "Response Utilities" の通り、これらは Response オブジェクトでは
 * なく「応答ボディ(JSON シリアライズ可能なオブジェクト)」を生成する純粋関数である。
 * dispatch / worker entry がこれを `Response.json` で包んで送出する責務を持つ。
 *
 * 依存方向: 本モジュールは `./types` と `discord-api-types` のみ参照し、registry /
 * dispatch / rest を import しない(上方向 import 禁止)。
 *
 * type 定数(1/4/5/9, ephemeral=64)は本番 workerd ランタイム上で値が正しく解決される
 * `discord-interactions` の runtime enum({@link InteractionResponseType} /
 * {@link InteractionResponseFlags})を用いる。`discord-api-types` は応答ボディの
 * 型(`APIInteractionResponse*`)のみを型として参照する(値 import はしない。design
 * §Technology Stack: discord-api-types は型のみでランタイムコストゼロ)。`discord-api-types`
 * の enum 値は workerd バンドル上で undefined に解決される既知の不具合があるため、
 * 実行時参照は `discord-interactions` 側へ寄せる。値は design 記載(1/4/5/9, 64)と
 * 一致することをテストで固定する。
 */

/** {@link reply} / {@link deferred} の任意オプション。 */
export interface ResponseOptions {
  /** true のとき応答を本人のみ可視(ephemeral / flag 64)にする (Req 4.6, 6.2)。 */
  readonly ephemeral?: boolean;
}

/**
 * {@link modal} の引数 (Req 4.7)。
 *
 * {@link HandlerResult} の modal 変種から判別子 `mode` を除いた payload 部分
 * (`customId` / `title` / `components`)。dispatch は `HandlerResult`(`mode:"modal"`)を
 * そのまま渡せる(構造的に互換)。
 */
export type ModalInput = Omit<Extract<HandlerResult, { mode: "modal" }>, "mode">;

/**
 * ephemeral 指定を Discord の message flags へ変換する。
 *
 * `ephemeral` が true のときのみ {@link InteractionResponseFlags.EPHEMERAL}(64)を返す。
 * それ以外は `undefined` を返し、応答ボディの `data.flags` を省略する。
 */
function ephemeralFlag(ephemeral?: boolean): number | undefined {
  return ephemeral ? InteractionResponseFlags.EPHEMERAL : undefined;
}

/**
 * PING に対する PONG 応答ボディ(type 1)を生成する (Req 1.4)。
 */
export function pong(): APIInteractionResponsePong {
  return { type: InteractionResponseType.PONG as unknown as ApiResponseType.Pong };
}

/**
 * 即時応答ボディ(type 4: CHANNEL_MESSAGE_WITH_SOURCE)を生成する (Req 4.5)。
 *
 * `ephemeral` 指定時は `data.flags` に 64 を立てる (Req 4.6, 6.2)。
 */
export function reply(
  content: string,
  opts?: ResponseOptions,
): APIInteractionResponseChannelMessageWithSource {
  const flags = ephemeralFlag(opts?.ephemeral);
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE as unknown as ApiResponseType.ChannelMessageWithSource,
    data: flags === undefined ? { content } : { content, flags },
  };
}

/**
 * deferred 応答ボディ(type 5: DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE)を生成する
 * (Req 4.1)。
 *
 * `ephemeral` 指定時は `data.flags` に 64 を立てる (Req 4.6, 6.2)。本応答は follow-up
 * webhook で別途送る(本関数は初期 deferred ボディのみを生成する)。
 */
export function deferred(
  opts?: ResponseOptions,
): APIInteractionResponseDeferredChannelMessageWithSource {
  const flags = ephemeralFlag(opts?.ephemeral);
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE as unknown as ApiResponseType.DeferredChannelMessageWithSource,
    data: flags === undefined ? {} : { flags },
  };
}

/**
 * modal を開く応答ボディ(type 9: MODAL)を生成する (Req 4.7)。
 *
 * {@link HandlerResult} の modal 変種(`customId` / `title` / `components`)を Discord
 * modal payload(`custom_id` / `title` / action row 内 text input)へ整形する。
 */
export function modal(input: ModalInput): APIModalInteractionResponse {
  return {
    type: InteractionResponseType.MODAL as unknown as ApiResponseType.Modal,
    data: {
      custom_id: input.customId,
      title: input.title,
      components: input.components,
    },
  };
}
