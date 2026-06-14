// ハンドラレジストリ(src/discord/registry.ts)の検証
// (Req 3.1, 3.2, 3.3, 3.4, 3.6, 7.4 / design.md §dispatch・registry "Handler Registry"
// L351-375, Service Interface registerHandler/lookupHandler)。
//
// 完了条件(tasks 3.1): (kind, name) をキーにした登録/照合の往復が成立し、未登録キーで
// null、同一キーの重複登録が検出される(後勝ち禁止)。異なる kind の同名 name は別キーと
// して共存でき、command/component/modal の各 kind で動作する。テスト間で状態が汚染しない
// (factory による独立インスタンス、および module-level のデフォルトインスタンスを reset
// できること)。
//
// 本テストは (kind, name) → handler のマップ規約という純粋ロジックを検証する。
// 実行環境: vitest projects の "node" プロジェクト。

import { beforeEach, describe, expect, it } from "vitest";
import {
  createRegistry,
  DuplicateHandlerError,
  lookupHandler,
  registerHandler,
  resetDefaultRegistry,
} from "../src/discord/registry";
import type { InteractionHandler, InteractionKind } from "../src/discord/types";

/** テスト用のダミーハンドラを生成する(同一性の比較に用いる)。 */
function makeHandler(label: string): InteractionHandler {
  return {
    handle() {
      return { mode: "reply", content: label };
    },
  };
}

const ALL_KINDS: InteractionKind[] = ["command", "component", "modal"];

describe("createRegistry: 独立インスタンス", () => {
  it("(kind, name) で登録したハンドラを lookup で往復取得できる (Req 3.1, 3.6)", () => {
    const registry = createRegistry();
    const handler = makeHandler("checkin");

    registry.register("command", "checkin", handler);

    expect(registry.lookup("command", "checkin")).toBe(handler);
  });

  it("未登録キーでは null を返す (Req 3.4)", () => {
    const registry = createRegistry();

    expect(registry.lookup("command", "unknown")).toBeNull();
  });

  it("登録済みでも別の name は未登録として null を返す (Req 3.4)", () => {
    const registry = createRegistry();
    registry.register("command", "checkin", makeHandler("checkin"));

    expect(registry.lookup("command", "status")).toBeNull();
  });

  it("同一 (kind, name) への重複登録を検出してエラーにする(後勝ち禁止) (Req 3.6)", () => {
    const registry = createRegistry();
    const first = makeHandler("first");
    registry.register("component", "retry_button", first);

    expect(() =>
      registry.register("component", "retry_button", makeHandler("second")),
    ).toThrow(DuplicateHandlerError);

    // 後勝ちしていない(最初のハンドラが保持されている)ことを確認する。
    expect(registry.lookup("component", "retry_button")).toBe(first);
  });

  it("異なる kind の同名 name は別キーとして共存できる (Req 3.1, 3.2, 3.3, 3.6)", () => {
    const registry = createRegistry();
    const asCommand = makeHandler("as-command");
    const asComponent = makeHandler("as-component");
    const asModal = makeHandler("as-modal");

    registry.register("command", "shared", asCommand);
    registry.register("component", "shared", asComponent);
    registry.register("modal", "shared", asModal);

    expect(registry.lookup("command", "shared")).toBe(asCommand);
    expect(registry.lookup("component", "shared")).toBe(asComponent);
    expect(registry.lookup("modal", "shared")).toBe(asModal);
  });

  it.each(ALL_KINDS)("kind=%s で登録/照合の往復が成立する (Req 3.1, 3.2, 3.3)", (kind) => {
    const registry = createRegistry();
    const handler = makeHandler(`handler-${kind}`);

    registry.register(kind, "key", handler);

    expect(registry.lookup(kind, "key")).toBe(handler);
  });

  it("インスタンスは互いに独立している(状態を共有しない)", () => {
    const a = createRegistry();
    const b = createRegistry();
    a.register("command", "only-in-a", makeHandler("a"));

    expect(b.lookup("command", "only-in-a")).toBeNull();
  });
});

describe("module-level registerHandler / lookupHandler(デフォルトインスタンスへの委譲)", () => {
  beforeEach(() => {
    // テスト間の状態汚染を防ぐためデフォルトインスタンスを初期化する。
    resetDefaultRegistry();
  });

  it("module-level の往復が成立する (design Service Interface)", () => {
    const handler = makeHandler("checkin");
    registerHandler("command", "checkin", handler);

    expect(lookupHandler("command", "checkin")).toBe(handler);
  });

  it("未登録キーでは null を返す (Req 3.4)", () => {
    expect(lookupHandler("command", "nope")).toBeNull();
  });

  it("重複登録を検出する(後勝ち禁止) (Req 3.6)", () => {
    registerHandler("modal", "checkin_modal", makeHandler("first"));

    expect(() =>
      registerHandler("modal", "checkin_modal", makeHandler("second")),
    ).toThrow(DuplicateHandlerError);
  });

  it("resetDefaultRegistry でデフォルトインスタンスの状態が初期化される", () => {
    registerHandler("command", "checkin", makeHandler("checkin"));
    expect(lookupHandler("command", "checkin")).not.toBeNull();

    resetDefaultRegistry();

    expect(lookupHandler("command", "checkin")).toBeNull();
  });
});
