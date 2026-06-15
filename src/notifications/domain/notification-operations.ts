// Notification Domain Operations(週次チェックイン実行ドメインメソッド) (Req 1.2, 1.5, 2.1, 2.4, 7.1)。
//
// design.md §Notification Domain Operations の `runWeeklyCheckin` を、goal-management /
// status-and-draft で確立した純粋関数パターン(`(authority, deps, llm, ...)` 引数注入)で実装する。
// `src/agents/*.ts` は変更しない(boundary.test が Agent へのドメインメソッド/色リテラル混入を禁止)。
// 後続タスク(6.3)が EvaluationCycleAgent の発火コールバックから本関数を呼び出して配線する。
//
// 境界(再実装しない・Req 7.1, 7.2):
//  - 状態判定は status-and-draft の `determineAllStatuses` へ委譲する。色/判定はここで再計算せず、
//    判定結果の `verdict.status` を件数集計に用いるのみ。
//  - 配信は delivery の `deliver`(discord-gateway 送信ヘルパーのラッパ)へ委譲する。
// テスト容易性と境界明示のため、両上流契約(`determineAllStatuses` / `deliver`)を引数注入し、
// 本番既定はモジュール実装を束縛する。

import type { DiscordEnv } from "../../discord/env";
import type {
  CycleDataAuthority,
  DomainDeps,
} from "../../goal-management/domain/cycle-operations";
import type { LlmClient } from "../../llm/client";
import type { SendResult } from "../../discord/types";
import type { DetermineAllStatusesResult } from "../../status-and-draft/domain/status-operations";
import { determineAllStatuses as determineAllStatusesImpl } from "../../status-and-draft/domain/status-operations";
import type { Repository } from "../../persistence/repository";
import type { EntityRow, GoalStatus } from "../../types";
import { daysUntilCycleEnd, evaluateTriggers } from "../alert/triggers";
import { filterUnsentTriggers } from "../alert/dedup";
import type { AlertStateStore } from "../state/alert-state";
import { deliver as deliverImpl } from "../delivery";
import { buildAlertMessage, buildCheckinMessage, type StatusCounts } from "../messages";

/**
 * status-and-draft の全目標判定契約(消費する上流署名)。本スペックは再実装しない(Req 7.1)。
 * 既定は {@link determineAllStatusesImpl}。テストは fake を注入する。
 */
export type DetermineAllStatusesFn = (
  authority: CycleDataAuthority,
  deps: DomainDeps,
  llm: LlmClient,
  userId: string,
) => Promise<DetermineAllStatusesResult>;

/**
 * delivery の配信契約(消費する上流署名)。本スペックは DM/フォールバック機構を再実装しない(Req 7.2)。
 * 既定は {@link deliverImpl}。テストは fake を注入する。
 */
export type DeliverFn = (env: DiscordEnv, userId: string, content: string) => Promise<SendResult>;

/** {@link runWeeklyCheckin} の引数。上流契約は注入可能(既定はモジュール実装)。 */
export interface RunWeeklyCheckinArgs {
  /** Discord secrets / 個人用フォールバックチャンネルを含む実行環境。 */
  env: DiscordEnv;
  /** 実行ユーザーのサイクルデータ権威(`determineAllStatuses` へ素通しする)。 */
  authority: CycleDataAuthority;
  /** ID/時刻生成の注入点(判定の証跡経過・残日数算出に用いられる)。 */
  deps: DomainDeps;
  /** ステータス判定が用いる LLM クライアント。 */
  llm: LlmClient;
  /** 配信対象 = 実行ユーザー識別子(本人経路に限定・Req 2.5)。 */
  userId: string;
  /** status-and-draft 判定の注入点(既定: モジュール実装)。 */
  determineAllStatuses?: DetermineAllStatusesFn;
  /** delivery 配信の注入点(既定: モジュール実装)。 */
  deliver?: DeliverFn;
}

/**
 * 判定結果の各目標 `verdict.status` から Green/Yellow/Red 件数を集計する(Req 2.1)。
 *
 * 判定そのものは status-and-draft 所有であり、本関数は確定済みの `status` を数えるのみで
 * 色/判定ロジックを再実装しない(Req 7.1)。gray 等は §9.1 チェックイン文の対象外のため数えない。
 */
function countStatuses(
  results: ReadonlyArray<{ verdict: { status: string } }>,
): StatusCounts {
  const counts: StatusCounts = { green: 0, yellow: 0, red: 0 };
  for (const { verdict } of results) {
    if (verdict.status === "green") {
      counts.green += 1;
    } else if (verdict.status === "yellow") {
      counts.yellow += 1;
    } else if (verdict.status === "red") {
      counts.red += 1;
    }
  }
  return counts;
}

/**
 * 週次チェックイン実行ドメインメソッド (Req 1.2, 1.5, 2.1, 2.4, 7.1)。
 *
 * 手順(design.md §Notification Domain Operations `runWeeklyCheckin`):
 *  1. status-and-draft の `determineAllStatuses(userId)` で全目標を判定する(Req 2.1, 7.1)。
 *  2. アクティブサイクルが無い(`no_cycle`)場合は何も配信せず終了する(Req 1.5)。
 *  3. 目標0件(`no_goals` または results 空)は全件数0として扱う(Req 2.4)。それ以外は
 *     `verdict.status` から Green/Yellow/Red を集計する。
 *  4. `buildCheckinMessage` で §9.1 チェックイン文を組み立て、`deliver` で本人経路へ配信する
 *     (Req 2.2, 2.3, 2.5)。
 *
 * 判定は status-and-draft、配信は delivery(→ discord-gateway)へ委譲し、色判定/DM 機構を
 * 再実装しない(Req 7.1, 7.2)。配信成否(`SendResult`)は呼び出し元の関心外のため握りつぶさず
 * 単に処理を継続する(delivery 側で失敗をログ済み)。
 *
 * @param args 実行コンテキストと(任意の)上流契約注入点。
 */
export async function runWeeklyCheckin(args: RunWeeklyCheckinArgs): Promise<void> {
  const determineAllStatuses = args.determineAllStatuses ?? determineAllStatusesImpl;
  const deliver = args.deliver ?? deliverImpl;

  const result = await determineAllStatuses(args.authority, args.deps, args.llm, args.userId);

  // アクティブサイクル不在 → チェックイン通知を送らずに終了する(Req 1.5)。
  if (!result.ok) {
    if (result.reason === "no_cycle") {
      return;
    }
    // no_goals: サイクルは存在し目標が0件 → 全件数0で配信する(Req 2.4)。
    await deliver(args.env, args.userId, buildCheckinMessage({ green: 0, yellow: 0, red: 0 }));
    return;
  }

  // 目標あり(0件含む)→ status を集計し件数付きチェックイン文を配信する(Req 2.1, 2.2, 2.4)。
  const counts = countStatuses(result.results);
  await deliver(args.env, args.userId, buildCheckinMessage(counts));
}

/**
 * 証跡なし2週継続トリガ(Req 4.4)用の最新 `evidence_date` 読取に必要な infra `Repository` の
 * 読み取り専用サブセット。§11.5 `evidence` / §11.6 `evidence_goal_links` を `goal_id` で参照する。
 *
 * 本スペックは §11 への列追加・スキーマ変更を行わず、既存列のみを read-only で参照する
 * (design「証跡経過は §11.5/§11.6 の読み取りのみで算出」)。`StatusVerdict` には依存しない。
 */
export type EvidenceReader = Pick<Repository, "getById" | "listBy">;

/**
 * 目標ごとの最新 `evidence.evidence_date` から証跡経過日数を算出する(Req 4.4)。
 *
 * `evidence_goal_links`(§11.6)を `goal_id` で引き、紐づく `evidence`(§11.5)を読み、最大の
 * `evidence_date` と `now` の UTC 暦日差(日数)を返す。証跡 0 件なら `null`(証跡なし)。
 * トリガ評価本体は `evaluateTriggers`(純関数)が所有し、本算出値のみを `no_evidence_2w` 判定に
 * 用いる(design L421)。読み取りは getById/listBy のみで、書き込み・列追加は行わない。
 *
 * @param evidence §11.5/§11.6 を参照する read-only Repository サブセット。
 * @param goalId 対象目標 ID。
 * @param nowIso 現在日時(`deps.now()`)。証跡経過の基準。
 * @returns 最新証跡からの経過日数。証跡 0 件は `null`。
 */
function computeLatestEvidenceAgeDays(
  evidence: EvidenceReader,
  goalId: string,
  nowIso: string,
): number | null {
  const links = evidence.listBy("evidence_goal_links", {
    goal_id: goalId,
  } as Partial<EntityRow<"evidence_goal_links">>);

  let latestDate: string | null = null;
  const seen = new Set<string>();
  for (const link of links) {
    if (seen.has(link.evidence_id)) {
      continue;
    }
    seen.add(link.evidence_id);
    const row = evidence.getById("evidence", link.evidence_id);
    if (row === null) {
      continue;
    }
    if (latestDate === null || row.evidence_date > latestDate) {
      latestDate = row.evidence_date;
    }
  }

  if (latestDate === null) {
    return null;
  }
  // daysUntilCycleEnd(target, now) は now→target の UTC 暦日差を返す。証跡日付を target に置けば
  // 「証跡から現在までの経過日数」= now - evidenceDate となるよう符号を反転する。
  return -daysUntilCycleEnd(latestDate, new Date(nowIso));
}

/** {@link evaluateAndSendAlerts} の引数。上流契約はすべて注入可能(既定はモジュール実装)。 */
export interface EvaluateAndSendAlertsArgs {
  /** Discord secrets / 個人用フォールバックチャンネルを含む実行環境。 */
  env: DiscordEnv;
  /** 実行ユーザーのサイクルデータ権威(`determineAllStatuses` へ素通しする)。 */
  authority: CycleDataAuthority;
  /** ID/時刻生成の注入点(証跡経過・残日数算出に用いられる)。 */
  deps: DomainDeps;
  /** ステータス判定が用いる LLM クライアント。 */
  llm: LlmClient;
  /** 配信対象 = 実行ユーザー識別子(本人経路に限定・Req 5.4)。 */
  userId: string;
  /** notifications 所有の Alert State Store(直近状態 / 送信履歴)。 */
  store: AlertStateStore;
  /** §11.5/§11.6 を read-only 参照する Repository サブセット(Req 4.4 証跡経過算出)。 */
  evidence: EvidenceReader;
  /** status-and-draft 判定の注入点(既定: モジュール実装)。判定は再利用する(Req 7.1)。 */
  determineAllStatuses?: DetermineAllStatusesFn;
  /** delivery 配信の注入点(既定: モジュール実装)(Req 7.2)。 */
  deliver?: DeliverFn;
}

/**
 * アラート評価・配信ドメインメソッド (Req 3.*, 4.*, 5.*, 6.4, 7.1, 7.2)。
 *
 * 手順(design.md §Notification Domain Operations `evaluateAndSendAlerts`, L509/L421):
 *  1. `determineAllStatuses(userId)` で全目標の最新判定を取得(週次発火の判定を再利用・Req 4.1, 7.1)。
 *     アクティブサイクル不在(`no_cycle`)/目標0件は何もせず終了。
 *  2. 保持中の直近状態 `getLastStatuses` を取得(唯一の比較元・Req 3.5)。
 *  3. 各目標について、最新 `evidence_date` を infra `Repository` から読み証跡経過 `latestEvidenceAgeDays`
 *     を自前算出(Req 4.4)。残日数は `daysUntilCycleEnd`(Req 4.7)。
 *  4. `evaluateTriggers`(純関数・Req 4.2-4.6)で成立トリガを得る。比較に用いた新状態を
 *     `upsertLastStatus` で直近状態として更新(Req 3.2, 3.3)。初回(直近未保持)は悪化遷移を成立
 *     させない(Req 3.4)。
 *  5. `filterUnsentTriggers`(dedup・Req 4.8)で同一サイクル送信済みを除外。
 *  6. 未送信トリガごとに `buildAlertMessage`(§9.3・Req 5.1, 5.2)→ `deliver`(本人経路・Req 5.3, 5.4)。
 *     配信成功時のみ `recordSent`(Req 6.4)。失敗は記録せず再送可能を保つ。
 *
 * トリガ評価/dedup/メッセージ整形/配信はすべて既存モジュールへ委譲し再実装しない(Req 7.1, 7.2)。
 * 証跡経過のみ本スペックが §11.5/§11.6 の read-only 読取から算出し、`StatusVerdict` には依存しない。
 *
 * @param args 実行コンテキストと注入された上流契約。
 */
export async function evaluateAndSendAlerts(args: EvaluateAndSendAlertsArgs): Promise<void> {
  const determineAllStatuses = args.determineAllStatuses ?? determineAllStatusesImpl;
  const deliver = args.deliver ?? deliverImpl;

  const result = await determineAllStatuses(args.authority, args.deps, args.llm, args.userId);
  if (!result.ok) {
    // no_cycle / no_goals: 評価対象なし → 何も配信せず終了(Req 4.1)。
    return;
  }

  const cycleId = result.cycle.id;
  const nowIso = args.deps.now();
  const cycleEndDays = daysUntilCycleEnd(result.cycle.end_date, new Date(nowIso));
  const lastStatuses = args.store.getLastStatuses(args.userId, cycleId);

  for (const { goal, verdict } of result.results) {
    const newStatus = verdict.status as GoalStatus;
    const previousStatus = lastStatuses.get(goal.id) ?? null;

    const latestEvidenceAgeDays = computeLatestEvidenceAgeDays(args.evidence, goal.id, nowIso);

    const fired = evaluateTriggers({
      goalId: goal.id,
      goalTitle: goal.title,
      newStatus,
      previousStatus,
      latestEvidenceAgeDays,
      daysUntilCycleEnd: cycleEndDays,
    });

    // 比較に用いた新状態を直近状態として更新する(Req 3.3)。配信成否に依存しない。
    args.store.upsertLastStatus(args.userId, cycleId, goal.id, newStatus);

    // 成立かつ未送信のトリガのみ配信する(Req 4.8)。
    const unsent = filterUnsentTriggers(args.store, args.userId, cycleId, fired);
    for (const trigger of unsent) {
      const content = buildAlertMessage({
        goalId: trigger.goalId,
        goalTitle: trigger.goalTitle,
        newStatus: trigger.newStatus,
        reasons: trigger.reasons,
      });
      const sendResult = await deliver(args.env, args.userId, content);
      // 配信成功時のみ送信履歴を記録(Req 6.4)。失敗は記録せず再送可能を保つ。
      if (sendResult.ok) {
        args.store.recordSent(args.userId, cycleId, trigger.goalId, trigger.kind);
      }
    }
  }
}
