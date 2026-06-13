import type { Env } from "./env";

export { EvaluationCycleAgent } from "./agents/evaluation-cycle-agent";
export { GoalAgent } from "./agents/goal-agent";

/**
 * Worker エントリーポイント (Req 1.2, 1.3)。
 *
 * 本タスク (1.1) では疎通確認のための最小応答のみを提供する。
 * ルーティングヘルパーや Agent への配線は後続タスク (5.1) で実装される。
 */
export default {
  fetch(request: Request, _env: Env): Response {
    const { pathname } = new URL(request.url);
    if (pathname === "/") {
      return new Response("goal-agent: ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
