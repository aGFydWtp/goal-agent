import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// 2 つの vitest プロジェクトを使い分ける:
// - "node": 純粋ロジック/永続化のユニットテスト。`node:sqlite` 等の Node 組み込みを
//   利用するため Node 環境で実行する(pool-workers/workerd には node:sqlite が無い)。
// - "workers": Cloudflare Workers ランタイム統合テスト(pool-workers プラグイン)。
//
// `pnpm test` (vitest run) は両プロジェクトを実行する。
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          // 永続化のユニットテスト群。node:sqlite を使う migrator/repository はここで動かす。
          include: ["test/migrator.test.ts", "test/repository.test.ts", "test/llm-client.test.ts"],
        },
      },
      {
        // Workers ランタイム上で動かすテスト(型・スキーマ定義など)。
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
          }),
        ],
        test: {
          name: "workers",
          include: ["test/types.test.ts", "test/schema.test.ts"],
        },
      },
    ],
  },
});
