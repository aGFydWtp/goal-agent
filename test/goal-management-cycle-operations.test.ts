// サイクル作成ドメインロジックの検証(goal-management task 2.1 / Req 1.2, 1.5, 4.3, 5.3, 5.4)。
//
// 完了条件: 重複なしで `evaluation_cycles` 行が user_id・期間・timestamp 付きで insert され
// (getById で round-trip 確認)、同一ユーザー内の同名重複で `{ok:false, reason:"duplicate"}`
// を返し 2 件目を insert しないこと。別ユーザーの同名は重複扱いしない(所有者スコープ)。
//
// 実行環境: vitest projects の "node" プロジェクト(node:sqlite を使う実 SQLite で検証)。
// 参考: test/repository.test.ts。

import { describe, expect, it } from "vitest";
import {
  type CycleDataAuthority,
  createCycle,
  type DomainDeps,
} from "../src/goal-management/domain/cycle-operations";
import { createRepository } from "../src/persistence/repository";
import { runMigrations } from "../src/persistence/migrator";
import type { EntityName, EntityRow } from "../src/types";
import { NodeSqliteBackend } from "./helpers/node-sqlite-adapter";

/**
 * マイグレーション適用済みの実 SQLite を `CycleDataAuthority` に async ラップしたアダプタと、
 * DO 無しで検証するための後始末用 `db` を返す。
 */
function setupAuthority(): { db: NodeSqliteBackend; authority: CycleDataAuthority } {
  const db = new NodeSqliteBackend();
  runMigrations(db);
  const repo = createRepository(db);
  const authority: CycleDataAuthority = {
    insertRow: async (entity, row) => repo.insert(entity, row),
    getRowById: async <E extends EntityName>(entity: E, id: string) => repo.getById(entity, id),
    listRowsBy: async <E extends EntityName>(entity: E, where: Partial<EntityRow<E>>) =>
      repo.listBy(entity, where),
    removeRow: async (entity, id) => repo.remove(entity, id),
  };
  return { db, authority };
}

/** 決定的な deps(連番 ID + 固定 timestamp)を生成する。 */
function makeDeps(now = "2026-06-14T00:00:00.000Z"): DomainDeps {
  let counter = 0;
  return {
    newId: () => {
      counter += 1;
      return `cyc-${counter}`;
    },
    now: () => now,
  };
}

describe("createCycle: サイクル作成ドメインロジック", () => {
  it("重複なしで user_id・期間・timestamp 付きの evaluation_cycles 行を insert する (1.2, 4.3, 5.3, 5.4)", async () => {
    const { db, authority } = setupAuthority();
    try {
      const deps = makeDeps();
      const result = await createCycle(
        authority,
        deps,
        "user-1",
        "2026 上期",
        "2026-01-01",
        "2026-06-30",
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.cycle).toEqual({
        id: "cyc-1",
        user_id: "user-1",
        name: "2026 上期",
        start_date: "2026-01-01",
        end_date: "2026-06-30",
        created_at: "2026-06-14T00:00:00.000Z",
        updated_at: "2026-06-14T00:00:00.000Z",
      });

      // 永続化を round-trip で確認する。
      const fetched = await authority.getRowById("evaluation_cycles", "cyc-1");
      expect(fetched).toEqual(result.cycle);
      expect(fetched?.user_id).toBe("user-1");
    } finally {
      db.close();
    }
  });

  it("同一ユーザー内の同名サイクルは duplicate を返し 2 件目を insert しない (1.5)", async () => {
    const { db, authority } = setupAuthority();
    try {
      const deps = makeDeps();
      const first = await createCycle(
        authority,
        deps,
        "user-1",
        "重複名",
        "2026-01-01",
        "2026-06-30",
      );
      expect(first.ok).toBe(true);

      const second = await createCycle(
        authority,
        deps,
        "user-1",
        "重複名",
        "2026-07-01",
        "2026-12-31",
      );
      expect(second).toEqual({ ok: false, reason: "duplicate" });

      // 2 件目は永続化されない(同名は 1 件のみ)。
      const rows = await authority.listRowsBy("evaluation_cycles", {
        user_id: "user-1",
        name: "重複名",
      });
      expect(rows).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("別ユーザーの同名サイクルは重複扱いしない(所有者スコープ) (4.3)", async () => {
    const { db, authority } = setupAuthority();
    try {
      const deps = makeDeps();
      const a = await createCycle(authority, deps, "user-1", "共通名", "2026-01-01", "2026-06-30");
      const b = await createCycle(authority, deps, "user-2", "共通名", "2026-01-01", "2026-06-30");

      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      if (!a.ok || !b.ok) throw new Error("expected both ok");
      expect(a.cycle.user_id).toBe("user-1");
      expect(b.cycle.user_id).toBe("user-2");
      expect(a.cycle.id).not.toBe(b.cycle.id);
    } finally {
      db.close();
    }
  });
});
