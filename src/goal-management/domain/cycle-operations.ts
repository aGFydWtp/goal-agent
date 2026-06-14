// サイクル/目標/証跡のドメイン操作(goal-management Cycle Domain Operations)。
//
// 設計上の配置(tasks.md Implementation Notes 準拠): infra-foundation は骨格ドメイン
// メソッドを持たず汎用 passthrough のみを公開し、infra 所有の boundary.test が Agent への
// ドメインメソッド追加を禁止する。したがってドメインロジックは `src/agents/*.ts` を変更せず
// 本ファイルの純粋関数として実装し、Agent の汎用データ権威サーフェスを引数で消費する。
// 後続タスク(2.2/2.3/2.4)が同一の `CycleDataAuthority`/`DomainDeps` 基盤を拡張する。

import type { EntityName, EntityRow, EvaluationCycleRow } from "../../types";

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
