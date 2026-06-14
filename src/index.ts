import { getCycleAgent, getGoalAgent } from "./agents/routing";
import type { Env } from "./env";
import { createLlmClient } from "./llm/factory";

export { EvaluationCycleAgent } from "./agents/evaluation-cycle-agent";
export { GoalAgent } from "./agents/goal-agent";

/**
 * 配線疎通プローブ用のセンチネル識別子。
 *
 * 実在しない固定 id のみを読むため、ユーザーデータの変更・露出は発生しない。
 * 認証は下流(discord-gateway)の責務であり、本プローブは認証を必要としない。
 */
const WIRING_PROBE_USER_ID = "__wiring_probe__";
const WIRING_PROBE_CYCLE_ID = "__wiring_probe__";
const WIRING_PROBE_GOAL_ID = "__wiring_probe__";
const WIRING_PROBE_ROW_ID = "__wiring_probe__";

/**
 * 基盤段階の配線疎通(疎通確認のみ)を実行する (Req 1.3, 3.3, 3.4, 4.4)。
 *
 * design.md「Worker Entry + Env」に従い、本段階のエントリーは Agent 配線と
 * 疎通確認のみを担う(具体的なコマンド処理は discord-gateway)。本ハンドラは
 * 1 経路で次を疎通させる:
 *  1. ルーティングヘルパー経由で EvaluationCycleAgent に到達し、スキーマ初期化を
 *     伴う読み取り専用操作(存在しないセンチネル id の取得 → null)を行う
 *     (Req 3.3, 1.2/1.3)。
 *  2. ルーティングヘルパー経由で GoalAgent に到達し、親委譲の読み取り専用操作を
 *     行う(Req 3.4)。
 *  3. LLM ファクトリでクライアントを生成する(生成のみ。AI 呼び出しは行わない)
 *     (Req 4.4)。
 */
async function handleWiringProbe(env: Env): Promise<Response> {
  try {
    // 1. ルーティング → サイクル Agent(データ権威)へ到達 + スキーマ初期化を伴う読み取り。
    const cycleStub = await getCycleAgent(env, WIRING_PROBE_USER_ID, WIRING_PROBE_CYCLE_ID);
    await cycleStub.getRowById("evaluation_cycles", WIRING_PROBE_ROW_ID);
    const cycleReachable = true;

    // 2. ルーティング → 目標 Agent(親委譲)へ到達 + 読み取り専用委譲。
    const goalStub = await getGoalAgent(
      env,
      WIRING_PROBE_USER_ID,
      WIRING_PROBE_CYCLE_ID,
      WIRING_PROBE_GOAL_ID,
    );
    await goalStub.getRowById("goals", WIRING_PROBE_ROW_ID);
    const goalReachable = true;

    // 3. LLM ファクトリ配線(生成のみ。AI は呼ばない)。
    createLlmClient(env);
    const llmClientCreated = true;

    return Response.json({
      ok: true,
      cycleReachable,
      goalReachable,
      llmClientCreated,
    });
  } catch (_error) {
    // スタック/シークレットを露出しない短いエラー応答に留める。
    return Response.json({ ok: false, error: "wiring probe failed" }, { status: 500 });
  }
}

/**
 * Worker エントリーポイント (Req 1.2, 1.3)。
 *
 * - `/`: ヘルスチェック(200)。
 * - `/__health/wiring`: 基盤配線の疎通確認(ルーティング + スキーマ初期化 + LLM 生成)。
 * - その他: 404。
 *
 * Discord 署名検証・スラッシュコマンドルーティング・ドメイン CRUD は本段階の
 * 責務外(discord-gateway / 下流)。
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/") {
      return new Response("goal-agent: ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (pathname === "/__health/wiring") {
      return handleWiringProbe(env);
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
