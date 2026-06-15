/**
 * Weekly Checkin Scheduler(週次チェックイン cron の冪等登録) (Req 1.1, 1.3, 1.4)。
 *
 * design.md §Weekly Checkin Scheduler の通り、毎週金曜(日本時間)15:00 に発火する定期スケジュールを
 * Agent の `this.schedule()` に登録する。本モジュールは Agent 本体ではなく、必要な API
 * サブセット({@link WeeklyCheckinSchedulerAgent})だけを受け取る純粋ヘルパーとして実装する。
 * これにより単体テスト可能で、後続タスク(EvaluationCycleAgent への配線)が `this` を渡して
 * 再利用できる。Agent クラスは構造的に {@link WeeklyCheckinSchedulerAgent} を満たす。
 *
 * 境界(再実装しない・Req 7.3):`this.schedule()` / cron 基盤は infra-foundation の提供物で
 * あり、本モジュールはそれを消費するのみ。cron 表現と登録判定のみを所有する。
 */

/**
 * 毎週金曜(日本時間 JST)15:00 を表す cron 式(分 時 日 月 曜。5 = 金曜) (Req 1.1)。
 *
 * 注意(タイムゾーン):agents SDK の cron は DO アラームのタイムゾーン(UTC)で評価される。
 * 目標の「JST 金曜15:00」は UTC では金曜06:00(JST = UTC+9)に相当するため、UTC 基準で
 * `0 6 * * 5` を登録する。DO 側に TZ 指定の余地がないため、この UTC リテラルで JST 15:00 を表現する。
 */
export const WEEKLY_CHECKIN_CRON = "0 6 * * 5";

/**
 * cron 発火時に呼ばれる EvaluationCycleAgent のコールバックメソッド名 (Req 1.2)。
 * 後続タスク(Agent 配線)が同名メソッドを実装し、cron tick ごとに起動される。
 */
export const WEEKLY_CHECKIN_CALLBACK = "fireWeeklyCheckin";

export interface WeeklyCheckinSchedule {
  id: string;
  callback?: string;
  type?: string;
  cron?: string;
}

/**
 * {@link scheduleWeeklyCheckin} が必要とする Agent API の構造的サブセット。
 *
 * 実 Agent(EvaluationCycleAgent)はこのインターフェースを構造的に満たすため、本ヘルパーは
 * Agent 全体に依存せず単体テスト可能。`schedule` は cron 文字列で定期スケジュールを登録し、
 * `listSchedules` は登録済みスケジュールを非同期に列挙し、`cancelSchedule` は古い cron を解除する
 * (agents SDK 準拠)。`getSchedules` はテスト/旧 SDK 互換のフォールバック。
 */
export interface WeeklyCheckinSchedulerAgent {
  schedule(when: string, callback: string, payload?: unknown): Promise<unknown>;
  cancelSchedule(id: string): Promise<boolean>;
  listSchedules?(criteria?: { type?: "cron" }): Promise<ReadonlyArray<WeeklyCheckinSchedule>>;
  getSchedules?(criteria?: { type?: "cron" }): ReadonlyArray<WeeklyCheckinSchedule>;
}

/**
 * 毎週金曜 JST 15:00 の週次チェックイン cron を冪等に登録する (Req 1.1, 1.3, 1.4)。
 *
 * 手順:
 *  1. 登録済み cron を照会し、コールバック名が {@link WEEKLY_CHECKIN_CALLBACK} の週次チェックイン
 *     スケジュールを抽出する。
 *  2. callback は同じだが cron が {@link WEEKLY_CHECKIN_CRON} と異なる既存行を stale とみなし、
 *     `cancelSchedule()` で解除する。Agents SDK のスケジュールは永続 SQLite に残るため、cron 定数
 *     変更時はこの置換が必要。
 *  3. 正しい cron が既に存在すれば no-op(再初期化でも重複登録しない・Req 1.4)。
 *  4. 未登録なら {@link WEEKLY_CHECKIN_CRON} の cron を登録する (Req 1.1)。cron は毎週同一
 *     曜日・時刻に繰り返し発火するため、以降の繰り返し発火が維持される (Req 1.3)。
 *
 * @param agent `schedule` / `cancelSchedule` / `listSchedules` を備えた Agent(またはその構造的サブセット)。
 */
export async function scheduleWeeklyCheckin(agent: WeeklyCheckinSchedulerAgent): Promise<void> {
  const existing = await listCronSchedules(agent);
  const weeklyCheckinSchedules = existing.filter(
    (schedule) => schedule.callback === WEEKLY_CHECKIN_CALLBACK,
  );
  const staleSchedules = weeklyCheckinSchedules.filter(
    (schedule) => schedule.cron !== WEEKLY_CHECKIN_CRON,
  );

  for (const schedule of staleSchedules) {
    await agent.cancelSchedule(schedule.id);
  }

  const currentRegistered = weeklyCheckinSchedules.some(
    (schedule) => schedule.cron === WEEKLY_CHECKIN_CRON,
  );
  if (currentRegistered) {
    // 既に同 cron+callback が登録済み → 重複登録しない (Req 1.4)。
    return;
  }

  await agent.schedule(WEEKLY_CHECKIN_CRON, WEEKLY_CHECKIN_CALLBACK);
}

async function listCronSchedules(
  agent: WeeklyCheckinSchedulerAgent,
): Promise<ReadonlyArray<WeeklyCheckinSchedule>> {
  if (agent.listSchedules) {
    return agent.listSchedules({ type: "cron" });
  }
  if (agent.getSchedules) {
    return agent.getSchedules({ type: "cron" });
  }
  return [];
}
