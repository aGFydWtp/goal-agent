// checkin-classification の分類構造化出力スキーマと検証ヘルパーの検証
// (Req 1.4, 2.4, 2.5, 2.6 / design.md Classification Prompt + Schema + Verify)。

import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type ClassificationResult,
  classificationResultSchema,
} from "../src/checkin-classification/classification/schema";
import {
  guardNonEmptyCheckinInput,
  parseAndVerifyClassificationResult,
  verifyClassificationResult,
} from "../src/checkin-classification/classification/verify";
import type { RelevanceScore, Usefulness } from "../src/types";

const validClassification = {
  items: [
    {
      text: "AI を使った議事録要約をチームに展開した",
      candidateGoals: [
        {
          goalId: "goal-ai",
          relevanceScore: 0.92,
          reason: "AI 活用の定着に直接関係する",
        },
      ],
      usefulness: "high",
      suggestedEvidenceTitle: "AI 議事録要約のチーム展開",
    },
    {
      text: "オフィスの席替えを手伝った",
      candidateGoals: [],
      usefulness: "low",
      suggestedEvidenceTitle: "席替え支援",
    },
  ],
} satisfies ClassificationResult;

describe("classificationResultSchema", () => {
  it("§13.1 の items/text/candidateGoals/usefulness/suggestedEvidenceTitle 形式を検証する", () => {
    const parsed = classificationResultSchema.safeParse(validClassification);

    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("expected schema parse to succeed");

    expect(parsed.data.items[0]?.candidateGoals[0]?.goalId).toBe("goal-ai");
    expect(parsed.data.items[1]?.candidateGoals).toEqual([]);
  });

  it("ClassificationResult は zod schema から導出され、共有基本型を組み合わせている", () => {
    type Item = ClassificationResult["items"][number];
    type CandidateGoal = Item["candidateGoals"][number];

    expectTypeOf<Item["usefulness"]>().toEqualTypeOf<Usefulness>();
    expectTypeOf<CandidateGoal["relevanceScore"]>().toEqualTypeOf<RelevanceScore>();
  });

  it.each([
    ["relevanceScore が 0 未満", -0.01],
    ["relevanceScore が 1 超過", 1.01],
  ] as const)("%s は schema で失敗する", (_label, relevanceScore) => {
    const parsed = classificationResultSchema.safeParse({
      ...validClassification,
      items: [
        {
          ...validClassification.items[0],
          candidateGoals: [
            {
              ...validClassification.items[0].candidateGoals[0],
              relevanceScore,
            },
          ],
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it("usefulness が列挙外なら schema で失敗する", () => {
    const parsed = classificationResultSchema.safeParse({
      ...validClassification,
      items: [{ ...validClassification.items[0], usefulness: "critical" }],
    });

    expect(parsed.success).toBe(false);
  });
});

describe("guardNonEmptyCheckinInput", () => {
  it.each(["", "   ", "\n\t  "])("空/空白のみ入力を empty_input として弾く: %j", (rawText) => {
    expect(guardNonEmptyCheckinInput(rawText)).toEqual({
      ok: false,
      reason: "empty_input",
    });
  });

  it("正常入力は trim 済み text を返す", () => {
    expect(guardNonEmptyCheckinInput("  今週は分類を実装した\n")).toEqual({
      ok: true,
      text: "今週は分類を実装した",
    });
  });
});

describe("parseAndVerifyClassificationResult", () => {
  it("空/空白のみ JSON 入力を empty_input として判別できる", () => {
    expect(parseAndVerifyClassificationResult(" \n\t ", new Set(["goal-ai"]))).toEqual({
      ok: false,
      reason: "empty_input",
    });
  });

  it("JSON 不整合を malformed_json として判別できる", () => {
    expect(parseAndVerifyClassificationResult('{"items": [', new Set(["goal-ai"]))).toEqual({
      ok: false,
      reason: "malformed_json",
    });
  });

  it.each([
    ["relevanceScore が 0 未満", -0.01],
    ["relevanceScore が 1 超過", 1.01],
  ] as const)("%s を schema_invalid として判別できる", (_label, relevanceScore) => {
    const result = parseAndVerifyClassificationResult(
      JSON.stringify({
        ...validClassification,
        items: [
          {
            ...validClassification.items[0],
            candidateGoals: [
              {
                ...validClassification.items[0].candidateGoals[0],
                relevanceScore,
              },
            ],
          },
        ],
      }),
      new Set(["goal-ai"]),
    );

    expect(result).toEqual({
      ok: false,
      reason: "schema_invalid",
    });
  });

  it("usefulness が列挙外なら schema_invalid として判別できる", () => {
    const result = parseAndVerifyClassificationResult(
      JSON.stringify({
        ...validClassification,
        items: [{ ...validClassification.items[0], usefulness: "critical" }],
      }),
      new Set(["goal-ai"]),
    );

    expect(result).toEqual({
      ok: false,
      reason: "schema_invalid",
    });
  });

  it("非実在 goalId を invalid_goal_id として判別できる", () => {
    expect(
      parseAndVerifyClassificationResult(JSON.stringify(validClassification), new Set(["other-goal"])),
    ).toEqual({
      ok: false,
      reason: "invalid_goal_id",
      goalIds: ["goal-ai"],
    });
  });

  it("正常入力を検証成功にし、未分類項目を保持して公開する", () => {
    const verified = parseAndVerifyClassificationResult(
      JSON.stringify(validClassification),
      new Set(["goal-ai"]),
    );

    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("expected verification to succeed");

    expect(verified.result.items).toHaveLength(2);
    expect(verified.result.items[1]?.candidateGoals).toEqual([]);
    expect(verified.unclassifiedItems).toEqual([validClassification.items[1]]);
  });
});

describe("verifyClassificationResult", () => {
  it("正常入力を検証成功にし、候補目標が無い項目を未分類として保持する", () => {
    const verified = verifyClassificationResult(validClassification, new Set(["goal-ai"]));

    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("expected verification to succeed");

    expect(verified.result.items).toHaveLength(2);
    expect(verified.result.items[1]?.candidateGoals).toEqual([]);
  });

  it("非実在 goalId は invalid_goal_id として schema invalidity と区別する", () => {
    const verified = verifyClassificationResult(validClassification, new Set(["other-goal"]));

    expect(verified).toEqual({
      ok: false,
      reason: "invalid_goal_id",
      goalIds: ["goal-ai"],
    });
  });
});
