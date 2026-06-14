import { describe, expect, expectTypeOf, it } from "vitest";
import {
  DRAFT_TYPES,
  type EntityRow,
  EVIDENCE_SOURCE_TYPES,
  GOAL_STATUSES,
  type GoalRow,
  MILESTONE_STATUSES,
  USEFULNESS_VALUES,
} from "../src/types";

describe("shared domain types: single entry import", () => {
  it("exposes goal status values including the 'gray' default", () => {
    expect(GOAL_STATUSES).toEqual(["green", "yellow", "red", "gray"]);
    expect(GOAL_STATUSES).toContain("gray");
  });

  it("exposes milestone status values including 'dropped'", () => {
    expect(MILESTONE_STATUSES).toEqual(["todo", "doing", "done", "dropped"]);
    expect(MILESTONE_STATUSES).toContain("dropped");
  });

  it("exposes all evidence source types", () => {
    expect(EVIDENCE_SOURCE_TYPES).toEqual([
      "manual_checkin",
      "discord_message",
      "github_pr",
      "meeting_note",
      "calendar_event",
      "other",
    ]);
  });

  it("exposes usefulness values including the 'medium' default", () => {
    expect(USEFULNESS_VALUES).toEqual(["low", "medium", "high"]);
    expect(USEFULNESS_VALUES).toContain("medium");
  });

  it("exposes all draft types", () => {
    expect(DRAFT_TYPES).toEqual([
      "self_evaluation",
      "one_on_one",
      "manager_summary",
      "short_summary",
    ]);
  });

  it("compiles an example typed row and the EntityRow mapping", () => {
    const goal: GoalRow = {
      id: "g1",
      cycle_id: "c1",
      user_id: "u1",
      title: "AI 活用",
      description: "生成AIを業務に活用する",
      success_criteria: null,
      evaluation_points: null,
      status: "gray",
      created_at: "2026-06-14T00:00:00Z",
      updated_at: "2026-06-14T00:00:00Z",
    };
    expect(goal.status).toBe("gray");

    // EntityRow<'goals'> は GoalRow と一致する(Repository が利用する型解決)。
    expectTypeOf<EntityRow<"goals">>().toEqualTypeOf<GoalRow>();
  });
});
