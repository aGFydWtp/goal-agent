import type { APIInteraction } from "discord-api-types/v10";
// 注意: 数値の判別子(PING/PONG = 1)は `discord-interactions` の実行時 enum を用いる。
// `discord-api-types/v10` は型のみ提供で、その enum「値」は @cloudflare/vitest-pool-workers
// (workerd)バンドル上で undefined に解決される(再エクスポート連鎖の interop 問題)。
// `discord-interactions`(本プロジェクト既存依存・verify.ts も使用)の enum は workerd 上で
// 正しい数値を保持するため、ランタイム比較・応答 type の生成にはこちらを用いる。
import { InteractionResponseType, InteractionType } from "discord-interactions";

import { getCycleAgent, getGoalAgent } from "./agents/routing";
import { registerCheckinClassification } from "./checkin-classification/register";
import { dispatchInteraction } from "./discord/dispatch";
import type { DiscordEnv } from "./discord/env";
import { verifyInteraction } from "./discord/verify";
import { registerGoalManagement } from "./goal-management/register";
import { createLlmClient } from "./llm/factory";

export { EvaluationCycleAgent } from "./agents/evaluation-cycle-agent";
export { GoalAgent } from "./agents/goal-agent";

// goal-management のハンドラ登録とコマンド定義集約を起動時に一度行う (design L142 承認済み)。
// dispatch はデフォルトレジストリを照合するため、interaction を受ける前に登録を済ませる。
registerGoalManagement();
// checkin-classification(/checkin 系ハンドラ + コマンド定義)も同様に起動時へ登録する
// (checkin-classification task 4.1)。保存/修正/破棄ボタンは接頭辞ディスパッチで解決される。
registerCheckinClassification();

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
async function handleWiringProbe(env: DiscordEnv): Promise<Response> {
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
 * Discord interactions エンドポイント (Req 1.1-1.6 / design.md §worker「Worker Entry 統合」
 * L476-493・受信フロー L137-178)。
 *
 * raw body を `request.text()` で一度だけ取得し(design Invariant: JSON パース前に取得し
 * 再シリアライズしない)、署名ヘッダ(`X-Signature-Ed25519` / `X-Signature-Timestamp`)と
 * `env.DISCORD_PUBLIC_KEY` で {@link verifyInteraction} を実行する。
 *
 *  - 検証失敗 / ヘッダ欠落(`ok:false`)→ ハンドラ処理を行わず 401(Req 1.2, 1.3)。
 *  - PING(type1)→ PONG(type1)JSON を返す(Req 1.4)。
 *  - 非 PING → {@link dispatchInteraction} へ委譲し、その Response をそのまま返す
 *    (Req 1.6。deferred 継続は dispatch 内で `ctx.waitUntil` に登録される)。
 */
async function handleInteractions(
  request: Request,
  env: DiscordEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  // raw body を一度だけ取得(JSON パース前)。verify は raw body に対して署名検証する。
  const rawBody = await request.text();
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");

  const result = await verifyInteraction(rawBody, signature, timestamp, env.DISCORD_PUBLIC_KEY);
  if (!result.ok) {
    // 署名不正 / ヘッダ欠落: ハンドラ処理を行わず 401 (Req 1.2, 1.3)。
    return new Response("invalid request signature", { status: 401 });
  }

  const interaction = result.interaction as APIInteraction;
  // PING(type1)判定。`discord-interactions` と `discord-api-types` の InteractionType は
  // 同一の数値プロトコル定数(PING=1)を表すが TypeScript 上は別 enum 型のため、数値として比較する。
  if ((interaction.type as number) === InteractionType.PING) {
    // PING ハンドシェイク → PONG(type1)(Req 1.4)。
    return Response.json({ type: InteractionResponseType.PONG });
  }

  // 検証済みの非 PING はディスパッチャへ委譲する (Req 1.6)。
  return dispatchInteraction(interaction, env, ctx);
}

/**
 * Worker エントリーポイント (Req 1.2, 1.3, 1.4, 1.6)。
 *
 * - `POST /interactions`: Discord interactions(署名検証 → PING/PONG / ディスパッチ委譲)。
 * - `/`: ヘルスチェック(200)。
 * - `/__health/wiring`: 基盤配線の疎通確認(ルーティング + スキーマ初期化 + LLM 生成)。
 * - その他: 404。
 *
 * infra-foundation の既存配線(ヘルスチェック・wiring probe・Agent ルーティング)は
 * 変更せず、Discord interactions パスを追加する。`ctx` は dispatch の deferred 継続
 * (`ctx.waitUntil`)に用いるため fetch シグネチャに追加する(既存経路は ctx 不使用で後方互換)。
 */
export default {
  async fetch(request: Request, env: DiscordEnv, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname === "/interactions") {
      return handleInteractions(request, env, ctx);
    }
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
} satisfies ExportedHandler<DiscordEnv>;
