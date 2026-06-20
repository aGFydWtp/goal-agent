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
          // 純ロジック/永続化のユニットテスト群(node:sqlite を使う migrator/repository 等)。
          // 各スペックがファイルごとに登録する allowlist 方式は共有 config への頻繁な競合編集を
          // 招くため、test/ 直下の *.test.ts を glob で自動取り込みする。workers ランタイムを
          // 要するテストだけを下の exclude で除外する(node 環境では二重実行/環境不一致になるため)。
          include: ["test/**/*.test.ts"],
          // workers プロジェクト(下記)で実行するランタイム統合テスト。node からは除外する。
          // ここに列挙されない新規 *.test.ts は自動的に node プロジェクトで実行される。
          exclude: [
            "test/types.test.ts",
            "test/schema.test.ts",
            "test/evaluation-cycle-agent.test.ts",
            "test/evaluation-cycle-agent-ephemeral.test.ts",
            "test/notifications-agent-wiring.test.ts",
            "test/discord-continuation-seam.test.ts",
            "test/discord-continuation-isolate.test.ts",
            "test/goal-agent.test.ts",
            "test/routing.test.ts",
            "test/worker-entry.test.ts",
            "test/discord-worker-interactions.test.ts",
            "test/discord-dispatch-integration.test.ts",
            "test/discord-ping-smoke.test.ts",
            "test/integration.test.ts",
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
            // 汎用揮発 KV サーフェス(task 4.5, Req 3.7-3.9)。DO ランタイム上で getByName 同名解決の put/get/delete を検証する。
            "test/evaluation-cycle-agent-ephemeral.test.ts",
            // 週次チェックイン配線(task 6.3, Req 1.1, 1.2, 7.3)。onStart の schedule 登録 + 追加マイグレーション + fireWeeklyCheckin 委譲を DO ランタイムで検証する。
            "test/notifications-agent-wiring.test.ts",
            // deferred-continuation seam 配線(task 7.4, Req 8.2, 8.8)。scheduleDeferredContinuation の one-shot 登録 + runDeferredContinuation の substrate 委譲を DO ランタイムで検証する。
            "test/discord-continuation-seam.test.ts",
            // 継続レジストリ/runner/isolate 存在保証(task 7.6, Req 8.3-8.6)。src/index(DO export)評価後の top-level 継続登録が workerd 上で lookup 解決できることを固定する。
            "test/discord-continuation-isolate.test.ts",
            "test/goal-agent.test.ts",
            "test/routing.test.ts",
            "test/worker-entry.test.ts",
            // interactions パスの Worker エントリー統合(task 4.1)。ExecutionContext を要するため workers。
            "test/discord-worker-interactions.test.ts",
            // 検証〜ディスパッチ統合(task 5.1)。署名込み worker.fetch 経路 + 実 waitUntil 継続を workers で検証する。
            "test/discord-dispatch-integration.test.ts",
            // PING スモーク(task 5.2)。署名付き PING → PONG をエンドポイント登録検証相当として workers で疎通確認する。
            "test/discord-ping-smoke.test.ts",
            "test/integration.test.ts",
          ],
        },
      },
    ],
  },
});
