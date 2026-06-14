import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EvaluationCycleRow } from "../src/types";

// EvaluationCycleAgent のデータ権威・スキーマ初期化の統合テスト(Req 3.1, 3.5)。
//
// 実行プロジェクト: "workers"(Cloudflare Workers ランタイム + DO SQLite)。
// 検証内容:
//  - Agent 起動時(コンストラクタ)に §11 スキーマがマイグレーション済みになる。
//    コンストラクタは全 RPC ハンドラより先に完了が保証されるため、最初の
//    データ権威 RPC 時点でスキーマは初期化済みになる。
//  - リポジトリ委譲 RPC(insertRow/getRowById 等)経由で DO SQLite に
//    実データを読み書きできる(疎通)。
//  - 再起動相当(同一論理インスタンスへの再アクセス)で冪等に動作する。

function makeCycleRow(id: string): EvaluationCycleRow {
  return {
    id,
    user_id: "u1",
    name: "2026 H1",
    start_date: "2026-01-01",
    end_date: "2026-06-30",
    created_at: "2026-06-14T00:00:00Z",
    updated_at: "2026-06-14T00:00:00Z",
  };
}

describe("EvaluationCycleAgent: データ権威 + スキーマ初期化", () => {
  it("起動時にスキーマが初期化され、リポジトリ経由で読み書きが疎通する", async () => {
    const stub = env.EvaluationCycleAgent.getByName("evaluation:u1:c1");
    const row = makeCycleRow("c1");

    // insert は migrate 済みスキーマに対して成功する(スキーマ未初期化なら例外)。
    await stub.insertRow("evaluation_cycles", row);

    const read = await stub.getRowById("evaluation_cycles", "c1");
    expect(read).toEqual(row);
  });

  it("update / listBy / remove のデータ権威メソッドが疎通する", async () => {
    const stub = env.EvaluationCycleAgent.getByName("evaluation:u1:c2");
    await stub.insertRow("evaluation_cycles", makeCycleRow("c2"));

    await stub.updateRow("evaluation_cycles", "c2", { name: "renamed" });
    const updated = await stub.getRowById("evaluation_cycles", "c2");
    expect(updated?.name).toBe("renamed");

    const listed = await stub.listRowsBy("evaluation_cycles", { user_id: "u1" });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe("c2");

    await stub.removeRow("evaluation_cycles", "c2");
    expect(await stub.getRowById("evaluation_cycles", "c2")).toBeNull();
  });

  it("マイグレーションは冪等(複数回の起動相当アクセスでもエラーにならずデータ保持)", async () => {
    const id = "evaluation:u1:c3";
    const first = env.EvaluationCycleAgent.getByName(id);
    await first.insertRow("evaluation_cycles", makeCycleRow("c3"));

    // 同一論理インスタンスへ再取得 = 起動時マイグレーションが再度走っても冪等であること。
    const second = env.EvaluationCycleAgent.getByName(id);
    const read = await second.getRowById("evaluation_cycles", "c3");
    expect(read?.id).toBe("c3");
  });
});
