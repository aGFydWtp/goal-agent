// notifications のアラートトリガ算出ユニットテスト(task 2.1 / Req 4.7)。
//
// 完了条件: サイクル終了日と現在日付の既知の組について、期待される残り日数(UTC 暦日)が返ること。
// 残日数は未来で正、終了当日で 0、過去で負。`now` の時刻成分は暦日差を変えない。解析不能な日付は throw。

import { describe, expect, it } from "vitest";
import { daysUntilCycleEnd } from "../src/notifications/alert/triggers";

describe("daysUntilCycleEnd", () => {
  it("終了日の 30 日前は 30 を返す", () => {
    expect(daysUntilCycleEnd("2026-09-30", new Date("2026-08-31T00:00:00Z"))).toBe(30);
  });

  it("終了日の 14 日前は 14 を返す", () => {
    expect(daysUntilCycleEnd("2026-09-30", new Date("2026-09-16T00:00:00Z"))).toBe(14);
  });

  it("終了当日は 0 を返す", () => {
    expect(daysUntilCycleEnd("2026-09-30", new Date("2026-09-30T00:00:00Z"))).toBe(0);
  });

  it("終了日を過ぎている場合は負値を返す(1 日後 → -1)", () => {
    expect(daysUntilCycleEnd("2026-09-30", new Date("2026-10-01T00:00:00Z"))).toBe(-1);
  });

  it("now の時刻成分は暦日差を変えない(同日 23:00 でも UTC 暦日で算出)", () => {
    expect(daysUntilCycleEnd("2026-09-30", new Date("2026-09-01T23:00:00Z"))).toBe(29);
  });

  it("ISO8601 timestamp 形式の終了日も時刻成分を切り捨てて算出する", () => {
    expect(daysUntilCycleEnd("2026-09-30T12:00:00Z", new Date("2026-09-16T00:00:00Z"))).toBe(14);
  });

  it("解析不能な終了日入力は throw する", () => {
    expect(() => daysUntilCycleEnd("not-a-date", new Date("2026-09-01T00:00:00Z"))).toThrow();
  });

  it("Invalid Date の now 入力は throw する", () => {
    expect(() => daysUntilCycleEnd("2026-09-30", new Date("not-a-date"))).toThrow();
  });
});
