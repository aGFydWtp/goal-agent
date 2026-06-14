// チェックイン分類のドメイン操作(checkin-classification)。
//
// goal-management が確立した対象サイクル決定規約と汎用データ権威サーフェスを消費し、
// EvaluationCycleAgent へ下流ドメインメソッドを追加しない。pending 分類は Agent インスタンスや
// handler 層が所有できる揮発 store として分離し、userId 不一致は不存在として正規化する。

import {
  type CycleDataAuthority,
  type DomainDeps,
  resolveActiveCycle,
} from "../../goal-management/domain/cycle-operations";
import type { EvaluationCycleRow } from "../../types";
import type { ClassificationResult } from "../classification/schema";

/** `/checkin` 起点で使う対象サイクル解決結果。 */
export type ResolveCheckinActiveCycleResult =
  | { ok: true; cycle: EvaluationCycleRow }
  | { ok: false; reason: "no_cycle" };

/**
 * 実行ユーザーのチェックイン対象サイクルを解決する。
 *
 * 対象決定規約は goal-management の `resolveActiveCycle` に委譲し、実行ユーザー所有の
 * latest `created_at` サイクルのみを対象にする。存在しない場合は `/checkin` フローを開始しない
 * 判別として `no_cycle` を返す。
 */
export async function resolveCheckinActiveCycle(
  authority: CycleDataAuthority,
  userId: string,
): Promise<ResolveCheckinActiveCycleResult> {
  const cycle = await resolveActiveCycle(authority, userId);
  if (cycle === null) {
    return { ok: false, reason: "no_cycle" };
  }
  return { ok: true, cycle };
}

/** 分類完了から保存/修正/破棄まで揮発保持する pending 分類。 */
export interface PendingCheckinClassification {
  pendingId: string;
  userId: string;
  cycleId: string;
  rawText: string;
  result: ClassificationResult;
  createdAt: string;
}

/** pending 分類の保存入力。 */
export interface StorePendingClassificationInput {
  userId: string;
  cycleId: string;
  rawText: string;
  result: ClassificationResult;
}

/**
 * Agent インスタンスまたは handler 層が所有する揮発 pending store。
 *
 * Map はプロセス/インスタンス内メモリであり、永続化や cross-instance 共有を意図しない。
 */
export interface PendingCheckinStore {
  readonly classifications: Map<string, PendingCheckinClassification>;
}

/** 空の pending store を作成する。 */
export function createPendingCheckinStore(): PendingCheckinStore {
  return { classifications: new Map() };
}

/**
 * 分類結果を pendingId で揮発保持する。
 *
 * ID と timestamp は後続テスト/Agent 実装で決定的にできるよう `DomainDeps` から注入する。
 */
export function storePendingClassification(
  store: PendingCheckinStore,
  deps: DomainDeps,
  input: StorePendingClassificationInput,
): { pendingId: string; pending: PendingCheckinClassification } {
  const pendingId = deps.newId();
  const pending: PendingCheckinClassification = {
    pendingId,
    userId: input.userId,
    cycleId: input.cycleId,
    rawText: input.rawText,
    result: input.result,
    createdAt: deps.now(),
  };
  store.classifications.set(pendingId, pending);
  return { pendingId, pending };
}

/**
 * pending 分類を所有者スコープで取得する。
 *
 * 不在または userId 不一致はどちらも `null` として返し、存在有無を漏らさない。
 */
export function getPendingClassification(
  store: PendingCheckinStore,
  userId: string,
  pendingId: string,
): PendingCheckinClassification | null {
  const pending = store.classifications.get(pendingId);
  if (pending === undefined || pending.userId !== userId) {
    return null;
  }
  return pending;
}

/** pending 分類の破棄結果。 */
export type DiscardPendingClassificationResult = { ok: true } | { ok: false; reason: "not_found" };

/**
 * pending 分類を所有者スコープで破棄する。
 *
 * userId が一致する場合のみ削除する。別 userId からの操作は `not_found` に正規化し、対象を
 * 削除しない。
 */
export function discardPendingClassification(
  store: PendingCheckinStore,
  userId: string,
  pendingId: string,
): DiscardPendingClassificationResult {
  const pending = getPendingClassification(store, userId, pendingId);
  if (pending === null) {
    return { ok: false, reason: "not_found" };
  }
  store.classifications.delete(pending.pendingId);
  return { ok: true };
}
