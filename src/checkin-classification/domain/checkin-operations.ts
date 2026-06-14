// チェックイン分類のドメイン操作(checkin-classification)。
//
// goal-management が確立した対象サイクル決定規約と汎用データ権威サーフェスを消費し、
// EvaluationCycleAgent へ下流ドメインメソッドを追加しない。pending 分類は Agent インスタンスや
// handler 層が所有できる揮発 store として分離し、userId 不一致は不存在として正規化する。

import {
  type CycleDataAuthority,
  type DomainDeps,
  listGoals,
  resolveActiveCycle,
} from "../../goal-management/domain/cycle-operations";
import type { LlmClient, LlmError } from "../../llm/client";
import type { CheckinRow, EvaluationCycleRow, EvidenceGoalLinkRow, EvidenceRow } from "../../types";
import { buildClassificationPrompt } from "../classification/prompt";
import { type ClassificationResult, classificationResultSchema } from "../classification/schema";
import { guardNonEmptyCheckinInput, verifyClassificationResult } from "../classification/verify";

/** `/checkin` 起点で使う対象サイクル解決結果。 */
export type ResolveCheckinActiveCycleResult =
  | { ok: true; cycle: EvaluationCycleRow }
  | { ok: false; reason: "no_cycle" };

/** 分類実行の入力。cycleId は `/checkin` 起点で解決済みの対象サイクルを渡す。 */
export interface ClassifyCheckinInput {
  userId: string;
  cycleId: string;
  rawText: string;
}

/** 分類実行の成功/失敗結果。失敗時は証跡・pending を作らない。 */
export type ClassifyCheckinResult =
  | {
      ok: true;
      pendingId: string;
      result: ClassificationResult;
      unclassifiedItems: ClassificationResult["items"];
    }
  | { ok: false; reason: "empty_input" | "no_goals" }
  | {
      ok: false;
      reason: "classification_failed";
      errorKind: LlmError["kind"];
    }
  | {
      ok: false;
      reason: "classification_failed";
      verificationReason: "invalid_goal_id";
      goalIds: string[];
    };

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
 * 週次入力を分類し、検証成功時だけ pending として揮発保持する。
 *
 * 永続化は保存確定タスク(2.3)の責務なので、本関数は checkins/evidence/links を作らない。
 * 失敗時も pending を保持せず、呼び出し側が再試行案内へ正規化できる情報だけを返す。
 */
export async function classifyCheckin(
  authority: CycleDataAuthority,
  deps: DomainDeps,
  llm: LlmClient,
  store: PendingCheckinStore,
  input: ClassifyCheckinInput,
): Promise<ClassifyCheckinResult> {
  const guardedInput = guardNonEmptyCheckinInput(input.rawText);
  if (!guardedInput.ok) {
    return { ok: false, reason: guardedInput.reason };
  }

  const goals = await listGoals(authority, input.userId, input.cycleId);
  if (goals.length === 0) {
    return { ok: false, reason: "no_goals" };
  }

  const promptRequest = buildClassificationPrompt({
    goals: goals.map((goal) => ({
      id: goal.id,
      title: goal.title,
      description: goal.description,
      success_criteria: goal.success_criteria,
    })),
    rawText: guardedInput.text,
  });

  const llmResult = await llm.completeJson(promptRequest, classificationResultSchema);
  if (!llmResult.ok) {
    return {
      ok: false,
      reason: "classification_failed",
      errorKind: llmResult.error.kind,
    };
  }

  const verified = verifyClassificationResult(
    llmResult.value,
    new Set(goals.map((goal) => goal.id)),
  );
  if (!verified.ok) {
    return {
      ok: false,
      reason: "classification_failed",
      verificationReason: verified.reason,
      goalIds: verified.goalIds,
    };
  }

  const { pendingId } = storePendingClassification(store, deps, {
    userId: input.userId,
    cycleId: input.cycleId,
    rawText: guardedInput.text,
    result: verified.result,
  });

  return {
    ok: true,
    pendingId,
    result: verified.result,
    unclassifiedItems: verified.unclassifiedItems,
  };
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

/** pending 分類を証跡として保存する入力。 */
export interface SaveClassifiedCheckinInput {
  userId: string;
  pendingId: string;
  /** テスト/呼び出し側が週開始日を明示したい場合の注入点。未指定時は deps.now() の UTC 月曜。 */
  weekStartDate?: string;
}

/** pending 分類の証跡化保存結果。 */
export type SaveClassifiedCheckinResult =
  | {
      ok: true;
      checkinId: string;
      evidenceIds: string[];
      weekStartDate: string;
    }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "save_failed"; cause?: unknown };

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

/** ISO timestamp から UTC 基準の月曜週開始日(YYYY-MM-DD)を返す。 */
function weekStartDateFromUtcTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    throw new Error("invalid timestamp");
  }
  const day = date.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  const monday = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysSinceMonday),
  );
  return monday.toISOString().slice(0, 10);
}

/**
 * pending 分類を checkins/evidence/evidence_goal_links として保存する。
 *
 * pending 不在または userId 不一致は `not_found` に正規化し、DB と pending を変更しない。
 * Repository に transaction API が無いため、挿入済み ID を記録して失敗時に逆順削除する。
 */
export async function saveClassifiedCheckin(
  authority: CycleDataAuthority,
  deps: DomainDeps,
  store: PendingCheckinStore,
  input: SaveClassifiedCheckinInput,
): Promise<SaveClassifiedCheckinResult> {
  const pending = getPendingClassification(store, input.userId, input.pendingId);
  if (pending === null) {
    return { ok: false, reason: "not_found" };
  }

  const timestamp = deps.now();
  const weekStartDate = input.weekStartDate ?? weekStartDateFromUtcTimestamp(timestamp);
  const insertedLinkIds: string[] = [];
  const insertedEvidenceIds: string[] = [];
  let insertedCheckinId: string | null = null;

  try {
    const checkin: CheckinRow = {
      id: deps.newId(),
      cycle_id: pending.cycleId,
      user_id: pending.userId,
      raw_text: pending.rawText,
      week_start_date: weekStartDate,
      created_at: timestamp,
    };
    await authority.insertRow("checkins", checkin);
    insertedCheckinId = checkin.id;

    for (const item of pending.result.items) {
      const evidence: EvidenceRow = {
        id: deps.newId(),
        cycle_id: pending.cycleId,
        user_id: pending.userId,
        source_type: "manual_checkin",
        source_url: null,
        title: item.suggestedEvidenceTitle,
        body: item.text,
        evidence_date: weekStartDate,
        usefulness: item.usefulness,
        created_at: timestamp,
        updated_at: timestamp,
      };
      await authority.insertRow("evidence", evidence);
      insertedEvidenceIds.push(evidence.id);

      for (const candidateGoal of item.candidateGoals) {
        const link: EvidenceGoalLinkRow = {
          id: deps.newId(),
          evidence_id: evidence.id,
          goal_id: candidateGoal.goalId,
          relevance_score: candidateGoal.relevanceScore,
          reason: candidateGoal.reason,
          created_at: timestamp,
        };
        await authority.insertRow("evidence_goal_links", link);
        insertedLinkIds.push(link.id);
      }
    }

    store.classifications.delete(pending.pendingId);
    return {
      ok: true,
      checkinId: checkin.id,
      evidenceIds: insertedEvidenceIds,
      weekStartDate,
    };
  } catch (cause) {
    for (const linkId of insertedLinkIds.slice().reverse()) {
      await authority.removeRow("evidence_goal_links", linkId);
    }
    for (const evidenceId of insertedEvidenceIds.slice().reverse()) {
      await authority.removeRow("evidence", evidenceId);
    }
    if (insertedCheckinId !== null) {
      await authority.removeRow("checkins", insertedCheckinId);
    }
    return { ok: false, reason: "save_failed", cause };
  }
}
