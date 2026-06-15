// 証跡削除ドメインロジックの検証(goal-management task 2.4 / Req 3.1, 3.2, 3.3, 3.4, 5.3, 5.4)。
//
// 完了条件: 所有証跡が紐づく evidence_goal_links ごと削除され(getById null / 当該リンク空)、
// 不存在・非所有のいずれも `{ok:false, reason:"not_found"}` を返し副作用を残さない(露出しない)。
// 連動削除は対象 evidence_id のリンクに限定し、他証跡のリンクは残す。
//
// 実行環境: vitest projects の "node" プロジェクト(node:sqlite を使う実 SQLite で検証)。
// 参考: test/goal-management-add-goal.test.ts / test/repository.test.ts(FULL_ROWS)。

import { describe, expect, it } from "vitest";
import {
  type CycleDataAuthority,
  deleteEvidence,
} from "../src/goal-management/domain/cycle-operations";
import { runMigrations } from "../src/persistence/migrator";
import { createRepository } from "../src/persistence/repository";
import type {
  EntityName,
  EntityRow,
  EvidenceGoalLinkRow,
  EvidenceRow,
} from "../src/types";
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

/** 完全に項目を埋めた EvidenceRow を生成する。 */
function makeEvidence(overrides: Partial<EvidenceRow> = {}): EvidenceRow {
  return {
    id: "ev-1",
    cycle_id: "cyc-1",
    user_id: "user-1",
    source_type: "manual_checkin",
    source_url: null,
    title: null,
    body: "証跡本文",
    evidence_date: "2026-01-02",
    usefulness: "medium",
    created_at: "2026-01-02T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

/** EvidenceGoalLinkRow を生成する。 */
function makeLink(overrides: Partial<EvidenceGoalLinkRow> = {}): EvidenceGoalLinkRow {
  return {
    id: "link-1",
    evidence_id: "ev-1",
    goal_id: "goal-1",
    relevance_score: 0.5,
    reason: null,
    created_at: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("deleteEvidence: 証跡削除ドメインロジック", () => {
  it("所有証跡を紐づく evidence_goal_links ごと削除し ok を返す (3.1, 3.2, 5.3)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await authority.insertRow("evidence", makeEvidence({ id: "ev-1", user_id: "user-1" }));
      // 対象証跡に紐づくリンク(複数)。
      await authority.insertRow(
        "evidence_goal_links",
        makeLink({ id: "link-1", evidence_id: "ev-1", goal_id: "goal-1" }),
      );
      await authority.insertRow(
        "evidence_goal_links",
        makeLink({ id: "link-2", evidence_id: "ev-1", goal_id: "goal-2" }),
      );
      // 別証跡に紐づくリンク(連動削除の対象外)。
      await authority.insertRow("evidence", makeEvidence({ id: "ev-2", user_id: "user-1" }));
      await authority.insertRow(
        "evidence_goal_links",
        makeLink({ id: "link-3", evidence_id: "ev-2", goal_id: "goal-1" }),
      );

      const result = await deleteEvidence(authority, "user-1", "ev-1");
      expect(result).toEqual({ ok: true });

      // 証跡本体が削除される。
      expect(await authority.getRowById("evidence", "ev-1")).toBeNull();
      // 当該 evidence_id のリンクは全て削除される。
      expect(await authority.listRowsBy("evidence_goal_links", { evidence_id: "ev-1" })).toHaveLength(
        0,
      );
      // 他証跡のリンク・証跡は残る(連動削除が対象限定であること)。
      expect(await authority.getRowById("evidence", "ev-2")).not.toBeNull();
      expect(
        await authority.listRowsBy("evidence_goal_links", { evidence_id: "ev-2" }),
      ).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("リンクの無い所有証跡も本体のみ削除して ok を返す (3.1)", async () => {
    const { db, authority } = setupAuthority();
    try {
      await authority.insertRow("evidence", makeEvidence({ id: "ev-1", user_id: "user-1" }));

      const result = await deleteEvidence(authority, "user-1", "ev-1");
      expect(result).toEqual({ ok: true });
      expect(await authority.getRowById("evidence", "ev-1")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("不存在 evidenceId は not_found を返し副作用を残さない (3.3)", async () => {
    const { db, authority } = setupAuthority();
    try {
      // 無関係な証跡・リンクが存在しても影響を受けないこと。
      await authority.insertRow("evidence", makeEvidence({ id: "ev-1", user_id: "user-1" }));
      await authority.insertRow(
        "evidence_goal_links",
        makeLink({ id: "link-1", evidence_id: "ev-1" }),
      );

      const result = await deleteEvidence(authority, "user-1", "missing");
      expect(result).toEqual({ ok: false, reason: "not_found" });

      // 既存の証跡・リンクは削除されない。
      expect(await authority.getRowById("evidence", "ev-1")).not.toBeNull();
      expect(
        await authority.listRowsBy("evidence_goal_links", { evidence_id: "ev-1" }),
      ).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("非所有(別 user_id)の証跡は not_found を返し削除・露出しない (3.4)", async () => {
    const { db, authority } = setupAuthority();
    try {
      // 他ユーザー所有の証跡 + 紐づくリンク。
      await authority.insertRow("evidence", makeEvidence({ id: "ev-other", user_id: "user-2" }));
      await authority.insertRow(
        "evidence_goal_links",
        makeLink({ id: "link-other", evidence_id: "ev-other", goal_id: "goal-1" }),
      );

      const result = await deleteEvidence(authority, "user-1", "ev-other");
      expect(result).toEqual({ ok: false, reason: "not_found" });

      // 他ユーザーの証跡もリンクも削除されない(誤削除・露出しない)。
      expect(await authority.getRowById("evidence", "ev-other")).not.toBeNull();
      expect(
        await authority.listRowsBy("evidence_goal_links", { evidence_id: "ev-other" }),
      ).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
