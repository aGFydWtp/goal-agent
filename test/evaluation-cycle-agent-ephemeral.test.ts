import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// EvaluationCycleAgent の汎用揮発 KV サーフェスの統合テスト(Req 3.7, 3.8, 3.9)。
//
// 実行プロジェクト: "workers"(Cloudflare Workers ランタイム + DO)。
// 検証内容:
//  - 同一論理 DO インスタンス(getByName 同名解決)内で put→get→delete が成立する。
//    これはリクエスト跨ぎ(複数 interaction)の一時データ保持に相当する。
//  - 値は不透明文字列として透過保持される(JSON 文字列をそのまま往復)。
//  - キーは独立に扱われ、上書き・削除が他キーに影響しない。
//  - 別インスタンス(別 ID)からは参照できない(per-instance スコープ)。

describe("EvaluationCycleAgent: 揮発的インスタンス状態サーフェス(汎用 KV)", () => {
  it("同一インスタンスでリクエスト跨ぎに put→get→delete が成立する", async () => {
    const id = "evaluation:u1:ephemeral-1";
    // 1 回目のアクセス(= 1 つ目の interaction 相当)で保持する。
    const first = env.EvaluationCycleAgent.getByName(id);
    const payload = JSON.stringify({ pendingId: "p1", items: ["a", "b"] });
    await first.putEphemeral("pending:p1", payload);

    // 2 回目のアクセス(= 別 interaction 相当)で同名解決し、値を引ける。
    const second = env.EvaluationCycleAgent.getByName(id);
    expect(await second.getEphemeral("pending:p1")).toBe(payload);

    // 削除後は null。
    await second.deleteEphemeral("pending:p1");
    const third = env.EvaluationCycleAgent.getByName(id);
    expect(await third.getEphemeral("pending:p1")).toBeNull();
  });

  it("未保存キーは null を返し、削除は no-op(例外を投げない)", async () => {
    const stub = env.EvaluationCycleAgent.getByName("evaluation:u1:ephemeral-2");
    expect(await stub.getEphemeral("missing")).toBeNull();
    await stub.deleteEphemeral("missing"); // no-op
    expect(await stub.getEphemeral("missing")).toBeNull();
  });

  it("上書き保存され、複数キーは独立に扱われる", async () => {
    const stub = env.EvaluationCycleAgent.getByName("evaluation:u1:ephemeral-3");
    await stub.putEphemeral("k1", "v1");
    await stub.putEphemeral("k2", "v2");

    // k1 を上書きしても k2 は影響を受けない。
    await stub.putEphemeral("k1", "v1-updated");
    expect(await stub.getEphemeral("k1")).toBe("v1-updated");
    expect(await stub.getEphemeral("k2")).toBe("v2");

    // k1 の削除は k2 に影響しない。
    await stub.deleteEphemeral("k1");
    expect(await stub.getEphemeral("k1")).toBeNull();
    expect(await stub.getEphemeral("k2")).toBe("v2");
  });

  it("揮発状態は per-instance(別 ID のインスタンスからは参照できない)", async () => {
    const a = env.EvaluationCycleAgent.getByName("evaluation:u1:ephemeral-4a");
    const b = env.EvaluationCycleAgent.getByName("evaluation:u1:ephemeral-4b");
    await a.putEphemeral("shared-key", "only-in-a");

    expect(await a.getEphemeral("shared-key")).toBe("only-in-a");
    expect(await b.getEphemeral("shared-key")).toBeNull();
  });
});
