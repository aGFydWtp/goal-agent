// status-and-draft のメッセージ整形ヘルパーの検証
// (Req 2.2, 3.1, 4.1, 4.3, 5.5, 6.5 / design.md Message Formatter §8.4-§8.7)。

import { describe, expect, it } from "vitest";
import type { DraftContent } from "../src/status-and-draft/draft/schema";
import {
  formatDraft,
  formatEvidenceList,
  formatGoalStatus,
  formatStatusOverview,
} from "../src/status-and-draft/messages";
import type { StatusVerdict } from "../src/status-and-draft/status/schema";
import type { EntityRow } from "../src/types";

function makeGoal(overrides: Partial<EntityRow<"goals">> = {}): EntityRow<"goals"> {
  return {
    id: "goal-1",
    cycle_id: "cycle-1",
    user_id: "user-1",
    title: "生成AI活用・導入",
    description: "",
    success_criteria: null,
    evaluation_points: null,
    status: "yellow",
    created_at: "2026-04-01T00:00:00.000Z",
    updated_at: "2026-04-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeVerdict(overrides: Partial<StatusVerdict> = {}): StatusVerdict {
  return {
    status: "yellow",
    reason: "調査・構想は進んでいますが、実装とチーム展開の証跡がまだ不足しています。",
    risks: [],
    nextActions: ["MVPを1つ決める"],
    reasonMissing: false,
    ...overrides,
  };
}

function makeEvidence(overrides: Partial<EntityRow<"evidence">> = {}): EntityRow<"evidence"> {
  return {
    id: "evidence-1",
    cycle_id: "cycle-1",
    user_id: "user-1",
    source_type: "manual_checkin",
    source_url: null,
    title: null,
    body: "Cloudflare Agents を調査",
    evidence_date: "2026-06-13",
    usefulness: "medium",
    created_at: "2026-06-13T00:00:00.000Z",
    updated_at: "2026-06-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("formatStatusOverview (§8.4)", () => {
  it("ヘッダ・目標ごとの状態/理由・今週やるとよいことを §8.4 構造で整形する", () => {
    const message = formatStatusOverview([
      {
        goal: makeGoal({ id: "g1", title: "生成AI活用・導入" }),
        verdict: makeVerdict({
          status: "yellow",
          reason: "調査・構想は進んでいますが、実装とチーム展開の証跡がまだ不足しています。",
          nextActions: ["MVPを1つ決める"],
        }),
      },
      {
        goal: makeGoal({ id: "g3", title: "技術発信" }),
        verdict: makeVerdict({
          status: "red",
          reason: "3週間、証跡が追加されていません。",
          nextActions: ["Cloudflare Agents の調査内容を社内メモ化する"],
        }),
      },
    ]);

    expect(message).toContain("評価目標ステータス");
    expect(message).toContain("生成AI活用・導入");
    expect(message).toContain("技術発信");
    // 状態は人間向けラベル(Green/Yellow/Red/Gray)へマップする。
    expect(message).toContain("状態: Yellow");
    expect(message).toContain("状態: Red");
    expect(message).toContain("理由:");
    expect(message).toContain("調査・構想は進んでいますが");
    // 目標横断の「今週やるとよいこと」セクションを集約する。
    expect(message).toContain("今週やるとよいこと:");
    expect(message).toContain("生成AI活用・導入: MVPを1つ決める");
    expect(message).toContain("技術発信: Cloudflare Agents の調査内容を社内メモ化する");
  });

  it("全状態ラベルを capitalized 英語へマップする", () => {
    const message = formatStatusOverview([
      { goal: makeGoal({ title: "G_green" }), verdict: makeVerdict({ status: "green" }) },
      { goal: makeGoal({ title: "G_yellow" }), verdict: makeVerdict({ status: "yellow" }) },
      { goal: makeGoal({ title: "G_red" }), verdict: makeVerdict({ status: "red" }) },
      { goal: makeGoal({ title: "G_gray" }), verdict: makeVerdict({ status: "gray" }) },
    ]);

    expect(message).toContain("状態: Green");
    expect(message).toContain("状態: Yellow");
    expect(message).toContain("状態: Red");
    expect(message).toContain("状態: Gray");
  });

  it("reasonMissing 時も目標ブロックを描画し理由欠落をフォールバック表記する", () => {
    const message = formatStatusOverview([
      {
        goal: makeGoal({ title: "見立て欠落目標" }),
        verdict: makeVerdict({ reason: "", reasonMissing: true, nextActions: [] }),
      },
    ]);

    expect(message).toContain("見立て欠落目標");
    expect(message).toContain("理由:");
    // 空 reason でクラッシュせず、何らかのフォールバック文言を出す。
    expect(message).toContain("見立ては取得できませんでした");
  });

  it("nextActions が無い目標は今週やるとよいことへ寄与しない", () => {
    const message = formatStatusOverview([
      {
        goal: makeGoal({ title: "アクション無し目標" }),
        verdict: makeVerdict({ nextActions: [] }),
      },
    ]);

    expect(message).toContain("今週やるとよいこと:");
    expect(message).not.toContain("アクション無し目標:");
  });
});

describe("formatGoalStatus (§8.5)", () => {
  it("目標・状態・見立て・保存済み証跡・不足・次アクションを §8.5 構造で整形する", () => {
    const message = formatGoalStatus(
      makeGoal({ title: "生成AI活用・導入", status: "yellow" }),
      makeVerdict({
        status: "yellow",
        reason: "調査・構想は進んでいます。",
        nextActions: ["MVP対象を1つ決める", "GoalAgent のデータ構造を作る"],
      }),
      [
        makeEvidence({ evidence_date: "2026-06-13", body: "Cloudflare Agents を調査" }),
        makeEvidence({ evidence_date: "2026-06-13", body: "Durable Objects を整理" }),
      ],
      ["MVP実装", "チーム共有"],
    );

    expect(message).toContain("目標: 生成AI活用・導入");
    expect(message).toContain("状態: Yellow");
    expect(message).toContain("Agent の見立て:");
    expect(message).toContain("調査・構想は進んでいます。");
    expect(message).toContain("保存済み証跡:");
    expect(message).toContain("- 2026-06-13 Cloudflare Agents を調査");
    expect(message).toContain("- 2026-06-13 Durable Objects を整理");
    expect(message).toContain("不足:");
    expect(message).toContain("- MVP実装");
    expect(message).toContain("- チーム共有");
    expect(message).toContain("次アクション:");
    // 次アクションは番号付き。
    expect(message).toContain("1. MVP対象を1つ決める");
    expect(message).toContain("2. GoalAgent のデータ構造を作る");
  });

  it("証跡が無い場合は保存済み証跡欄に未保存案内を出す", () => {
    const message = formatGoalStatus(
      makeGoal({ title: "証跡無し目標" }),
      makeVerdict({ status: "gray", reason: "判断材料が不足しています。" }),
      [],
      [],
    );

    expect(message).toContain("保存済み証跡:");
    expect(message).toContain("証跡が未保存");
  });
});

describe("formatEvidenceList (§8.6)", () => {
  it("ヘッダ・証跡ごとの日付/内容/紐づく目標/使いやすさ/補足を §8.6 構造で整形する", () => {
    const message = formatEvidenceList([
      {
        evidence: makeEvidence({
          evidence_date: "2026-06-13",
          body: "Cloudflare Agents と Durable Objects を調査した。",
          usefulness: "medium",
        }),
        linkedGoalTitles: ["生成AI活用・導入"],
      },
    ]);

    expect(message).toContain("保存済み証跡");
    expect(message).toContain("2026-06-13");
    expect(message).toContain("内容:");
    expect(message).toContain("Cloudflare Agents と Durable Objects を調査した。");
    expect(message).toContain("紐づく目標:");
    expect(message).toContain("- 生成AI活用・導入");
    expect(message).toContain("評価への使いやすさ:");
    expect(message).toContain("中");
    expect(message).toContain("補足:");
  });

  it("usefulness を low→低 / medium→中 / high→高 にマップする", () => {
    const low = formatEvidenceList([
      { evidence: makeEvidence({ usefulness: "low" }), linkedGoalTitles: ["G"] },
    ]);
    const medium = formatEvidenceList([
      { evidence: makeEvidence({ usefulness: "medium" }), linkedGoalTitles: ["G"] },
    ]);
    const high = formatEvidenceList([
      { evidence: makeEvidence({ usefulness: "high" }), linkedGoalTitles: ["G"] },
    ]);

    expect(low).toContain("評価への使いやすさ:\n低");
    expect(medium).toContain("評価への使いやすさ:\n中");
    expect(high).toContain("評価への使いやすさ:\n高");
  });

  it("紐づく目標が無い証跡もクラッシュせず描画する", () => {
    const message = formatEvidenceList([
      { evidence: makeEvidence(), linkedGoalTitles: [] },
    ]);

    expect(message).toContain("紐づく目標:");
    expect(message).toContain("- なし");
  });

  it("証跡が空のとき未保存案内を返す(Req 4.3)", () => {
    const message = formatEvidenceList([]);

    expect(message).toContain("証跡");
    expect(message).toContain("未保存");
    // 証跡ブロックのヘッダ「内容:」は出さない。
    expect(message).not.toContain("内容:");
  });
});

describe("formatDraft (§8.7)", () => {
  it("ドラフト本文を §8.7 構造で整形し、調整/保存ボタン提示テキストを返す", () => {
    const content: DraftContent = {
      facts: "Cloudflare Agents / Durable Objects を調査し、業務適用可能性を検討した。",
      interpretation: "新しい Agent 基盤の実用アプリ案を具体化した。",
      issues: "現時点では実装・チーム展開の証跡はまだ不足している。",
      nextActions: "評価目標フォロー Agent を MVP として試作する。",
      speculativeNotes: [],
    };

    const message = formatDraft(content);

    expect(message).toContain("自己評価ドラフト");
    expect(message).toContain("Cloudflare Agents / Durable Objects を調査");
    expect(message).toContain("新しい Agent 基盤の実用アプリ案を具体化した。");
    expect(message).toContain("現時点では実装・チーム展開の証跡はまだ不足している。");
    expect(message).toContain("評価目標フォロー Agent を MVP として試作する。");
    // §8.7 のボタン提示テキスト。
    expect(message).toContain("[短くする]");
    expect(message).toContain("[成果を強める]");
    expect(message).toContain("[課題を明確にする]");
    expect(message).toContain("[上司向けにする]");
    expect(message).toContain("[保存]");
  });

  it("speculativeNotes があれば推測として明示する(Req 5.4)", () => {
    const content: DraftContent = {
      facts: "事実。",
      interpretation: "解釈。",
      issues: "課題。",
      nextActions: "次アクション。",
      speculativeNotes: ["チームへの展開が今後見込まれる"],
    };

    const message = formatDraft(content);

    expect(message).toContain("推測");
    expect(message).toContain("チームへの展開が今後見込まれる");
  });

  it("speculativeNotes が空のときは推測セクションを出さない", () => {
    const content: DraftContent = {
      facts: "事実。",
      interpretation: "解釈。",
      issues: "課題。",
      nextActions: "次アクション。",
      speculativeNotes: [],
    };

    const message = formatDraft(content);

    expect(message).not.toContain("推測:");
  });
});
