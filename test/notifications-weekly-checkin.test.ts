import { describe, expect, it } from "vitest";

import {
  WEEKLY_CHECKIN_CALLBACK,
  WEEKLY_CHECKIN_CRON,
  type WeeklyCheckinSchedule,
  type WeeklyCheckinSchedulerAgent,
  scheduleWeeklyCheckin,
} from "../src/notifications/schedule/weekly-checkin";

// 週次チェックイン cron の冪等登録(task 5.1)のユニットテスト (Req 1.1, 1.3, 1.4)。
//
// 方針: 実 Agent の `this.schedule()` / `listSchedules()` / `cancelSchedule()` を忠実に模した
// FAKE スケジューラを用意し、cron 文字列 + コールバック名で 1 件の cron スケジュールを登録する挙動を検証する。
// agents SDK の cron は本来冪等(同 callback+cron+payload で既存を返す)だが、本実装は
// listSchedules() を照会して登録済みを明示判定する(防御的・テスト可能、Req 1.4)。

/**
 * 実 Agent を忠実に模した FAKE スケジューラ。
 * `schedule(cron, callback)` が呼ばれるたびに cron 型スケジュールを内部配列へ push し、
 * `listSchedules()` でそれを返す。`scheduleCalls` / `cancelCalls` で呼び出し回数を記録する。
 */
class FakeSchedulerAgent implements WeeklyCheckinSchedulerAgent {
  readonly schedules: WeeklyCheckinSchedule[] = [];
  readonly cancelledIds: string[] = [];
  scheduleCalls = 0;
  cancelCalls = 0;

  async schedule(when: string, callback: string, _payload?: unknown): Promise<unknown> {
    this.scheduleCalls += 1;
    const record: WeeklyCheckinSchedule = {
      id: `sched-${this.schedules.length + 1}`,
      callback,
      type: "cron",
      cron: when,
    };
    this.schedules.push(record);
    return record;
  }

  async cancelSchedule(id: string): Promise<boolean> {
    this.cancelCalls += 1;
    this.cancelledIds.push(id);

    const index = this.schedules.findIndex((schedule) => schedule.id === id);
    if (index === -1) return false;

    this.schedules.splice(index, 1);
    return true;
  }

  async listSchedules(criteria?: { type?: "cron" }): Promise<ReadonlyArray<WeeklyCheckinSchedule>> {
    if (!criteria?.type) return this.schedules;
    return this.schedules.filter((schedule) => schedule.type === criteria.type);
  }
}

describe("scheduleWeeklyCheckin (週次チェックイン cron の冪等登録)", () => {
  it("未登録時に金曜(JST)15:00 cron を 1 件登録する (Req 1.1)", async () => {
    const agent = new FakeSchedulerAgent();

    await scheduleWeeklyCheckin(agent);

    expect(agent.schedules).toHaveLength(1);
    expect(agent.scheduleCalls).toBe(1);
    expect(agent.cancelCalls).toBe(0);

    const [registered] = agent.schedules;
    expect(registered.cron).toBe(WEEKLY_CHECKIN_CRON);
    expect(registered.cron).toBe("0 6 * * 5"); // JST 金曜15:00 = UTC 金曜06:00(分 時 日 月 曜、5=金曜)
    expect(registered.callback).toBe(WEEKLY_CHECKIN_CALLBACK);
    expect(registered.callback).toBe("fireWeeklyCheckin");
    expect(registered.type).toBe("cron");
  });

  it("再呼び出しで重複登録しない — 1 件のまま、schedule は 1 回のみ呼ばれる (Req 1.4)", async () => {
    const agent = new FakeSchedulerAgent();

    await scheduleWeeklyCheckin(agent);
    await scheduleWeeklyCheckin(agent);

    // 重複した通知が同一週に複数回送られないよう、スケジュールは 1 件のまま (Req 1.4)。
    expect(agent.schedules).toHaveLength(1);
    // 既登録を明示判定して no-op にするため、2 回目は schedule を呼ばない。
    expect(agent.scheduleCalls).toBe(1);
    expect(agent.cancelCalls).toBe(0);

    const [registered] = agent.schedules;
    expect(registered.cron).toBe(WEEKLY_CHECKIN_CRON);
    expect(registered.callback).toBe(WEEKLY_CHECKIN_CALLBACK);
  });

  it("登録済み cron は次回以降も維持される(照会で 1 件を返し続ける) (Req 1.3)", async () => {
    const agent = new FakeSchedulerAgent();

    await scheduleWeeklyCheckin(agent);
    // 登録後も listSchedules() は同一の cron スケジュールを返し続ける(繰り返し発火を維持)。
    const after = await agent.listSchedules({ type: "cron" });
    expect(after).toHaveLength(1);
    expect(after[0]?.cron).toBe(WEEKLY_CHECKIN_CRON);
  });

  it("同じ callback の古い cron を解除して金曜(JST)15:00 cron に置き換える", async () => {
    const agent = new FakeSchedulerAgent();
    agent.schedules.push({
      id: "legacy-weekly",
      callback: WEEKLY_CHECKIN_CALLBACK,
      type: "cron",
      cron: "30 16 * * 5",
    });

    await scheduleWeeklyCheckin(agent);

    expect(agent.cancelCalls).toBe(1);
    expect(agent.cancelledIds).toEqual(["legacy-weekly"]);
    expect(agent.scheduleCalls).toBe(1);
    expect(agent.schedules).toHaveLength(1);
    expect(agent.schedules[0]?.callback).toBe(WEEKLY_CHECKIN_CALLBACK);
    expect(agent.schedules[0]?.cron).toBe(WEEKLY_CHECKIN_CRON);
  });

  it("別 callback の cron は解除対象にしない", async () => {
    const agent = new FakeSchedulerAgent();
    agent.schedules.push({
      id: "other-cron",
      callback: "someOtherCallback",
      type: "cron",
      cron: "30 16 * * 5",
    });

    await scheduleWeeklyCheckin(agent);

    expect(agent.cancelCalls).toBe(0);
    expect(agent.cancelledIds).toEqual([]);
    expect(agent.scheduleCalls).toBe(1);
    expect(agent.schedules).toHaveLength(2);
    expect(agent.schedules.some((schedule) => schedule.id === "other-cron")).toBe(true);
    expect(agent.schedules.some((schedule) => schedule.cron === WEEKLY_CHECKIN_CRON)).toBe(true);
  });
});
