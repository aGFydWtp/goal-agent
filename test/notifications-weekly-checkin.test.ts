import { describe, expect, it } from "vitest";

import {
  WEEKLY_CHECKIN_CALLBACK,
  WEEKLY_CHECKIN_CRON,
  type WeeklyCheckinSchedulerAgent,
  scheduleWeeklyCheckin,
} from "../src/notifications/schedule/weekly-checkin";

// 週次チェックイン cron の冪等登録(task 5.1)のユニットテスト (Req 1.1, 1.3, 1.4)。
//
// 方針: 実 Agent の `this.schedule()` / `getSchedules()` を忠実に模した FAKE スケジューラを
// 用意し、cron 文字列 + コールバック名で 1 件の cron スケジュールを登録する挙動を検証する。
// agents SDK の cron は本来冪等(同 callback+cron+payload で既存を返す)だが、本実装は
// getSchedules() を照会して登録済みを明示判定する(防御的・テスト可能、Req 1.4)。

/** 実 Agent の Schedule を模した最小レコード。 */
interface FakeSchedule {
  id: string;
  callback: string;
  type: string;
  cron: string;
}

/**
 * 実 Agent を忠実に模した FAKE スケジューラ。
 * `schedule(cron, callback)` が呼ばれるたびに cron 型スケジュールを内部配列へ push し、
 * `getSchedules()` でそれを返す。`scheduleCalls` で schedule の呼び出し回数を記録する。
 */
class FakeSchedulerAgent implements WeeklyCheckinSchedulerAgent {
  readonly schedules: FakeSchedule[] = [];
  scheduleCalls = 0;

  async schedule(when: string, callback: string, _payload?: unknown): Promise<unknown> {
    this.scheduleCalls += 1;
    const record: FakeSchedule = {
      id: `sched-${this.schedules.length + 1}`,
      callback,
      type: "cron",
      cron: when,
    };
    this.schedules.push(record);
    return record;
  }

  getSchedules(): ReadonlyArray<{ id: string; callback?: string; type?: string; cron?: string }> {
    return this.schedules;
  }
}

describe("scheduleWeeklyCheckin (週次チェックイン cron の冪等登録)", () => {
  it("未登録時に金曜16:30 cron を 1 件登録する (Req 1.1)", async () => {
    const agent = new FakeSchedulerAgent();

    await scheduleWeeklyCheckin(agent);

    expect(agent.schedules).toHaveLength(1);
    expect(agent.scheduleCalls).toBe(1);

    const [registered] = agent.schedules;
    expect(registered.cron).toBe(WEEKLY_CHECKIN_CRON);
    expect(registered.cron).toBe("30 16 * * 5"); // 金曜 16:30(分 時 日 月 曜、5=金曜)
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

    const [registered] = agent.schedules;
    expect(registered.cron).toBe(WEEKLY_CHECKIN_CRON);
    expect(registered.callback).toBe(WEEKLY_CHECKIN_CALLBACK);
  });

  it("登録済み cron は次回以降も維持される(照会で 1 件を返し続ける) (Req 1.3)", async () => {
    const agent = new FakeSchedulerAgent();

    await scheduleWeeklyCheckin(agent);
    // 登録後も getSchedules() は同一の cron スケジュールを返し続ける(繰り返し発火を維持)。
    const after = agent.getSchedules();
    expect(after).toHaveLength(1);
    expect(after[0]?.cron).toBe(WEEKLY_CHECKIN_CRON);
  });
});
