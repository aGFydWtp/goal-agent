// checkin-classification の分類/週次レビュープロンプトとレビュー出力 schema の検証
// (Req 2.1, 2.2, 5.1 / design.md Classification Prompt + Schema + Verify, Weekly Review Prompt + Schema)。

import { describe, expect, expectTypeOf, it } from "vitest";
import { buildClassificationPrompt } from "../src/checkin-classification/classification/prompt";
import { buildWeeklyReviewPrompt } from "../src/checkin-classification/weekly-review/prompt";
import {
  type WeeklyReview,
  weeklyReviewSchema,
} from "../src/checkin-classification/weekly-review/schema";

const goals = [
  {
    id: "goal-ai",
    title: "AI 活用の定着",
    description: "チームが日常業務で生成 AI を安全に使える状態を作る",
    success_criteria: "週 3 件以上の利用事例とガイドライン更新",
  },
  {
    id: "goal-reliability",
    title: "運用品質の改善",
    description: "障害対応の再発防止と監視精度を上げる",
    success_criteria: null,
  },
] as const;

describe("buildClassificationPrompt", () => {
  it("目標一覧・達成条件・今週の入力を §13.1 分類プロンプト本文へ反映する", () => {
    const request = buildClassificationPrompt({
      goals,
      rawText: "議事録要約 bot を作った。オンコール手順も見直した。",
    });

    expect(request.system).toContain("評価目標");
    expect(request.system).toContain("JSON");
    expect(request.prompt).toContain("goal-ai");
    expect(request.prompt).toContain("AI 活用の定着");
    expect(request.prompt).toContain("チームが日常業務で生成 AI を安全に使える状態を作る");
    expect(request.prompt).toContain("週 3 件以上の利用事例とガイドライン更新");
    expect(request.prompt).toContain("goal-reliability");
    expect(request.prompt).toContain("運用品質の改善");
    expect(request.prompt).toContain("達成条件: 未設定");
    expect(request.prompt).toContain("議事録要約 bot を作った。オンコール手順も見直した。");
  });

  it("§13.1 の items/text/candidateGoals/goalId/relevanceScore/reason/usefulness/suggestedEvidenceTitle と未分類を明示する", () => {
    const request = buildClassificationPrompt({
      goals,
      rawText: "席替えを手伝った",
    });

    expect(request.prompt).toContain("items");
    expect(request.prompt).toContain("text");
    expect(request.prompt).toContain("candidateGoals");
    expect(request.prompt).toContain("goalId");
    expect(request.prompt).toContain("relevanceScore");
    expect(request.prompt).toContain("reason");
    expect(request.prompt).toContain("usefulness");
    expect(request.prompt).toContain("suggestedEvidenceTitle");
    expect(request.prompt).toContain("candidateGoals: []");
  });
});

describe("weeklyReviewSchema", () => {
  it("summary/risks/next_actions を zod v4 schema の単一ソースとして検証する", () => {
    const parsed = weeklyReviewSchema.safeParse({
      summary: "今週は AI 活用と運用改善が前進した。",
      risks: ["利用事例の記録が不足している"],
      next_actions: ["ガイドライン更新 PR を出す"],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("expected weekly review parse to succeed");

    expect(parsed.data.next_actions).toEqual(["ガイドライン更新 PR を出す"]);
    expectTypeOf<WeeklyReview>().toEqualTypeOf<typeof parsed.data>();
  });

  it("必須キーが欠けた出力を拒否する", () => {
    expect(
      weeklyReviewSchema.safeParse({
        summary: "今週のまとめ",
        risks: [],
      }).success,
    ).toBe(false);
  });
});

describe("buildWeeklyReviewPrompt", () => {
  it("保存済み checkin/evidence と summary/risks/next_actions 要求をプロンプトへ反映する", () => {
    const request = buildWeeklyReviewPrompt({
      goals,
      weekStartDate: "2026-06-08",
      checkins: [
        {
          id: "checkin-1",
          raw_text: "議事録要約 bot を作り、オンコール手順を見直した。",
        },
      ],
      evidence: [
        {
          id: "evidence-1",
          title: "議事録要約 bot の試作",
          body: "チーム定例の議事録要約を自動化した",
          usefulness: "high",
          linkedGoals: [
            {
              goalId: "goal-ai",
              relevanceScore: 0.91,
              reason: "AI 活用の具体的な導入実績",
            },
          ],
        },
      ],
    });

    expect(request.system).toContain("週次レビュー");
    expect(request.system).toContain("JSON");
    expect(request.prompt).toContain("2026-06-08");
    expect(request.prompt).toContain("議事録要約 bot を作り、オンコール手順を見直した。");
    expect(request.prompt).toContain("議事録要約 bot の試作");
    expect(request.prompt).toContain("チーム定例の議事録要約を自動化した");
    expect(request.prompt).toContain("goal-ai");
    expect(request.prompt).toContain("0.91");
    expect(request.prompt).toContain("summary");
    expect(request.prompt).toContain("risks");
    expect(request.prompt).toContain("next_actions");
  });
});
