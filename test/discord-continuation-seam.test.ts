import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeferredContinuationEnvelope } from "../src/discord/types";

// infra EvaluationCycleAgent への deferred-continuation seam 配線(task 7.4)の結合テスト
// (Req 8.2, 8.8)。
//
// 実行プロジェクト: "workers"(Cloudflare Workers ランタイム + DO SQLite)。`@callable` の
// デコレータ変換と `this.schedule()` の DO alarm 基盤を要するため node 環境では実行できない。
//
// 検証内容(完了条件):
//  1. `scheduleDeferredContinuation(envelope)` が呼ばれると、callback が
//     `"runDeferredContinuation"` で envelope を payload に載せた one-shot(delayed)
//     スケジュールが 1 件登録される。
//  2. alarm callback `runDeferredContinuation(envelope)` は gateway substrate runner
//     `runScheduledContinuation(env, envelope)` へ委譲するのみ(業務ロジックを持たない)。

// gateway substrate runner をスパイ対象にする。seam は委譲のみを行うため、
// `runScheduledContinuation` が `(env, envelope)` で 1 度呼ばれることを検証すれば疎通が示せる。
vi.mock("../src/discord/continuation", () => ({
  runScheduledContinuation: vi.fn(async () => {}),
}));

import { runScheduledContinuation } from "../src/discord/continuation";

afterEach(() => {
  vi.clearAllMocks();
});

/** テスト用の最小 envelope(JSON シリアライズ可能 / Req 8.3)。 */
function makeEnvelope(): DeferredContinuationEnvelope {
  return {
    interactionToken: "tok-abc",
    applicationId: "app-123",
    continuationKey: "feature:do-something",
    payload: { messageId: "m1", attempt: 2 },
  };
}

describe("EvaluationCycleAgent deferred-continuation seam: 登録入口", () => {
  it("scheduleDeferredContinuation は runDeferredContinuation へ one-shot で envelope を載せて登録する (Req 8.2)", async () => {
    const stub = env.EvaluationCycleAgent.getByName("evaluation:seam-u1:primary");
    // RPC を1度通して DO を起動させる。
    await stub.getRowById("evaluation_cycles", "none");

    const envelope = makeEnvelope();

    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as {
        scheduleDeferredContinuation(e: DeferredContinuationEnvelope): Promise<void>;
        listSchedules(criteria?: { type?: "delayed" }): Promise<
          ReadonlyArray<{ callback?: string; payload?: unknown }>
        >;
      };

      await agent.scheduleDeferredContinuation(envelope);

      const schedules = await agent.listSchedules();
      const seam = schedules.filter((s) => s.callback === "runDeferredContinuation");
      expect(seam).toHaveLength(1);
      expect(seam[0]?.payload).toEqual(envelope);
    });
  });
});

describe("EvaluationCycleAgent deferred-continuation seam: alarm 委譲", () => {
  it("runDeferredContinuation は substrate runner へ (env, envelope) で委譲するのみ (Req 8.2, 8.8)", async () => {
    const stub = env.EvaluationCycleAgent.getByName("evaluation:seam-u2:primary");
    await stub.getRowById("evaluation_cycles", "none");

    const envelope = makeEnvelope();

    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as {
        runDeferredContinuation(e: DeferredContinuationEnvelope): Promise<void>;
        env: unknown;
      };

      // この alarm callback はワンショット登録なしで直接呼ぶため、先行テストで登録された
      // 即時 alarm の非決定的な発火がカウントに混入しないよう、直前にモックを初期化する。
      vi.mocked(runScheduledContinuation).mockClear();
      await agent.runDeferredContinuation(envelope);

      expect(runScheduledContinuation).toHaveBeenCalledTimes(1);
      expect(runScheduledContinuation).toHaveBeenCalledWith(agent.env, envelope);
    });
  });
});
