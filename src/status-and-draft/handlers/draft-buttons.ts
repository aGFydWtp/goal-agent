// §8.7 のドラフト調整/保存ボタン行を組み立てる共有ヘルパー(Draft Command / Refine Button
// Handlers が消費 / Req 5.5, 6.5)。
//
// 生成(draft-command)と調整(refine-button)はどちらも同一の 5 ボタン行(調整 4 種 + [保存])を
// 再提示するため、custom_id 付与とラベル/スタイル割当を 1 箇所に集約する。実体ボタンの生成は
// ハンドラ層の責務(messages.ts はテキストのみ)であり、本モジュールは custom-ids の組立関数で
// draftPendingId/kind を埋め込んだ message action row を返すだけの薄い presentation 関数に徹する。
//
// 依存方向: handlers/draft-buttons → custom-ids / discord 契約型(左方向のみ)。

import type { MessageActionRow } from "../../discord/types";
import {
  buildRefineButtonId,
  buildSaveDraftButtonId,
  REFINE_KINDS,
  type RefineKind,
} from "../custom-ids";

// message component button のスタイル値(types.ts: 1=Primary / 2=Secondary)。調整は補助操作なので
// Secondary、[保存] は主要操作なので Primary。リテラル型で MessageButton.style に直接代入する。
const STYLE_PRIMARY = 1 as const;
const STYLE_SECONDARY = 2 as const;

/** 調整 kind → §8.7 のボタン日本語ラベル。 */
const REFINE_KIND_LABELS: Record<RefineKind, string> = {
  shorten: "短くする",
  strengthen: "成果を強める",
  clarify: "課題を明確にする",
  manager: "上司向けにする",
};

/**
 * §8.7 の調整 4 種 + [保存] を 1 行に並べた message action row を組み立てる(Req 5.5, 6.5)。
 *
 * 4 調整ボタンは {@link REFINE_KINDS} の順に並べ、各 custom_id に kind と draftPendingId を
 * 埋め込む。[保存] は draftPendingId を埋め込む。Discord は 1 row 最大 5 button のため 5 つが
 * 1 行に収まる。
 */
export function draftButtonsRow(draftPendingId: string): MessageActionRow {
  return {
    type: 1,
    components: [
      ...REFINE_KINDS.map((kind) => ({
        type: 2 as const,
        custom_id: buildRefineButtonId(kind, draftPendingId),
        label: REFINE_KIND_LABELS[kind],
        style: STYLE_SECONDARY,
      })),
      {
        type: 2 as const,
        custom_id: buildSaveDraftButtonId(draftPendingId),
        label: "保存",
        style: STYLE_PRIMARY,
      },
    ],
  };
}
