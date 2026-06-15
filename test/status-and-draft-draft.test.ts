// status-and-draft の draft プロンプト・出力スキーマ・検証の単体テスト
// (Req 5.1, 5.4, 5.7, 6.1, 6.2, 6.3, 6.4, 7.2 /
//  design.md「Draft Prompt + Schema + Verify」Service Interface・Testing Strategy Unit Tests、
//  Requirements Traceability 5.1/5.4/6.1-6.4/7.2)。
//
// 完了条件(task 3.1):
// - draftContentSchema が 4 セクション + 推測注記ありで safeParse 受理、セクション欠落で不一致。
// - refineKindToDraftType の kind→type 対応が期待通り。
// - buildDraftPrompt が証跡・誇張抑制・推測明示の指示を含み、goalTitle null を「全体」として扱う。
// - buildRefinePrompt が kind ごとに別個の指示を生成し、strengthen で捏造禁止ガードを保持する。

import { describe, expect, it } from "vitest";
import {
  buildDraftPrompt,
  buildRefinePrompt,
} from "../src/status-and-draft/draft/prompt";
import {
  draftContentSchema,
  type DraftContent,
  type DraftEvidenceInput,
  type RefineKind,
} from "../src/status-and-draft/draft/schema";
import { refineKindToDraftType } from "../src/status-and-draft/draft/verify";

const validDraft: DraftContent = {
  facts: "API のレート制限機能を実装し、既存テストを通した。",
  interpretation: "目標の信頼性向上に直接貢献した。",
  issues: "負荷試験が未実施で実運用での挙動が未検証。",
  nextActions: "来週に負荷試験を実施する。",
  speculativeNotes: ["レビュー工数の削減は推測(証跡なし)。"],
};

describe("draftContentSchema", () => {
  it("4 セクション + speculativeNotes ありで受理する(Req 5.4)", () => {
    const result = draftContentSchema.safeParse(validDraft);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.facts).toBe(validDraft.facts);
      expect(result.data.speculativeNotes).toEqual(validDraft.speculativeNotes);
    }
  });

  it("speculativeNotes が空配列でも受理する(推測なしは有効)", () => {
    const result = draftContentSchema.safeParse({
      ...validDraft,
      speculativeNotes: [],
    });
    expect(result.success).toBe(true);
  });

  it("セクション欠落(issues 無し)で不一致になる(invalid_output, Req 5.4)", () => {
    const { issues: _issues, ...withoutIssues } = validDraft;
    const result = draftContentSchema.safeParse(withoutIssues);
    expect(result.success).toBe(false);
  });

  it("nextActions 欠落で不一致になる", () => {
    const { nextActions: _next, ...withoutNext } = validDraft;
    const result = draftContentSchema.safeParse(withoutNext);
    expect(result.success).toBe(false);
  });

  it("speculativeNotes が配列でない場合は不一致になる", () => {
    const result = draftContentSchema.safeParse({
      ...validDraft,
      speculativeNotes: "推測です",
    });
    expect(result.success).toBe(false);
  });

  it("セクションが文字列でない場合は不一致になる", () => {
    const result = draftContentSchema.safeParse({
      ...validDraft,
      facts: 123,
    });
    expect(result.success).toBe(false);
  });

  it("余分なキーは拒否する(.strict)", () => {
    const result = draftContentSchema.safeParse({
      ...validDraft,
      extra: "余分",
    });
    expect(result.success).toBe(false);
  });
});

describe("refineKindToDraftType", () => {
  it("null(初期生成)は self_evaluation(Req 7.2)", () => {
    expect(refineKindToDraftType(null)).toBe("self_evaluation");
  });

  it("manager は manager_summary(Req 7.2)", () => {
    expect(refineKindToDraftType("manager")).toBe("manager_summary");
  });

  it("shorten は short_summary(Req 7.2)", () => {
    expect(refineKindToDraftType("shorten")).toBe("short_summary");
  });

  it("strengthen は self_evaluation(Req 7.2)", () => {
    expect(refineKindToDraftType("strengthen")).toBe("self_evaluation");
  });

  it("clarify は self_evaluation(Req 7.2)", () => {
    expect(refineKindToDraftType("clarify")).toBe("self_evaluation");
  });
});

describe("buildDraftPrompt", () => {
  const input: DraftEvidenceInput = {
    goalTitle: "API 信頼性の向上",
    evidence: [
      {
        body: "レート制限機能を実装",
        evidenceDate: "2026-05-10",
        usefulness: "high",
      },
      {
        body: "監視ダッシュボードを追加",
        evidenceDate: "2026-05-20",
        usefulness: "medium",
      },
    ],
  };

  it("system / prompt 文字列を返す", () => {
    const { system, prompt } = buildDraftPrompt(input);
    expect(typeof system).toBe("string");
    expect(system.length).toBeGreaterThan(0);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("目標タイトルと全証跡の本文・日付・有用度を含む(Req 5.1)", () => {
    const { prompt } = buildDraftPrompt(input);
    expect(prompt).toContain("API 信頼性の向上");
    expect(prompt).toContain("レート制限機能を実装");
    expect(prompt).toContain("監視ダッシュボードを追加");
    expect(prompt).toContain("2026-05-10");
    expect(prompt).toContain("2026-05-20");
    expect(prompt).toContain("high");
    expect(prompt).toContain("medium");
  });

  it("事実/解釈/課題/次アクションの分離を指示する(Req 5.1)", () => {
    const { prompt } = buildDraftPrompt(input);
    expect(prompt).toContain("事実");
    expect(prompt).toContain("解釈");
    expect(prompt).toContain("課題");
    expect(prompt).toContain("次アクション");
  });

  it("誇張抑制を指示する(Req 5.4)", () => {
    const combined = JSON.stringify(buildDraftPrompt(input));
    expect(combined).toContain("誇張");
  });

  it("証跡にない内容を推測として明示するよう指示する(Req 5.4)", () => {
    const { prompt } = buildDraftPrompt(input);
    expect(prompt).toContain("推測");
    expect(prompt).toContain("speculativeNotes");
  });

  it("goalTitle が null のとき「全体」として扱う(Req 5.2 全体ドラフト)", () => {
    const { prompt } = buildDraftPrompt({ ...input, goalTitle: null });
    expect(prompt).toContain("全体");
  });
});

describe("buildRefinePrompt", () => {
  const prev = validDraft;
  const kinds: readonly RefineKind[] = [
    "shorten",
    "strengthen",
    "clarify",
    "manager",
  ];

  it("直前ドラフトの各セクションを入力に含める(Req 6.5)", () => {
    const { prompt } = buildRefinePrompt(prev, "shorten");
    expect(prompt).toContain(prev.facts);
    expect(prompt).toContain(prev.interpretation);
    expect(prompt).toContain(prev.issues);
    expect(prompt).toContain(prev.nextActions);
  });

  it("kind ごとに別個の指示を生成する", () => {
    const prompts = kinds.map((kind) => buildRefinePrompt(prev, kind).prompt);
    const unique = new Set(prompts);
    expect(unique.size).toBe(kinds.length);
  });

  it("shorten は簡潔化を指示する(Req 6.1)", () => {
    const { prompt } = buildRefinePrompt(prev, "shorten");
    expect(prompt).toContain("簡潔");
  });

  it("strengthen は成果強調かつ捏造禁止ガードを保持する(Req 6.2)", () => {
    const { system, prompt } = buildRefinePrompt(prev, "strengthen");
    const combined = `${system}\n${prompt}`;
    expect(prompt).toContain("成果");
    // 成果強調でも事実を捏造しない/誇張しない/推測は推測として明示するガードを維持する。
    expect(combined).toContain("誇張");
    expect(combined).toContain("推測");
  });

  it("clarify は課題と次アクションの明確化を指示する(Req 6.3)", () => {
    const { prompt } = buildRefinePrompt(prev, "clarify");
    expect(prompt).toContain("課題");
    expect(prompt).toContain("次アクション");
  });

  it("manager は上司・評価者向けトーンを指示する(Req 6.4)", () => {
    const { prompt } = buildRefinePrompt(prev, "manager");
    expect(prompt).toContain("上司");
  });

  it("全 kind で推測注記の保持を指示する(Req 6.2 推測明示維持)", () => {
    for (const kind of kinds) {
      const { prompt } = buildRefinePrompt(prev, kind);
      expect(prompt).toContain("speculativeNotes");
    }
  });
});
