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
import type {
  CheckinRow,
  DraftRow,
  EntityName,
  EntityRow,
  EvaluationCycleRow,
  EvidenceGoalLinkRow,
  EvidenceRow,
  GoalRow,
  MilestoneRow,
  WeeklyReviewRow,
} from "../src/types";
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

// §11 全 8 エンティティの read/write が共有型(EntityRow<E>)と整合することを、
// nullable 列を「値あり」「null」の両方で埋めた行で round-trip 検証する(Req 2.4 breadth)。
// 既存のケース(goals / evidence / evidence_goal_links)は他テストでも検証済みだが、
// ここでは 8 エンティティ全てを同一の判定基準で網羅し、共有型整合のカバレッジを広げる。

/** nullable 列を「値あり」で埋めた、エンティティごとの完全な行サンプル。 */
const FULL_ROWS: { [E in EntityName]: EntityRow<E> } = {
  evaluation_cycles: {
    id: "cyc-full",
    user_id: "user-1",
    name: "2026 上期",
    start_date: "2026-01-01",
    end_date: "2026-06-30",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  } satisfies EvaluationCycleRow,
  goals: {
    id: "goal-full",
    cycle_id: "cyc-full",
    user_id: "user-1",
    title: "目標",
    description: "本文",
    success_criteria: "達成条件",
    evaluation_points: "観点",
    status: "green",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  } satisfies GoalRow,
  milestones: {
    id: "ms-full",
    goal_id: "goal-full",
    title: "マイルストーン",
    description: "詳細",
    due_date: "2026-03-31",
    status: "in_progress",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  } satisfies MilestoneRow,
  checkins: {
    id: "ci-full",
    cycle_id: "cyc-full",
    user_id: "user-1",
    raw_text: "今週の進捗",
    week_start_date: "2026-01-05",
    created_at: "2026-01-05T00:00:00.000Z",
  } satisfies CheckinRow,
  evidence: {
    id: "ev-full",
    cycle_id: "cyc-full",
    user_id: "user-1",
    source_type: "discord_link",
    source_url: "https://example.com/x",
    title: "証跡タイトル",
    body: "証跡本文",
    evidence_date: "2026-01-06",
    usefulness: "high",
    created_at: "2026-01-06T00:00:00.000Z",
    updated_at: "2026-01-06T00:00:00.000Z",
  } satisfies EvidenceRow,
  evidence_goal_links: {
    id: "egl-full",
    evidence_id: "ev-full",
    goal_id: "goal-full",
    relevance_score: 0.9,
    reason: "強く関連",
    created_at: "2026-01-06T00:00:00.000Z",
  } satisfies EvidenceGoalLinkRow,
  weekly_reviews: {
    id: "wr-full",
    cycle_id: "cyc-full",
    user_id: "user-1",
    week_start_date: "2026-01-05",
    summary: "週次サマリ",
    risks: "リスク",
    next_actions: "次アクション",
    created_at: "2026-01-09T00:00:00.000Z",
  } satisfies WeeklyReviewRow,
  drafts: {
    id: "dr-full",
    cycle_id: "cyc-full",
    goal_id: "goal-full",
    user_id: "user-1",
    type: "goal_proposal",
    body: "ドラフト本文",
    created_at: "2026-01-10T00:00:00.000Z",
    updated_at: "2026-01-10T00:00:00.000Z",
  } satisfies DraftRow,
};

/** nullable 列を null にした行(値ありとは別 id)。null を持たないエンティティは undefined。 */
const NULLED_ROWS: { [E in EntityName]?: EntityRow<E> } = {
  goals: {
    ...FULL_ROWS.goals,
    id: "goal-nulled",
    success_criteria: null,
    evaluation_points: null,
  },
  milestones: {
    ...FULL_ROWS.milestones,
    id: "ms-nulled",
    description: null,
    due_date: null,
  },
  evidence: {
    ...FULL_ROWS.evidence,
    id: "ev-nulled",
    source_url: null,
    title: null,
  },
  evidence_goal_links: {
    ...FULL_ROWS.evidence_goal_links,
    id: "egl-nulled",
    reason: null,
  },
  weekly_reviews: {
    ...FULL_ROWS.weekly_reviews,
    id: "wr-nulled",
    risks: null,
    next_actions: null,
  },
  drafts: {
    ...FULL_ROWS.drafts,
    id: "dr-nulled",
    goal_id: null,
  },
};

const ALL_ENTITIES = Object.keys(FULL_ROWS) as EntityName[];

describe("repository: §11 全 8 エンティティの共有型整合 round-trip (2.4)", () => {
  it("全 8 エンティティ名がスキーマ定義の §11 テーブルと一致する", () => {
    expect(ALL_ENTITIES.sort()).toEqual(
      [
        "checkins",
        "drafts",
        "evaluation_cycles",
        "evidence",
        "evidence_goal_links",
        "goals",
        "milestones",
        "weekly_reviews",
      ].sort(),
    );
  });

  for (const entity of ALL_ENTITIES) {
    it(`${entity}: nullable=値あり の行が型・値ともに round-trip する`, () => {
      const { db, repo } = setup();
      try {
        const row = FULL_ROWS[entity];
        repo.insert(entity, row);
        const fetched = repo.getById(entity, (row as { id: string }).id);
        // 共有型の全列が同一値で取得できること(余分/欠落キーなし)。
        expect(fetched).toEqual(row);
      } finally {
        db.close();
      }
    });

    const nulled = NULLED_ROWS[entity];
    if (nulled !== undefined) {
      it(`${entity}: nullable=null の行が null を保持して round-trip する(undefined にならない)`, () => {
        const { db, repo } = setup();
        try {
          repo.insert(entity, nulled);
          const fetched = repo.getById(entity, (nulled as { id: string }).id);
          expect(fetched).toEqual(nulled);
          // null 列がキー欠落(undefined)になっていないことを明示確認。
          const full = FULL_ROWS[entity] as Record<string, unknown>;
          const nulledRec = nulled as Record<string, unknown>;
          const fetchedRec = fetched as Record<string, unknown>;
          for (const key of Object.keys(full)) {
            if (nulledRec[key] === null) {
              expect(fetchedRec).toHaveProperty(key, null);
            }
          }
        } finally {
          db.close();
        }
      });
    }
  }
});
