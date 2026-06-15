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
import { deliver as deliverImpl } from "../delivery";
import { buildCheckinMessage, type StatusCounts } from "../messages";

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
