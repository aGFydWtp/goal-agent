// `/goal add` コマンドハンドラ(goal-management Goal Add Handler / Req 2.1)。
//
// design「`/goal add` フロー(modal → submit)」に従い、本ハンドラは command interaction を
// 受けて目標入力 modal を提示する責務のみを所有する。永続化・必須検証・対象サイクル解決は
// modal submit ハンドラ(別タスク)とドメイン層が担うため、本ハンドラは入力を読まず、
// 確定した custom_id / フィールド規約(commands.ts)に基づき modal を開く HandlerResult を
// 返す薄層に徹する。
//
// 依存方向: handlers → commands(定数のみ)/ discord 契約型(左方向のみ)。

import type { DiscordEnv } from "../../discord/env";
import type {
  HandlerResult,
  InteractionContext,
  InteractionHandler,
  ModalActionRow,
  ModalTextInput,
} from "../../discord/types";
import {
  GOAL_FIELD_DESCRIPTION,
  GOAL_FIELD_DUE_DATE,
  GOAL_FIELD_EVALUATION_POINTS,
  GOAL_FIELD_SUCCESS_CRITERIA,
  GOAL_FIELD_TITLE,
  GOAL_MODAL_ID,
} from "../commands";

// Discord modal text input の style 値(数値リテラル / workerd enum 問題回避。types.ts の
// ModalTextInput.style は 1=Short / 2=Paragraph)。
const SHORT = 1; // TextInputStyle.Short
const PARAGRAPH = 2; // TextInputStyle.Paragraph

/** text input を 1 つ内包する action row を組み立てる(Discord modal は row が input を包む)。 */
function row(input: ModalTextInput): ModalActionRow {
  return { type: 1, components: [input] };
}

/**
 * 目標入力 modal の 5 フィールド(Req 2.1)。
 *
 * 目標名・目標本文を必須、達成条件・評価観点・期限を任意とする。達成条件 / 評価観点は
 * 複数行(Paragraph)で受ける(Req 2.4 の複数行保持に対応する入力面)。
 * Discord modal の action row は最大 5 であり、本 modal はちょうど 5 行で上限内に収まる。
 */
const goalModalRows: ModalActionRow[] = [
  row({
    type: 4,
    custom_id: GOAL_FIELD_TITLE,
    label: "目標名",
    style: SHORT,
    required: true,
  }),
  row({
    type: 4,
    custom_id: GOAL_FIELD_DESCRIPTION,
    label: "目標本文",
    style: PARAGRAPH,
    required: true,
  }),
  row({
    type: 4,
    custom_id: GOAL_FIELD_SUCCESS_CRITERIA,
    label: "達成条件",
    style: PARAGRAPH,
    required: false,
  }),
  row({
    type: 4,
    custom_id: GOAL_FIELD_EVALUATION_POINTS,
    label: "評価観点",
    style: PARAGRAPH,
    required: false,
  }),
  row({
    type: 4,
    custom_id: GOAL_FIELD_DUE_DATE,
    label: "期限",
    style: SHORT,
    required: false,
    placeholder: "YYYY-MM-DD",
  }),
];

/**
 * `/goal add` ハンドラ(Req 2.1)。
 *
 * 目標名・目標本文・達成条件・評価観点・期限を入力する modal を開く HandlerResult を返す。
 * modal の custom_id は {@link GOAL_MODAL_ID} であり、submit ハンドラの照合キーとなる。
 * 入力を読まないため同期で完結する(InteractionHandler は sync/async 両対応)。
 */
export const goalAddHandler: InteractionHandler = {
  handle(_ctx: InteractionContext, _env: DiscordEnv): HandlerResult {
    return {
      mode: "modal",
      customId: GOAL_MODAL_ID,
      title: "目標を登録",
      components: goalModalRows,
    };
  },
};
