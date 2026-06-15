// status-and-draft の証跡閲覧ドメイン操作(task 5.2 / Req 4.1, 4.2, 4.4, 8.1)。
//
// 設計の Service Interface(EvidenceViewOperations.listEvidenceWithLinks)は理想形であり、
// goal-management / checkin-classification で確立した純粋関数パターンに従って `(authority, userId)` を
// 引数注入する実シグネチャで実装する(tasks.md Implementation Notes 1.1)。`src/agents/*.ts` は
// 変更しない。下流(handlers / メッセージ層)はここで公開する関数と `EvidenceWithLinks` 型を、
// Agent から得たデータ権威を渡して再利用する。
//
// 所有者スコープのみを対象とし、他ユーザーの証跡・目標名を露出しない(Req 4.4, 8.1)。証跡が
// 無ければ空配列を返し、案内(Req 4.3)はメッセージ層の責務とする。

import type { CycleDataAuthority } from "../../goal-management/domain/cycle-operations";
import { assertOwned } from "../../goal-management/ownership";
import type { EntityRow } from "../../types";

/**
 * 1 件の証跡と、それに紐づく所有者スコープの目標名(design Service Interface)。
 *
 * `linkedGoalTitles` は当該証跡が `evidence_goal_links` で結ばれる、実行ユーザー所有の目標名のみ。
 * リンクが無い証跡や、リンク先が非所有/不存在の場合は空配列になる(他ユーザーの目標名を露出しない)。
 */
export interface EvidenceWithLinks {
  evidence: EntityRow<"evidence">;
  linkedGoalTitles: string[];
}

/**
 * 1 件の証跡に紐づく所有者スコープの目標名を解決する。
 *
 * `evidence_goal_links`(evidence_id 一致)から目標 ID を辿り、`assertOwned` で所有者一致の目標のみ
 * 採用する(防御的: 非所有/不存在の目標名は露出しない)。同一目標への重複リンクは 1 度だけ含め、
 * 解決順(リンク列挙順)を保って決定的に返す。
 */
async function resolveLinkedGoalTitles(
  authority: CycleDataAuthority,
  userId: string,
  evidenceId: string,
): Promise<string[]> {
  const links = await authority.listRowsBy("evidence_goal_links", { evidence_id: evidenceId });
  const seenGoalIds = new Set<string>();
  const titles: string[] = [];
  for (const link of links) {
    if (seenGoalIds.has(link.goal_id)) {
      continue;
    }
    seenGoalIds.add(link.goal_id);
    const goalRow = await authority.getRowById("goals", link.goal_id);
    const owned = assertOwned<"goals">(goalRow, userId);
    if (owned !== null) {
      titles.push(owned.title);
    }
  }
  return titles;
}

/**
 * 実行ユーザーが所有する証跡を、紐づく目標名付きで一覧返却する(Req 4.1, 4.2, 4.4, 8.1)。
 *
 * 証跡は `listRowsBy("evidence", { user_id })` で取得するため、他ユーザーの証跡は含まれない
 * (Req 4.4, 8.1)。各証跡について `evidence_goal_links` → 目標を辿り、所有者一致の目標名のみを
 * 解決して付与する(Req 4.2)。証跡が無ければ空配列を返す(案内は呼び出し側のメッセージ層、Req 4.3)。
 * 並びは `evidence_date` 昇順(同日は id 昇順)で決定的にする。
 *
 * @param authority サイクル/目標/証跡を所有者スコープで読むデータ権威。
 * @param userId 実行ユーザーの所有者識別子。
 * @returns 所有証跡と紐づく目標名の配列(証跡無しは空配列)。
 */
export async function listEvidenceWithLinks(
  authority: CycleDataAuthority,
  userId: string,
): Promise<EvidenceWithLinks[]> {
  const evidenceRows = await authority.listRowsBy("evidence", { user_id: userId });
  const sorted = [...evidenceRows].sort((a, b) => {
    if (a.evidence_date !== b.evidence_date) {
      return a.evidence_date < b.evidence_date ? -1 : 1;
    }
    if (a.id === b.id) {
      return 0;
    }
    return a.id < b.id ? -1 : 1;
  });

  const result: EvidenceWithLinks[] = [];
  for (const evidence of sorted) {
    const linkedGoalTitles = await resolveLinkedGoalTitles(authority, userId, evidence.id);
    result.push({ evidence, linkedGoalTitles });
  }
  return result;
}
