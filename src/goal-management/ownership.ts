import type { EntityRow } from "../types";

/**
 * 所有者スコープ強制ヘルパー(Req 4.1, 4.2, 3.4)。
 *
 * Repository から取得した行に対し、実行ユーザーの所有者識別子(`user_id`)一致を
 * 検証する。`row` が `null`、または `user_id` 不一致なら `null`(不存在扱い)を返し、
 * 他ユーザーデータの存在を露出しない。
 *
 * 型パラメータ `E` は `user_id: string` 列を持つエンティティに限定する。
 *
 * @param row 検証対象の行、または `null`。
 * @param userId 実行ユーザーの所有者識別子。
 * @returns 所有者一致時は `row`、それ以外は `null`。
 */
export function assertOwned<E extends "evaluation_cycles" | "goals" | "evidence">(
  row: EntityRow<E> | null,
  userId: string,
): EntityRow<E> | null {
  if (row === null) return null;
  return row.user_id === userId ? row : null;
}
