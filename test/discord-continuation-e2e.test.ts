import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dispatchInteraction } from "../src/discord/dispatch";
import type { DiscordEnv } from "../src/discord/env";
import { registerHandler, resetDefaultRegistry } from "../src/discord/registry";
import type {
  Continuation,
  ContinuationPayload,
  DeferredContinuationEnvelope,
  HandlerResult,
  SendResult,
} from "../src/discord/types";

// 永続的継続の End-to-End 統合テスト(task 7.7 / Req 8.1, 8.2, 8.4, 8.5, 8.8)。
//
// 実行プロジェクト: "workers"(Cloudflare Workers ランタイム / workerd + DO SQLite)。
// `@callable` のデコレータ変換・`this.schedule()` の DO alarm 基盤・実 `ExecutionContext`
// (`waitUntil`)・実 `EvaluationCycleAgent` DO を要するため node では実行できない。
//
// 位置づけ(既存テストとの非重複):
//  - `test/discord-continuation-seam.test.ts`(7.4)は seam を焦点化したユニット結合テストで、
//    substrate runner(`runScheduledContinuation`)を `vi.mock` でスパイ化し「seam が委譲のみ」
//    を検証する(substrate 本体は走らせない)。
//  - `test/discord-continuation-isolate.test.ts`(7.6)は substrate / 継続登録の isolate 保証を
//    `runScheduledContinuation` を直接呼んで検証する(dispatch / 実 agent / `this.schedule` は
//    経由しない)。
//  - 本ファイル(7.7)は上記を複製せず、**enqueue → seam → substrate → follow-up の鎖全体**を
//    実 `EvaluationCycleAgent` を貫いて検証する:
//      1. ハンドラが `mode:"deferred-persistent"` を返すと `dispatchInteraction` が type5
//         (DEFERRED)を即返し、`ctx.waitUntil` 内でユーザーの primary cycle agent
//         (`evaluation:{userId}:primary`)の seam(`scheduleDeferredContinuation`)へ
//         dispatch が組み立てた envelope が渡る(Req 8.1, 8.2)。
//      2. seam の alarm callback(`runDeferredContinuation`)は substrate(`runScheduledContinuation`)
//         へ委譲するのみで、継続成功なら本応答 follow-up(editOriginal)・継続失敗/キー未登録なら
//         失敗 follow-up が envelope の token 窓内に送られる(Req 8.4, 8.5, 8.8)。
//
// follow-up の観測: REST leaf(`./rest` の `editWebhookMessage` / `sendWebhookMessage`)のみを
// spy 化し、継続レジストリ・dispatch・実 agent・substrate・`createFollowup` の本物の実装は
// そのまま貫く。これにより「seam が業務ロジックを持たず、結果が substrate の挙動そのもの」を
// 鎖の出力(本応答 vs 失敗 follow-up と envelope の token)で検証できる。
//
// alarm のタイミング: `scheduleDeferredContinuation` は `this.schedule(0, ...)` でワンショット
// 登録するため、pool-workers ランタイムでは登録直後に自動発火・消費される。よって enqueue の
// 検証は「登録済み schedule の一覧」(発火後は空になり競合する)ではなく、鎖の終端効果
// (substrate が dispatch 由来の envelope で継続を実行し follow-up を送ったこと)で行う。
// 失敗パスは実 agent の alarm callback を `runInDurableObject` 上で直接発火させて決定的に検証する。

const editWebhookMessageSpy = vi.fn(async (): Promise<SendResult> => ({ ok: true }));
const sendWebhookMessageSpy = vi.fn(async (): Promise<SendResult> => ({ ok: true }));

vi.mock("../src/discord/rest", () => ({
  editWebhookMessage: (...args: unknown[]) => editWebhookMessageSpy(...(args as [])),
  sendWebhookMessage: (...args: unknown[]) => sendWebhookMessageSpy(...(args as [])),
}));

// REST モック確立後に本物の substrate / index モジュールグラフを import する。`src/index` の
// 評価は DO(`EvaluationCycleAgent`)を export し、起動時 top-level 副作用を実行する。
import { lookupContinuation, registerContinuation } from "../src/discord/continuation";
import "../src/index";

// 応答 type の数値定数(enum 解決揺れを避け数値で固定)。
const RESP_DEFERRED = 5;

// 本テストで継続を登録するキー(機能スペックの adoption を模倣した top-level 登録)。
const SUCCESS_KEY = "test:e2e:success";
const THROWS_KEY = "test:e2e:throws";
const UNREGISTERED_KEY = "test:e2e:unregistered";

// 本応答(成功継続が送る)文言。失敗 follow-up と区別するためユニークにする。
const MAIN_RESPONSE = "本応答(E2E 成功)";

// 成功継続が substrate から受け取った (payload, token) を記録する観測点。dispatch が
// 組み立てた envelope が enqueue→seam→substrate を通って継続まで到達したことを終端で検証する。
const observed: { payload?: ContinuationPayload; calls: number } = { calls: 0 };

// 成功継続: 受信 payload を記録し、本応答 follow-up を editOriginal で送る(adoption 模倣)。
const successContinuation: Continuation = async (_e, payload, followup) => {
  observed.payload = payload;
  observed.calls += 1;
  await followup.editOriginal(MAIN_RESPONSE);
};
registerContinuation(SUCCESS_KEY, successContinuation);

// 例外継続: 業務本体が例外を投げる(substrate が失敗 follow-up へ正規化する)。
const throwsContinuation: Continuation = async () => {
  throw new Error("continuation boom (e2e)");
};
registerContinuation(THROWS_KEY, throwsContinuation);

/** dispatch / followup / rest が参照するのは application id のみ。env を最小拡張する。 */
const discordEnv = {
  ...env,
  DISCORD_APPLICATION_ID: "app-123",
} as unknown as DiscordEnv;

/** ID 衝突(他テストの DO 状態混入)を避けるため、テストごとにユーザー ID を分ける。 */
function commandPayload(userId: string, name: string, token: string): Record<string, unknown> {
  return {
    id: "interaction-cmd",
    application_id: "app-123",
    type: 2,
    token,
    version: 1,
    guild_id: "guild-1",
    channel_id: "chan-1",
    member: { user: { id: userId } },
    data: { id: "cmd-id", name, type: 1 },
  };
}

/** 実 EvaluationCycleAgent 上で deferred alarm callback を直接発火させる(seam→substrate を貫く)。 */
async function fireDeferred(userId: string, envelope: DeferredContinuationEnvelope): Promise<void> {
  const stub = env.EvaluationCycleAgent.getByName(`evaluation:${userId}:primary`);
  // RPC を1度通して DO を起動させる(他配線テストと同じ確立パターン)。
  await stub.getRowById("evaluation_cycles", "none");
  await runInDurableObject(stub, async (instance) => {
    const agent = instance as unknown as {
      runDeferredContinuation(e: DeferredContinuationEnvelope): Promise<void>;
    };
    await agent.runDeferredContinuation(envelope);
  });
}

/** 条件が満たされるまで短時間ポーリングする(自動発火する delay-0 alarm の完了を待つ)。 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: 条件が時間内に満たされませんでした");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeEach(() => {
  resetDefaultRegistry();
  observed.payload = undefined;
  observed.calls = 0;
  editWebhookMessageSpy.mockClear();
  sendWebhookMessageSpy.mockClear();
  editWebhookMessageSpy.mockResolvedValue({ ok: true });
  sendWebhookMessageSpy.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("永続的継続 E2E: enqueue → seam → substrate → follow-up(成功パス)", () => {
  it("deferred-persistent ハンドラ → type5 即返、dispatch の envelope が実 primary cycle agent を通って継続を実行し本応答 follow-up を送る (Req 8.1, 8.2, 8.4, 8.8)", async () => {
    const userId = "e2e-success-u1";
    registerHandler("command", "persist", {
      handle(): HandlerResult {
        return {
          mode: "deferred-persistent",
          continuation: { key: SUCCESS_KEY, payload: { messageId: "m1", attempt: 2 } },
        };
      },
    });

    const ctx = createExecutionContext();
    const res = await dispatchInteraction(
      commandPayload(userId, "persist", "tok-success-1"),
      discordEnv,
      ctx,
    );

    // 初期応答は type5(DEFERRED)を即返す(本処理は alarm 側 / Req 8.1)。
    const json = (await res.json()) as { type: number };
    expect(json.type).toBe(RESP_DEFERRED);

    // waitUntil(enqueue)の完了を待つ。enqueue は dispatch の envelope を実ユーザーの
    // primary cycle agent(`evaluation:{userId}:primary`)の seam へ渡し、delay-0 alarm が
    // 自動発火して substrate→継続を走らせる。鎖の終端(継続実行 + follow-up 送出)を待つ。
    await waitOnExecutionContext(ctx);
    await waitFor(() => observed.calls > 0 && editWebhookMessageSpy.mock.calls.length > 0);

    // 継続は dispatch が組み立てた payload で実行された(enqueue→seam→substrate が envelope を
    // 正しく運んだ / Req 8.2)。所有者スコープは Agent 名の userId で構造的に閉じる。
    expect(observed.calls).toBe(1);
    expect(observed.payload).toEqual({ messageId: "m1", attempt: 2 });

    // 本応答 follow-up は editOriginal 経由・envelope の token(dispatch 由来)で送られる
    // (主応答であり失敗通知ではない / Req 8.4)。
    expect(editWebhookMessageSpy).toHaveBeenCalledTimes(1);
    const [, callToken, callContent] = editWebhookMessageSpy.mock.calls[0] as [
      DiscordEnv,
      string,
      string,
    ];
    expect(callToken).toBe("tok-success-1");
    expect(callContent).toBe(MAIN_RESPONSE);
    // 成功経路では追加の失敗 follow-up(send)を送らない。
    expect(sendWebhookMessageSpy).not.toHaveBeenCalled();
  });
});

describe("永続的継続 E2E: seam → substrate → follow-up(失敗パス・alarm 直接発火)", () => {
  it("継続成功時の alarm callback は substrate へ委譲し本応答 follow-up を envelope の token へ送る(seam に業務ロジックなし / Req 8.8)", async () => {
    const userId = "e2e-delegate-u1";
    const envelope: DeferredContinuationEnvelope = {
      interactionToken: "tok-delegate-1",
      applicationId: "app-123",
      continuationKey: SUCCESS_KEY,
      payload: { messageId: "m9", attempt: 7 },
    };

    // 成功継続が登録済みであることを前提に、実 agent 上で alarm callback を発火させる。
    expect(lookupContinuation(SUCCESS_KEY)).toBe(successContinuation);
    await fireDeferred(userId, envelope);

    // seam は委譲のみ: 結果は substrate の挙動そのもの。継続は envelope の payload で実行され、
    // 本応答 follow-up が envelope の token へ送られる(分類・生成等の業務判断は agent にない)。
    expect(observed.payload).toEqual({ messageId: "m9", attempt: 7 });
    expect(editWebhookMessageSpy).toHaveBeenCalledTimes(1);
    const [, callToken, callContent] = editWebhookMessageSpy.mock.calls[0] as [
      DiscordEnv,
      string,
      string,
    ];
    expect(callToken).toBe("tok-delegate-1");
    expect(callContent).toBe(MAIN_RESPONSE);
    expect(sendWebhookMessageSpy).not.toHaveBeenCalled();
  });

  it("継続例外: alarm callback 経由で失敗 follow-up が送られ deferred 固着を防ぐ (Req 8.5)", async () => {
    const userId = "e2e-throws-u1";
    const envelope: DeferredContinuationEnvelope = {
      interactionToken: "tok-throws-1",
      applicationId: "app-123",
      continuationKey: THROWS_KEY,
      payload: {},
    };

    await fireDeferred(userId, envelope);

    // 失敗 follow-up は editOriginal で送られる(本応答枠を失敗文言で置換)。本応答文言ではない。
    expect(editWebhookMessageSpy).toHaveBeenCalledTimes(1);
    const [, callToken, callContent] = editWebhookMessageSpy.mock.calls[0] as [
      DiscordEnv,
      string,
      string,
    ];
    expect(callToken).toBe("tok-throws-1");
    expect(callContent).not.toBe(MAIN_RESPONSE);
    expect(callContent.length).toBeGreaterThan(0);
  });

  it("継続キー未登録: alarm callback 経由で失敗 follow-up が送られ deferred 固着を防ぐ (Req 8.5)", async () => {
    const userId = "e2e-unregistered-u1";
    // 未登録キーであることを固定する。
    expect(lookupContinuation(UNREGISTERED_KEY)).toBeNull();

    const envelope: DeferredContinuationEnvelope = {
      interactionToken: "tok-unregistered-1",
      applicationId: "app-123",
      continuationKey: UNREGISTERED_KEY,
      payload: {},
    };

    await fireDeferred(userId, envelope);

    // 未登録 → 継続を実行できないため失敗 follow-up が editOriginal で送られる(本応答ではない)。
    expect(editWebhookMessageSpy).toHaveBeenCalledTimes(1);
    const [, callToken, callContent] = editWebhookMessageSpy.mock.calls[0] as [
      DiscordEnv,
      string,
      string,
    ];
    expect(callToken).toBe("tok-unregistered-1");
    expect(callContent).not.toBe(MAIN_RESPONSE);
    expect(callContent.length).toBeGreaterThan(0);
  });
});
