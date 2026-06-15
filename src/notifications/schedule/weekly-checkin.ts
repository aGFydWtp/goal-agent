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

/**
 * {@link scheduleWeeklyCheckin} が必要とする Agent API の構造的サブセット。
 *
 * 実 Agent(EvaluationCycleAgent)はこのインターフェースを構造的に満たすため、本ヘルパーは
 * Agent 全体に依存せず単体テスト可能。`schedule` は cron 文字列で定期スケジュールを登録し、
 * `getSchedules` は登録済みスケジュールを同期的に列挙する(agents SDK 準拠)。
 */
export interface WeeklyCheckinSchedulerAgent {
  schedule(when: string, callback: string, payload?: unknown): Promise<unknown>;
  getSchedules(): ReadonlyArray<{ id: string; callback?: string; type?: string; cron?: string }>;
}

/**
 * 毎週金曜 16:30 の週次チェックイン cron を冪等に登録する (Req 1.1, 1.3, 1.4)。
 *
 * 手順:
 *  1. `getSchedules()` を照会し、コールバック名が {@link WEEKLY_CHECKIN_CALLBACK} で
 *     (cron が判明する場合は cron が {@link WEEKLY_CHECKIN_CRON} に一致する)週次チェックイン
 *     スケジュールが既に登録済みかを判定する。冪等性を明示的・テスト可能にし、SDK の暗黙的な
 *     cron 重複排除のみに依存しない(防御的二重化・Req 1.4)。
 *  2. 一致するスケジュールが存在すれば no-op(再初期化でも重複登録しない・Req 1.4)。
 *  3. 未登録なら {@link WEEKLY_CHECKIN_CRON} の cron を登録する (Req 1.1)。cron は毎週同一
 *     曜日・時刻に繰り返し発火するため、以降の繰り返し発火が維持される (Req 1.3)。
 *
 * @param agent `schedule` / `getSchedules` を備えた Agent(またはその構造的サブセット)。
 */
export async function scheduleWeeklyCheckin(agent: WeeklyCheckinSchedulerAgent): Promise<void> {
  const existing = agent.getSchedules();
  const alreadyRegistered = existing.some(
    (schedule) =>
      schedule.callback === WEEKLY_CHECKIN_CALLBACK &&
      // cron が露出している場合のみ一致確認する。露出しない実装でも callback 一致で冪等を担保。
      (schedule.cron === undefined || schedule.cron === WEEKLY_CHECKIN_CRON),
  );

  if (alreadyRegistered) {
    // 既に同 cron+callback が登録済み → 重複登録しない (Req 1.4)。
    return;
  }

  await agent.schedule(WEEKLY_CHECKIN_CRON, WEEKLY_CHECKIN_CALLBACK);
}
