import type {
  APIActionRowComponent,
  APIComponentInModalActionRow,
  APIInteraction,
} from "discord-api-types/v10";

import type { DiscordEnv } from "./env";

/**
 * Discord interaction の入出力契約 (Req 3.5, 3.6, 4.1, 4.7, 6.1, 7.4)。
 *
 * このモジュールは依存方向の左端に位置し、`./env`(task 1.1)と `discord-api-types`
 * のみを参照する。registry / dispatch / response / followup など下位コンポーネントは
 * これらの型を import して規約に従う(上方向 import は行わない)。
 *
 * ゲートウェイはコマンドの中身を持たず、ハンドラは外部供給物として {@link InteractionHandler}
 * の形で型から受け取る (Req 7.4)。
 */

/**
 * interaction の種別 (Req 3.5)。
 *
 * - `"command"`: slash command(Discord interaction type 2)。
 * - `"component"`: message component(button / select 等、type 3)。
 * - `"modal"`: modal submit(type 5)。
 */
export type InteractionKind = "command" | "component" | "modal";

/**
 * ハンドラへ渡す interaction 文脈 (Req 3.5, 6.1)。
 *
 * 実行ユーザー ID・コマンド名 / custom_id・チャンネル / DM 文脈・follow-up token を
 * 含み、全ハンドラはこの単一契約から必要な文脈を読む。`userId` は常に供給され
 * (Req 6.1)、follow-up は `token` を介して行う。
 *
 * 引数(slash command options 等)は種別ごとに構造が異なるため、生 payload を
 * {@link InteractionContext.raw} として保持し、ハンドラ側で discord-api-types の
 * 型へ絞り込んで参照する。
 */
export interface InteractionContext {
  /** interaction 種別 (Req 3.5)。 */
  readonly kind: InteractionKind;
  /** command 名、または component / modal の custom_id。 */
  readonly name: string;
  /** 実行ユーザー ID。常に供給される (Req 6.1)。 */
  readonly userId: string;
  /** チャンネル ID。文脈が無い場合は null。 */
  readonly channelId: string | null;
  /** DM 文脈か否か。 */
  readonly isDm: boolean;
  /** interaction ID。 */
  readonly interactionId: string;
  /** follow-up に用いる interaction token (Req 4.1)。 */
  readonly token: string;
  /**
   * 元 interaction payload。型は discord-api-types の {@link APIInteraction}。
   * ハンドラは種別に応じて narrow して引数等を読む。
   */
  readonly raw: APIInteraction;
}

/**
 * deferred ハンドラが本応答 / 失敗送信に用いる follow-up 契約 (Req 4.2, 4.4)。
 *
 * 実装は task 2.4(followup)が `./env` と REST クライアント(task 2.3)を用いて
 * 提供する。型をここに置くことで {@link HandlerResult} の deferred 変種が
 * 上方向 import なしに `Followup` を参照できる(型の単方向依存を保つ)。
 *
 * 送信は例外を投げず、結果を {@link SendResult} として判別可能に返す。
 */
export interface Followup {
  /** @original webhook を編集して本応答を送る (Req 4.2)。 */
  editOriginal(content: string, opts?: { ephemeral?: boolean }): Promise<SendResult>;
  /** 追加の follow-up メッセージを送る (Req 4.2)。 */
  send(content: string, opts?: { ephemeral?: boolean }): Promise<SendResult>;
}

/**
 * Discord への送信結果 (Req 4.4, 5.3)。
 *
 * REST 失敗は例外ではなく判別可能な失敗値として返す。`status` は HTTP ステータス
 * (取得できた場合)。
 */
export type SendResult =
  | { ok: true }
  | { ok: false; reason: "forbidden" | "not_found" | "rest_error"; status?: number };

/**
 * ハンドラが宣言できる応答結果 (Req 4.1, 4.7)。
 *
 * - `"reply"`: 即時応答(Discord response type 4)。
 * - `"deferred"`: deferred 応答。`run` が {@link Followup} 経由で本応答を送る。
 * - `"modal"`: modal を開く(response type 9)。`customId` / `title` / text input
 *   群を {@link ModalActionRow} で宣言する (Req 4.7)。
 */
export type HandlerResult =
  | { mode: "reply"; ephemeral?: boolean; content: string }
  | { mode: "deferred"; ephemeral?: boolean; run: (followup: Followup) => Promise<void> }
  | { mode: "modal"; customId: string; title: string; components: ModalActionRow[] };

/**
 * modal の action row (Req 4.7)。
 *
 * Discord modal payload に準拠する(action row が text input を内包する)。
 * discord-api-types の
 * {@link APIActionRowComponent}<{@link APIComponentInModalActionRow}>
 * と構造的に互換であることを {@link ModalActionRow} 自身で検証する。
 */
export interface ModalActionRow {
  /** ActionRow component type。 */
  type: 1;
  /** action row が内包する text input 群。 */
  components: ModalTextInput[];
}

/**
 * modal の text input component (Req 4.7)。
 *
 * Discord modal payload の text input(component type 4)に準拠する。`style` は
 * 1=Short / 2=Paragraph。`value` は再オープン時の既存値(checkin の [修正] 等)。
 */
export interface ModalTextInput {
  /** TextInput component type。 */
  type: 4;
  custom_id: string;
  label: string;
  /** 1=Short, 2=Paragraph。 */
  style: 1 | 2;
  required?: boolean;
  min_length?: number;
  max_length?: number;
  placeholder?: string;
  /** 再オープン時の既存値。 */
  value?: string;
}

/**
 * ハンドラ登録規約 (Req 3.6, 7.4)。
 *
 * ハンドラは外部供給物として {@link InteractionContext} と {@link DiscordEnv} を受け、
 * {@link HandlerResult} を同期 / 非同期で返す。registry / dispatch はこのインター
 * フェイスを介してハンドラを登録・実行する。
 */
export interface InteractionHandler {
  handle(
    ctx: InteractionContext,
    env: DiscordEnv,
  ): Promise<HandlerResult> | HandlerResult;
}

/**
 * {@link ModalActionRow} が Discord modal payload の action row 型と構造的に互換で
 * あることをコンパイル時に検証する(ランタイムコストゼロ)。`label` を必須にする等、
 * 本ローカル型はより厳格な制約を課すが、payload としては互換であることを保証する。
 */
type _AssertModalActionRowCompatible = ModalActionRow extends APIActionRowComponent<APIComponentInModalActionRow>
  ? true
  : never;
// 互換でなければ never となり、下記 const 初期化が型エラーになる。
const _assertModalActionRowCompatible: _AssertModalActionRowCompatible = true;
void _assertModalActionRowCompatible;
