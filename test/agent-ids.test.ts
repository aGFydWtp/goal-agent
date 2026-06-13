// Agent ID 規約(仕様書 §6)の組立/分解ユーティリティの検証(Req 3.2 / design.md "Agent IDs + Routing")。
//
// 完了条件: 組立/分解が往復一致し、不正な ID 文字列は分解で null を返すこと。
// 加えて、往復一致を曖昧にしないために、区切り文字 `:` を含む / 空の id は
// 組立側で拒否(throw)する契約とする。
//
// 実行環境: vitest projects の "node" プロジェクト(純粋ロジック)。

import { describe, expect, it } from "vitest";
import {
  cycleAgentName,
  goalAgentName,
  parseAgentName,
} from "../src/agents/ids";

describe("cycleAgentName / goalAgentName", () => {
  it("§6 の cycle 名を厳密に組み立てる", () => {
    expect(cycleAgentName("haruki", "2026H1")).toBe("evaluation:haruki:2026H1");
  });

  it("§6 の goal 名を厳密に組み立てる", () => {
    expect(goalAgentName("haruki", "2026H1", "ai-adoption")).toBe(
      "evaluation:haruki:2026H1:goal:ai-adoption",
    );
    expect(goalAgentName("haruki", "2026H1", "quality-improvement")).toBe(
      "evaluation:haruki:2026H1:goal:quality-improvement",
    );
  });

  it("空 id を拒否する(throw)", () => {
    expect(() => cycleAgentName("", "2026H1")).toThrow();
    expect(() => cycleAgentName("haruki", "")).toThrow();
    expect(() => goalAgentName("", "2026H1", "g")).toThrow();
    expect(() => goalAgentName("haruki", "", "g")).toThrow();
    expect(() => goalAgentName("haruki", "2026H1", "")).toThrow();
  });

  it("区切り文字 `:` を含む id を拒否する(throw)", () => {
    expect(() => cycleAgentName("har:uki", "2026H1")).toThrow();
    expect(() => cycleAgentName("haruki", "2026:H1")).toThrow();
    expect(() => goalAgentName("haruki", "2026H1", "ai:adoption")).toThrow();
  });
});

describe("parseAgentName (round-trip)", () => {
  it("cycle 名を構造化して往復一致する", () => {
    const name = cycleAgentName("haruki", "2026H1");
    expect(parseAgentName(name)).toEqual({
      kind: "cycle",
      userId: "haruki",
      cycleId: "2026H1",
    });
  });

  it("goal 名を構造化して往復一致する", () => {
    const name = goalAgentName("haruki", "2026H1", "ai-adoption");
    expect(parseAgentName(name)).toEqual({
      kind: "goal",
      userId: "haruki",
      cycleId: "2026H1",
      goalId: "ai-adoption",
    });
  });
});

describe("parseAgentName (不正入力 → null)", () => {
  it.each([
    ["空文字列", ""],
    ["プレフィックス不正", "foo:a:b"],
    ["セグメント不足", "evaluation:a"],
    ["セグメント過多/不正アリティ", "evaluation:a:b:c:d:e"],
    ["goal マーカーが goal でない", "evaluation:a:b:notgoal:d"],
    ["空セグメント(中間)", "evaluation::b"],
    ["空セグメント(末尾)", "evaluation:a:"],
  ])("%s → null", (_label, input) => {
    expect(parseAgentName(input)).toBeNull();
  });
});
