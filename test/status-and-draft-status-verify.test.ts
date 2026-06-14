// status-and-draft のステータス見立てプロンプト・構造化出力スキーマ・統合の検証
// (Req 1.1, 1.3, 1.5 / design.md "Status Rules + Prompt + Schema + Verify")。

import { describe, expect, expectTypeOf, it } from "vitest";
import type { LlmResult } from "../src/llm/client";
import { buildStatusPrompt } from "../src/status-and-draft/status/prompt";
import type { GoalStatusContext, RuleOutcome } from "../src/status-and-draft/status/rules";
import {
  type StatusVerdict,
  statusVerdictLlmSchema,
} from "../src/status-and-draft/status/schema";
import { combineVerdict } from "../src/status-and-draft/status/verify";

const baseContext: GoalStatusContext = {
  goalId: "goal-ai",
  title: "AI 活用の定着",
  description: "チームが日常業務で生成 AI を安全に使える状態を作る",
  successCriteria: "週 3 件以上の利用事例とガイドライン更新",
  evaluationPoints: "定着度と安全性のバランス",
  evidence: [
    { body: "議事録要約 bot を試作した", evidenceDate: "2026-06-01", usefulness: "high" },
    { body: "利用ガイドラインの草案を作成した", evidenceDate: "2026-06-05", usefulness: "medium" },
  ],
  daysUntilCycleEnd: 30,
  latestEvidenceAgeDays: 9,
};

const validVerdict = {
  status: "green",
  reason: "直近に成果証跡があり達成条件に着実に近づいている",
  risks: ["利用事例の継続記録が不足する可能性"],
  nextActions: ["ガイドライン更新 PR を出す"],
} satisfies Omit<StatusVerdict, "reasonMissing">;

describe("statusVerdictLlmSchema", () => {
  it("§13.2 の status/reason/risks/nextActions 形式を受理する", () => {
    const parsed = statusVerdictLlmSchema.safeParse(validVerdict);

    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("expected status verdict parse to succeed");

    expect(parsed.data.status).toBe("green");
    expect(parsed.data.risks).toEqual(["利用事例の継続記録が不足する可能性"]);
    expect(parsed.data.nextActions).toEqual(["ガイドライン更新 PR を出す"]);
  });

  it("StatusVerdict は schema infer 型 + reasonMissing で構成される", () => {
    expectTypeOf<StatusVerdict>().toEqualTypeOf<
      import("zod").infer<typeof statusVerdictLlmSchema> & { reasonMissing: boolean }
    >();
  });

  it("status が GoalStatus 列挙外の出力を拒否する", () => {
    expect(
      statusVerdictLlmSchema.safeParse({ ...validVerdict, status: "blue" }).success,
    ).toBe(false);
  });

  it("risks 配列が欠けた出力を拒否する", () => {
    const { risks: _risks, ...withoutRisks } = validVerdict;
    expect(statusVerdictLlmSchema.safeParse(withoutRisks).success).toBe(false);
  });

  it("nextActions が文字列配列でない出力を拒否する", () => {
    expect(
      statusVerdictLlmSchema.safeParse({ ...validVerdict, nextActions: "やること" }).success,
    ).toBe(false);
  });

  it("reason が文字列でない出力を拒否する", () => {
    expect(
      statusVerdictLlmSchema.safeParse({ ...validVerdict, reason: 123 }).success,
    ).toBe(false);
  });
});

describe("buildStatusPrompt", () => {
  it("目標定義・達成条件・証跡・半期終了までの日数をプロンプト本文へ反映する", () => {
    const request = buildStatusPrompt(baseContext);

    expect(request.system.length).toBeGreaterThan(0);
    expect(request.prompt.length).toBeGreaterThan(0);
    expect(request.system).toContain("JSON");
    expect(request.prompt).toContain("AI 活用の定着");
    expect(request.prompt).toContain("週 3 件以上の利用事例とガイドライン更新");
    expect(request.prompt).toContain("議事録要約 bot を試作した");
    expect(request.prompt).toContain("2026-06-01");
    expect(request.prompt).toContain("30");
  });

  it("status/reason/risks/nextActions の出力要件を明示する", () => {
    const request = buildStatusPrompt(baseContext);

    expect(request.prompt).toContain("status");
    expect(request.prompt).toContain("reason");
    expect(request.prompt).toContain("risks");
    expect(request.prompt).toContain("nextActions");
  });

  it("達成条件・評価観点が未設定でも未設定として明示する", () => {
    const request = buildStatusPrompt({
      ...baseContext,
      successCriteria: null,
      evaluationPoints: null,
    });

    expect(request.prompt).toContain("未設定");
  });
});

describe("combineVerdict", () => {
  const ruleOutcome: RuleOutcome = { candidate: "yellow", insufficientMaterial: false };

  it("LLM 成功時は見立てを採用し reasonMissing を false にする", () => {
    const llm: LlmResult<typeof validVerdict> = { ok: true, value: validVerdict };

    const result = combineVerdict(ruleOutcome, llm);

    expect(result.status).toBe("green");
    expect(result.reason).toBe(validVerdict.reason);
    expect(result.risks).toEqual(validVerdict.risks);
    expect(result.nextActions).toEqual(validVerdict.nextActions);
    expect(result.reasonMissing).toBe(false);
  });

  it("LLM 失敗時はルール候補で status を成立させ reasonMissing を true にする", () => {
    const llm: LlmResult<typeof validVerdict> = {
      ok: false,
      error: { kind: "invalid_output", message: "" },
    };

    const result = combineVerdict(ruleOutcome, llm);

    expect(result.status).toBe("yellow");
    expect(result.reason).toBe("");
    expect(result.risks).toEqual([]);
    expect(result.nextActions).toEqual([]);
    expect(result.reasonMissing).toBe(true);
  });

  it("provider_error / timeout でもルール候補へフォールバックする", () => {
    const grayRule: RuleOutcome = { candidate: "gray", insufficientMaterial: true };

    for (const kind of ["provider_error", "timeout"] as const) {
      const llm: LlmResult<typeof validVerdict> = {
        ok: false,
        error: { kind, message: "" },
      };
      const result = combineVerdict(grayRule, llm);
      expect(result.status).toBe("gray");
      expect(result.reasonMissing).toBe(true);
    }
  });

  it("常に有効な StatusVerdict 形状を返す", () => {
    const llm: LlmResult<typeof validVerdict> = {
      ok: false,
      error: { kind: "invalid_output", message: "" },
    };

    const result = combineVerdict(ruleOutcome, llm);

    // reasonMissing を除いた形状が LLM 出力スキーマを満たすことを確認。
    const { reasonMissing: _reasonMissing, ...verdictShape } = result;
    expect(statusVerdictLlmSchema.safeParse(verdictShape).success).toBe(true);
  });
});
