import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { getCycleAgent, getGoalAgent } from "../src/agents/routing";
import type { Env } from "../src/env";
import { createLlmClient } from "../src/llm/factory";
import type { EvaluationCycleRow, GoalRow } from "../src/types";

// インフラ基盤の END-TO-END 統合テスト(Task 6.3、design.md「Testing Strategy → Integration Tests」)。
//
// 各構成要素の単体疎通は専用テストで網羅済み:
//  - routing.test.ts        : getCycleAgent/getGoalAgent の同一インスタンス解決(3.3, 3.4, 3.6)
//  - evaluation-cycle-agent.test.ts : 起動時スキーマ初期化 + リポジトリ往復(3.5 init)
//  - goal-agent.test.ts     : GoalAgent → 親 SQLite 委譲(3.5 delegation)
//  - llm-workers-ai.test.ts : createLlmClient + モック AI で complete 成功(4.2-4.4)
//
// 本ファイルはそれらを「1 本の連続フロー」に束ね、ルーティング → 委譲 →
// LLM ファクトリ疎通が一貫して結合動作することを統合レベルで検証する
// (完了条件: ルーティング・委譲・LLM ファクトリ疎通の統合テストが通る)。
//
// 実行プロジェクト: "workers"(Cloudflare Workers ランタイム + 実 DO SQLite)。
//  - ルーティング/委譲は実 DO 上で実行する。
//  - LLM は createLlmClient に AI を差し替えた Env を渡してモック AI で疎通させる
//    (env.AI は remote=true の実 Workers AI のため、本物は呼ばない)。

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

describe("インフラ基盤 統合フロー: ルーティング + 委譲 + LLM ファクトリ疎通", () => {
  it("ルーティング(同一インスタンス)→ スキーマ初期化 → GoalAgent 委譲 → LLM ファクトリ補完が一貫して結合動作する", async () => {
    const cycleId = "it-c1";
    const goalId = "it-g1";

    // --- 1. ルーティングで cycle Agent を取得し、起動時スキーマ初期化を確認する(Req 3.3, 3.5) ---
    // 起動時(onStart/コンストラクタ)にスキーマが初期化済みなら、最初の read RPC が
    // 例外なく解決する。未作成テーブルへの問い合わせは null を返す(スキーマ存在の証跡)。
    const cycle = await getCycleAgent(env, USER_ID, cycleId);
    expect(await cycle.getRowById("evaluation_cycles", cycleId)).toBeNull();

    // cycle Agent 経由でサイクル行を書き込む(データ権威への書き込み)。
    const cycleRow = makeCycleRow(cycleId);
    await cycle.insertRow("evaluation_cycles", cycleRow);

    // --- 2. 同一引数の再取得が同一論理インスタンスに解決する(Req 3.6) ---
    // 別スタブから先の書き込みが見えれば、両者は同一 SQLite を共有する同一論理 DO。
    const cycleAgain = await getCycleAgent(env, USER_ID, cycleId);
    expect(await cycleAgain.getRowById("evaluation_cycles", cycleId)).toEqual(cycleRow);

    // --- 3. GoalAgent の操作が親サイクルの同一 SQLite に委譲反映される(Req 3.4, 3.5) ---
    const goal = await getGoalAgent(env, USER_ID, cycleId, goalId);
    const goalRow = makeGoalRow(goalId, cycleId);
    await goal.insertRow("goals", goalRow);

    // 親 cycle Agent(独立に取得)から同じ goal 行が読める = 親リポジトリ経由で
    // 単一 SQLite に着地した証跡(委譲が成立している)。
    const cycleForGoal = await getCycleAgent(env, USER_ID, cycleId);
    expect(await cycleForGoal.getRowById("goals", goalId)).toEqual(goalRow);

    // --- 4. LLM ファクトリ疎通: createLlmClient が返すクライアントが ---
    //         バインディング(モック AI)経由で補完を返す(Req 4.2, 4.3, 4.4) ---
    // env.AI は remote=true の実 Workers AI のため、AI のみ差し替えた Env を渡して
    // モック AI で疎通させる(本物の Workers AI は呼ばない)。
    const run = vi.fn(async () => ({ response: "integration ok" }));
    const llmEnv = { ...env, AI: { run } as unknown as Ai } as Env;

    const client = createLlmClient(llmEnv);
    expect(typeof client.complete).toBe("function");
    expect(typeof client.completeJson).toBe("function");

    const completion = await client.complete({ prompt: "ping" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(completion).toEqual({ ok: true, value: "integration ok" });
  });
});
