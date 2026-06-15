// notifications のアラートトリガ算出ユニットテスト(task 2.1 / Req 4.7)。
//
// 完了条件: サイクル終了日と現在日付の既知の組について、期待される残り日数(UTC 暦日)が返ること。
// 残日数は未来で正、終了当日で 0、過去で負。`now` の時刻成分は暦日差を変えない。解析不能な日付は throw。

import { describe, expect, it } from "vitest";
import {
  daysUntilCycleEnd,
  evaluateTriggers,
  type TriggerInput,
} from "../src/notifications/alert/triggers";

// evaluateTriggers の既定入力ヘルパ。各テストは関心のあるフィールドのみ上書きする。
// 既定値はどのトリガも成立しない状態(初回でない・Green 維持・証跡新鮮・残日数十分)に揃える。
function makeInput(overrides: Partial<TriggerInput> = {}): TriggerInput {
  return {
    goalId: "goal-1",
    goalTitle: "目標タイトル",
    newStatus: "green",
    previousStatus: "green",
    latestEvidenceAgeDays: 0,
    daysUntilCycleEnd: 90,
    ...overrides,
  };
}

describe("daysUntilCycleEnd", () => {
  it("終了日の 30 日前は 30 を返す", () => {
    expect(daysUntilCycleEnd("2026-09-30", new Date("2026-08-31T00:00:00Z"))).toBe(30);
  });

  it("終了日の 14 日前は 14 を返す", () => {
    expect(daysUntilCycleEnd("2026-09-30", new Date("2026-09-16T00:00:00Z"))).toBe(14);
  });

  it("終了当日は 0 を返す", () => {
    expect(daysUntilCycleEnd("2026-09-30", new Date("2026-09-30T00:00:00Z"))).toBe(0);
  });

  it("終了日を過ぎている場合は負値を返す(1 日後 → -1)", () => {
    expect(daysUntilCycleEnd("2026-09-30", new Date("2026-10-01T00:00:00Z"))).toBe(-1);
  });

  it("now の時刻成分は暦日差を変えない(同日 23:00 でも UTC 暦日で算出)", () => {
    expect(daysUntilCycleEnd("2026-09-30", new Date("2026-09-01T23:00:00Z"))).toBe(29);
  });

  it("ISO8601 timestamp 形式の終了日も時刻成分を切り捨てて算出する", () => {
    expect(daysUntilCycleEnd("2026-09-30T12:00:00Z", new Date("2026-09-16T00:00:00Z"))).toBe(14);
  });

  it("解析不能な終了日入力は throw する", () => {
    expect(() => daysUntilCycleEnd("not-a-date", new Date("2026-09-01T00:00:00Z"))).toThrow();
  });

  it("Invalid Date の now 入力は throw する", () => {
    expect(() => daysUntilCycleEnd("2026-09-30", new Date("not-a-date"))).toThrow();
  });
});

describe("evaluateTriggers", () => {
  // 1 つの kind のトリガを抽出するヘルパ(成立件数の検証用)。
  function kinds(fired: ReturnType<typeof evaluateTriggers>): string[] {
    return fired.map((f) => f.kind);
  }

  describe("状態悪化遷移(Req 3.2, 4.2, 4.3)", () => {
    it("Green→Yellow で green_to_yellow がちょうど 1 件成立する", () => {
      const fired = evaluateTriggers(
        makeInput({ previousStatus: "green", newStatus: "yellow" }),
      );
      const gy = fired.filter((f) => f.kind === "green_to_yellow");
      expect(gy).toHaveLength(1);
      expect(gy[0].goalId).toBe("goal-1");
      expect(gy[0].goalTitle).toBe("目標タイトル");
      expect(gy[0].newStatus).toBe("yellow");
      expect(gy[0].reasons.length).toBeGreaterThan(0);
      // 理由行に状態悪化の old→new が反映される。
      expect(gy[0].reasons.join("")).toContain("yellow");
    });

    it("Yellow→Red で yellow_to_red がちょうど 1 件成立する", () => {
      const fired = evaluateTriggers(
        makeInput({ previousStatus: "yellow", newStatus: "red" }),
      );
      const yr = fired.filter((f) => f.kind === "yellow_to_red");
      expect(yr).toHaveLength(1);
      expect(yr[0].newStatus).toBe("red");
      expect(yr[0].reasons.length).toBeGreaterThan(0);
      expect(yr[0].reasons.join("")).toContain("red");
    });

    it("改善遷移(Yellow→Green)や同状態維持では遷移トリガは成立しない", () => {
      expect(
        kinds(evaluateTriggers(makeInput({ previousStatus: "yellow", newStatus: "green" }))),
      ).not.toContain("green_to_yellow");
      expect(
        kinds(evaluateTriggers(makeInput({ previousStatus: "green", newStatus: "green" }))),
      ).toEqual([]);
      // Green→Red の一足飛び悪化は green_to_yellow / yellow_to_red のいずれにも該当しない。
      expect(
        kinds(evaluateTriggers(makeInput({ previousStatus: "green", newStatus: "red" }))),
      ).toEqual([]);
    });
  });

  describe("初回判定(Req 3.4)", () => {
    it("初回(previousStatus===null)で newStatus=yellow でも遷移トリガは成立しない", () => {
      const fired = evaluateTriggers(
        makeInput({ previousStatus: null, newStatus: "yellow" }),
      );
      expect(kinds(fired)).not.toContain("green_to_yellow");
      expect(kinds(fired)).not.toContain("yellow_to_red");
    });

    it("初回(previousStatus===null)で newStatus=red でも遷移トリガは成立しない", () => {
      const fired = evaluateTriggers(
        makeInput({ previousStatus: null, newStatus: "red" }),
      );
      expect(kinds(fired)).not.toContain("green_to_yellow");
      expect(kinds(fired)).not.toContain("yellow_to_red");
    });

    it("初回でも停滞・期限トリガは previousStatus に依存せず独立に成立する", () => {
      const fired = evaluateTriggers(
        makeInput({
          previousStatus: null,
          newStatus: "yellow",
          latestEvidenceAgeDays: 20,
          daysUntilCycleEnd: 10,
        }),
      );
      // 遷移は抑止されるが、停滞 / 期限は成立する。
      expect(kinds(fired)).not.toContain("green_to_yellow");
      expect(kinds(fired)).not.toContain("yellow_to_red");
      expect(kinds(fired)).toContain("no_evidence_2w");
      expect(kinds(fired)).toContain("cycle_end_30d");
      expect(kinds(fired)).toContain("cycle_end_14d");
    });
  });

  describe("証跡なし2週継続(Req 4.4)", () => {
    it("latestEvidenceAgeDays=14 で no_evidence_2w が成立する", () => {
      const fired = evaluateTriggers(makeInput({ latestEvidenceAgeDays: 14 }));
      const ne = fired.filter((f) => f.kind === "no_evidence_2w");
      expect(ne).toHaveLength(1);
      expect(ne[0].reasons.length).toBeGreaterThan(0);
      expect(ne[0].reasons.join("")).toContain("14");
    });

    it("latestEvidenceAgeDays=20 でも no_evidence_2w が成立する", () => {
      expect(
        kinds(evaluateTriggers(makeInput({ latestEvidenceAgeDays: 20 }))),
      ).toContain("no_evidence_2w");
    });

    it("latestEvidenceAgeDays=5 では no_evidence_2w は成立しない", () => {
      expect(
        kinds(evaluateTriggers(makeInput({ latestEvidenceAgeDays: 5 }))),
      ).not.toContain("no_evidence_2w");
    });

    it("latestEvidenceAgeDays=null(証跡 0 件)では no_evidence_2w は成立しない", () => {
      // null は「証跡アンカー無し = 年齢計測不能」であり age ベースの本トリガは成立させない。
      expect(
        kinds(evaluateTriggers(makeInput({ latestEvidenceAgeDays: null }))),
      ).not.toContain("no_evidence_2w");
    });
  });

  describe("半期終了期限トリガ(Req 4.5, 4.6)", () => {
    it("daysUntilCycleEnd=30 で cycle_end_30d が成立する(14d は非成立)", () => {
      const fired = evaluateTriggers(makeInput({ daysUntilCycleEnd: 30 }));
      expect(kinds(fired)).toContain("cycle_end_30d");
      expect(kinds(fired)).not.toContain("cycle_end_14d");
      const ce = fired.filter((f) => f.kind === "cycle_end_30d");
      expect(ce[0].reasons.join("")).toContain("30");
    });

    it("daysUntilCycleEnd=14 で cycle_end_30d と cycle_end_14d の両方が成立する", () => {
      const fired = evaluateTriggers(makeInput({ daysUntilCycleEnd: 14 }));
      expect(kinds(fired)).toContain("cycle_end_30d");
      expect(kinds(fired)).toContain("cycle_end_14d");
    });

    it("daysUntilCycleEnd=40 では期限トリガは成立しない", () => {
      const fired = evaluateTriggers(makeInput({ daysUntilCycleEnd: 40 }));
      expect(kinds(fired)).not.toContain("cycle_end_30d");
      expect(kinds(fired)).not.toContain("cycle_end_14d");
    });
  });

  describe("複合入力", () => {
    it("複数トリガ成立時は kind ごとに別エントリを返す", () => {
      const fired = evaluateTriggers(
        makeInput({
          previousStatus: "yellow",
          newStatus: "red",
          latestEvidenceAgeDays: 20,
          daysUntilCycleEnd: 10,
        }),
      );
      const k = kinds(fired);
      expect(k).toContain("yellow_to_red");
      expect(k).toContain("no_evidence_2w");
      expect(k).toContain("cycle_end_30d");
      expect(k).toContain("cycle_end_14d");
      expect(fired).toHaveLength(4);
      // すべてのエントリが goalId / goalTitle / newStatus を入力から引き継ぐ。
      for (const f of fired) {
        expect(f.goalId).toBe("goal-1");
        expect(f.goalTitle).toBe("目標タイトル");
        expect(f.newStatus).toBe("red");
        expect(f.reasons.length).toBeGreaterThan(0);
      }
    });
  });
});
