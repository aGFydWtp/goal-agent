import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DiscordEnv } from "../src/discord/env";
import type {
  Continuation,
  ContinuationPayload,
  DeferredContinuationEnvelope,
  Followup,
  SendResult,
} from "../src/discord/types";

// 永続的継続 substrate(task 7.3)のユニットテスト (Req 8.1, 8.3-8.8)。
//
// 方針:
//  - `../src/agents/routing`(`getCycleAgent` / `PRIMARY_CYCLE_KEY`)と
//    `../src/discord/followup`(`createFollowup`)を `vi.mock` で差し替え、
//    substrate のロジック(レジストリ登録/照合・enqueue 委譲・runner の成功/失敗分岐)を
//    DO ランタイムや実 REST なしの純ロジックとして検証する(`node` プロジェクト)。
//  - Followup は editOriginal / send を spy 化したフェイクで観測する。
//
// 完了状態(tasks.md 7.3): 継続レジストリの登録/照合往復が成立し、enqueue が primary
// cycle agent seam(`scheduleDeferredContinuation`)へ envelope を渡し、runner が成功時のみ
// 本応答 follow-up・失敗時(未登録・例外・送信失敗)は失敗 follow-up を送ることを確認する。

// --- モック ---------------------------------------------------------------

const scheduleSpy = vi.fn<(envelope: DeferredContinuationEnvelope) => Promise<void>>(
  async () => {},
);
const getCycleAgentMock = vi.fn(async () => ({
  scheduleDeferredContinuation: scheduleSpy,
}));

vi.mock("../src/agents/routing", () => ({
  PRIMARY_CYCLE_KEY: "primary",
  getCycleAgent: (...args: unknown[]) => getCycleAgentMock(...(args as [])),
}));

const editOriginalSpy = vi.fn<Followup["editOriginal"]>(async () => ({ ok: true }) as SendResult);
const sendSpy = vi.fn<Followup["send"]>(async () => ({ ok: true }) as SendResult);
const createFollowupMock = vi.fn((): Followup => ({
  editOriginal: editOriginalSpy,
  send: sendSpy,
}));

vi.mock("../src/discord/followup", () => ({
  createFollowup: (...args: unknown[]) => createFollowupMock(...(args as [])),
}));

// モック確立後に対象モジュールを import する。
import {
  enqueueDeferredContinuation,
  lookupContinuation,
  registerContinuation,
  runScheduledContinuation,
} from "../src/discord/continuation";

// --- フィクスチャ ---------------------------------------------------------

const env = {
  DISCORD_BOT_TOKEN: "bot-token-xyz",
  DISCORD_APPLICATION_ID: "app-123",
  DISCORD_PUBLIC_KEY: "pubkey",
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
  scheduleSpy.mockClear();
  getCycleAgentMock.mockClear();
  editOriginalSpy.mockClear();
  sendSpy.mockClear();
  createFollowupMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- 継続レジストリ(Req 8.6, 8.8) ----------------------------------------

describe("継続レジストリ: registerContinuation / lookupContinuation", () => {
  it("登録したキーで継続関数を照合できる(往復)", () => {
    const fn: Continuation = async () => {};
    registerContinuation("registry:roundtrip", fn);
    expect(lookupContinuation("registry:roundtrip")).toBe(fn);
  });

  it("未登録キーは null を返す", () => {
    expect(lookupContinuation("registry:never-registered")).toBeNull();
  });
});

// --- enqueue ヘルパー(Req 8.1, 8.2) --------------------------------------

describe("enqueueDeferredContinuation: primary cycle agent seam へ委譲", () => {
  it("getCycleAgent(env, userId, PRIMARY_CYCLE_KEY) を引き、seam へ envelope を渡す", async () => {
    const envelope = makeEnvelope();

    await enqueueDeferredContinuation(env, "user-42", envelope);

    expect(getCycleAgentMock).toHaveBeenCalledWith(env, "user-42", "primary");
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    expect(scheduleSpy).toHaveBeenCalledWith(envelope);
  });
});

// --- substrate runner(Req 8.3-8.5) ---------------------------------------

describe("runScheduledContinuation: alarm 実行 substrate", () => {
  it("成功時: 継続を実行し、本応答 follow-up を送る(失敗 follow-up は送らない)", async () => {
    const observed: { env?: DiscordEnv; payload?: ContinuationPayload; followup?: Followup } = {};
    const continuation: Continuation = async (e, payload, followup) => {
      observed.env = e;
      observed.payload = payload;
      observed.followup = followup;
      await followup.editOriginal("本応答です");
    };
    registerContinuation("runner:success", continuation);

    const envelope = makeEnvelope({ continuationKey: "runner:success", payload: { a: 1 } });
    await runScheduledContinuation(env, envelope);

    // Followup は envelope の token から再構築される(Req 8.3, 8.4)。
    expect(createFollowupMock).toHaveBeenCalledWith(env, "interaction-token-abc");
    // 継続は env + payload + followup で呼ばれる(Req 8.6)。
    expect(observed.env).toBe(env);
    expect(observed.payload).toEqual({ a: 1 });
    expect(editOriginalSpy).toHaveBeenCalledTimes(1);
    expect(editOriginalSpy.mock.calls[0]?.[0]).toBe("本応答です");
    // 成功経路では追加の失敗通知を送らない。
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("継続キー未登録時: 失敗 follow-up を送り固着を防ぐ(Req 8.5)", async () => {
    const envelope = makeEnvelope({ continuationKey: "runner:unregistered-key" });

    await runScheduledContinuation(env, envelope);

    // 継続は実行できないため、失敗 follow-up が editOriginal で送られる。
    expect(editOriginalSpy).toHaveBeenCalledTimes(1);
    const [content] = editOriginalSpy.mock.calls[0] as [string];
    expect(typeof content).toBe("string");
    expect(content.length).toBeGreaterThan(0);
  });

  it("継続例外時: 失敗 follow-up を送り固着を防ぐ(Req 8.5)", async () => {
    const continuation: Continuation = async () => {
      throw new Error("continuation boom");
    };
    registerContinuation("runner:throws", continuation);

    const envelope = makeEnvelope({ continuationKey: "runner:throws" });
    await expect(runScheduledContinuation(env, envelope)).resolves.toBeUndefined();

    // 例外を握りつぶさず失敗 follow-up を送る(throw 後にも editOriginal が呼ばれる)。
    expect(editOriginalSpy).toHaveBeenCalledTimes(1);
  });

  it("継続自身の本応答 follow-up 送信が失敗した時: 失敗 follow-up を追送する(Req 8.5)", async () => {
    // 継続は editOriginal を呼ぶが token 失効等で 1 通目が失敗結果を返す。substrate はこれを
    // 検知し、deferred 固着を防ぐため失敗通知 follow-up を追送する(2 通目の editOriginal)。
    editOriginalSpy.mockResolvedValueOnce({ ok: false, reason: "not_found", status: 404 });
    const continuation: Continuation = async (_e, _payload, followup) => {
      await followup.editOriginal("本応答です");
    };
    registerContinuation("runner:send-failure", continuation);

    const envelope = makeEnvelope({ continuationKey: "runner:send-failure" });
    await runScheduledContinuation(env, envelope);

    // 継続の 1 通目失敗 → substrate が失敗 follow-up を追送(計 2 回 editOriginal)。
    expect(editOriginalSpy).toHaveBeenCalledTimes(2);
    expect(editOriginalSpy.mock.calls[1]?.[0]).not.toBe("本応答です");
  });

  it("失敗 follow-up の本応答枠編集が失効した時: 追加 follow-up(send)へフォールバックする", async () => {
    // 継続未登録 → 失敗 follow-up を editOriginal で送ろうとするが token 失効で失敗 →
    // send へフォールバックして必ず利用者へ失敗を伝える(固着防止 / Req 8.5)。
    editOriginalSpy.mockResolvedValue({ ok: false, reason: "not_found", status: 404 });

    const envelope = makeEnvelope({ continuationKey: "runner:fallback-to-send" });
    await runScheduledContinuation(env, envelope);

    expect(editOriginalSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});
