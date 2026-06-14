import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

// Worker エントリーポイント配線の統合テスト(Req 1.2, 1.3, 3.3, 3.4, 4.4)。
//
// 実行プロジェクト: "workers"(Cloudflare Workers ランタイム + DO SQLite)。
// 検証内容:
//  - `/` がヘルスチェックとして 200 を返す(Req 1.2)。
//  - `/__health/wiring` がルーティングヘルパー経由で両 Agent に到達し、
//    スキーマ初期化を伴う読み取り専用操作と LLM クライアント生成を一連で疎通する
//    (Req 1.3, 3.3, 3.4, 4.4)。
//  - 未知パスは 404 を返す。
//
// 配線確認(疎通)であり機能ではない: プローブは存在しないセンチネル id のみを
// 読み(データ変更なし)、ユーザーデータも露出しない。

describe("Worker エントリーポイント: ヘルスチェック", () => {
  it("GET / は 200 を返す(Req 1.2)", async () => {
    const res = await worker.fetch(new Request("http://x/"), env);
    expect(res.status).toBe(200);
  });

  it("未知パスは 404 を返す", async () => {
    const res = await worker.fetch(new Request("http://x/unknown"), env);
    expect(res.status).toBe(404);
  });
});

describe("Worker エントリーポイント: 配線疎通プローブ", () => {
  it("GET /__health/wiring が両 Agent 到達・スキーマ初期化・LLM 生成を一連で疎通する(Req 1.3, 3.3, 3.4, 4.4)", async () => {
    const res = await worker.fetch(new Request("http://x/__health/wiring"), env);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      ok: boolean;
      cycleReachable: boolean;
      goalReachable: boolean;
      llmClientCreated: boolean;
    };
    expect(body).toEqual({
      ok: true,
      cycleReachable: true,
      goalReachable: true,
      llmClientCreated: true,
    });
  });
});
