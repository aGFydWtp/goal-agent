// checkin-classification のメッセージ整形ヘルパーの検証
// (Req 1.1, 2.5, 3.1, 5.3, 5.4 / design.md Message Formatter)。

import { describe, expect, it } from "vitest";
import type { ClassificationResult } from "../src/checkin-classification/classification/schema";
import type { WeeklyReview } from "../src/checkin-classification/weekly-review/schema";
import {
  formatCheckinPromptMessage,
  formatClassificationConfirmation,
  formatPostSaveMessage,
} from "../src/checkin-classification/messages";

const classification = {
  items: [
    {
      text: "AI を使った議事録要約をチームに展開した",
      candidateGoals: [
        {
          goalId: "goal-ai",
          relevanceScore: 0.92,
          reason: "AI 活用の定着に直接関係する",
        },
        {
          goalId: "goal-ops",
          relevanceScore: 0.54,
          reason: "定例運用の効率化にもつながる",
        },
      ],
      usefulness: "high",
      suggestedEvidenceTitle: "AI 議事録要約のチーム展開",
    },
    {
      text: "オンコール手順の抜け漏れを直した",
      candidateGoals: [
        {
          goalId: "goal-ops",
          relevanceScore: 0.86,
          reason: "運用品質の改善に関係する",
        },
      ],
      usefulness: "medium",
      suggestedEvidenceTitle: "オンコール手順の改善",
    },
    {
      text: "オフィスの席替えを手伝った",
      candidateGoals: [],
      usefulness: "low",
      suggestedEvidenceTitle: "席替え支援",
    },
  ],
} satisfies ClassificationResult;

const goals = [
  { id: "goal-ai", title: "AI 活用の定着" },
  { id: "goal-ops", title: "運用品質の改善" },
] as const;

const review = {
  summary: "今週は AI 活用と運用品質の両方で前進がありました。",
  risks: ["AI 活用の事例記録がまだ薄いです", "オンコール手順の共有が未完了です"],
  next_actions: ["議事録要約 bot の利用事例を 2 件残す", "オンコール手順の変更点をチームへ共有する"],
} satisfies WeeklyReview;

describe("formatCheckinPromptMessage", () => {
  it("§8.3 の /checkin 促し文を返す", () => {
    expect(formatCheckinPromptMessage()).toBe(
      "今週やったことを雑に書いてください。評価目標に関係あるかどうかはこちらで分類します。",
    );
  });
});

describe("formatClassificationConfirmation", () => {
  it("分類結果を §14.1 の目標別グルーピング + 未分類 + 保存確認へ整形する", () => {
    const message = formatClassificationConfirmation(classification, goals);

    expect(message).toContain("分類案を作りました");
    expect(message).toContain("## AI 活用の定着");
    expect(message).toContain("AI を使った議事録要約をチームに展開した");
    expect(message).toContain("証跡タイトル: AI 議事録要約のチーム展開");
    expect(message).toContain("有用度: high");
    expect(message).toContain("関連度: 0.92");
    expect(message).toContain("理由: AI 活用の定着に直接関係する");

    expect(message).toContain("## 運用品質の改善");
    expect(message).toContain("関連度: 0.54");
    expect(message).toContain("オンコール手順の抜け漏れを直した");
    expect(message).toContain("関連度: 0.86");

    expect(message).toContain("## 未分類");
    expect(message).toContain("オフィスの席替えを手伝った");
    expect(message).toContain("証跡タイトル: 席替え支援");
    expect(message).toContain("この内容で保存しますか?");
  });

  it("未知の goalId は ID を見出しにして決定的に出力する", () => {
    const message = formatClassificationConfirmation(
      {
        items: [
          {
            text: "別管理の目標に関係しそうな作業",
            candidateGoals: [
              {
                goalId: "goal-unknown",
                relevanceScore: 0.7,
                reason: "候補目標 ID が結果に含まれている",
              },
            ],
            usefulness: "medium",
            suggestedEvidenceTitle: "別管理目標の作業",
          },
        ],
      },
      goals,
    );

    expect(message).toContain("## goal-unknown");
    expect(message).toContain("この内容で保存しますか?");
  });
});

describe("formatPostSaveMessage", () => {
  it("§14.2 の保存完了 + 見立て + 来週やるとよいことを整形する", () => {
    const message = formatPostSaveMessage(review, {
      goalLabel: "AI 活用の定着",
      status: "Yellow",
      reason: "成果は出ているが、事例数が目標に少し足りません。",
    });

    expect(message).toContain("保存しました");
    expect(message).toContain("## 今週の見立て");
    expect(message).toContain("今週は AI 活用と運用品質の両方で前進がありました。");
    expect(message).toContain("AI 活用の定着: Yellow");
    expect(message).toContain("成果は出ているが、事例数が目標に少し足りません。");
    expect(message).toContain("## 気になるリスク");
    expect(message).toContain("AI 活用の事例記録がまだ薄いです");
    expect(message).toContain("## 来週やるとよいこと");
    expect(message).toContain("議事録要約 bot の利用事例を 2 件残す");
  });

  it("ステータス見立てが未指定なら見立て本文だけを残し、ステータス欄は省略する", () => {
    const message = formatPostSaveMessage(review);

    expect(message).toContain("保存しました");
    expect(message).toContain("## 今週の見立て");
    expect(message).toContain("今週は AI 活用と運用品質の両方で前進がありました。");
    expect(message).not.toContain("ステータス");
    expect(message).not.toContain("Yellow");
    expect(message).toContain("## 来週やるとよいこと");
  });
});
