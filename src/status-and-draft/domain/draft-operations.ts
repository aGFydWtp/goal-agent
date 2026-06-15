// status-and-draft のドラフト生成・調整・保存ドメイン操作(task 5.3)。
//
// 設計の Service Interface(GoalAgent / EvaluationCycleAgent のメソッド)は理想形であり、
// goal-management / checkin-classification で確立した純粋関数パターンに従って
// `(authority, deps, llm, store, ...)` を引数注入する実シグネチャで実装する(tasks.md
// Implementation Notes 1.1)。`src/agents/*.ts` は変更しない。
//
// draft pending は Agent インスタンスや handler 層が所有できる揮発 store(Map)として分離する
// (checkin-classification の PendingCheckinStore と同型)。userId 不一致は不存在として正規化し、
// 他ユーザーのデータ存在を露出しない(Req 5.6, 6.6, 7.4, 8.1)。生成/調整は永続化せず pending の
// みを更新し、保存([保存])でのみ drafts へ書き込む(design State Management / Req 7.1)。

import {
  type CycleDataAuthority,
  type DomainDeps,
  getGoal,
  resolveActiveCycle,
} from "../../goal-management/domain/cycle-operations";
import { assertOwned } from "../../goal-management/ownership";
import type { LlmClient } from "../../llm/client";
import type { EntityRow } from "../../types";
import type { DraftType } from "../../types/enums";
import { buildDraftPrompt, buildRefinePrompt } from "../draft/prompt";
import { type DraftContent, draftContentSchema, type RefineKind } from "../draft/schema";
import { refineKindToDraftType } from "../draft/verify";

/** ドラフト生成の対象。目標単位は GoalAgent、全体は EvaluationCycleAgent 相当(design)。 */
export type DraftTarget = { kind: "goal"; goalId: string } | { kind: "all" };

/**
 * ドラフト生成結果(design Service Interface)。
 *
 * - `not_found`: アクティブサイクル不在/非所有・不存在目標を正規化(Req 5.6, 8.1)。
 * - `no_evidence`: 対象証跡が無く、誇張補完しないため生成しない(Req 5.7)。
 * - `generation_failed`: LLM 生成/検証失敗。pending を作らない(Req 5.8)。
 */
export type GenerateDraftResult =
  | { ok: true; draftPendingId: string; content: DraftContent }
  | { ok: false; reason: "not_found" | "no_evidence" | "generation_failed" };

/**
 * ドラフト調整結果(design Service Interface)。
 *
 * - `not_found`: pending 不在/別人操作を正規化(Req 6.6, 8.1)。
 * - `refine_failed`: 再生成失敗。直前 pending を保持したまま失敗を返す(Req 6.7)。
 */
export type RefineDraftResult =
  | { ok: true; content: DraftContent }
  | { ok: false; reason: "not_found" | "refine_failed" };

/**
 * ドラフト保存結果(design Service Interface)。
 *
 * - `not_found`: pending 不在/別人操作を正規化(Req 7.4, 8.1)。
 */
export type SaveDraftResult =
  | { ok: true; draft: EntityRow<"drafts"> }
  | { ok: false; reason: "not_found" };

/**
 * 確定保存前の揮発ドラフト作業状態(design State Management)。
 *
 * `goalId` は `{ kind: "all" }` のとき null(全体ドラフトは目標未指定、Req 7.1)。
 * `draftType` は初期生成で self_evaluation、調整で kind に応じて更新する(Req 7.2)。
 */
export interface PendingDraft {
  draftPendingId: string;
  userId: string;
  cycleId: string;
  goalId: string | null;
  draftType: DraftType;
  content: DraftContent;
  createdAt: string;
}

/**
 * Agent インスタンスまたは handler 層が所有する揮発 pending store。
 *
 * Map はプロセス/インスタンス内メモリであり、永続化や cross-instance 共有を意図しない
 * (DO 再起動で消失 → 再生成、確定済み drafts に影響なし)。
 */
export interface PendingDraftStore {
  readonly drafts: Map<string, PendingDraft>;
}

/** 空の pending store を作成する。 */
export function createPendingDraftStore(): PendingDraftStore {
  return { drafts: new Map() };
}

/**
 * pending ドラフトを所有者スコープで取得する。
 *
 * 不在または userId 不一致はどちらも `null` として返し、存在有無を漏らさない
 * (getPendingClassification と同じ idiom、Req 6.6, 7.4, 8.1)。
 */
function getPendingDraft(
  store: PendingDraftStore,
  userId: string,
  draftPendingId: string,
): PendingDraft | null {
  const pending = store.drafts.get(draftPendingId);
  if (pending === undefined || pending.userId !== userId) {
    return null;
  }
  return pending;
}

/** プロンプト入力へ渡す証跡の射影(本文・評価日付・有用度)。 */
function toPromptEvidence(
  evidence: ReadonlyArray<EntityRow<"evidence">>,
): ReadonlyArray<{ body: string; evidenceDate: string; usefulness: string }> {
  return evidence.map((item) => ({
    body: item.body,
    evidenceDate: item.evidence_date,
    usefulness: item.usefulness,
  }));
}

/**
 * 目標に紐づく所有者スコープ済みの証跡行を集める(status-operations と同じ idiom)。
 *
 * `evidence_goal_links`(goal_id 一致)から証跡 ID を辿り、`assertOwned` で所有者一致のみ採用する
 * (他ユーザー証跡の存在を露出しない)。同一証跡が複数リンクを持っても 1 度だけ含める。
 */
async function collectGoalEvidence(
  authority: CycleDataAuthority,
  userId: string,
  goalId: string,
): Promise<EntityRow<"evidence">[]> {
  const links = await authority.listRowsBy("evidence_goal_links", { goal_id: goalId });
  const seen = new Set<string>();
  const evidence: EntityRow<"evidence">[] = [];
  for (const link of links) {
    if (seen.has(link.evidence_id)) {
      continue;
    }
    seen.add(link.evidence_id);
    const row = await authority.getRowById("evidence", link.evidence_id);
    const owned = assertOwned<"evidence">(row, userId);
    if (owned !== null) {
      evidence.push(owned);
    }
  }
  return evidence;
}

/** 生成対象の集約結果(対象目標名・所有者スコープ済み証跡・保存用 goalId)。 */
interface DraftTargetData {
  goalTitle: string | null;
  goalId: string | null;
  evidence: EntityRow<"evidence">[];
}

/**
 * 生成対象(目標単位 / 全体)の集約データを所有者スコープで解決する。
 *
 * 目標単位は `getGoal`(非所有/別サイクル/不存在は null = 見つからない)で目標を取得し、紐づく証跡を
 * 集約する。全体は当該サイクルの所有者スコープ証跡を集約し、目標名は null(全体)とする。
 *
 * @returns 解決できれば対象データ。非所有/不存在目標は `null`(Req 5.6, 8.1)。
 */
async function resolveTargetData(
  authority: CycleDataAuthority,
  userId: string,
  cycleId: string,
  target: DraftTarget,
): Promise<DraftTargetData | null> {
  if (target.kind === "goal") {
    const goal = await getGoal(authority, userId, cycleId, target.goalId);
    if (goal === null) {
      return null;
    }
    const evidence = await collectGoalEvidence(authority, userId, goal.id);
    return { goalTitle: goal.title, goalId: goal.id, evidence };
  }
  const evidence = await authority.listRowsBy("evidence", {
    user_id: userId,
    cycle_id: cycleId,
  });
  return { goalTitle: null, goalId: null, evidence };
}

/**
 * 対象証跡を集約し、自己評価ドラフトを生成して揮発 pending として保持する(Req 5.1, 5.2, 5.6,
 * 5.7, 5.8, 8.1)。
 *
 * 対象サイクルは `resolveActiveCycle` で解決する(不在は `not_found`)。目標単位/全体の対象証跡を
 * 所有者スコープで集約し、空証跡は `no_evidence`(誇張補完しない、Req 5.7)。`buildDraftPrompt` →
 * `completeJson` 失敗は pending を作らず `generation_failed`(Req 5.8)。生成成功で draftPendingId を
 * 採番し、初期種別 self_evaluation の PendingDraft を保持する(Req 7.2)。
 */
export async function generateDraft(
  authority: CycleDataAuthority,
  deps: DomainDeps,
  llm: LlmClient,
  store: PendingDraftStore,
  userId: string,
  target: DraftTarget,
): Promise<GenerateDraftResult> {
  const cycle = await resolveActiveCycle(authority, userId);
  if (cycle === null) {
    return { ok: false, reason: "not_found" };
  }

  const targetData = await resolveTargetData(authority, userId, cycle.id, target);
  if (targetData === null) {
    return { ok: false, reason: "not_found" };
  }

  if (targetData.evidence.length === 0) {
    return { ok: false, reason: "no_evidence" };
  }

  const promptRequest = buildDraftPrompt({
    goalTitle: targetData.goalTitle,
    evidence: toPromptEvidence(targetData.evidence),
  });

  const llmResult = await llm.completeJson(promptRequest, draftContentSchema);
  if (!llmResult.ok) {
    return { ok: false, reason: "generation_failed" };
  }

  const draftPendingId = deps.newId();
  const pending: PendingDraft = {
    draftPendingId,
    userId,
    cycleId: cycle.id,
    goalId: targetData.goalId,
    draftType: refineKindToDraftType(null),
    content: llmResult.value,
    createdAt: deps.now(),
  };
  store.drafts.set(draftPendingId, pending);

  return { ok: true, draftPendingId, content: llmResult.value };
}

/**
 * 提示中の pending ドラフトを調整 kind に従って再生成し、pending を更新する(Req 6.1-6.4, 6.6,
 * 6.7, 8.1)。
 *
 * pending 不在/別人操作は `not_found` に正規化し LLM を呼ばない(Req 6.6)。`buildRefinePrompt`
 * (直前内容 + kind)→ `completeJson` 失敗時は直前 pending を保持したまま `refine_failed`(Req 6.7)。
 * 成功時は pending の内容を更新し、種別を kind に応じて更新する(Req 6.5, 7.2)。
 */
export async function refineDraft(
  // authority / deps は調整では参照しないが、生成/保存と同じ注入順を保つため契約に含める
  // (handler / Agent が 3 操作を一様に呼べるようにする)。
  _authority: CycleDataAuthority,
  _deps: DomainDeps,
  llm: LlmClient,
  store: PendingDraftStore,
  userId: string,
  draftPendingId: string,
  kind: RefineKind,
): Promise<RefineDraftResult> {
  const pending = getPendingDraft(store, userId, draftPendingId);
  if (pending === null) {
    return { ok: false, reason: "not_found" };
  }

  const promptRequest = buildRefinePrompt(pending.content, kind);
  const llmResult = await llm.completeJson(promptRequest, draftContentSchema);
  if (!llmResult.ok) {
    // 直前 pending は更新しない(再生成失敗で作業状態を失わせない)。
    return { ok: false, reason: "refine_failed" };
  }

  pending.content = llmResult.value;
  pending.draftType = refineKindToDraftType(kind);

  return { ok: true, content: llmResult.value };
}

/**
 * §13.3 の 4 セクション + 推測注記を、安定した読みやすいプレーンテキスト本文へ整形する。
 *
 * messages.ts(ボタン文言を含む)へは依存せず本モジュール内で完結させ、drafts.body(文字列)へ
 * そのまま保存できる決定的な整形に絞る。推測注記は箇条書き、無ければ「(なし)」を出力する。
 */
function serializeDraftBody(content: DraftContent): string {
  const speculative =
    content.speculativeNotes.length === 0
      ? "(なし)"
      : content.speculativeNotes.map((note) => `- ${note}`).join("\n");

  return [
    `## 事実\n${content.facts}`,
    `## 解釈\n${content.interpretation}`,
    `## 課題\n${content.issues}`,
    `## 次アクション\n${content.nextActions}`,
    `## 推測\n${speculative}`,
  ].join("\n\n");
}

/**
 * 提示中の pending ドラフトを drafts へ確定保存する(Req 7.1, 7.2, 7.4, 7.5, 8.1)。
 *
 * pending 不在/別人操作は `not_found` に正規化し、行を作らない(Req 7.4)。所有者検証済みの場合は
 * 本文・対象サイクル・対象目標(全体は goal_id=null)・種別・所有者を伴って drafts へ書き込む
 * (Req 7.1, 7.2)。保存後も pending は破棄しない(調整→再保存の UX を維持、design §8.7 でボタンが
 * 残るため)。drafts は確定済み最終評価ではなくドラフトとして保持する(Req 7.5)。
 */
export async function saveDraft(
  authority: CycleDataAuthority,
  deps: DomainDeps,
  store: PendingDraftStore,
  userId: string,
  draftPendingId: string,
): Promise<SaveDraftResult> {
  const pending = getPendingDraft(store, userId, draftPendingId);
  if (pending === null) {
    return { ok: false, reason: "not_found" };
  }

  const timestamp = deps.now();
  const draft: EntityRow<"drafts"> = {
    id: deps.newId(),
    cycle_id: pending.cycleId,
    goal_id: pending.goalId,
    user_id: userId,
    type: pending.draftType,
    body: serializeDraftBody(pending.content),
    created_at: timestamp,
    updated_at: timestamp,
  };
  await authority.insertRow("drafts", draft);

  return { ok: true, draft };
}
