// notifications のアラートトリガ算出ドメイン(task 2.1 / Req 4.7)。
//
// 半期終了までの残り日数を、対象サイクルの終了日(`evaluation_cycles.end_date`)と現在日付から
// 算出する。status-and-draft の `utcDayDiff` と同じ UTC 暦日基準で差を取り、コードベース全体で
// 日数差の振る舞いを一致させる(時刻成分は切り捨て、UTC の暦日同士で差分)。
//
// 後続 task 2.2 で本ファイルに `evaluateTriggers` を追加する想定だが、ここでは
// `daysUntilCycleEnd` のみを実装する。

/** 1 日のミリ秒数。日数差計算に用いる。 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 半期終了までの残り日数(UTC 暦日)を返す(Req 4.7)。
 *
 * `now` から `cycleEndDate`(サイクル終了日)までの UTC 暦日差を整数で返す。終了日が未来なら正、
 * 終了当日は 0、過去なら負。両辺とも時刻成分を切り捨てて UTC の暦日同士で差を取るため、`now` の
 * 時刻(time-of-day)は結果を変えない。
 *
 * @param cycleEndDate サイクル終了日。`YYYY-MM-DD` または ISO8601 timestamp 文字列
 *   (`evaluation_cycles.end_date` に対応)。
 * @param now 基準となる現在日時。
 * @returns `now` から `cycleEndDate` までの整数 UTC 暦日数。
 * @throws いずれかの日付が解析不能(Invalid Date)な場合。
 */
export function daysUntilCycleEnd(cycleEndDate: string, now: Date): number {
  const endDate = new Date(cycleEndDate);
  if (Number.isNaN(endDate.getTime()) || Number.isNaN(now.getTime())) {
    throw new Error("invalid date for days-until-cycle-end");
  }
  const nowUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const endUtc = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate());
  return Math.round((endUtc - nowUtc) / MS_PER_DAY);
}
