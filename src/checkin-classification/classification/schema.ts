import { z } from "zod";
import { USEFULNESS_VALUES } from "../../types/enums";
import type { RelevanceScore, Usefulness } from "../../types/llm-shared";

const usefulnessSchema: z.ZodType<Usefulness> = z.enum(USEFULNESS_VALUES);

const relevanceScoreSchema: z.ZodType<RelevanceScore> = z.number().min(0).max(1);

const candidateGoalSchema = z
  .object({
    goalId: z.string().min(1),
    relevanceScore: relevanceScoreSchema,
    reason: z.string().min(1),
  })
  .strict();

const classificationItemSchema = z
  .object({
    text: z.string().min(1),
    candidateGoals: z.array(candidateGoalSchema),
    usefulness: usefulnessSchema,
    suggestedEvidenceTitle: z.string().min(1),
  })
  .strict();

/**
 * §13.1 準拠のチェックイン分類結果スキーマ。
 *
 * `candidateGoals: []` は「未分類」を表す有効な分類項目として扱う。
 */
export const classificationResultSchema = z
  .object({
    items: z.array(classificationItemSchema).min(1),
  })
  .strict();

export type ClassificationResult = z.infer<typeof classificationResultSchema>;
