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

describe("createRegistry: 接頭辞ディスパッチ(動的 custom_id)", () => {
  it("接頭辞登録した name の前方一致で照合できる (Req 3.4)", () => {
    const registry = createRegistry();
    const save = makeHandler("save");
    registry.registerPrefix("component", "checkin:save:", save);

    expect(registry.lookup("component", "checkin:save:abc123")).toBe(save);
  });

  it("完全一致は接頭辞一致より優先される", () => {
    const registry = createRegistry();
    const exact = makeHandler("exact");
    const prefix = makeHandler("prefix");
    registry.register("component", "checkin:save:abc", exact);
    registry.registerPrefix("component", "checkin:save:", prefix);

    expect(registry.lookup("component", "checkin:save:abc")).toBe(exact);
  });

  it("最長一致の接頭辞ハンドラが選ばれる", () => {
    const registry = createRegistry();
    const broad = makeHandler("broad");
    const narrow = makeHandler("narrow");
    registry.registerPrefix("component", "checkin:", broad);
    registry.registerPrefix("component", "checkin:save:", narrow);

    expect(registry.lookup("component", "checkin:save:abc")).toBe(narrow);
    expect(registry.lookup("component", "checkin:discard:xyz")).toBe(broad);
  });

  it("前方一致しない name は接頭辞ハンドラに照合されず null を返す (Req 3.4)", () => {
    const registry = createRegistry();
    registry.registerPrefix("component", "checkin:save:", makeHandler("save"));

    expect(registry.lookup("component", "other:save:abc")).toBeNull();
    // 区切り無し接頭辞の誤一致を防ぐ(登録側が区切りを含める規約)。
    expect(registry.lookup("component", "checkin:savezzz")).toBeNull();
  });

  it("異なる kind には接頭辞ハンドラが照合されない", () => {
    const registry = createRegistry();
    registry.registerPrefix("component", "checkin:save:", makeHandler("save"));

    expect(registry.lookup("modal", "checkin:save:abc")).toBeNull();
  });

  it("同一 (kind, prefix) の重複接頭辞登録を検出する(後勝ち禁止) (Req 3.6)", () => {
    const registry = createRegistry();
    const first = makeHandler("first");
    registry.registerPrefix("component", "checkin:save:", first);

    expect(() =>
      registry.registerPrefix("component", "checkin:save:", makeHandler("second")),
    ).toThrow(DuplicateHandlerError);
    expect(registry.lookup("component", "checkin:save:abc")).toBe(first);
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
