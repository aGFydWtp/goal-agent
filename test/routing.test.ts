import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getCycleAgent, getGoalAgent } from "../src/agents/routing";
import { cycleAgentName } from "../src/agents/ids";
import type { EvaluationCycleRow, GoalRow } from "../src/types";

// Agent 取得ルーティングヘルパーの統合テスト(Req 3.3, 3.4, 3.6)。
//
// 実行プロジェクト: "workers"(Cloudflare Workers ランタイム + DO SQLite)。
// 検証内容:
//  - getCycleAgent / getGoalAgent が §6 規約名で実 DO スタブを取得する。
//  - 同一引数の複数回取得が同一論理 Agent インスタンスに解決する(Req 3.6)。
//    片方のスタブで書いた行をもう片方のスタブ(または親)で読めることで、
//    両者が同じ状態(同一 SQLite)を共有する = 同一論理インスタンスであると証明する。
//  - 取得後の Agent がそのまま利用可能になる(Req 3.3, 3.4):
//    cycle スタブはデータ権威呼び出しに、goal スタブは親委譲呼び出しに応答する。

const USER_ID = "u1";

function makeCycleRow(id: string): EvaluationCycleRow {
  return {
    id,
    user_id: USER_ID,
    name: "2026 H1",
    start_date: "2026-01-01",
    end_date: "2026-06-30",
    created_at: "2026-06-14T00:00:00Z",
    updated_at: "2026-06-14T00:00:00Z",
  };
}

function makeGoalRow(id: string, cycleId: string): GoalRow {
  return {
    id,
    cycle_id: cycleId,
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

describe("getCycleAgent: EvaluationCycleAgent 取得ルーティング", () => {
  it("同一 (userId, cycleId) の 2 回取得が同一論理インスタンスに解決する(Req 3.6)", async () => {
    const cycleId = "rc1";
    const row = makeCycleRow(cycleId);

    // 1 回目のスタブで書き込み、2 回目のスタブで読み出す。
    // 同じ行が見えれば両者は同一論理 DO(同一 SQLite)に解決している。
    const first = await getCycleAgent(env, USER_ID, cycleId);
    await first.insertRow("evaluation_cycles", row);

    const second = await getCycleAgent(env, USER_ID, cycleId);
    const read = await second.getRowById("evaluation_cycles", cycleId);
    expect(read).toEqual(row);
  });

  it("取得後の cycle スタブがデータ権威呼び出しに応答する(Req 3.3)", async () => {
    const cycleId = "rc2";
    const stub = await getCycleAgent(env, USER_ID, cycleId);
    const row = makeCycleRow(cycleId);

    await stub.insertRow("evaluation_cycles", row);
    expect(await stub.getRowById("evaluation_cycles", cycleId)).toEqual(row);
  });
});

describe("getGoalAgent: GoalAgent 取得ルーティング", () => {
  it("同一 (userId, cycleId, goalId) の 2 回取得が同一論理インスタンスに解決する(Req 3.6)", async () => {
    const cycleId = "rc3";
    const goalId = "rg1";
    const row = makeGoalRow(goalId, cycleId);

    // 1 回目の goal スタブで書き込み、2 回目の goal スタブで読み出す。
    // GoalAgent はステートレスだが、同一論理インスタンスなら同じ親へ委譲するため
    // 同じ行が見える。
    const first = await getGoalAgent(env, USER_ID, cycleId, goalId);
    await first.insertRow("goals", row);

    const second = await getGoalAgent(env, USER_ID, cycleId, goalId);
    const read = await second.getRowById("goals", goalId);
    expect(read).toEqual(row);
  });

  it("取得後の goal スタブの書き込みが親サイクルの同一 SQLite に着地する(Req 3.4, 3.6)", async () => {
    const cycleId = "rc4";
    const goalId = "rg2";
    const row = makeGoalRow(goalId, cycleId);

    // goal スタブ経由で書き込む(親へ委譲される)。
    const goalStub = await getGoalAgent(env, USER_ID, cycleId, goalId);
    await goalStub.insertRow("goals", row);

    // 同じ引数の getCycleAgent から独立に読み、親の単一 SQLite に着地したことを確認する。
    const cycleStub = await getCycleAgent(env, USER_ID, cycleId);
    const readFromParent = await cycleStub.getRowById("goals", goalId);
    expect(readFromParent).toEqual(row);
  });

  it("ルーティング名は ids.ts の規約に一致する(回帰防止)", () => {
    // ヘルパーが独自に名前を再導出していないことの間接確認:
    // 親スタブ取得に使う cycle 名が ids.ts と一致する規約であることを固定する。
    expect(cycleAgentName(USER_ID, "rc4")).toBe(`evaluation:${USER_ID}:rc4`);
  });
});
