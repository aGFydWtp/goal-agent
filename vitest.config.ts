import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import agents from "agents/vite";
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
          include: [
            "test/migrator.test.ts",
            "test/repository.test.ts",
            "test/llm-client.test.ts",
            "test/llm-workers-ai.test.ts",
            "test/agent-ids.test.ts",
            // 境界整合の機械的検証(task 6.4)。node:fs でソースを静的検査するため node プロジェクト。
            "test/boundary.test.ts",
            // Ed25519 署名検証(task 2.1)。discord-interactions verifyKey の純粋ロジック。
            "test/discord-verify.test.ts",
            // 応答ユーティリティ(task 2.2)。応答ボディ生成の純粋ロジック。
            "test/discord-response.test.ts",
            // REST クライアント(task 2.3)。fetch モックで純粋に検証する。
            "test/discord-rest.test.ts",
            // follow-up 送信ユーティリティ(task 2.4)。fetch モックで純粋に検証する。
            "test/discord-followup.test.ts",
            // プロアクティブ送信ヘルパー(task 2.5)。fetch モックで純粋に検証する。
            "test/discord-proactive.test.ts",
          ],
        },
      },
      {
        // Workers ランタイム上で動かすテスト(型・スキーマ定義など)。
        // `agents/vite` は `@callable()` の TC39 デコレータ変換を行う
        // (pool-workers の oxc/esbuild はデコレータ未対応のため必須)。
        plugins: [
          ...agents(),
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
          }),
        ],
        test: {
          name: "workers",
          include: [
            "test/types.test.ts",
            "test/schema.test.ts",
            "test/evaluation-cycle-agent.test.ts",
            "test/goal-agent.test.ts",
            "test/routing.test.ts",
            "test/worker-entry.test.ts",
            "test/integration.test.ts",
          ],
        },
      },
    ],
  },
});
