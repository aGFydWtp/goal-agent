import { z } from "zod";

/**
 * ドラフト調整の種別(Req 6.1-6.4)。
 *
 * design.md「Draft Prompt + Schema + Verify」Service Interface の `RefineKind` と一致させる。
 * custom-ids.ts でも同一定義を持つ(custom_id 規約側の参照元)が、draft ヘルパー層は
 * この schema 定義を参照元とし、後続タスク(draft 操作・task 5.3)はここから import する。
 */
export type RefineKind = "shorten" | "strengthen" | "clarify" | "manager";

/**
 * §13.3 準拠のドラフト構造化出力スキーマ(Req 5.1, 5.4)。
 *
 * 事実/解釈/課題/次アクションの 4 セクションを必須とし、証跡にない内容は
 * `speculativeNotes` に推測として分離する。4 セクション必須・speculativeNotes 配列の
 * 構造検証は `completeJson(req, draftContentSchema)` の `safeParse` に委ねる。
 * 余分なキーを拒否するため checkin / status と同様 `.strict()` を用いる。
 */
export const draftContentSchema = z
  .object({
    facts: z.string(), // 事実: 何をしたか(証跡ベース)
    interpretation: z.string(), // 解釈: 目標にどう効いたか
    issues: z.string(), // 課題: 何が不足しているか
    nextActions: z.string(), // 次アクション: 今後どうするか
    speculativeNotes: z.array(z.string()), // 証跡にない内容を推測として明示
  })
  .strict();

/** §13.3 ドラフト本文の構造化型(zod から導出)。 */
export type DraftContent = z.infer<typeof draftContentSchema>;

/**
 * ドラフト生成プロンプトへ渡す対象証跡の入力(Req 5.1, 5.2)。
 *
 * `goalTitle` が null のときは `/draft all`(半期全体)を表す。
 * `evidence` は所有者スコープ済み。空配列は呼び出し側(`generateDraft`)が事前に弾く(Req 5.7)。
 */
export interface DraftEvidenceInput {
  goalTitle: string | null; // all は null(全体)
  evidence: ReadonlyArray<{
    body: string;
    evidenceDate: string;
    usefulness: string;
  }>;
}
