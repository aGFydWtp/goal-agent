// DO-backed 永続的継続の型契約(task 7.1 / src/discord/types.ts)の検証
// (Req 8.1, 8.3, 8.6, 8.8 / design.md §types Service Interface L408-436)。
//
// 完了条件(tasks 7.1): HandlerResult に deferred-persistent 変種(継続キー +
// シリアライズ可能 payload)が純加算され、Continuation / DeferredContinuationEnvelope /
// ContinuationPayload / JsonValue が公開される。既存 reply/deferred/modal 変種は不変。
//
// 本テストは型契約(コンパイル時の構造)と値の生成可能性を検証する純ロジック。
// 実行環境: vitest projects の "node" プロジェクト。

import { describe, expect, expectTypeOf, it } from "vitest";
import type { DiscordEnv } from "../src/discord/env";
import type {
  Continuation,
  ContinuationPayload,
  DeferredContinuationEnvelope,
  Followup,
  HandlerResult,
  JsonValue,
} from "../src/discord/types";

describe("JsonValue / ContinuationPayload (Req 8.3)", () => {
  it("JSON プリミティブ・配列・ネストオブジェクトを表現できる", () => {
    const v: JsonValue = {
      s: "x",
      n: 1,
      b: true,
      nul: null,
      arr: [1, "a", false, { nested: ["deep"] }],
    };
    expect(v).toBeDefined();
  });

  it("ContinuationPayload は string キーの JsonValue マップである", () => {
    const payload: ContinuationPayload = { messageId: "m1", attempt: 2 };
    expect(payload.messageId).toBe("m1");
    expectTypeOf<ContinuationPayload[string]>().toEqualTypeOf<JsonValue>();
  });
});

describe("HandlerResult.deferred-persistent への純加算(Req 8.1, 8.6)", () => {
  it("deferred-persistent 変種は継続キー + シリアライズ可能 payload を宣言する", () => {
    const result: HandlerResult = {
      mode: "deferred-persistent",
      ephemeral: true,
      continuation: { key: "checkin:classify", payload: { messageId: "m1" } },
    };
    expect(result.mode).toBe("deferred-persistent");
    if (result.mode === "deferred-persistent") {
      expect(result.continuation.key).toBe("checkin:classify");
      expect(result.continuation.payload.messageId).toBe("m1");
    }
  });

  it("既存 reply/deferred/modal 変種は維持される(純加算)", () => {
    const reply: HandlerResult = { mode: "reply", content: "hi" };
    const deferred: HandlerResult = { mode: "deferred", run: async () => {} };
    const modal: HandlerResult = { mode: "modal", customId: "c", title: "t", components: [] };
    expect(reply.mode).toBe("reply");
    expect(deferred.mode).toBe("deferred");
    expect(modal.mode).toBe("modal");
  });
});

describe("Continuation(Req 8.6, 8.8)", () => {
  it("env + payload + Followup を受けて Promise<void> を返す", () => {
    const cont: Continuation = async (_env, _payload, _followup) => {};
    expectTypeOf<Continuation>().parameters.toEqualTypeOf<
      [DiscordEnv, ContinuationPayload, Followup]
    >();
    expectTypeOf<Continuation>().returns.toEqualTypeOf<Promise<void>>();
    expect(cont).toBeTypeOf("function");
  });
});

describe("DeferredContinuationEnvelope(Req 8.3, 8.4, 8.6)", () => {
  it("interactionToken / applicationId / continuationKey / payload を運ぶ", () => {
    const env: DeferredContinuationEnvelope = {
      interactionToken: "tok",
      applicationId: "app",
      continuationKey: "checkin:classify",
      payload: { messageId: "m1" },
    };
    expect(env.interactionToken).toBe("tok");
    expect(env.applicationId).toBe("app");
    expect(env.continuationKey).toBe("checkin:classify");
    expect(env.payload.messageId).toBe("m1");
    expectTypeOf<DeferredContinuationEnvelope["payload"]>().toEqualTypeOf<ContinuationPayload>();
  });
});
