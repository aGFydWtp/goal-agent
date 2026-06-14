import { type ClassificationResult, classificationResultSchema } from "./schema";

export type NonEmptyCheckinInputResult =
  | { ok: true; text: string }
  | { ok: false; reason: "empty_input" };

export type VerifyClassificationResultResult =
  | {
      ok: true;
      result: ClassificationResult;
      unclassifiedItems: ClassificationResult["items"];
    }
  | {
      ok: false;
      reason: "invalid_goal_id";
      goalIds: string[];
    };

export type ParseAndVerifyClassificationResultResult =
  | Extract<VerifyClassificationResultResult, { ok: true }>
  | Extract<VerifyClassificationResultResult, { ok: false }>
  | {
      ok: false;
      reason: "empty_input" | "malformed_json" | "schema_invalid";
    };

/**
 * 分類前の空入力ガード。
 *
 * Discord modal の入力は信頼境界なので、LLM 呼び出し前に空/空白のみを弾く。
 */
export function guardNonEmptyCheckinInput(rawText: string): NonEmptyCheckinInputResult {
  const text = rawText.trim();
  if (text.length === 0) {
    return { ok: false, reason: "empty_input" };
  }

  return { ok: true, text };
}

/**
 * LLM の raw JSON 文字列を分類結果として解釈し、構造・値域・goalId 実在性を検証する入口。
 *
 * later domain code が保存可否を単一の discriminated union で扱えるように、
 * JSON パース不能・zod schema 不一致・非実在 goalId を別 reason に正規化する。
 */
export function parseAndVerifyClassificationResult(
  rawJson: string,
  allowedGoalIds: ReadonlySet<string>,
): ParseAndVerifyClassificationResultResult {
  if (rawJson.trim().length === 0) {
    return { ok: false, reason: "empty_input" };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawJson);
  } catch {
    return { ok: false, reason: "malformed_json" };
  }

  const parsedResult = classificationResultSchema.safeParse(parsedJson);
  if (!parsedResult.success) {
    return { ok: false, reason: "schema_invalid" };
  }

  return verifyClassificationResult(parsedResult.data, allowedGoalIds);
}

/**
 * zod 検証済み分類結果に対するドメイン固有検証。
 *
 * 構造・型・値域は `classificationResultSchema` / `completeJson` が担い、ここでは
 * goalId が分類コンテキストの実在目標集合に含まれることだけを検証する。
 * 候補目標が空の項目は未分類として成功結果に保持する。
 */
export function verifyClassificationResult(
  result: ClassificationResult,
  allowedGoalIds: ReadonlySet<string>,
): VerifyClassificationResultResult {
  const invalidGoalIds = Array.from(
    new Set(
      result.items.flatMap((item) =>
        item.candidateGoals
          .filter((candidateGoal) => !allowedGoalIds.has(candidateGoal.goalId))
          .map((candidateGoal) => candidateGoal.goalId),
      ),
    ),
  );

  if (invalidGoalIds.length > 0) {
    return {
      ok: false,
      reason: "invalid_goal_id",
      goalIds: invalidGoalIds,
    };
  }

  return {
    ok: true,
    result,
    unclassifiedItems: result.items.filter((item) => item.candidateGoals.length === 0),
  };
}
