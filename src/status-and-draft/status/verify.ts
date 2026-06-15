import type { z } from "zod";
import type { LlmResult } from "../../llm/client";
import type { RuleOutcome } from "./rules";
import type { StatusVerdict, statusVerdictLlmSchema } from "./schema";

/** `completeJson(req, statusVerdictLlmSchema)` の戻り値型(zod 検証済み)。 */
type StatusVerdictLlm = z.infer<typeof statusVerdictLlmSchema>;

/**
 * ルール候補と zod 検証済みの LLM 見立てを統合し、常に有効な `StatusVerdict` を返す(Req 1.5)。
 *
 * - LLM 成功時: 見立てをそのまま採用し `reasonMissing: false`。
 * - LLM 失敗時(provider_error / timeout / invalid_output): ルール候補 `rule.candidate` で
 *   status を成立させ、reason/risks/nextActions は空(有効な形状)とし `reasonMissing: true`。
 *
 * `llm` は `completeJson` が zod 検証済みで返すため、ここでは構造の再検証を行わない。
 * 判断材料不足の Gray 判定はルール側の責務(`evaluateRules`)で、本関数は `rule.candidate` を信頼する(Req 1.4)。
 */
export function combineVerdict(
  rule: RuleOutcome,
  llm: LlmResult<StatusVerdictLlm>,
): StatusVerdict {
  if (llm.ok) {
    return { ...llm.value, reasonMissing: false };
  }

  // LLM 失敗/検証 NG: ルール候補で status を成立させ、見立て欠落を識別可能にする。
  return {
    status: rule.candidate,
    reason: "",
    risks: [],
    nextActions: [],
    reasonMissing: true,
  };
}
