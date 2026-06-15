import { describe, expect, it } from "vitest";
import { assertOwned } from "../src/goal-management/ownership";
import type { EvaluationCycleRow, EvidenceRow, GoalRow } from "../src/types";

/** 完全項目の GoalRow を生成する。 */
function makeGoal(overrides: Partial<GoalRow> = {}): GoalRow {
  return {
    id: "goal-1",
    cycle_id: "cyc-1",
    user_id: "user-1",
    title: "目標",
    description: "本文",
    success_criteria: null,
    evaluation_points: null,
    status: "gray",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** 完全項目の EvidenceRow を生成する。 */
function makeEvidence(overrides: Partial<EvidenceRow> = {}): EvidenceRow {
  return {
    id: "ev-1",
    cycle_id: "cyc-1",
    user_id: "user-1",
    source_type: "manual",
    source_url: null,
    title: null,
    body: "本文",
    evidence_date: "2026-01-01",
    usefulness: "high",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** 完全項目の EvaluationCycleRow を生成する。 */
function makeCycle(overrides: Partial<EvaluationCycleRow> = {}): EvaluationCycleRow {
  return {
    id: "cyc-1",
    user_id: "user-1",
    name: "サイクル",
    start_date: "2026-01-01",
    end_date: "2026-03-31",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("assertOwned (Req 4.1, 4.2, 3.4)", () => {
  it("row が null なら null を返す (goals)", () => {
    expect(assertOwned<"goals">(null, "user-1")).toBeNull();
  });

  it("user_id 一致なら同一行を返す (goals)", () => {
    const row = makeGoal({ user_id: "user-1" });
    expect(assertOwned(row, "user-1")).toBe(row);
  });

  it("user_id 不一致なら null(不存在扱い)を返す (goals)", () => {
    const row = makeGoal({ user_id: "user-2" });
    expect(assertOwned(row, "user-1")).toBeNull();
  });

  it("user_id 一致なら同一行を返す (evidence)", () => {
    const row = makeEvidence({ user_id: "user-1" });
    expect(assertOwned(row, "user-1")).toBe(row);
  });

  it("user_id 不一致なら null を返す (evidence)", () => {
    const row = makeEvidence({ user_id: "user-2" });
    expect(assertOwned(row, "user-1")).toBeNull();
  });

  it("user_id 一致なら同一行を返す (evaluation_cycles)", () => {
    const row = makeCycle({ user_id: "user-1" });
    expect(assertOwned(row, "user-1")).toBe(row);
  });

  it("user_id 不一致なら null を返す (evaluation_cycles)", () => {
    const row = makeCycle({ user_id: "user-2" });
    expect(assertOwned(row, "user-1")).toBeNull();
  });

  it("null 入力は型を問わず null (evidence)", () => {
    expect(assertOwned<"evidence">(null, "user-1")).toBeNull();
  });
});
