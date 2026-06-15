// status-and-draft のステータス判定ルール前処理(§10.2)の検証
// (Req 1.2, 1.4, 3.5 / design.md「Status Rules + Prompt + Schema + Verify」
//  Service Interface `evaluateRules`・Testing Strategy「evaluateRules」line ~823)。
//
// 完了条件(task 2.1): 直近2週内証跡で Green 候補、3週以上証跡なしで Red 候補、
// 証跡少/達成条件未設定で Gray(insufficientMaterial: 判断材料不足フラグ)が返る。

import { describe, expect, it } from "vitest";
import {
  type GoalStatusContext,
  evaluateRules,
} from "../src/status-and-draft/status/rules";

/** 十分な達成条件・評価観点を備えた基底コンテキスト(個別テストで差分上書き)。 */
function baseContext(overrides: Partial<GoalStatusContext> = {}): GoalStatusContext {
  return {
    goalId: "goal-1",
    title: "新機能のリリース",
    description: "四半期内に新しい検索機能をリリースし利用率を高める。",
    successCriteria: "検索機能をリリースし、利用率を前期比20%向上させる。",
    evaluationPoints: "リリース完了・利用率改善・品質指標の維持。",
    evidence: [
      {
        body: "検索 API の設計レビューを完了し実装に着手した。",
        evidenceDate: "2026-06-10",
        usefulness: "high",
      },
      {
        body: "検索 UI のプロトタイプを社内デモで共有した。",
        evidenceDate: "2026-06-12",
        usefulness: "medium",
      },
    ],
    daysUntilCycleEnd: 60,
    latestEvidenceAgeDays: 3,
    ...overrides,
  };
}

describe("evaluateRules - §10.2 ルール前処理", () => {
  describe("Green 候補(直近2週内証跡)", () => {
    it("直近14日以内に証跡があり達成条件・証跡が十分なら Green 候補を返す", () => {
      const outcome = evaluateRules(baseContext({ latestEvidenceAgeDays: 3 }));

      expect(outcome.candidate).toBe("green");
      expect(outcome.insufficientMaterial).toBe(false);
    });

    it("最新証跡経過が境界値の14日でも Green 候補(直近2週=14日以内)", () => {
      const outcome = evaluateRules(baseContext({ latestEvidenceAgeDays: 14 }));

      expect(outcome.candidate).toBe("green");
      expect(outcome.insufficientMaterial).toBe(false);
    });
  });

  describe("Red 候補(3週以上証跡なし)", () => {
    it("最新証跡経過が21日以上なら Red 候補を返す", () => {
      const outcome = evaluateRules(baseContext({ latestEvidenceAgeDays: 21 }));

      expect(outcome.candidate).toBe("red");
      expect(outcome.insufficientMaterial).toBe(false);
    });

    it("最新証跡経過が30日でも Red 候補", () => {
      const outcome = evaluateRules(baseContext({ latestEvidenceAgeDays: 30 }));

      expect(outcome.candidate).toBe("red");
    });
  });

  describe("Gray 候補(判断材料不足)", () => {
    it("証跡が1件も存在しなければ Gray + insufficientMaterial を返す", () => {
      const outcome = evaluateRules(
        baseContext({ evidence: [], latestEvidenceAgeDays: null }),
      );

      expect(outcome.candidate).toBe("gray");
      expect(outcome.insufficientMaterial).toBe(true);
    });

    it("達成条件(successCriteria)が未設定なら Gray + insufficientMaterial を返す", () => {
      const outcome = evaluateRules(baseContext({ successCriteria: null }));

      expect(outcome.candidate).toBe("gray");
      expect(outcome.insufficientMaterial).toBe(true);
    });

    it("達成条件が空白のみなら未設定と同様に Gray + insufficientMaterial を返す", () => {
      const outcome = evaluateRules(baseContext({ successCriteria: "   " }));

      expect(outcome.candidate).toBe("gray");
      expect(outcome.insufficientMaterial).toBe(true);
    });

    it("証跡が少なすぎる(1件のみ)なら Gray + insufficientMaterial を返す", () => {
      const outcome = evaluateRules(
        baseContext({
          evidence: [
            {
              body: "キックオフのみ実施。",
              evidenceDate: "2026-06-12",
              usefulness: "low",
            },
          ],
          latestEvidenceAgeDays: 3,
        }),
      );

      expect(outcome.candidate).toBe("gray");
      expect(outcome.insufficientMaterial).toBe(true);
    });

    it("目標定義が曖昧(description が短すぎる)なら Gray + insufficientMaterial を返す", () => {
      const outcome = evaluateRules(baseContext({ description: "やる" }));

      expect(outcome.candidate).toBe("gray");
      expect(outcome.insufficientMaterial).toBe(true);
    });
  });

  describe("Yellow 候補(調査偏重・着手はあるが進捗不足)", () => {
    it("直近に証跡はあるが全て low usefulness(調査偏重)なら Yellow 候補を返す", () => {
      const outcome = evaluateRules(
        baseContext({
          evidence: [
            {
              body: "競合調査を実施した。",
              evidenceDate: "2026-06-08",
              usefulness: "low",
            },
            {
              body: "関連ドキュメントを読み込んだ。",
              evidenceDate: "2026-06-11",
              usefulness: "low",
            },
            {
              body: "技術選定の比較表を作成した。",
              evidenceDate: "2026-06-12",
              usefulness: "low",
            },
          ],
          latestEvidenceAgeDays: 3,
        }),
      );

      expect(outcome.candidate).toBe("yellow");
      expect(outcome.insufficientMaterial).toBe(false);
    });

    it("最新証跡が2週超3週未満で半期終了に余裕があれば警告寄りの Yellow 候補", () => {
      const outcome = evaluateRules(
        baseContext({ latestEvidenceAgeDays: 18, daysUntilCycleEnd: 30 }),
      );

      expect(outcome.candidate).toBe("yellow");
      expect(outcome.insufficientMaterial).toBe(false);
    });

    it("半期終了が近い(残日数小)かつ最新証跡が2週超3週未満なら回復余地が乏しく Red 候補へ警告寄せ", () => {
      const outcome = evaluateRules(
        baseContext({ latestEvidenceAgeDays: 18, daysUntilCycleEnd: 5 }),
      );

      expect(outcome.candidate).toBe("red");
      expect(outcome.insufficientMaterial).toBe(false);
    });
  });

  describe("境界・優先順位", () => {
    it("判断材料不足(達成条件未設定)は直近証跡があっても Gray を優先する", () => {
      const outcome = evaluateRules(
        baseContext({ successCriteria: null, latestEvidenceAgeDays: 1 }),
      );

      expect(outcome.candidate).toBe("gray");
      expect(outcome.insufficientMaterial).toBe(true);
    });

    it("最新証跡経過が15日(2週超3週未満)で進捗ありなら Yellow 候補(Green でも Red でもない)", () => {
      const outcome = evaluateRules(baseContext({ latestEvidenceAgeDays: 15 }));

      expect(outcome.candidate).toBe("yellow");
      expect(outcome.insufficientMaterial).toBe(false);
    });
  });
});
