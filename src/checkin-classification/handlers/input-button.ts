// [入力する] ボタンハンドラ(checkin-classification Input Button Handler / Req 1.3)。
//
// design「`/checkin` 開始 → 自由文入力(modal)」フローに従い、本ハンドラは [入力する] ボタンの
// component interaction を受けて checkin modal を開く責務のみを所有する。空入力ガード・分類・
// 永続化は modal submit ハンドラ(task 3.2)とドメイン層が担うため、本ハンドラは入力を読まず、
// 確定した custom_id 規約(custom-ids.ts)に基づき modal を開く HandlerResult を返す薄層に
// 徹する。modal は複数行(Paragraph)TextInput を 1 つ持ち、その custom_id は
// CHECKIN_INPUT_FIELD_ID で、submit ハンドラの読み取りキーとなる。
//
// 依存方向: handlers → custom-ids(定数のみ)/ discord 契約型(左方向のみ)。

import type { DiscordEnv } from "../../discord/env";
import type {
  HandlerResult,
  InteractionContext,
  InteractionHandler,
  ModalActionRow,
} from "../../discord/types";
import { CHECKIN_INPUT_FIELD_ID, CHECKIN_MODAL_ID } from "../custom-ids";

// Discord modal text input の style 値(数値リテラル / workerd enum 問題回避。types.ts の
// ModalTextInput.style は 1=Short / 2=Paragraph)。週次の雑メモは複数行で受けるため Paragraph。
const PARAGRAPH = 2; // TextInputStyle.Paragraph

/**
 * checkin 入力 modal の action row(複数行 TextInput を 1 つ内包、Req 1.3)。
 *
 * 週次の自由文を 1 フィールドで受け、custom_id は {@link CHECKIN_INPUT_FIELD_ID}。submit
 * ハンドラ(task 3.2)がこの custom_id で raw テキストを読み取る。
 */
const checkinModalRows: ModalActionRow[] = [
  {
    type: 1,
    components: [
      {
        type: 4,
        custom_id: CHECKIN_INPUT_FIELD_ID,
        label: "今週やったこと",
        style: PARAGRAPH,
        required: true,
        placeholder: "今週やったことを雑に書いてください。評価目標との関連はこちらで分類します。",
      },
    ],
  },
];

/**
 * [入力する] ボタンハンドラ(Req 1.3)。
 *
 * 複数行 TextInput を 1 つ持つ checkin modal を開く HandlerResult を返す。modal の custom_id は
 * {@link CHECKIN_MODAL_ID} であり、submit ハンドラの照合キーとなる。入力を読まないため同期で
 * 完結する(InteractionHandler は sync/async 両対応)。
 */
export const inputButtonHandler: InteractionHandler = {
  handle(_ctx: InteractionContext, _env: DiscordEnv): HandlerResult {
    return {
      mode: "modal",
      customId: CHECKIN_MODAL_ID,
      title: "今週の実績を入力",
      components: checkinModalRows,
    };
  },
};
