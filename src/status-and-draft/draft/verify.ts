import type { DraftType } from "../../types/enums";
import type { RefineKind } from "./schema";

/**
 * 調整 kind から drafts.type への対応を決定する(Req 7.2)。
 *
 * - null(初期生成)= self_evaluation
 * - manager(上司向け)= manager_summary
 * - shorten(短縮)= short_summary
 * - strengthen(成果強調)/ clarify(課題明確化)= self_evaluation
 *
 * 構造検証は `completeJson(req, draftContentSchema)` の zod 側で完結するため、
 * 本ヘルパーは保存時の type 決定に責務を絞る(空証跡ガードは呼び出し側 `generateDraft` の責務)。
 */
export function refineKindToDraftType(kind: RefineKind | null): DraftType {
  switch (kind) {
    case "manager":
      return "manager_summary";
    case "shorten":
      return "short_summary";
    case null:
    case "strengthen":
    case "clarify":
      return "self_evaluation";
  }
}
