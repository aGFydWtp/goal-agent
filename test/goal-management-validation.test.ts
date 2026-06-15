import { describe, expect, it } from "vitest";

import { validateCyclePeriod, validateGoalFields } from "../src/goal-management/validation";

// goal-management task 1.1: 入力検証ヘルパーのユニットテスト (Req 1.4, 2.5)。
// 純粋ロジックのため node プロジェクトで実行する。

describe("validateCyclePeriod (Req 1.4)", () => {
  it("正常な期間で ok を返す", () => {
    expect(validateCyclePeriod("2026-04-01", "2026-09-30")).toEqual({ ok: true });
  });

  it("開始日と終了日が同一でも ok を返す", () => {
    expect(validateCyclePeriod("2026-04-01", "2026-04-01")).toEqual({ ok: true });
  });

  it("開始日が日付として解釈できないとき invalid_date を返す", () => {
    expect(validateCyclePeriod("not-a-date", "2026-09-30")).toEqual({
      ok: false,
      reason: "invalid_date",
    });
  });

  it("終了日が日付として解釈できないとき invalid_date を返す", () => {
    expect(validateCyclePeriod("2026-04-01", "bogus")).toEqual({
      ok: false,
      reason: "invalid_date",
    });
  });

  it("開始日が空文字のとき invalid_date を返す", () => {
    expect(validateCyclePeriod("", "2026-09-30")).toEqual({
      ok: false,
      reason: "invalid_date",
    });
  });

  it("終了日が空文字のとき invalid_date を返す", () => {
    expect(validateCyclePeriod("2026-04-01", "")).toEqual({
      ok: false,
      reason: "invalid_date",
    });
  });

  it("空白のみの入力を invalid_date として扱う", () => {
    expect(validateCyclePeriod("   ", "2026-09-30")).toEqual({
      ok: false,
      reason: "invalid_date",
    });
  });

  it("終了日が開始日より前のとき end_before_start を返す", () => {
    expect(validateCyclePeriod("2026-09-30", "2026-04-01")).toEqual({
      ok: false,
      reason: "end_before_start",
    });
  });

  it("両方有効だが終了が開始より前のときは invalid_date より end_before_start を優先する", () => {
    expect(validateCyclePeriod("2026-12-31", "2026-01-01")).toEqual({
      ok: false,
      reason: "end_before_start",
    });
  });
});

describe("validateGoalFields (Req 2.5)", () => {
  it("目標名・本文が揃っているとき ok を返す", () => {
    expect(validateGoalFields("目標A", "本文B")).toEqual({ ok: true });
  });

  it("目標名が空のとき title を不足項目として返す", () => {
    expect(validateGoalFields("", "本文B")).toEqual({ ok: false, missing: ["title"] });
  });

  it("目標本文が空のとき description を不足項目として返す", () => {
    expect(validateGoalFields("目標A", "")).toEqual({
      ok: false,
      missing: ["description"],
    });
  });

  it("両方空のとき title と description を不足項目として返す", () => {
    expect(validateGoalFields("", "")).toEqual({
      ok: false,
      missing: ["title", "description"],
    });
  });

  it("空白のみの目標名を不足として扱う", () => {
    expect(validateGoalFields("   ", "本文B")).toEqual({
      ok: false,
      missing: ["title"],
    });
  });

  it("空白のみの本文を不足として扱う", () => {
    expect(validateGoalFields("目標A", "  \n ")).toEqual({
      ok: false,
      missing: ["description"],
    });
  });
});
