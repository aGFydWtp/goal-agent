// サイクル/目標/証跡のドメイン操作(goal-management Cycle Domain Operations)。
//
// 設計上の配置(tasks.md Implementation Notes 準拠): infra-foundation は骨格ドメイン
// メソッドを持たず汎用 passthrough のみを公開し、infra 所有の boundary.test が Agent への
// ドメインメソッド追加を禁止する。したがってドメインロジックは `src/agents/*.ts` を変更せず
// 本ファイルの純粋関数として実装し、Agent の汎用データ権威サーフェスを引数で消費する。
// 後続タスク(2.2/2.3/2.4)が同一の `CycleDataAuthority`/`DomainDeps` 基盤を拡張する。

import type { EntityName, EntityRow, EvaluationCycleRow, GoalRow } from "../../types";
import { assertOwned } from "../ownership";

/**
 * ドメイン関数が消費する最小の async データ権威インターフェイス。
 *
 * Agent の汎用 passthrough(`getCycleAgent` 戻り値)が構造的に満たす subset。
 * ユニットテストは `createRepository` を async ラップしたアダプタを渡し、DO 無しで検証する。
 */
export interface CycleDataAuthority {
  insertRow<E extends EntityName>(entity: E, row: EntityRow<E>): Promise<void>;
  getRowById<E extends EntityName>(entity: E, id: string): Promise<EntityRow<E> | null>;
  listRowsBy<E extends EntityName>(
    entity: E,
    where: Partial<EntityRow<E>>,
  ): Promise<EntityRow<E>[]>;
  removeRow<E extends EntityName>(entity: E, id: string): Promise<void>;
}

/**
 * ID / タイムスタンプ生成の注入点(テスト決定性のため)。
 * 本番既定は `defaultDeps()`。
 */
export interface DomainDeps {
  newId(): string;
  now(): string;
}

/** 本番既定の deps(`crypto.randomUUID` / ISO8601 現在時刻)。 */
export function defaultDeps(): DomainDeps {
  return {
    newId: () => crypto.randomUUID(),
    now: () => new Date().toISOString(),
  };
}

/** `createCycle` の結果型(design Service Interface)。 */
export type CreateCycleResult =
  | { ok: true; cycle: EvaluationCycleRow }
  | { ok: false; reason: "duplicate" };

/**
 * 評価サイクルを作成して永続化する(Req 1.2, 1.5, 4.3, 5.3, 5.4)。
 *
 * 同一ユーザー内に同名サイクルがあれば作成せず `duplicate` を返す(Req 1.5)。
 * 重複なしの場合は実行ユーザーを所有者として付与し(Req 4.3)、ID/timestamp を採番して
 * 単一権威へ insert する(Req 1.2, 5.3)。スキーマ・型は再定義せず共有型を使う(Req 5.4)。
 *
 * 注: 期間妥当性(`invalid_period`)はハンドラ層(validation.ts)で事前検証する設計のため、
 * 本ドメイン関数では再検証しない(design Service Interface の `invalid_period` は handler 責務)。
 *
 * @param authority サイクルデータ権威(insert / list を消費)。
 * @param deps ID / timestamp 生成の注入点。
 * @param userId 実行ユーザー(= 所有者)識別子。
 * @param name サイクル名。
 * @param startDate 開始日(検証済み前提)。
 * @param endDate 終了日(検証済み前提)。
 * @returns 重複なしで作成成功時は `{ ok: true, cycle }`、同名重複時は `{ ok: false, reason: "duplicate" }`。
 */
export async function createCycle(
  authority: CycleDataAuthority,
  deps: DomainDeps,
  userId: string,
  name: string,
  startDate: string,
  endDate: string,
): Promise<CreateCycleResult> {
  const existing = await authority.listRowsBy("evaluation_cycles", {
    user_id: userId,
    name,
  });
  if (existing.length > 0) {
    return { ok: false, reason: "duplicate" };
  }

  const timestamp = deps.now();
  const cycle: EvaluationCycleRow = {
    id: deps.newId(),
    user_id: userId,
    name,
    start_date: startDate,
    end_date: endDate,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await authority.insertRow("evaluation_cycles", cycle);
  return { ok: true, cycle };
}

/**
 * 対象サイクル決定規約: 実行ユーザーが所有する最新(`created_at` 最大)の評価サイクルを返す
 * (tasks.md Implementation Notes / design L387)。
 *
 * 所有者スコープは `user_id` クエリで担保する(他ユーザーのサイクルは対象外)。
 * 1 件も無ければ `null` を返す。`addGoal` などハンドラ起点の操作が cycleId を持たないため、
 * 対象サイクルは本関数で内部解決する。下流スペックも本契約を消費する。
 *
 * @param authority サイクルデータ権威(list を消費)。
 * @param userId 実行ユーザー(= 所有者)識別子。
 * @returns 最新の所有サイクル行。1 件も無ければ `null`。
 */
export async function resolveActiveCycle(
  authority: CycleDataAuthority,
  userId: string,
): Promise<EvaluationCycleRow | null> {
  const rows = await authority.listRowsBy("evaluation_cycles", { user_id: userId });
  let latest: EvaluationCycleRow | null = null;
  for (const row of rows) {
    if (latest === null || row.created_at > latest.created_at) {
      latest = row;
    }
  }
  return latest;
}

/**
 * 目標登録の入力(design Service Interface `GoalInput`)。
 *
 * `dueDate` は §11.2 `goals` に専用列が無いため、永続化時に `evaluation_points` テキストへ
 * 畳み込んで保持する(tasks.md Implementation Notes / design L386, L450)。
 */
export interface GoalInput {
  /** 目標名(必須。空検証は handler 層 validation.ts 責務)。 */
  title: string;
  /** 目標本文(必須。空検証は handler 層 validation.ts 責務)。 */
  description: string;
  /** 達成条件。複数行 TEXT としてそのまま保持する(Req 2.4)。 */
  successCriteria: string | null;
  /** 評価観点。複数行 TEXT としてそのまま保持する(Req 2.4)。 */
  evaluationPoints: string | null;
  /** 期限。専用列が無いため `evaluation_points` 末尾へ畳み込む(Req 2.4)。 */
  dueDate: string | null;
}

/** `addGoal` の結果型(design Service Interface)。 */
export type AddGoalResult = { ok: true; goal: GoalRow } | { ok: false; reason: "no_cycle" };

/**
 * `dueDate` を `evaluationPoints` 末尾へ畳み込む(design L386 dueDate 永続化規約)。
 *
 * - 評価観点あり + 期限あり → `${evaluationPoints}\n期限: ${dueDate}`
 * - 評価観点なし + 期限あり → `期限: ${dueDate}`
 * - 期限なし → `evaluationPoints`(null ならそのまま null)
 */
function foldDueDate(evaluationPoints: string | null, dueDate: string | null): string | null {
  if (dueDate === null || dueDate === "") {
    return evaluationPoints;
  }
  const dueLine = `期限: ${dueDate}`;
  if (evaluationPoints === null || evaluationPoints === "") {
    return dueLine;
  }
  return `${evaluationPoints}\n${dueLine}`;
}

/**
 * 目標を対象サイクルへ登録して永続化する(Req 2.2, 2.4, 2.6, 2.8, 4.3, 5.3, 5.4)。
 *
 * 対象サイクル(実行ユーザー所有の最新サイクル)を `resolveActiveCycle` で内部解決し、
 * 無ければ `no_cycle` を返す(Req 2.6)。存在時は実行ユーザーを所有者として付与し(Req 4.3)、
 * 初期ステータス `'gray'`(Req 2.8)・複数行の達成条件/評価観点(Req 2.4)・`dueDate` を畳み込んだ
 * 評価観点で `GoalRow` を構築し、単一権威へ insert する(Req 2.2, 5.3)。共有型を再利用する(Req 5.4)。
 *
 * 注: 必須項目(目標名・本文)の空検証はハンドラ層(validation.ts)責務のため、本関数では行わない。
 *
 * @param authority サイクルデータ権威(list / insert を消費)。
 * @param deps ID / timestamp 生成の注入点。
 * @param userId 実行ユーザー(= 所有者)識別子。
 * @param fields 目標入力。
 * @returns サイクル存在時は `{ ok: true, goal }`、不存在時は `{ ok: false, reason: "no_cycle" }`。
 */
export async function addGoal(
  authority: CycleDataAuthority,
  deps: DomainDeps,
  userId: string,
  fields: GoalInput,
): Promise<AddGoalResult> {
  const cycle = await resolveActiveCycle(authority, userId);
  if (cycle === null) {
    return { ok: false, reason: "no_cycle" };
  }

  const timestamp = deps.now();
  const goal: GoalRow = {
    id: deps.newId(),
    cycle_id: cycle.id,
    user_id: userId,
    title: fields.title,
    description: fields.description,
    success_criteria: fields.successCriteria,
    evaluation_points: foldDueDate(fields.evaluationPoints, fields.dueDate),
    status: "gray",
    created_at: timestamp,
    updated_at: timestamp,
  };
  await authority.insertRow("goals", goal);
  return { ok: true, goal };
}

/**
 * 指定サイクルに属する目標定義の一覧を所有者スコープ内で取得する(Req 5.1, 5.3)。
 *
 * 所有者スコープは `user_id` クエリで担保し(他ユーザーの目標は対象外)、`cycle_id` で
 * 対象サイクルに限定する(他サイクルの目標は対象外)。該当が無ければ空配列を返す。
 *
 * @param authority サイクルデータ権威(list を消費)。
 * @param userId 実行ユーザー(= 所有者)識別子。
 * @param cycleId 対象サイクル識別子。
 * @returns 所有者かつ同一サイクルの目標行の配列(0 件なら空配列)。
 */
export async function listGoals(
  authority: CycleDataAuthority,
  userId: string,
  cycleId: string,
): Promise<GoalRow[]> {
  return authority.listRowsBy("goals", { cycle_id: cycleId, user_id: userId });
}

/**
 * 特定目標の定義を所有者スコープ内で取得する(Req 5.2, 5.3, 2.3)。
 *
 * 取得行を `assertOwned` で所有者検証し(不一致/不存在は `null` = 不存在扱いで露出しない)、
 * さらに `cycle_id` が対象サイクルと一致しない場合も `null` を返す(別サイクルの目標を露出しない)。
 * 所有かつ同一サイクルの場合のみ行を返す。
 *
 * @param authority サイクルデータ権威(getById を消費)。
 * @param userId 実行ユーザー(= 所有者)識別子。
 * @param cycleId 対象サイクル識別子。
 * @param goalId 取得対象の目標識別子。
 * @returns 所有かつ同一サイクルの目標行。非所有/別サイクル/不存在は `null`。
 */
export async function getGoal(
  authority: CycleDataAuthority,
  userId: string,
  cycleId: string,
  goalId: string,
): Promise<GoalRow | null> {
  const row = await authority.getRowById("goals", goalId);
  const owned = assertOwned<"goals">(row, userId);
  if (owned === null || owned.cycle_id !== cycleId) {
    return null;
  }
  return owned;
}

/** `deleteEvidence` の結果型(design Service Interface)。所有者不一致も `not_found` に正規化する。 */
export type DeleteEvidenceResult = { ok: true } | { ok: false; reason: "not_found" };

/**
 * 指定証跡を所有者スコープ内で削除する(Req 3.1, 3.2, 3.3, 3.4, 5.3, 5.4)。
 *
 * 取得行を `assertOwned` で所有者検証し、不一致/不存在のいずれも `null`(不存在扱い)へ
 * 正規化して `{ ok: false, reason: "not_found" }` を返す(Req 3.3, 3.4。他ユーザーデータの
 * 存在を露出しない)。所有一致時は当該証跡に紐づく `evidence_goal_links` を連動削除して
 * 孤立参照を残さず(Req 3.2)、証跡本体を削除する(Req 3.1)。書き込みは単一権威へ反映し
 * (Req 5.3)、スキーマ・型は再定義せず共有型を使う(Req 5.4)。
 *
 * 注: 削除のみのため ID / timestamp 生成(`DomainDeps`)は不要で、引数は (authority, userId, evidenceId)。
 *
 * @param authority サイクルデータ権威(getById / list / remove を消費)。
 * @param userId 実行ユーザー(= 所有者)識別子。
 * @param evidenceId 削除対象の証跡識別子。
 * @returns 所有証跡を削除できた場合は `{ ok: true }`、不存在/非所有は `{ ok: false, reason: "not_found" }`。
 */
export async function deleteEvidence(
  authority: CycleDataAuthority,
  userId: string,
  evidenceId: string,
): Promise<DeleteEvidenceResult> {
  const row = await authority.getRowById("evidence", evidenceId);
  const owned = assertOwned<"evidence">(row, userId);
  if (owned === null) {
    return { ok: false, reason: "not_found" };
  }

  const links = await authority.listRowsBy("evidence_goal_links", { evidence_id: evidenceId });
  for (const link of links) {
    await authority.removeRow("evidence_goal_links", link.id);
  }
  await authority.removeRow("evidence", evidenceId);
  return { ok: true };
}
