// 型付きリポジトリ(低レベル行アクセス)の検証(Req 2.1, 2.4 / design.md Repository)。
//
// 完了条件: 各エンティティの read/write が型付きで動作し、書き込んだ行が同じ型で
// 取得できること(round-trip)。本物の SQLite バックエンド(Node 組み込み
// `node:sqlite`)上で、まずマイグレーションを適用してから CRUD を検証する。
//
// 実行環境: vitest projects の "node" プロジェクト(environment: node)。
// pool-workers では `node:sqlite` が無いため、本スイートは Node で動かす。

import { describe, expect, it } from "vitest";
import { createRepository } from "../src/persistence/repository";
import { runMigrations } from "../src/persistence/migrator";
import type { EvidenceRow, GoalRow } from "../src/types";
import { NodeSqliteBackend } from "./helpers/node-sqlite-adapter";

/** マイグレーション適用済み DB と repository を生成する。 */
function setup(): { db: NodeSqliteBackend; repo: ReturnType<typeof createRepository> } {
  const db = new NodeSqliteBackend();
  runMigrations(db);
  return { db, repo: createRepository(db) };
}

/** 完全に項目を埋めた GoalRow を生成する(nullable は値あり)。 */
function makeGoal(overrides: Partial<GoalRow> = {}): GoalRow {
  return {
    id: "goal-1",
    cycle_id: "cyc-1",
    user_id: "user-1",
    title: "目標タイトル",
    description: "目標本文",
    success_criteria: "達成条件",
    evaluation_points: "評価観点",
    status: "gray",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** EvidenceRow を生成する。 */
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

describe("repository: 型付き低レベル行アクセス", () => {
  it("insert → getById で同じ型・同じ値の行が round-trip する (2.1, 2.4)", () => {
    const { db, repo } = setup();
    try {
      const goal = makeGoal();
      repo.insert("goals", goal);

      const fetched = repo.getById("goals", goal.id);
      expect(fetched).toEqual(goal);
      // status・nullable(値あり)も保持されること。
      expect(fetched?.status).toBe("gray");
      expect(fetched?.success_criteria).toBe("達成条件");
    } finally {
      db.close();
    }
  });

  it("getById は存在しない id に対して null を返す", () => {
    const { db, repo } = setup();
    try {
      expect(repo.getById("goals", "missing")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("listBy(where) は一致する行のみ返し、空 where は全件返す", () => {
    const { db, repo } = setup();
    try {
      repo.insert("evidence", makeEvidence({ id: "ev-a", cycle_id: "cyc-1" }));
      repo.insert("evidence", makeEvidence({ id: "ev-b", cycle_id: "cyc-1" }));
      repo.insert("evidence", makeEvidence({ id: "ev-c", cycle_id: "cyc-2" }));

      const cyc1 = repo.listBy("evidence", { cycle_id: "cyc-1" });
      expect(cyc1.map((r) => r.id).sort()).toEqual(["ev-a", "ev-b"]);
      for (const row of cyc1) {
        expect(row.cycle_id).toBe("cyc-1");
      }

      const all = repo.listBy("evidence", {});
      expect(all).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  it("listBy は複数 where 列を AND で結合する", () => {
    const { db, repo } = setup();
    try {
      repo.insert("evidence", makeEvidence({ id: "ev-a", cycle_id: "cyc-1", user_id: "user-1" }));
      repo.insert("evidence", makeEvidence({ id: "ev-b", cycle_id: "cyc-1", user_id: "user-2" }));

      const result = repo.listBy("evidence", { cycle_id: "cyc-1", user_id: "user-2" });
      expect(result.map((r) => r.id)).toEqual(["ev-b"]);
    } finally {
      db.close();
    }
  });

  it("update は patch の列のみ更新し、他列は不変、getById に反映される", () => {
    const { db, repo } = setup();
    try {
      const goal = makeGoal();
      repo.insert("goals", goal);

      repo.update("goals", goal.id, { status: "green", title: "x" });

      const fetched = repo.getById("goals", goal.id);
      expect(fetched?.status).toBe("green");
      expect(fetched?.title).toBe("x");
      // patch 外の列は不変。
      expect(fetched?.description).toBe(goal.description);
      expect(fetched?.success_criteria).toBe(goal.success_criteria);
      expect(fetched?.created_at).toBe(goal.created_at);
    } finally {
      db.close();
    }
  });

  it("update は空 patch を no-op として扱い、行を変更しない", () => {
    const { db, repo } = setup();
    try {
      const goal = makeGoal();
      repo.insert("goals", goal);

      expect(() => repo.update("goals", goal.id, {})).not.toThrow();
      expect(repo.getById("goals", goal.id)).toEqual(goal);
    } finally {
      db.close();
    }
  });

  it("remove は行を削除し、getById は以降 null を返す", () => {
    const { db, repo } = setup();
    try {
      const goal = makeGoal();
      repo.insert("goals", goal);
      expect(repo.getById("goals", goal.id)).not.toBeNull();

      repo.remove("goals", goal.id);
      expect(repo.getById("goals", goal.id)).toBeNull();
    } finally {
      db.close();
    }
  });

  it("nullable 列(success_criteria=null)が null として round-trip する(undefined にならない)", () => {
    const { db, repo } = setup();
    try {
      const goal = makeGoal({ success_criteria: null, evaluation_points: null });
      repo.insert("goals", goal);

      const fetched = repo.getById("goals", goal.id);
      expect(fetched).toEqual(goal);
      expect(fetched?.success_criteria).toBeNull();
      // キーが欠落していない(undefined ではなく null)こと。
      expect(fetched).toHaveProperty("success_criteria", null);
      expect(fetched).toHaveProperty("evaluation_points", null);
    } finally {
      db.close();
    }
  });

  it("REAL 列(relevance_score)が number として round-trip する", () => {
    const { db, repo } = setup();
    try {
      repo.insert("evidence_goal_links", {
        id: "link-1",
        evidence_id: "ev-1",
        goal_id: "goal-1",
        relevance_score: 0.75,
        reason: null,
        created_at: "2026-01-02T00:00:00.000Z",
      });

      const fetched = repo.getById("evidence_goal_links", "link-1");
      expect(fetched?.relevance_score).toBe(0.75);
      expect(typeof fetched?.relevance_score).toBe("number");
      expect(fetched?.reason).toBeNull();
    } finally {
      db.close();
    }
  });
});
