import { z } from "zod";
import { GOAL_STATUSES } from "../../types/enums";
import type { GoalStatus } from "../../types/enums";

// `GoalStatus` 用の zod スキーマは infra 共有では未提供のため、
// const タプル `GOAL_STATUSES` を単一の参照元として組み立てる(Implementation Notes 1.1)。
const goalStatusSchema: z.ZodType<GoalStatus> = z.enum(GOAL_STATUSES);

/**
 * §13.2 LLM 見立ての構造化出力スキーマ(Req 1.3)。
 *
 * `reasonMissing` は LLM 出力ではなく `combineVerdict` が付与するため、
 * 本スキーマには含めない。`completeJson(req, statusVerdictLlmSchema)` に渡し、
 * status の列挙・risks/nextActions の文字列配列・全体構造の検証を LLM クライアントへ委ねる。
 * 余分なキーを拒否するため checkin と同様 `.strict()` を用いる。
 */
export const statusVerdictLlmSchema = z
  .object({
    status: goalStatusSchema, // green | yellow | red | gray
    reason: z.string(),
    risks: z.array(z.string()),
    nextActions: z.array(z.string()),
  })
  .strict();

/**
 * ステータス判定の公開契約(notifications と共有、形状不変)。
 *
 * LLM 出力スキーマの infer 型に、見立て欠落を示す `reasonMissing` を加えた形。
 * LLM 見立てが採用されたときは `false`、ルール候補へフォールバックしたときは `true`。
 */
export type StatusVerdict = z.infer<typeof statusVerdictLlmSchema> & {
  reasonMissing: boolean; // LLM 見立て欠落時 true(ルールのみで成立)
};
