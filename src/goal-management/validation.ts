/**
 * goal-management の入力検証ヘルパー (Req 1.4, 2.5)。
 *
 * design.md shared「Ownership Scope Helper / Input Validation」の Service Interface
 * (`validateCyclePeriod` / `validateGoalFields`)を実装する純粋関数群。書き込み前に
 * ハンドラ層から呼ばれ、不備は判別可能な結果型として返す(例外は投げない)。
 *
 * 依存方向: 横断ヘルパーとして handlers/domain から参照される。本モジュールは他の
 * goal-management モジュールを import しない。
 */

/** {@link validateCyclePeriod} の結果。期間が妥当なら ok、不備なら reason を返す。 */
export type PeriodCheck = { ok: true } | { ok: false; reason: "invalid_date" | "end_before_start" };

/** {@link validateGoalFields} の結果。必須が揃えば ok、欠落時は不足項目名を返す。 */
export type GoalFieldsCheck = { ok: true } | { ok: false; missing: string[] };

/**
 * サイクルの開始日/終了日を検証する (Req 1.4)。
 *
 * `start`/`end` を日付文字列(Discord コマンド由来。例 `YYYY-MM-DD`)としてパースする。
 * いずれかが日付として解釈できない(空文字・空白のみを含む)なら `invalid_date`、
 * 両方有効でも終了が開始より前なら `end_before_start` を返す。終了 === 開始は許容。
 */
export function validateCyclePeriod(start: string, end: string): PeriodCheck {
  const startMs = parseDate(start);
  const endMs = parseDate(end);
  if (startMs === null || endMs === null) {
    return { ok: false, reason: "invalid_date" };
  }
  if (endMs < startMs) {
    return { ok: false, reason: "end_before_start" };
  }
  return { ok: true };
}

/**
 * 日付文字列を epoch ミリ秒へパースする。解釈できなければ null。
 *
 * `Date.parse` ベース。空文字・空白のみは無効として扱う(`Date.parse("")` の挙動は
 * 環境依存のため明示的に弾く)。
 */
function parseDate(value: string): number | null {
  if (value.trim().length === 0) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * 目標の必須項目(目標名・目標本文)を検証する (Req 2.5)。
 *
 * `title`/`description` が trim 後に空なら不足とみなし、`missing` に欠落項目名
 * (`"title"` / `"description"`)を順に列挙して返す。両方あれば ok。
 */
export function validateGoalFields(title: string, description: string): GoalFieldsCheck {
  const missing: string[] = [];
  if (title.trim().length === 0) {
    missing.push("title");
  }
  if (description.trim().length === 0) {
    missing.push("description");
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}
