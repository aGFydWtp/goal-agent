// 応答ユーティリティ(src/discord/response.ts)の検証 (Req 1.4, 4.1, 4.5, 4.6, 4.7,
// 6.2 / design.md §response "Response Utilities" L237, Requirements Traceability
// L210-222 のインターフェイス pong/reply/deferred/modal、Testing Strategy L519)。
//
// 完了条件(tasks 2.2): PONG(type1)/reply(type4)/deferred(type5)/modal(type9)
// の各応答ボディが生成され、type9 が customId/title/text input を含む payload を
// 生成し、ephemeral 指定でフラグ(64)が立つ。enum 値が design 記載数値と一致する。
//
// 本テストは応答ボディ(JSON シリアライズ可能なオブジェクト)生成の純粋ロジックを
// 検証する。実行環境: vitest projects の "node" プロジェクト。

import { InteractionResponseType, MessageFlags } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import { deferred, modal, pong, reply } from "../src/discord/response";
import type { MessageActionRow, ModalActionRow } from "../src/discord/types";

describe("response: enum 値が design 記載と一致する", () => {
  it("InteractionResponseType / MessageFlags が期待数値である", () => {
    // design L210/220/218/222/519 が前提とする数値。ハードコードでなく enum を
    // 使うが、値が design 記載(1/4/5/9, 64)と一致することを固定する。
    expect(InteractionResponseType.Pong).toBe(1);
    expect(InteractionResponseType.ChannelMessageWithSource).toBe(4);
    expect(InteractionResponseType.DeferredChannelMessageWithSource).toBe(5);
    expect(InteractionResponseType.Modal).toBe(9);
    expect(MessageFlags.Ephemeral).toBe(64);
  });
});

describe("pong (Req 1.4)", () => {
  it("type1 (PONG) のボディを生成する", () => {
    const body = pong();
    expect(body).toEqual({ type: 1 });
  });
});

describe("reply (Req 4.5, 4.6, 6.2)", () => {
  it("type4 + content を生成する(ephemeral 未指定時は flags なし)", () => {
    const body = reply("hello");
    expect(body.type).toBe(4);
    expect(body.data.content).toBe("hello");
    expect(body.data.flags).toBeUndefined();
  });

  it("ephemeral 指定で data.flags === 64 が立つ", () => {
    const body = reply("secret", { ephemeral: true });
    expect(body.type).toBe(4);
    expect(body.data.content).toBe("secret");
    expect(body.data.flags).toBe(64);
  });

  it("ephemeral: false で flags を立てない", () => {
    const body = reply("public", { ephemeral: false });
    expect(body.data.flags).toBeUndefined();
  });
});

describe("deferred (Req 4.1, 4.6, 6.2)", () => {
  it("type5 のボディを生成する(ephemeral 未指定時は flags なし)", () => {
    const body = deferred();
    expect(body.type).toBe(5);
    expect(body.data?.flags).toBeUndefined();
  });

  it("ephemeral 指定で data.flags === 64 が立つ", () => {
    const body = deferred({ ephemeral: true });
    expect(body.type).toBe(5);
    expect(body.data?.flags).toBe(64);
  });

  it("ephemeral: false で flags を立てない", () => {
    const body = deferred({ ephemeral: false });
    expect(body.data?.flags).toBeUndefined();
  });
});

describe("modal (Req 4.7)", () => {
  const components: ModalActionRow[] = [
    {
      type: 1,
      components: [
        {
          type: 4,
          custom_id: "field_note",
          label: "メモ",
          style: 2,
          required: true,
        },
      ],
    },
  ];

  it("type9 + data.custom_id/title/components を生成する", () => {
    const body = modal({
      customId: "checkin_modal",
      title: "チェックイン",
      components,
    });
    expect(body.type).toBe(9);
    expect(body.data.custom_id).toBe("checkin_modal");
    expect(body.data.title).toBe("チェックイン");
    expect(body.data.components).toBe(components);
  });

  it("payload の components は action row(type1)内に text input(type4)を含む", () => {
    const body = modal({
      customId: "checkin_modal",
      title: "チェックイン",
      components,
    });
    // response の components は v10 の component union 型。生成時に渡した
    // ModalActionRow[] と同一参照であることは前テストで確認済みのため、構造検証は
    // ローカル payload 型で行う。
    const rows = body.data.components as ModalActionRow[];
    const row = rows[0]!;
    expect(row.type).toBe(1);
    const input = row.components[0]!;
    expect(input.type).toBe(4);
    expect(input.custom_id).toBe("field_note");
  });
});

describe("reply: message component button(task 6.2, Req 4.8)", () => {
  const row: MessageActionRow = {
    type: 1,
    components: [
      { type: 2, custom_id: "btn:confirm", label: "確定", style: 1 },
      { type: 2, custom_id: "btn:cancel", label: "取消", style: 4, disabled: true },
    ],
  };

  it("components 指定で type4 応答の data.components に action row/button が含まれる", () => {
    const body = reply("実行しますか?", { components: [row] });
    expect(body.type).toBe(4);
    expect(body.data.content).toBe("実行しますか?");
    expect(body.data.components).toEqual([row]);
  });

  it("button style は 1-4(message button)で、modal の text input(type4 component)と混同しない", () => {
    const body = reply("x", { components: [row] });
    const rows = body.data.components as MessageActionRow[];
    const btn = rows[0]!.components[0]!;
    expect(rows[0]!.type).toBe(1); // ActionRow
    expect(btn.type).toBe(2); // Button(modal の text input は type4)
    expect(btn.style).toBe(1);
  });

  it("ephemeral と併用でき、flags(64)と components の双方が出力される", () => {
    const body = reply("本人のみ", { ephemeral: true, components: [row] });
    expect(body.data.flags).toBe(64);
    expect(body.data.components).toEqual([row]);
  });

  it("components 未指定時は data.components を出力しない(純加算 / 既存挙動維持)", () => {
    const body = reply("hello");
    expect(body.data.components).toBeUndefined();
  });
});
