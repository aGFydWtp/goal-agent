// message component button 契約型(task 6.1 / src/discord/types.ts)の検証
// (Req 4.8, 4.11 / design.md §types Service Interface L304-322, Requirements
// Traceability L239-242)。
//
// 完了条件(tasks 6.1): MessageButton / MessageActionRow / MessageOptions が公開され
// reply 変種が components を持つ。追加は型への純加算で、message 用 MessageActionRow と
// modal 用 ModalActionRow が型レベルで区別される。
//
// 本テストは型契約(コンパイル時の構造)と値の生成可能性を検証する純ロジック。
// 実行環境: vitest projects の "node" プロジェクト。

import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  HandlerResult,
  MessageActionRow,
  MessageButton,
  MessageButtonStyle,
  MessageOptions,
  ModalActionRow,
} from "../src/discord/types";

describe("MessageButton (Req 4.8)", () => {
  it("type2 / custom_id / label / style / 任意 disabled を持つ", () => {
    const btn: MessageButton = {
      type: 2,
      custom_id: "btn:confirm",
      label: "確定",
      style: 1,
      disabled: false,
    };
    expect(btn.type).toBe(2);
    expect(btn.custom_id).toBe("btn:confirm");
    expect(btn.label).toBe("確定");
    expect(btn.style).toBe(1);
    expect(btn.disabled).toBe(false);
  });

  it("style は 1-4(Primary/Secondary/Success/Danger)に限定される", () => {
    expectTypeOf<MessageButtonStyle>().toEqualTypeOf<1 | 2 | 3 | 4>();
    expectTypeOf<MessageButton["style"]>().toEqualTypeOf<MessageButtonStyle>();
  });
});

describe("MessageActionRow (Req 4.8)", () => {
  it("type1 で MessageButton[] を内包する", () => {
    const row: MessageActionRow = {
      type: 1,
      components: [{ type: 2, custom_id: "a", label: "A", style: 2 }],
    };
    expect(row.type).toBe(1);
    expect(row.components[0]?.type).toBe(2);
  });
});

describe("MessageOptions (Req 4.8, 4.9)", () => {
  it("ephemeral と components(MessageActionRow[])を任意で持つ", () => {
    const opts: MessageOptions = {
      ephemeral: true,
      components: [{ type: 1, components: [{ type: 2, custom_id: "a", label: "A", style: 3 }] }],
    };
    expect(opts.ephemeral).toBe(true);
    expect(opts.components?.[0]?.components[0]?.style).toBe(3);
  });

  it("空オブジェクトも許容する(両フィールド任意)", () => {
    const opts: MessageOptions = {};
    expect(opts.components).toBeUndefined();
  });
});

describe("HandlerResult.reply への純加算(Req 4.8)", () => {
  it("reply 変種は任意の components を持てる", () => {
    const result: HandlerResult = {
      mode: "reply",
      content: "押してください",
      components: [
        { type: 1, components: [{ type: 2, custom_id: "btn:ok", label: "OK", style: 1 }] },
      ],
    };
    // 既存フィールド(mode/content/ephemeral)は維持されている。
    expect(result.mode).toBe("reply");
    if (result.mode === "reply") {
      expect(result.components?.[0]?.components[0]?.custom_id).toBe("btn:ok");
    }
  });

  it("components 無しの reply も従来どおり成立する(純加算)", () => {
    const result: HandlerResult = { mode: "reply", content: "hello" };
    if (result.mode === "reply") {
      expect(result.components).toBeUndefined();
    }
  });
});

describe("message 用と modal 用 action row の型レベル区別(Req 4.8)", () => {
  it("MessageActionRow の子は button(type2)、ModalActionRow の子は text input(type4)", () => {
    expectTypeOf<MessageActionRow["components"][number]["type"]>().toEqualTypeOf<2>();
    expectTypeOf<ModalActionRow["components"][number]["type"]>().toEqualTypeOf<4>();
  });
});
