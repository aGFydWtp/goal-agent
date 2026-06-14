// ユーザー単位データホーム ルーティング規約(goal-management 共有依存)。
//
// tasks.md Implementation Notes「ユーザー単位データホーム ルーティング規約」で確定した
// 共有依存として新設する。サイクル名重複検出(Req 1.5)・対象サイクル解決(Req 2.6)・
// 最新サイクル取得は「ユーザーの全サイクルが 1 つの DB に集約」されている必要があるため、
// 本スペックはユーザーの全 cycle/goal/evidence データを単一の EvaluationCycleAgent
// インスタンス(`evaluation:{userId}:primary`)へ集約する。論理サイクル id
// (`evaluation_cycles.id`)は `/cycle create` ごとに生成して行に保持し、DO ルーティングには
// 用いない。この規約は本モジュールに定義・export し、下流スペックも同一規約に従う
// (infra-foundation の変更は不要)。
//
// 依存方向: handlers → routing → infra `getCycleAgent`/`getGoalAgent`(左方向のみ)。

import { getCycleAgent, getGoalAgent } from "../agents/routing";
import type { DiscordEnv } from "../discord/env";
import type { EntityName, EntityRow } from "../types";
import type { CycleDataAuthority } from "./domain/cycle-operations";

/**
 * ユーザーの全 cycle/goal/evidence データを集約する単一 DO のルーティングキー。
 *
 * `getCycleAgent(env, userId, PRIMARY_CYCLE_KEY)` で `evaluation:{userId}:primary` に解決し、
 * 同一ユーザーの操作は常に同一論理 DO へ着地する。
 */
export const PRIMARY_CYCLE_KEY = "primary";

/**
 * 実行ユーザーのデータ権威(EvaluationCycleAgent, `evaluation:{userId}:primary`)を取得する。
 *
 * `getCycleAgent` の戻り値 DO スタブは `insertRow`/`getRowById`/`listRowsBy`/`removeRow` を
 * RPC で Promise 化して公開する。スタブの RPC 型はジェネリックメソッドを呼び出しごとの
 * union 戻り値へ展開するため、{@link CycleDataAuthority} のジェネリックシグネチャへは直接
 * 代入できない。そこで各メソッドを薄くラップした明示アダプタを返し、型安全に橋渡しする
 * (全体キャストや `any` は用いない。アダプタ内の代入のみ局所化)。
 *
 * @param env Discord secrets と infra バインディングを含む実行環境。
 * @param userId 実行ユーザー識別子(= データホームのオーナー)。
 * @returns 実行ユーザーのサイクルデータ権威。
 */
export async function getUserCycleAuthority(
  env: DiscordEnv,
  userId: string,
): Promise<CycleDataAuthority> {
  const stub = await getCycleAgent(env, userId, PRIMARY_CYCLE_KEY);
  // スタブの RPC 戻り値は呼び出しごとの具体 union(非ジェネリック)に展開されるため、
  // ジェネリックな CycleDataAuthority のシグネチャへは `unknown` 経由で局所的に橋渡しする。
  // ラップは各メソッドの戻り値に限定し、スタブ全体や `any` へのキャストは避ける。
  return {
    insertRow: <E extends EntityName>(entity: E, row: EntityRow<E>): Promise<void> =>
      stub.insertRow(entity, row),
    getRowById: <E extends EntityName>(entity: E, id: string): Promise<EntityRow<E> | null> =>
      stub.getRowById(entity, id) as unknown as Promise<EntityRow<E> | null>,
    listRowsBy: <E extends EntityName>(
      entity: E,
      where: Partial<EntityRow<E>>,
    ): Promise<EntityRow<E>[]> =>
      stub.listRowsBy(entity, where) as unknown as Promise<EntityRow<E>[]>,
    removeRow: <E extends EntityName>(entity: E, id: string): Promise<void> =>
      stub.removeRow(entity, id),
  };
}

/**
 * 実行ユーザー・目標のロジック境界(GoalAgent)を同一データホーム下で取得する。
 *
 * GoalAgent も `evaluation:{userId}:primary:goal:{goalId}` で同一ホームに解決する
 * (tasks.md Implementation Notes)。本タスク(3.1)では未使用だが、下流スペックが
 * 同一規約で目標境界へ解決できるよう共有依存として併せて公開する。
 *
 * @param env Discord secrets と infra バインディングを含む実行環境。
 * @param userId 実行ユーザー識別子。
 * @param goalId 対象目標識別子。
 * @returns 実行ユーザー・目標の GoalAgent スタブ。
 */
export function getUserGoalAgent(env: DiscordEnv, userId: string, goalId: string) {
  return getGoalAgent(env, userId, PRIMARY_CYCLE_KEY, goalId);
}
