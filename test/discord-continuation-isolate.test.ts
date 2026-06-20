import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DiscordEnv } from "../src/discord/env";
import type {
  Continuation,
  ContinuationPayload,
  DeferredContinuationEnvelope,
  SendResult,
} from "../src/discord/types";

// 永続的継続 substrate(task 7.6)のユニットテスト (Req 8.3, 8.4, 8.5, 8.6)。
//
// 実行プロジェクト: "workers"(Cloudflare Workers ランタイム / workerd)。
//
// このファイルが workers プロジェクトで動く理由(意図的・重複ではない):
//  - 本タスクの新規かつ workers 限定の検証は「継続登録の isolate 存在保証」。design.md
//    §Persistent Continuation Substrate「Registration(DO isolate 上での存在保証)」の通り、
//    継続登録は DO を export するモジュールグラフ(`src/index.ts`)の起動時 top-level 副作用で
//    なければならず、lazy/fetch 経路限定登録は禁止(DO isolate で lookup-miss → 失敗 follow-up
//    が誤発火し「考え中…失敗」が常態化する)。この性質は module-interop / isolate の挙動に
//    依存するため node では表現できず、workers(workerd)ランタイムで固定する必要がある
//    (tasks.md Implementation Notes P0: Discord ランタイム挙動を伴うテストは workers で実行)。
//  - レジストリ往復/null と `runScheduledContinuation` の成功/例外/未登録/envelope-token も
//    本タスクの完了条件(「workers プロジェクトで通る」)が要求するため、workerd ランタイム上で
//    再検証する。これは task 7.3 の node テスト(`discord-continuation.test.ts`)の偶発的な複製
//    ではなく、workerd 上で substrate ロジックが成立することを固定する意図的なカバレッジである。
//
// REST leaf(`./rest` の `editWebhookMessage` / `sendWebhookMessage`)のみを spy 化し、
// 継続レジストリ・runner・`createFollowup` の本物の実装はそのまま検証する。これにより
// `createFollowup(env, token)` が envelope の token を webhook 経路へ渡すことも観測できる。

const editWebhookMessageSpy = vi.fn(async (): Promise<SendResult> => ({ ok: true }));
const sendWebhookMessageSpy = vi.fn(async (): Promise<SendResult> => ({ ok: true }));

vi.mock("../src/discord/rest", () => ({
  editWebhookMessage: (...args: unknown[]) => editWebhookMessageSpy(...(args as [])),
  sendWebhookMessage: (...args: unknown[]) => sendWebhookMessageSpy(...(args as [])),
}));

// REST モック確立後に本物の substrate / index モジュールグラフを import する。
import {
  lookupContinuation,
  registerContinuation,
  runScheduledContinuation,
} from "../src/discord/continuation";

// DO(`EvaluationCycleAgent` / `GoalAgent`)を export するモジュールグラフを評価する。
// `src/index.ts` の評価は top-level 副作用(registerGoalManagement 等)を実行する。本テストは
// その同一機構で登録した継続キーが、DO isolate へ反映される module スコープ登録として
// `lookupContinuation` から解決できることを固定する。
import "../src/index";

// adoption 側スペックが起動時に行う登録を模倣し、本テストモジュールの top-level で
// 継続キーを登録する(fetch/lazy 経路ではなく module 評価の副作用として登録される)。
const ISOLATE_GUARANTEE_KEY = "test:isolate-guarantee";
const isolateGuaranteeContinuation: Continuation = async () => {};
registerContinuation(ISOLATE_GUARANTEE_KEY, isolateGuaranteeContinuation);

// --- フィクスチャ ---------------------------------------------------------

const discordEnv = {
  ...env,
  DISCORD_APPLICATION_ID: "app-123",
} as unknown as DiscordEnv;

function makeEnvelope(
  overrides: Partial<DeferredContinuationEnvelope> = {},
): DeferredContinuationEnvelope {
  return {
    interactionToken: "interaction-token-abc",
    applicationId: "app-123",
    continuationKey: "test:continuation",
    payload: { foo: "bar" },
    ...overrides,
  };
}

beforeEach(() => {
  editWebhookMessageSpy.mockClear();
  sendWebhookMessageSpy.mockClear();
  editWebhookMessageSpy.mockResolvedValue({ ok: true });
  sendWebhookMessageSpy.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

// --- 継続登録の isolate 存在保証(本タスクの主眼 / Req 8.6) -------------------

describe("継続登録の isolate 存在保証: src/index 評価後に lookup 成功", () => {
  it("DO を export するモジュールグラフ評価後、top-level 登録した継続キーが lookup で解決できる", () => {
    // `import "../src/index"` で DO export を含むモジュールグラフが評価され、本モジュール
    // top-level の registerContinuation が module スコープ登録として反映されている。workers
    // (workerd)ランタイム上で lookup が成立することを固定し、lazy/fetch 経路限定登録への
    // 退行(DO isolate での lookup-miss)を防ぐ。
    expect(lookupContinuation(ISOLATE_GUARANTEE_KEY)).toBe(isolateGuaranteeContinuation);
  });
});

// --- 継続レジストリ(Req 8.6) ---------------------------------------------

describe("継続レジストリ: registerContinuation / lookupContinuation(workerd)", () => {
  it("登録したキーで継続関数を照合できる(往復)", () => {
    const fn: Continuation = async () => {};
    registerContinuation("workers:registry:roundtrip", fn);
    expect(lookupContinuation("workers:registry:roundtrip")).toBe(fn);
  });

  it("未登録キーは null を返す", () => {
    expect(lookupContinuation("workers:registry:never-registered")).toBeNull();
  });
});

// --- substrate runner(Req 8.3, 8.4, 8.5, 8.6) ----------------------------

describe("runScheduledContinuation: alarm 実行 substrate(workerd)", () => {
  it("成功時: 継続を実行し本応答 follow-up を送る / envelope の token から Followup を構築する", async () => {
    const observed: { env?: DiscordEnv; payload?: ContinuationPayload } = {};
    const continuation: Continuation = async (e, payload, followup) => {
      observed.env = e;
      observed.payload = payload;
      await followup.editOriginal("本応答です");
    };
    registerContinuation("workers:runner:success", continuation);

    const envelope = makeEnvelope({
      continuationKey: "workers:runner:success",
      payload: { a: 1 },
    });
    await runScheduledContinuation(discordEnv, envelope);

    // 継続は env + payload + followup で呼ばれる(Req 8.6)。
    expect(observed.env).toBe(discordEnv);
    expect(observed.payload).toEqual({ a: 1 });

    // Followup は envelope の interactionToken / applicationId から再構築される(Req 8.3, 8.4)。
    // createFollowup → editWebhookMessage(env, interactionToken, ...) を本物経由で観測する。
    expect(editWebhookMessageSpy).toHaveBeenCalledTimes(1);
    const [callEnv, callToken, callContent] = editWebhookMessageSpy.mock.calls[0] as [
      DiscordEnv,
      string,
      string,
    ];
    expect(callEnv).toBe(discordEnv);
    expect((callEnv as { DISCORD_APPLICATION_ID: string }).DISCORD_APPLICATION_ID).toBe("app-123");
    expect(callToken).toBe("interaction-token-abc");
    expect(callContent).toBe("本応答です");
    // 成功経路では追加 follow-up(send)を送らない。
    expect(sendWebhookMessageSpy).not.toHaveBeenCalled();
  });

  it("継続キー未登録時: 失敗 follow-up を送り固着を防ぐ(Req 8.5)", async () => {
    const envelope = makeEnvelope({ continuationKey: "workers:runner:unregistered-key" });

    await runScheduledContinuation(discordEnv, envelope);

    // 継続を実行できないため、失敗 follow-up が editOriginal 経由で送られる。
    expect(editWebhookMessageSpy).toHaveBeenCalledTimes(1);
    const [, , content] = editWebhookMessageSpy.mock.calls[0] as [DiscordEnv, string, string];
    expect(typeof content).toBe("string");
    expect(content.length).toBeGreaterThan(0);
  });

  it("継続例外時: 例外を握りつぶさず失敗 follow-up を送る(Req 8.5)", async () => {
    const continuation: Continuation = async () => {
      throw new Error("continuation boom");
    };
    registerContinuation("workers:runner:throws", continuation);

    const envelope = makeEnvelope({ continuationKey: "workers:runner:throws" });
    // 例外を呼び出し元へ伝播させない。
    await expect(runScheduledContinuation(discordEnv, envelope)).resolves.toBeUndefined();

    expect(editWebhookMessageSpy).toHaveBeenCalledTimes(1);
  });

  it("本応答 follow-up の送信が失敗した時: send へフォールバックして固着を防ぐ(Req 8.5)", async () => {
    // 継続未登録 → 失敗 follow-up を editOriginal で送ろうとするが token 失効(404)で失敗 →
    // send へフォールバックして必ず利用者へ失敗を伝える(deferred 固着防止)。
    editWebhookMessageSpy.mockResolvedValue({ ok: false, reason: "not_found", status: 404 });

    const envelope = makeEnvelope({ continuationKey: "workers:runner:fallback-to-send" });
    await runScheduledContinuation(discordEnv, envelope);

    expect(editWebhookMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendWebhookMessageSpy).toHaveBeenCalledTimes(1);
  });
});
