import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { cycleAgentName, goalAgentName } from "../src/agents/ids";
import type { GoalRow } from "../src/types";

// GoalAgent のデータ委譲(ステートレス境界)の統合テスト(Req 3.1, 3.5)。
//
// 実行プロジェクト: "workers"(Cloudflare Workers ランタイム + DO SQLite)。
// 検証内容:
//  - GoalAgent は自前の SQLite を持たず、書き込みを親 EvaluationCycleAgent の
//    データ権威リポジトリへ委譲する。
//  - GoalAgent 経由の書き込みが、親サイクルの単一 SQLite に反映される
//    (= 親 EvaluationCycleAgent から同じ行が独立に読める)。これが本タスクの
//    完了条件(GoalAgent からの操作が親リポジトリ経由で同一 SQLite に反映される)。

const USER_ID = "u1";
const CYCLE_ID = "c1";
const GOAL_ID = "g1";

function makeGoalRow(id: string): GoalRow {
  return {
    id,
    cycle_id: CYCLE_ID,
    user_id: USER_ID,
    title: "AI 活用を定着させる",
    description: "日次の検証サイクルを回す",
    success_criteria: null,
    evaluation_points: null,
    status: "gray",
    created_at: "2026-06-14T00:00:00Z",
    updated_at: "2026-06-14T00:00:00Z",
  };
}

describe("GoalAgent: 親サイクルへのデータ委譲(ステートレス境界)", () => {
  it("GoalAgent の書き込みが親 EvaluationCycleAgent の同一 SQLite に反映される", async () => {
    const goalStub = env.GoalAgent.getByName(goalAgentName(USER_ID, CYCLE_ID, GOAL_ID));
    const row = makeGoalRow(GOAL_ID);

    // GoalAgent 経由で書き込む(親へ委譲される)。
    await goalStub.insertRow("goals", row);

    // 親サイクル Agent から独立に読み出し、同じ行が見えることを検証する
    // (GoalAgent の書き込みが親の単一 SQLite に着地した証跡)。
    const cycleStub = env.EvaluationCycleAgent.getByName(cycleAgentName(USER_ID, CYCLE_ID));
    const readFromParent = await cycleStub.getRowById("goals", GOAL_ID);
    expect(readFromParent).toEqual(row);
  });

  it("GoalAgent の委譲ゲッターは親と同じ行を返す", async () => {
    const goalId = "g2";
    const goalStub = env.GoalAgent.getByName(goalAgentName(USER_ID, CYCLE_ID, goalId));
    const row = makeGoalRow(goalId);

    await goalStub.insertRow("goals", row);

    const readFromGoal = await goalStub.getRowById("goals", goalId);
    expect(readFromGoal).toEqual(row);
  });
});
