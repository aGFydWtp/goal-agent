// status-and-draft のステータス判定ドメイン操作(task 5.1)。
//
// 設計の Service Interface(GoalAgent / EvaluationCycleAgent のメソッド)は理想形であり、
// goal-management / checkin-classification で確立した純粋関数パターンに従って、
// `(authority, deps, llm, ...)` を引数注入する実シグネチャで実装する(tasks.md Implementation
// Notes 1.1)。`src/agents/*.ts` は変更しない。下流(notifications 想定)はここで公開する関数と
// 判定結果型(GoalStatusResult / DetermineAllStatusesResult / StatusVerdict)を、Agent から得た
// データ権威を渡して再利用できる(Req 1.6, 8.5)。
//
// 判定は読み取りのみで、status を永続化しない(design State Management)。所有者不一致・不存在は
// すべて「見つからない」(not_found / null)に正規化する(Req 1.7, 3.4, 8.1)。

import {
  type CycleDataAuthority,
  type DomainDeps,
  getGoal,
  listGoals,
  resolveActiveCycle,
} from "../../goal-management/domain/cycle-operations";
import { assertOwned } from "../../goal-management/ownership";
import type { LlmClient } from "../../llm/client";
import type { EntityRow } from "../../types";
import { buildStatusPrompt } from "../status/prompt";
import { evaluateRules, type GoalStatusContext } from "../status/rules";
import { type StatusVerdict, statusVerdictLlmSchema } from "../status/schema";
import { combineVerdict } from "../status/verify";

/**
 * 単一目標の判定結果(design Service Interface)。所有者不一致・不存在は `not_found` に正規化する。
 *
 * notifications 想定の下流が再利用できる安定契約(Req 1.6, 8.5)。`verdict` は LLM 見立て採用時も
 * ルール候補フォールバック時も常に有効な `StatusVerdict`(Req 1.5)。
 */
export type GoalStatusResult =
  | {
      ok: true;
      verdict: StatusVerdict;
      goal: EntityRow<"goals">;
      evidence: ReadonlyArray<EntityRow<"evidence">>;
      shortfalls: string[];
    }
  | { ok: false; reason: "not_found" };

/**
 * 全目標の集約判定結果(design Service Interface)。
 *
 * アクティブサイクル不在は `no_cycle`、目標未登録は `no_goals`(Req 2.4, 2.5 の呼び出し分岐用)。
 */
export type DetermineAllStatusesResult =
  | {
      ok: true;
      cycle: EntityRow<"evaluation_cycles">;
      results: ReadonlyArray<{ goal: EntityRow<"goals">; verdict: StatusVerdict }>;
    }
  | { ok: false; reason: "no_cycle" | "no_goals" };

/** 1 日のミリ秒数。日数差計算に用いる。 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * UTC 暦日の差(end - start、整数日)を返す。
 *
 * 入力は `YYYY-MM-DD` または ISO8601 timestamp。時刻成分は切り捨て、UTC の暦日同士で差を取る
 * (checkin-operations の UTC 基準日付処理と同じ idiom)。`end` が過去なら負値。
 */
function utcDayDiff(start: string, end: string): number {
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    throw new Error("invalid date for day diff");
  }
  const startUtc = Date.UTC(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth(),
    startDate.getUTCDate(),
  );
  const endUtc = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate());
  return Math.round((endUtc - startUtc) / MS_PER_DAY);
}

/**
 * 目標に紐づく所有者スコープ済みの証跡行を集める。
 *
 * `evidence_goal_links`(goal_id 一致)から証跡 ID を辿り、`assertOwned` で所有者一致のみ採用する
 * (他ユーザー証跡の存在を露出しない)。同一証跡が複数リンクを持っても 1 度だけ含める。
 */
async function collectOwnedEvidence(
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

/**
 * §10.2 / §13.2 のルール前処理・LLM 見立ての入力となる目標コンテキストを集約する(Req 1.1)。
 *
 * 所有者スコープの目標を `getGoal` で取得し(非所有/別サイクル/不存在は `null` = 見つからない)、
 * 親サイクルを所有者検証付きで読み、紐づく証跡を集めて、半期終了までの日数と最新証跡経過日数を算出する。
 *
 * @returns 所有目標のコンテキスト。非所有/不存在/サイクル不整合は `null`(Req 1.7, 3.4, 8.1)。
 */
export async function collectGoalContext(
  authority: CycleDataAuthority,
  deps: DomainDeps,
  userId: string,
  cycleId: string,
  goalId: string,
): Promise<GoalStatusContext | null> {
  const goal = await getGoal(authority, userId, cycleId, goalId);
  if (goal === null) {
    return null;
  }

  const cycleRow = await authority.getRowById("evaluation_cycles", cycleId);
  const cycle = assertOwned<"evaluation_cycles">(cycleRow, userId);
  if (cycle === null) {
    return null;
  }

  const evidence = await collectOwnedEvidence(authority, userId, goalId);

  const nowIso = deps.now();
  const daysUntilCycleEnd = utcDayDiff(nowIso, cycle.end_date);

  let latestEvidenceAgeDays: number | null = null;
  if (evidence.length > 0) {
    let latestDate: string | null = null;
    for (const item of evidence) {
      if (latestDate === null || item.evidence_date > latestDate) {
        latestDate = item.evidence_date;
      }
    }
    // latestDate は evidence.length > 0 のため非 null。
    latestEvidenceAgeDays = utcDayDiff(latestDate as string, nowIso);
  }

  return {
    goalId: goal.id,
    title: goal.title,
    description: goal.description,
    successCriteria: goal.success_criteria,
    evaluationPoints: goal.evaluation_points,
    evidence: evidence.map((item) => ({
      body: item.body,
      evidenceDate: item.evidence_date,
      usefulness: item.usefulness,
    })),
    daysUntilCycleEnd,
    latestEvidenceAgeDays,
  };
}

/**
 * verdict から不足点(shortfalls)を導く。
 *
 * 判断材料不足(ルール: Gray 候補かつ LLM 見立て欠落)は専用メッセージを足し、LLM 見立ての risks も
 * 不足点として併記する。重複は除去する。
 */
function buildShortfalls(ruleInsufficientMaterial: boolean, verdict: StatusVerdict): string[] {
  const shortfalls: string[] = [];
  if (verdict.reasonMissing && ruleInsufficientMaterial) {
    shortfalls.push("判断材料が不足しています(証跡・達成条件・目標定義を確認してください)");
  }
  for (const risk of verdict.risks) {
    if (!shortfalls.includes(risk)) {
      shortfalls.push(risk);
    }
  }
  return shortfalls;
}

/**
 * 単一目標の状態を判定する(ルール → プロンプト → completeJson → 検証 → 統合)(Req 1.1-1.5, 3.1, 3.2)。
 *
 * `collectGoalContext` が `null`(非所有/不存在)なら `not_found` に正規化し、LLM を呼ばない
 * (Req 1.7, 3.4, 8.1)。コンテキスト取得後はルール前処理(§10.2)で候補状態を導き、§13.2 の
 * プロンプトで LLM 見立てを取得、`combineVerdict` で統合する。LLM 失敗時はルール候補で status を
 * 成立させ `reasonMissing: true` を返す(Req 1.5)。証跡なしはルール側で Gray(判断材料不足)(Req 1.4, 3.5)。
 *
 * @returns 所有目標は `{ ok: true, verdict, goal, evidence, shortfalls }`、非所有/不存在は `{ ok: false, reason: "not_found" }`。
 */
export async function determineGoalStatus(
  authority: CycleDataAuthority,
  deps: DomainDeps,
  llm: LlmClient,
  userId: string,
  cycleId: string,
  goalId: string,
): Promise<GoalStatusResult> {
  const context = await collectGoalContext(authority, deps, userId, cycleId, goalId);
  if (context === null) {
    return { ok: false, reason: "not_found" };
  }

  // getGoal は collectGoalContext 内で所有者検証済み。表示用の行を再取得する。
  const goal = await getGoal(authority, userId, cycleId, goalId);
  if (goal === null) {
    return { ok: false, reason: "not_found" };
  }
  const evidence = await collectOwnedEvidence(authority, userId, goalId);

  const rule = evaluateRules(context);
  const promptRequest = buildStatusPrompt(context);
  const llmResult = await llm.completeJson(promptRequest, statusVerdictLlmSchema);
  const verdict = combineVerdict(rule, llmResult);
  const shortfalls = buildShortfalls(rule.insufficientMaterial, verdict);

  return { ok: true, verdict, goal, evidence, shortfalls };
}

/**
 * 実行ユーザーのアクティブサイクルに属する全目標の状態を集約判定する(Req 2.1, 8.5)。
 *
 * 対象サイクルは `resolveActiveCycle` で解決し(不在は `no_cycle`)、`listGoals` が空なら `no_goals`。
 * 各目標について `determineGoalStatus` を呼び、判定結果を集約する。判定中に `not_found` に正規化
 * された目標(競合削除など)は防御的にスキップする。
 *
 * @returns 集約成功時は `{ ok: true, cycle, results }`、不在時は `no_cycle` / `no_goals`。
 */
export async function determineAllStatuses(
  authority: CycleDataAuthority,
  deps: DomainDeps,
  llm: LlmClient,
  userId: string,
): Promise<DetermineAllStatusesResult> {
  const cycle = await resolveActiveCycle(authority, userId);
  if (cycle === null) {
    return { ok: false, reason: "no_cycle" };
  }

  const goals = await listGoals(authority, userId, cycle.id);
  if (goals.length === 0) {
    return { ok: false, reason: "no_goals" };
  }

  const results: { goal: EntityRow<"goals">; verdict: StatusVerdict }[] = [];
  for (const goal of goals) {
    const result = await determineGoalStatus(authority, deps, llm, userId, cycle.id, goal.id);
    if (result.ok) {
      results.push({ goal: result.goal, verdict: result.verdict });
    }
  }

  return { ok: true, cycle, results };
}
